import { describe, expect, it, beforeEach } from "vitest";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { AgentEvent, AuditEntry } from "../src/types.js";
import {
  OTEL_LINEAGE_STAGING_SCOPE,
  exportOtelLineage,
  registerOtelLineageFunctions,
  type OtelLineageExportResult,
  type OtelLineageImportResult,
  type OtelLineageStagedSpan,
} from "../src/functions/otel-lineage.js";

describe("otel lineage export/import foundation", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerOtelLineageFunctions(sdk as never, kv as never);
  });

  it("exports agent events as sanitized OTEL/OpenInference spans", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const parent: AgentEvent = {
      id: "agevt_parent",
      timestamp: "2026-06-28T10:00:00Z",
      type: "tool_requested",
      traceId,
      nativeId: "1111111111111111",
      project: "billing",
      sessionId: "ses_1",
      agentId: "codex",
      functionId: "tool::Read",
      status: "pending",
      targetIds: ["tool_1"],
      metadata: {
        safe: "lineage note",
        token: secret,
        prompt: "raw prompt must not leave agentmemory",
      },
    };
    const child: AgentEvent = {
      id: "agevt_child",
      timestamp: "2026-06-28T10:00:01Z",
      type: "tool_completed",
      traceId,
      nativeId: "2222222222222222",
      parentEventId: parent.id,
      project: "billing",
      sessionId: "ses_1",
      agentId: "codex",
      functionId: "tool::Read",
      status: "ok",
      targetIds: ["tool_1"],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    };
    await kv.set(KV.agentEvents, parent.id, parent);
    await kv.set(KV.agentEvents, child.id, child);

    const result = (await sdk.trigger("mem::otel-lineage-export", {
      project: "billing",
    })) as OtelLineageExportResult;

    expect(result.success).toBe(true);
    expect(result.format).toBe("otel-openinference");
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.spans).toHaveLength(2);

    const parentSpan = result.spans.find(
      (span) => span.attributes["agentmemory.event.id"] === parent.id,
    );
    const childSpan = result.spans.find(
      (span) => span.attributes["agentmemory.event.id"] === child.id,
    );
    expect(parentSpan).toMatchObject({
      traceId,
      spanId: parent.nativeId,
      name: "tool::Read",
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: "1782640800000000000",
    });
    expect(parentSpan?.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(parentSpan?.attributes["agentmemory.event.hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(parentSpan?.attributes["agentmemory.provenance.source"]).toBe(
      "agentmemory.agent_event",
    );
    expect(parentSpan?.attributes["agentmemory.metadata.safe"]).toBe("lineage note");
    expect(JSON.stringify(parentSpan)).not.toContain(secret);
    expect(JSON.stringify(parentSpan)).not.toContain("raw prompt must not leave agentmemory");

    expect(childSpan).toMatchObject({
      traceId,
      spanId: child.nativeId,
      parentSpanId: parent.nativeId,
      status: { code: "STATUS_CODE_OK" },
    });
    expect(childSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(7);

    const audit = await kv.list<AuditEntry>(KV.audit);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "export",
      functionId: "mem::otel-lineage-export",
      targetIds: [parent.id, child.id],
    });
    expect(audit[0].details).toMatchObject({
      format: "otel-openinference",
      count: 2,
      contentHash: result.contentHash,
    });
  });

  it("strips nested raw-payload keys from exported metadata", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const nestedPrompt = "nested prompt body that must never leave agentmemory";
    const nestedContent = "nested message content that must never leave agentmemory";
    const event: AgentEvent = {
      id: "agevt_nested",
      timestamp: "2026-06-28T10:00:00Z",
      type: "tool_completed",
      traceId,
      nativeId: "3333333333333333",
      project: "billing",
      sessionId: "ses_1",
      agentId: "codex",
      functionId: "tool::Read",
      status: "ok",
      targetIds: ["tool_1"],
      metadata: {
        context: {
          prompt: nestedPrompt,
          label: "safe nested label",
          inner: {
            message: nestedContent,
            note: "deep safe note",
          },
        },
        items: [{ content: "array-nested content leak", keep: "array safe value" }],
        safe: "top-level safe value",
      },
    };
    await kv.set(KV.agentEvents, event.id, event);

    const result = (await sdk.trigger("mem::otel-lineage-export", {
      project: "billing",
    })) as OtelLineageExportResult;

    expect(result.success).toBe(true);
    expect(result.spans).toHaveLength(1);
    const span = result.spans[0];
    const spanJson = JSON.stringify(span);

    expect(spanJson).not.toContain(nestedPrompt);
    expect(spanJson).not.toContain(nestedContent);
    expect(spanJson).not.toContain("array-nested content leak");

    const contextAttr = span.attributes["agentmemory.metadata.context"];
    expect(typeof contextAttr).toBe("string");
    const context = JSON.parse(contextAttr as string) as Record<string, unknown>;
    expect(context).not.toHaveProperty("prompt");
    expect(context.label).toBe("safe nested label");
    expect((context.inner as Record<string, unknown>)).not.toHaveProperty("message");
    expect((context.inner as Record<string, unknown>).note).toBe("deep safe note");

    const itemsAttr = span.attributes["agentmemory.metadata.items"];
    expect(typeof itemsAttr).toBe("string");
    const items = JSON.parse(itemsAttr as string) as Array<Record<string, unknown>>;
    expect(items[0]).not.toHaveProperty("content");
    expect(items[0].keep).toBe("array safe value");

    expect(span.attributes["agentmemory.metadata.safe"]).toBe("top-level safe value");
  });

  it("imports sanitized spans into staging while preserving ids, hashes, and provenance", async () => {
    const event: AgentEvent = {
      id: "agevt_external",
      timestamp: "2026-06-28T10:00:00Z",
      type: "memory_written",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nativeId: "bbbbbbbbbbbbbbbb",
      project: "billing",
      sessionId: "ses_1",
      functionId: "mem::remember",
      status: "ok",
      targetIds: ["mem_1"],
      memoryIds: ["mem_1"],
    };
    await kv.set(KV.agentEvents, event.id, event);
    const exported = await exportOtelLineage(kv as never, { project: "billing" });

    const imported = (await sdk.trigger("mem::otel-lineage-import", {
      source: "unit-test",
      spans: exported.spans,
    })) as OtelLineageImportResult;

    expect(imported.success).toBe(true);
    expect(imported.imported).toBe(1);
    expect(imported.batchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(imported.stagingScope).toBe(OTEL_LINEAGE_STAGING_SCOPE);

    const staged = await kv.list<OtelLineageStagedSpan>(OTEL_LINEAGE_STAGING_SCOPE);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      traceId: event.traceId,
      spanId: event.nativeId,
      sourceHash: exported.spans[0].attributes["agentmemory.event.hash"],
      nativeIds: {
        eventId: event.id,
        nativeId: event.nativeId,
        traceId: event.traceId,
        spanId: event.nativeId,
      },
      provenance: {
        source: "unit-test",
        schema: "agentmemory.otel-lineage",
        schemaVersion: 1,
        hashAlgorithm: "sha256",
        batchHash: imported.batchHash,
      },
    });
    expect(staged[0].id).toMatch(/^otel_[0-9a-f]{16}$/);
    expect(staged[0].spanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(staged[0].span.traceId).toBe(event.traceId);

    const audit = await kv.list<AuditEntry>(KV.audit);
    const importAudit = audit.find((entry) => entry.operation === "import");
    expect(importAudit).toMatchObject({
      functionId: "mem::otel-lineage-import",
      targetIds: [staged[0].id],
      details: {
        format: "otel-openinference",
        count: 1,
        stagingScope: OTEL_LINEAGE_STAGING_SCOPE,
        batchHash: imported.batchHash,
        source: "unit-test",
      },
    });
  });

  it("rejects raw and oversized import payloads without staging", async () => {
    const baseSpan = {
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "1111111111111111",
      name: "tool::Read",
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: "1782640800000000000",
      endTimeUnixNano: "1782640800000000000",
      status: { code: "STATUS_CODE_OK" },
    };

    const raw = (await sdk.trigger("mem::otel-lineage-import", {
      source: "unit-test",
      spans: [
        {
          ...baseSpan,
          attributes: {
            "openinference.span.kind": "TOOL",
            "input.value": "raw prompt should be rejected",
          },
        },
      ],
    })) as { success: boolean; error: string };

    expect(raw.success).toBe(false);
    expect(raw.error).toContain("raw payload");
    expect(await kv.list(OTEL_LINEAGE_STAGING_SCOPE)).toEqual([]);
    expect(await kv.list<AuditEntry>(KV.audit)).toEqual([]);

    const oversized = (await sdk.trigger("mem::otel-lineage-import", {
      source: "unit-test",
      spans: [
        {
          ...baseSpan,
          attributes: {
            "openinference.span.kind": "TOOL",
            "agentmemory.metadata.note": "x".repeat(2_049),
          },
        },
      ],
    })) as { success: boolean; error: string };

    expect(oversized.success).toBe(false);
    expect(oversized.error).toContain("exceeds 2048 characters");
    expect(await kv.list(OTEL_LINEAGE_STAGING_SCOPE)).toEqual([]);
    expect(await kv.list<AuditEntry>(KV.audit)).toEqual([]);
  });
});
