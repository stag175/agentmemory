import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { AgentEvent, Memory } from "../src/types.js";
import {
  listAgentEvents,
  registerAgentEventFunctions,
  recordAgentEvent,
  pruneAgentEvents,
  type AgentEventOtelSpan,
} from "../src/functions/agent-events.js";
import type { AuditEntry } from "../src/types.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerMemoryLifecycleFunctions } from "../src/functions/memory-lifecycle.js";
import { registerSignalsFunction } from "../src/functions/signals.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";

const CAPTURE_CONTROL_ENV_KEYS = [
  "AGENTMEMORY_INCOGNITO",
  "AGENTMEMORY_CAPTURE_INCOGNITO",
  "AGENTMEMORY_CAPTURE_PAUSED",
  "AGENTMEMORY_PAUSE_CAPTURE",
  "AGENTMEMORY_CAPTURE_CONSENT",
  "AGENTMEMORY_CONSENT_CAPTURE",
  "AGENTMEMORY_CAPTURE",
  "AGENTMEMORY_AUTO_CAPTURE",
  "AGENTMEMORY_ENABLE_CAPTURE",
  "AGENTMEMORY_CAPTURE_ENABLED",
  "AGENTMEMORY_REQUIRE_CAPTURE_CONSENT",
] as const;

const ORIGINAL_CAPTURE_ENV = Object.fromEntries(
  CAPTURE_CONTROL_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof CAPTURE_CONTROL_ENV_KEYS)[number], string | undefined>;

function restoreCaptureEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_CAPTURE_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function forceCaptureEnabledEnv(): void {
  process.env["AGENTMEMORY_INCOGNITO"] = "false";
  process.env["AGENTMEMORY_CAPTURE_INCOGNITO"] = "false";
  process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "false";
  process.env["AGENTMEMORY_PAUSE_CAPTURE"] = "false";
  process.env["AGENTMEMORY_CAPTURE_CONSENT"] = "true";
  process.env["AGENTMEMORY_CONSENT_CAPTURE"] = "true";
  process.env["AGENTMEMORY_CAPTURE"] = "true";
  process.env["AGENTMEMORY_AUTO_CAPTURE"] = "true";
  process.env["AGENTMEMORY_ENABLE_CAPTURE"] = "true";
  process.env["AGENTMEMORY_CAPTURE_ENABLED"] = "true";
  process.env["AGENTMEMORY_REQUIRE_CAPTURE_CONSENT"] = "false";
}

describe("agent event lineage ledger", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    forceCaptureEnabledEnv();
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    setIndexPersistence(null);
    registerAgentEventFunctions(sdk as never, kv as never);
  });

  afterEach(() => {
    restoreCaptureEnv();
  });

  it("records redacted events and lists them by lineage filters", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const event = await recordAgentEvent(kv as never, {
      type: "memory_written",
      timestamp: "2026-06-28T10:00:00Z",
      project: "billing",
      agentId: `agent-${secret}`,
      functionId: "mem::remember",
      targetIds: ["mem_1"],
      memoryIds: ["mem_1"],
      correlationId: "corr_1",
      metadata: { token: secret, safe: true },
    });

    expect(event.id).toMatch(/^agevt_/);
    expect(event.redactionApplied).toBe(true);
    expect(event.sensitivityLabels).toContain("github_token");
    expect(JSON.stringify(event)).not.toContain(secret);

    const listed = (await sdk.trigger("mem::agent-event-list", {
      project: "billing",
      memoryId: "mem_1",
      correlationId: "corr_1",
    })) as { success: boolean; total: number; events: AgentEvent[] };

    expect(listed.success).toBe(true);
    expect(listed.total).toBe(1);
    expect(listed.events[0].id).toBe(event.id);
  });

  it("exports redacted OpenTelemetry spans without changing the default list shape", async () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const parent = await recordAgentEvent(kv as never, {
      type: "tool_requested",
      timestamp: "2026-06-28T10:00:00Z",
      traceId,
      project: "billing",
      agentId: "codex",
      functionId: "tool::run",
      targetIds: ["tool_1"],
    });
    const child = await recordAgentEvent(kv as never, {
      type: "tool_completed",
      timestamp: "2026-06-28T10:00:01Z",
      traceId,
      project: "billing",
      agentId: "codex",
      functionId: "tool::run",
      parentEventId: parent.id,
      targetIds: ["tool_1"],
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });
    await kv.set<AgentEvent>(KV.agentEvents, "agevt_raw", {
      id: "agevt_raw",
      timestamp: "2026-06-28T10:00:02Z",
      type: "custom",
      traceId: "external-trace",
      project: "billing",
      targetIds: [],
      metadata: {
        authorization: `Bearer ${secret}`,
        nested: { token: secret },
      },
    });

    const defaultList = (await sdk.trigger("mem::agent-event-list", {
      limit: 10,
    })) as { success: boolean; events?: AgentEvent[]; spans?: AgentEventOtelSpan[] };

    expect(defaultList.success).toBe(true);
    expect(defaultList.events?.length).toBe(3);
    expect(defaultList.spans).toBeUndefined();

    const otel = (await sdk.trigger("mem::agent-event-list", {
      format: "otel",
      limit: 10,
    })) as {
      success: boolean;
      format: string;
      spans: AgentEventOtelSpan[];
      events?: AgentEvent[];
    };

    expect(otel.success).toBe(true);
    expect(otel.format).toBe("otel");
    expect(otel.events).toBeUndefined();
    expect(otel.spans).toHaveLength(3);

    const parentSpan = otel.spans.find(
      (span) => span.attributes["agentmemory.event.id"] === parent.id,
    );
    const childSpan = otel.spans.find(
      (span) => span.attributes["agentmemory.event.id"] === child.id,
    );
    const rawSpan = otel.spans.find(
      (span) => span.attributes["agentmemory.event.id"] === "agevt_raw",
    );

    expect(parentSpan?.traceId).toBe(traceId);
    expect(parentSpan?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(childSpan).toMatchObject({
      traceId,
      parentSpanId: parentSpan?.spanId,
      name: "tool::run",
      start: "2026-06-28T10:00:01Z",
      end: "2026-06-28T10:00:01Z",
    });
    expect(childSpan?.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(childSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(7);
    expect(rawSpan?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rawSpan?.attributes)).not.toContain(secret);

    const invalid = (await sdk.trigger("mem::agent-event-list", {
      format: "zipkin",
    } as never)) as { success: boolean; error: string };

    expect(invalid).toEqual({
      success: false,
      error: "format must be one of: otel",
    });
  });

  it("does not crash target filtering when events have no target ids", async () => {
    const recorded = (await sdk.trigger("mem::agent-event-record", {
      type: "custom",
      project: "billing",
      metadata: { note: "targetless event" },
    })) as { success: boolean; event: AgentEvent };

    expect(recorded.success).toBe(true);
    expect(recorded.event.targetIds).toEqual([]);

    const listed = (await sdk.trigger("mem::agent-event-list", {
      targetId: "missing",
    })) as { success: boolean; total: number; events: AgentEvent[] };

    expect(listed.success).toBe(true);
    expect(listed.total).toBe(0);
    expect(listed.events).toEqual([]);
  });

  it("uses server-owned ids for runtime events and rejects duplicate preserved import ids", async () => {
    const original = await recordAgentEvent(kv as never, {
      id: "agevt_external",
      preserveId: true,
      type: "custom",
      project: "billing",
      metadata: { note: "original" },
    });

    await expect(
      recordAgentEvent(kv as never, {
        id: "agevt_external",
        preserveId: true,
        type: "custom",
        project: "ops",
        metadata: { note: "overwrite attempt" },
      }),
    ).rejects.toThrow("agent event id already exists: agevt_external");

    const runtime = await recordAgentEvent(kv as never, {
      id: "agevt_external",
      type: "custom",
      project: "ops",
      metadata: { note: "runtime id is ignored" },
    });
    expect(runtime.id).not.toBe("agevt_external");

    const stored = await kv.get<AgentEvent>(KV.agentEvents, "agevt_external");
    expect(stored).toMatchObject({
      id: original.id,
      project: "billing",
      metadata: { note: "original" },
    });

    const overwrittenProject = await listAgentEvents(kv as never, {
      project: "ops",
    });
    expect(overwrittenProject.events.map((event) => event.id)).toEqual([runtime.id]);
  });

  it("uses indexes for memory, target, and project filters with ordered pagination", async () => {
    const older = await recordAgentEvent(kv as never, {
      type: "memory_written",
      timestamp: "2026-06-28T10:00:00Z",
      project: "billing",
      targetIds: ["ticket_1"],
      memoryIds: ["mem_1"],
    });
    const newer = await recordAgentEvent(kv as never, {
      type: "memory_updated",
      timestamp: "2026-06-28T10:05:00Z",
      project: "billing",
      targetIds: ["ticket_1"],
      memoryIds: ["mem_1"],
    });
    await recordAgentEvent(kv as never, {
      type: "memory_updated",
      timestamp: "2026-06-28T10:10:00Z",
      project: "billing",
      targetIds: ["ticket_2"],
      memoryIds: ["mem_1"],
    });
    await recordAgentEvent(kv as never, {
      type: "memory_updated",
      timestamp: "2026-06-28T10:15:00Z",
      project: "ops",
      targetIds: ["ticket_1"],
      memoryIds: ["mem_2"],
    });

    const listSpy = vi.spyOn(kv, "list");
    const listed = await listAgentEvents(kv as never, {
      project: "billing",
      targetId: "ticket_1",
      memoryId: "mem_1",
      limit: 1,
      offset: 1,
    });

    expect(listed.total).toBe(2);
    expect(listed.events.map((event) => event.id)).toEqual([older.id]);
    expect(
      listSpy.mock.calls.some(([scope]) => scope === KV.agentEvents),
    ).toBe(false);

    const firstPage = await listAgentEvents(kv as never, {
      project: "billing",
      targetId: "ticket_1",
      memoryId: "mem_1",
      limit: 1,
    });

    expect(firstPage.events.map((event) => event.id)).toEqual([newer.id]);
  });

  it("ignores stale and missing index entries", async () => {
    const matching = await recordAgentEvent(kv as never, {
      type: "memory_written",
      timestamp: "2026-06-28T10:00:00Z",
      project: "billing",
      memoryIds: ["mem_live"],
    });
    const stale = await recordAgentEvent(kv as never, {
      type: "memory_written",
      timestamp: "2026-06-28T10:01:00Z",
      project: "billing",
      memoryIds: ["mem_other"],
    });

    await kv.set(KV.agentEventIndexes, "memoryId:mem_live", {
      eventIds: [stale.id, "agevt_missing", matching.id],
      updatedAt: "2026-06-28T10:02:00Z",
    });
    const listSpy = vi.spyOn(kv, "list");

    const listed = await listAgentEvents(kv as never, {
      memoryId: "mem_live",
    });

    expect(listed.total).toBe(1);
    expect(listed.events.map((event) => event.id)).toEqual([matching.id]);
    expect(
      listSpy.mock.calls.some(([scope]) => scope === KV.agentEvents),
    ).toBe(false);
  });

  it("legacy forget purges memory revision payloads", async () => {
    registerRememberFunction(sdk as never, kv as never);
    registerMemoryLifecycleFunctions(sdk as never, kv as never);
    const created = (await sdk.trigger("mem::remember", {
      content: "Forget must erase revision payloads too",
      type: "fact",
    })) as { memory: Memory };

    await sdk.trigger("mem::forget", { memoryId: created.memory.id });

    expect(await kv.get<Memory>(KV.memories, created.memory.id)).toBeNull();
    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: unknown[] };
    expect(history.history).toEqual([]);
    expect(JSON.stringify(await kv.list(KV.memoryHistory))).not.toContain(
      "Forget must erase revision payloads too",
    );
  });

  it("captures observe, remember, lifecycle, and handoff events", async () => {
    sdk.registerFunction("stream::set", async () => ({}));
    sdk.registerFunction("stream::send", async () => ({}));
    registerObserveFunction(sdk as never, kv as never);
    registerRememberFunction(sdk as never, kv as never);
    registerMemoryLifecycleFunctions(sdk as never, kv as never);
    registerSignalsFunction(sdk as never, kv as never);

    const observed = (await sdk.trigger("mem::observe", {
      hookType: "prompt_submit",
      sessionId: "ses_1",
      project: "billing",
      cwd: "/repo/billing",
      timestamp: "2026-06-28T10:01:00Z",
      data: { prompt: "Remember the invoice workflow" },
    })) as { observationId: string };

    const created = (await sdk.trigger("mem::remember", {
      content: "Invoice fixes require scoped billing memories",
      type: "workflow",
      project: "billing",
      agentId: "codex",
      sourceObservationIds: [observed.observationId],
    })) as { memory: Memory };

    await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      confidence: 0.91,
      reason: "verified in test",
    });

    await sdk.trigger("mem::signal-send", {
      from: "codex",
      to: "reviewer",
      type: "handoff",
      content: "Review billing memory lineage",
      threadId: "thread_1",
    });

    const events = await kv.list<AgentEvent>(KV.agentEvents);
    const types = events.map((event) => event.type);

    expect(types).toContain("session_started");
    expect(types).toContain("observation_recorded");
    expect(types).toContain("memory_written");
    expect(types).toContain("memory_updated");
    expect(types).toContain("handoff_sent");

    const memoryEvents = events.filter((event) =>
      event.memoryIds?.includes(created.memory.id),
    );
    expect(memoryEvents.map((event) => event.type)).toEqual([
      "memory_written",
      "memory_updated",
    ]);
  });

  it("skips automatic hook-origin REST events when capture is paused", async () => {
    process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "true";
    registerApiTriggers(sdk as never, kv as never, "secret");

    const skipped = (await sdk.trigger("api::agent-event-record", {
      headers: { authorization: "Bearer secret" },
      body: {
        type: "tool_completed",
        status: "ok",
        project: "billing",
        functionId: "tool:Read",
        targetIds: ["tool_read"],
        metadata: {
          captureSource: "automatic_hook",
          hookType: "post_tool_use",
        },
      },
      query_params: {},
    })) as {
      status_code: number;
      body: { success: boolean; skipped: boolean; reason: string; source: string };
    };

    expect(skipped).toEqual({
      status_code: 200,
      body: {
        success: true,
        skipped: true,
        reason: "paused",
        source: "AGENTMEMORY_CAPTURE_PAUSED",
      },
    });
    expect(await kv.list<AgentEvent>(KV.agentEvents)).toEqual([]);
    expect(await kv.list(KV.agentEventIndexes)).toEqual([]);
  });

  it("does not treat manual REST events as automatic capture while paused", async () => {
    process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "true";
    registerApiTriggers(sdk as never, kv as never, "secret");

    const created = (await sdk.trigger("api::agent-event-record", {
      headers: { authorization: "Bearer secret" },
      body: {
        type: "custom",
        status: "ok",
        project: "billing",
        functionId: "manual::lineage-note",
        targetIds: ["manual_target"],
        metadata: {
          hookType: "post_tool_use",
          note: "manual review note about a hook",
        },
      },
      query_params: {},
    })) as { status_code: number; body: { success: boolean; event: AgentEvent } };

    expect(created.status_code).toBe(201);
    expect(created.body.success).toBe(true);
    expect(created.body.event.metadata).toMatchObject({
      hookType: "post_tool_use",
      note: "manual review note about a hook",
    });
    expect(await kv.list<AgentEvent>(KV.agentEvents)).toHaveLength(1);
  });

  it("exposes REST record and list endpoints", async () => {
    registerApiTriggers(sdk as never, kv as never, "secret");

    const created = (await sdk.trigger("api::agent-event-record", {
      headers: { authorization: "Bearer secret" },
      body: {
        id: "agevt_rest_manual",
        type: "custom",
        project: "billing",
        agentId: "codex",
        targetIds: ["evt_target"],
        usage: { inputTokens: "7", ignoredUsageKey: 999 },
        cost: { amount: 0.03, currency: "USD", ignoredCostKey: "drop" },
        metadata: { note: "manual lineage note" },
        unexpectedField: "must not be stored",
      },
      query_params: {},
    })) as { status_code: number; body: { success: boolean; event: AgentEvent } };

    expect(created.status_code).toBe(201);
    expect(created.body.success).toBe(true);
    expect(created.body.event.id).toMatch(/^agevt_/);
    expect(created.body.event.id).not.toBe("agevt_rest_manual");
    expect(created.body.event.usage).toEqual({ inputTokens: 7 });
    expect(created.body.event.cost).toEqual({ amount: 0.03, currency: "USD" });
    expect(
      (created.body.event as unknown as Record<string, unknown>).unexpectedField,
    ).toBeUndefined();

    const listed = (await sdk.trigger("api::agent-event-list", {
      headers: { authorization: "Bearer secret" },
      body: {},
      query_params: { project: "billing", targetId: "evt_target" },
    })) as { status_code: number; body: { success: boolean; total: number } };

    expect(listed.status_code).toBe(200);
    expect(listed.body.success).toBe(true);
    expect(listed.body.total).toBe(1);

    const otel = (await sdk.trigger("api::agent-event-list", {
      headers: { authorization: "Bearer secret" },
      body: {},
      query_params: { project: "billing", targetId: "evt_target", format: "otel" },
    })) as {
      status_code: number;
      body: { success: boolean; format: string; spans: AgentEventOtelSpan[]; events?: AgentEvent[] };
    };

    expect(otel.status_code).toBe(200);
    expect(otel.body.success).toBe(true);
    expect(otel.body.format).toBe("otel");
    expect(otel.body.events).toBeUndefined();
    expect(otel.body.spans).toHaveLength(1);
    expect(otel.body.spans[0].attributes["agentmemory.event.id"]).toBe(
      created.body.event.id,
    );

    const invalidFormat = (await sdk.trigger("api::agent-event-list", {
      headers: { authorization: "Bearer secret" },
      body: {},
      query_params: { format: "zipkin" },
    })) as { status_code: number; body: { error: string } };

    expect(invalidFormat).toEqual({
      status_code: 400,
      body: { error: "format must be one of: otel" },
    });

    const second = (await sdk.trigger("api::agent-event-record", {
      headers: { authorization: "Bearer secret" },
      body: {
        id: "agevt_rest_manual",
        type: "custom",
        project: "ops",
        targetIds: ["evt_target"],
      },
      query_params: {},
    })) as { status_code: number; body: { success: boolean; event: AgentEvent } };

    expect(second.status_code).toBe(201);
    expect(second.body.success).toBe(true);
    expect(second.body.event.id).toMatch(/^agevt_/);
    expect(second.body.event.id).not.toBe(created.body.event.id);
    expect(second.body.event.id).not.toBe("agevt_rest_manual");

    const rejected = (await sdk.trigger("api::agent-event-record", {
      headers: { authorization: "Bearer secret" },
      body: { type: "custom", targetIds: "evt_target" },
      query_params: {},
    })) as { status_code: number; body: { error: string } };

    expect(rejected.status_code).toBe(400);
    expect(rejected.body.error).toBe("targetIds must be an array of strings");
  });

  it("writes bounded sharded index rows instead of one growing array", async () => {
    const first = await recordAgentEvent(kv as never, {
      type: "memory_written",
      timestamp: "2026-06-28T10:00:00Z",
      project: "billing",
      agentId: "codex",
      memoryIds: ["mem_shared"],
    });
    const second = await recordAgentEvent(kv as never, {
      type: "memory_updated",
      timestamp: "2026-06-28T10:05:00Z",
      project: "billing",
      agentId: "codex",
      memoryIds: ["mem_shared"],
    });

    const indexRows = await kv.list<Record<string, unknown>>(
      KV.agentEventIndexes,
    );

    // No legacy aggregate row should exist: every index row is a
    // self-describing shard or time-bucket row, none of which carry an
    // unbounded eventIds array.
    expect(
      indexRows.some((row) => Array.isArray((row as { eventIds?: unknown }).eventIds)),
    ).toBe(false);

    const memoryShards = indexRows.filter(
      (row) =>
        row.kind === "agent-event-index-shard" &&
        row.field === "memoryId" &&
        row.value === "mem_shared",
    );
    // One shard per (field,value,eventId): the shared memory id maps to two
    // distinct rows, so a third write would not rewrite either existing row.
    expect(memoryShards.map((row) => row.eventId).sort()).toEqual(
      [first.id, second.id].sort(),
    );

    const listed = await listAgentEvents(kv as never, { memoryId: "mem_shared" });
    expect(listed.total).toBe(2);
    expect(listed.events.map((event) => event.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("uses time-bucket rows for date-range queries without scanning events", async () => {
    const inWindow = await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: "2026-06-28T12:00:00Z",
      project: "billing",
    });
    await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: "2026-06-20T12:00:00Z",
      project: "billing",
    });
    await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: "2026-07-05T12:00:00Z",
      project: "billing",
    });

    const listSpy = vi.spyOn(kv, "list");
    const listed = await listAgentEvents(kv as never, {
      dateFrom: "2026-06-27T00:00:00Z",
      dateTo: "2026-06-29T00:00:00Z",
    });

    expect(listed.events.map((event) => event.id)).toEqual([inWindow.id]);
    expect(
      listSpy.mock.calls.some(([scope]) => scope === KV.agentEvents),
    ).toBe(false);
  });

  it("prunes agent events past the max-age cutoff and removes their index rows", async () => {
    const now = Date.now();
    const old = await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(),
      project: "billing",
      memoryIds: ["mem_old"],
    });
    const fresh = await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      project: "billing",
      memoryIds: ["mem_fresh"],
    });

    const result = await pruneAgentEvents(kv as never, { maxAgeDays: 90 });

    expect(result.pruned).toBe(1);
    expect(result.byAge).toBe(1);
    expect(result.candidateIds).toEqual([old.id]);

    expect(await kv.get<AgentEvent>(KV.agentEvents, old.id)).toBeNull();
    expect(await kv.get<AgentEvent>(KV.agentEvents, fresh.id)).not.toBeNull();

    // The pruned event's shard rows are gone; the surviving event keeps its
    // own shard so it still lists.
    const indexRows = await kv.list<Record<string, unknown>>(
      KV.agentEventIndexes,
    );
    expect(
      indexRows.some(
        (row) =>
          row.kind === "agent-event-index-shard" && row.value === "mem_old",
      ),
    ).toBe(false);

    const survivors = await listAgentEvents(kv as never, { memoryId: "mem_fresh" });
    expect(survivors.events.map((event) => event.id)).toEqual([fresh.id]);

    const audits = await kv.list<AuditEntry>(KV.audit);
    const pruneAudit = audits.find(
      (entry) => entry.functionId === "mem::agent-event-prune",
    );
    expect(pruneAudit?.operation).toBe("delete");
    expect(pruneAudit?.targetIds).toEqual([old.id]);
  });

  it("prunes the oldest events beyond the max-count cap in bounded batches", async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const event = await recordAgentEvent(kv as never, {
        type: "custom",
        timestamp: `2026-06-28T10:0${i}:00Z`,
        project: "billing",
      });
      created.push(event.id);
    }

    // Keep only the 2 newest; the 3 oldest are over the cap. Cap the batch at 2
    // so a single sweep drains part of the backlog without an unbounded delete.
    const firstSweep = await pruneAgentEvents(kv as never, {
      maxAgeDays: 0,
      maxCount: 2,
      batch: 2,
    });
    expect(firstSweep.pruned).toBe(2);
    expect(firstSweep.byCount).toBe(2);

    const secondSweep = await pruneAgentEvents(kv as never, {
      maxAgeDays: 0,
      maxCount: 2,
      batch: 2,
    });
    expect(secondSweep.pruned).toBe(1);

    const remaining = await kv.list<AgentEvent>(KV.agentEvents);
    // The 2 newest survive (created[3], created[4]).
    expect(remaining.map((event) => event.id).sort()).toEqual(
      created.slice(3).sort(),
    );

    const noop = await pruneAgentEvents(kv as never, {
      maxAgeDays: 0,
      maxCount: 2,
      batch: 2,
    });
    expect(noop.pruned).toBe(0);
  });

  it("reports prune candidates without deleting on dryRun", async () => {
    const now = Date.now();
    const old = await recordAgentEvent(kv as never, {
      type: "custom",
      timestamp: new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString(),
      project: "billing",
    });

    const result = await pruneAgentEvents(kv as never, {
      maxAgeDays: 90,
      dryRun: true,
    });

    expect(result.pruned).toBe(0);
    expect(result.candidateIds).toEqual([old.id]);
    expect(await kv.get<AgentEvent>(KV.agentEvents, old.id)).not.toBeNull();
  });

  it("redacts a secret that straddles the metadata truncation boundary", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    // Position the token so its characters span the 12,000-char cut. Truncating
    // before scanning would split it below the github-token pattern length and
    // store each half unredacted; scanning first replaces it wholesale.
    const serializedPrefix = '{"pad":"'.length;
    const padLength = 12_000 - serializedPrefix - 20;
    const event = await recordAgentEvent(kv as never, {
      type: "custom",
      project: "billing",
      metadata: { pad: "x".repeat(padLength), token: secret },
    });

    expect(event.redactionApplied).toBe(true);
    expect(event.sensitivityLabels).toContain("github_token");
    const metadata = event.metadata as { truncated?: boolean; preview?: string };
    expect(metadata.truncated).toBe(true);
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(metadata.preview).not.toContain(secret);
    // No partial fragment of the token survives the cut either.
    expect(metadata.preview).not.toContain("ghp_ABCDEFGHIJ");
  });
});
