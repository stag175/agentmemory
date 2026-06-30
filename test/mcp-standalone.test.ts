import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../src/mcp/transport.js", () => ({
  createStdioTransport: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

vi.mock("../src/config.js", () => ({
  getAgentId: vi.fn(() => process.env["AGENT_ID"]),
  getStandalonePersistPath: vi.fn(() => "/tmp/test-standalone.json"),
  isAgentScopeIsolated: vi.fn(
    () => process.env["AGENTMEMORY_AGENT_SCOPE"] === "isolated",
  ),
}));

import {
  getAllTools,
  CORE_TOOLS,
  V040_TOOLS,
} from "../src/mcp/tools-registry.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { handleToolCall, handleToolsList } from "../src/mcp/standalone.js";
import {
  resetHandleForTests,
  setLivezProbe,
} from "../src/mcp/rest-proxy.js";
import { writeFileSync } from "node:fs";

// Issue #449: hard-coded fetch() against :3111 in the livez probe was racing
// with vitest's mock setup, making this file the "10-11 pre-existing failures"
// referenced in the last 5 release notes. Stub the probe with an instant
// ok:false response so the shim takes the deterministic InMemoryKV fallback
// path on every test. Guard the real network with a fetch trap so any
// regression that bypasses the DI seam fails loudly instead of timing out.
const instantLocalFallbackProbe = vi.fn(async () => ({
  ok: false,
  status: 0,
  statusText: "stubbed: forced local fallback",
}));

const fetchTrap = vi.fn(async (url: unknown) => {
  throw new Error(
    `unexpected real fetch() call in mcp-standalone.test.ts: ${String(url)} — the livez probe DI stub should have absorbed this`,
  );
});

const ORIGINAL_AGENT_ID = process.env["AGENT_ID"];
const ORIGINAL_AGENT_SCOPE = process.env["AGENTMEMORY_AGENT_SCOPE"];

describe("Tools Registry", () => {
  it("getAllTools returns all tools with unique names", () => {
    const tools = getAllTools();
    // 74 after the governance/control-plane + proposal tools were wired in
    // (was 65). Asserted exactly so a missing/duplicate registry entry fails
    // loudly instead of silently drifting from the dispatch switch.
    expect(tools.length).toBe(74);
    const names = new Set(tools.map((t) => t.name));
    expect(names.size).toBe(tools.length);
    for (const required of [
      "memory_verify",
      "memory_lesson_save",
      "memory_lesson_recall",
      "memory_obsidian_export",
      "memory_save",
      "memory_create",
      "memory_recall",
      // Governance / control-plane surfaces (item 1, 3, 6, 11).
      "memory_audit_chain",
      "memory_audit_chain_verify",
      "memory_sync_peer_set_status",
      "memory_agent_event_prune",
      // Team memory proposal queue (item 2).
      "memory_proposal_create",
      "memory_proposal_list",
      "memory_proposal_approve",
      "memory_proposal_reject",
      "memory_proposal_apply",
    ]) {
      expect(tools.some((t) => t.name === required)).toBe(true);
    }
  });

  it("CORE_TOOLS has 14 items", () => {
    expect(CORE_TOOLS.length).toBe(14);
  });

  it("V040_TOOLS has 8 items", () => {
    expect(V040_TOOLS.length).toBe(8);
  });

  it("all tools have required name, description, inputSchema fields", () => {
    const tools = getAllTools();
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description).toBeDefined();
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});

describe("InMemoryKV", () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it("get/set/list/delete operations work", async () => {
    await kv.set("scope1", "key1", { value: "hello" });
    const result = await kv.get<{ value: string }>("scope1", "key1");
    expect(result).toEqual({ value: "hello" });

    const list = await kv.list("scope1");
    expect(list.length).toBe(1);

    await kv.delete("scope1", "key1");
    const afterDelete = await kv.get("scope1", "key1");
    expect(afterDelete).toBeNull();
  });

  it("list returns empty array for unknown scope", async () => {
    const result = await kv.list("nonexistent");
    expect(result).toEqual([]);
  });

  it("persist writes JSON", async () => {
    const kvWithPersist = new InMemoryKV("/tmp/test-kv.json");
    await kvWithPersist.set("scope1", "key1", { data: "test" });
    kvWithPersist.persist();

    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-kv.json",
      expect.any(String),
      "utf-8",
    );
    const written = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.scope1.key1).toEqual({ data: "test" });
  });

  it("set overwrites existing values", async () => {
    await kv.set("scope1", "key1", "first");
    await kv.set("scope1", "key1", "second");
    const result = await kv.get("scope1", "key1");
    expect(result).toBe("second");
    const list = await kv.list("scope1");
    expect(list.length).toBe(1);
  });
});

describe("handleToolCall", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env["AGENT_ID"];
    delete process.env["AGENTMEMORY_AGENT_SCOPE"];
    vi.mocked(writeFileSync).mockClear();
    instantLocalFallbackProbe.mockClear();
    fetchTrap.mockClear();
    // Order matters: resetHandleForTests() restores the default probe and
    // clears the cached handle. Install the stub AFTER the reset so the
    // shim's next resolveHandle() call hits the stubbed instant-fail path
    // instead of the real 2s AbortController fetch.
    resetHandleForTests();
    setLivezProbe(instantLocalFallbackProbe);
    (globalThis as { fetch: typeof fetch }).fetch = fetchTrap as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    resetHandleForTests();
    if (ORIGINAL_AGENT_ID === undefined) delete process.env["AGENT_ID"];
    else process.env["AGENT_ID"] = ORIGINAL_AGENT_ID;
    if (ORIGINAL_AGENT_SCOPE === undefined) {
      delete process.env["AGENTMEMORY_AGENT_SCOPE"];
    } else {
      process.env["AGENTMEMORY_AGENT_SCOPE"] = ORIGINAL_AGENT_SCOPE;
    }
  });

  it("livez probe stub is invoked instead of the real fetch (issue #449)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "regression guard" }, kv);
    expect(instantLocalFallbackProbe).toHaveBeenCalledTimes(1);
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it("local fallback keeps diagnose/status parity server-only when no daemon is reachable", async () => {
    expect(getAllTools().some((tool) => tool.name === "memory_diagnose")).toBe(true);

    const listed = await handleToolsList();
    const localToolNames = listed.tools.map((tool) => (tool as { name: string }).name);
    expect(localToolNames).not.toContain("memory_diagnose");

    await expect(
      handleToolCall("memory_diagnose", { categories: "storage" }, new InMemoryKV()),
    ).rejects.toThrow("Unknown tool: memory_diagnose");
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it("memory_save persists to disk immediately after saving", async () => {
    const kv = new InMemoryKV("/tmp/test-handle.json");
    const result = await handleToolCall(
      "memory_save",
      { content: "Test memory content" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.saved).toMatch(/^mem_/);
    expect(writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-handle.json",
      expect.any(String),
      "utf-8",
    );
  });

  it("memory_create local fallback returns lifecycle create metadata", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_create",
      {
        content: "Use explicit lifecycle create in standalone fallback",
        concepts: "lifecycle,create",
        files: "src/mcp/standalone.ts",
        project: "agentmemory",
        lane: "semantic_fact",
        confidence: 0.82,
        sourceObservationIds: "obs_a,obs_b",
      },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.memory.project).toBe("agentmemory");
    expect(parsed.memory.lane).toBe("semantic_fact");
    expect(parsed.memory.sourceObservationIds).toEqual(["obs_a", "obs_b"]);
    expect(parsed.sourceCard.sourceObservationIds).toEqual(["obs_a", "obs_b"]);
    expect(parsed.history.map((row: { action: string }) => row.action)).toEqual(["create"]);
    expect(parsed.fallback).toBe(true);
  });

  it("memory_delete local fallback propagates a scoped source selector", async () => {
    const kv = new InMemoryKV();
    const first = JSON.parse((await handleToolCall(
      "memory_create",
      {
        content: "Local source delete should target the first memory",
        project: "billing",
        agentId: "codex-a",
        sourceObservationIds: "obs_local_delete",
        sourceHash: "hash-local-delete",
        sourceUri: "file:///repo/billing/source.md",
      },
      kv,
    )).content[0].text);
    const second = JSON.parse((await handleToolCall(
      "memory_create",
      {
        content: "Local source delete should target the second memory",
        project: "billing",
        agentId: "codex-a",
        sourceObservationIds: "obs_local_delete",
        sourceHash: "hash-local-delete",
        sourceUri: "file:///repo/billing/source.md",
      },
      kv,
    )).content[0].text);
    const other = JSON.parse((await handleToolCall(
      "memory_create",
      {
        content: "Local source delete must not cross agent scope",
        project: "billing",
        agentId: "codex-b",
        sourceObservationIds: "obs_local_delete",
      },
      kv,
    )).content[0].text);

    const dryRun = JSON.parse((await handleToolCall(
      "memory_delete",
      {
        sourceObservationId: "obs_local_delete",
        project: "billing",
        agentId: "codex-a",
        dryRun: true,
      },
      kv,
    )).content[0].text);

    expect(dryRun.success).toBe(true);
    expect(dryRun.deleted).toBe(0);
    expect(dryRun.wouldDelete).toBe(2);
    expect(dryRun.propagation.targetIds.sort()).toEqual(
      [first.memory.id, second.memory.id].sort(),
    );
    expect(
      (await kv.get<{ lifecycleState?: string }>("mem:memories", first.memory.id))
        ?.lifecycleState,
    ).toBe("active");

    const deleted = JSON.parse((await handleToolCall(
      "memory_delete",
      {
        sourceObservationId: "obs_local_delete",
        project: "billing",
        agentId: "codex-a",
      },
      kv,
    )).content[0].text);

    expect(deleted.success).toBe(true);
    expect(deleted.deleted).toBe(2);
    expect(deleted.propagation.deletedIds.sort()).toEqual(
      [first.memory.id, second.memory.id].sort(),
    );
    expect(
      (await kv.get<{ lifecycleState?: string }>("mem:memories", first.memory.id))
        ?.lifecycleState,
    ).toBe("tombstoned");
    expect(
      (await kv.get<{ lifecycleState?: string }>("mem:memories", second.memory.id))
        ?.lifecycleState,
    ).toBe("tombstoned");
    expect(
      (await kv.get<{ lifecycleState?: string }>("mem:memories", other.memory.id))
        ?.lifecycleState,
    ).toBe("active");
  });

  it("memory_save without persist path does not call writeFileSync", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "No persist path" }, kv);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("memory_save throws when content is missing", async () => {
    const kv = new InMemoryKV();
    await expect(
      handleToolCall("memory_save", {}, kv),
    ).rejects.toThrow("content is required");
  });

  it("memory_save rejects non-string content safely (no runtime TypeError)", async () => {
    const kv = new InMemoryKV();
    // These would have crashed on .trim() before the type-guard fix.
    for (const bogus of [42, {}, [], null, undefined, true]) {
      await expect(
        handleToolCall("memory_save", { content: bogus }, kv),
      ).rejects.toThrow("content is required");
    }
  });

  it("memory_recall returns matching memories", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "TypeScript is great" }, kv);
    await handleToolCall("memory_save", { content: "Python is also great" }, kv);
    const result = await handleToolCall(
      "memory_recall",
      { query: "typescript" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content).toBe("TypeScript is great");
  });

  it("memory_save preserves agent scope and memory_recall applies local hard filters", async () => {
    const kv = new InMemoryKV();
    await handleToolCall(
      "memory_save",
      {
        content: "Scoped billing retry policy",
        project: "billing",
        agentId: "codex-a",
      },
      kv,
    );
    await handleToolCall(
      "memory_save",
      {
        content: "Scoped billing retry policy from another agent",
        project: "billing",
        agentId: "codex-b",
      },
      kv,
    );

    const scoped = JSON.parse(
      (
        await handleToolCall(
          "memory_recall",
          { query: "scoped billing retry", project: "billing", agentId: "codex-a" },
          kv,
        )
      ).content[0].text,
    );
    const cwdScoped = JSON.parse(
      (
        await handleToolCall(
          "memory_recall",
          { query: "scoped billing retry", cwd: "C:\\other\\repo" },
          kv,
        )
      ).content[0].text,
    );

    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0].agentId).toBe("codex-a");
    expect(cwdScoped.results).toEqual([]);
  });

  it("memory_save uses env AGENT_ID and recall fails closed in isolated fallback mode", async () => {
    const kv = new InMemoryKV();
    process.env["AGENTMEMORY_AGENT_SCOPE"] = "isolated";
    process.env["AGENT_ID"] = "codex-env";

    const saved = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          { content: "Env scoped standalone memory" },
          kv,
        )
      ).content[0].text,
    );
    expect(saved.memory.agentId).toBe("codex-env");

    const recall = JSON.parse(
      (
        await handleToolCall(
          "memory_recall",
          { query: "env scoped standalone" },
          kv,
        )
      ).content[0].text,
    );
    expect(recall.results.map((memory: { id: string }) => memory.id)).toEqual([
      saved.saved,
    ]);

    delete process.env["AGENT_ID"];
    await expect(
      handleToolCall("memory_recall", { query: "env scoped standalone" }, kv),
    ).rejects.toThrow("AGENTMEMORY_AGENT_SCOPE=isolated");
  });

  it("memory_save accepts concepts/files as arrays (plugin skill format, #139)", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_save",
      {
        content: "Use HMAC for API auth",
        concepts: ["hmac", "api-auth", "security"],
        files: ["src/auth.ts", "src/middleware.ts"],
      },
      kv,
    );
    const saved = JSON.parse(result.content[0].text);
    const mem = await kv.get<{ concepts: string[]; files: string[] }>(
      "mem:memories",
      saved.saved,
    );
    expect(mem?.concepts).toEqual(["hmac", "api-auth", "security"]);
    expect(mem?.files).toEqual(["src/auth.ts", "src/middleware.ts"]);
  });

  it("memory_save still accepts concepts/files as comma-separated strings (legacy)", async () => {
    const kv = new InMemoryKV();
    const result = await handleToolCall(
      "memory_save",
      {
        content: "JWT refresh rotation",
        concepts: "jwt, refresh, rotation",
        files: "src/auth.ts",
      },
      kv,
    );
    const saved = JSON.parse(result.content[0].text);
    const mem = await kv.get<{ concepts: string[]; files: string[] }>(
      "mem:memories",
      saved.saved,
    );
    expect(mem?.concepts).toEqual(["jwt", "refresh", "rotation"]);
    expect(mem?.files).toEqual(["src/auth.ts"]);
  });

  it("memory_smart_search falls back to substring match in the standalone shim (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall(
      "memory_save",
      { content: "Use bcrypt for password hashing" },
      kv,
    );
    await handleToolCall(
      "memory_save",
      { content: "Use argon2id for new projects" },
      kv,
    );
    const result = await handleToolCall(
      "memory_smart_search",
      { query: "bcrypt", limit: 5 },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].content).toBe("Use bcrypt for password hashing");
  });

  it("memory_smart_search rejects empty query to prevent match-all in forget flow (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall("memory_save", { content: "anything" }, kv);
    await expect(
      handleToolCall("memory_smart_search", {}, kv),
    ).rejects.toThrow("query is required");
    await expect(
      handleToolCall("memory_smart_search", { query: "" }, kv),
    ).rejects.toThrow("query is required");
    await expect(
      handleToolCall("memory_smart_search", { query: "   " }, kv),
    ).rejects.toThrow("query is required");
  });

  it("memory_smart_search searches files and concepts, not just title/content (#139)", async () => {
    const kv = new InMemoryKV();
    await handleToolCall(
      "memory_save",
      {
        content: "generic note",
        concepts: ["oauth", "token-rotation"],
        files: ["src/auth/refresh.ts"],
      },
      kv,
    );
    await handleToolCall("memory_save", { content: "unrelated" }, kv);

    // Find by file path
    const byFile = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "src/auth/refresh.ts" },
          kv,
        )
      ).content[0].text,
    );
    expect(byFile.results).toHaveLength(1);
    expect(byFile.results[0].files).toContain("src/auth/refresh.ts");

    // Find by concept
    const byConcept = JSON.parse(
      (
        await handleToolCall(
          "memory_smart_search",
          { query: "token-rotation" },
          kv,
        )
      ).content[0].text,
    );
    expect(byConcept.results).toHaveLength(1);
  });

  it("local fallback redacts and quarantines sensitive saved memories", async () => {
    const kv = new InMemoryKV();
    const secret = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const saved = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          {
            content: `do not store ${secret}`,
            concepts: [secret],
            files: [`src/${secret}.ts`],
          },
          kv,
        )
      ).content[0].text,
    );

    expect(saved.memory.lifecycleState).toBe("quarantined");
    expect(JSON.stringify(saved)).not.toContain(secret);

    const recall = JSON.parse(
      (
        await handleToolCall("memory_smart_search", { query: "store" }, kv)
      ).content[0].text,
    );
    expect(recall.results).toHaveLength(0);

    const inspect = JSON.parse(
      (
        await handleToolCall("memory_inspect", { memoryId: saved.saved }, kv)
      ).content[0].text,
    );
    expect(JSON.stringify(inspect)).not.toContain(secret);
    expect(inspect.searchable).toBe(false);

    const queue = JSON.parse(
      (await handleToolCall("memory_review_queue", {}, kv)).content[0].text,
    );
    expect(queue.queue[0].memory.id).toBe(saved.saved);
    expect(queue.queue[0].reasons).toContain("sensitive_quarantine");
  });

  it("local fallback supports lifecycle, explain, history, and ledger tools", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (
        await handleToolCall(
          "memory_save",
          {
            content: "Use vitest for local MCP lifecycle tests",
            project: "agentmemory",
          },
          kv,
        )
      ).content[0].text,
    );

    const updated = JSON.parse(
      (
        await handleToolCall(
          "memory_update",
          {
            memoryId: saved.saved,
            content: "Use vitest for local MCP lifecycle and ledger tests",
            reason: "tighten wording",
          },
          kv,
        )
      ).content[0].text,
    );
    expect(updated.memory.version).toBe(2);

    const explain = JSON.parse(
      (
        await handleToolCall(
          "memory_search_explain",
          { query: "ledger", project: "agentmemory" },
          kv,
        )
      ).content[0].text,
    );
    expect(explain.results).toHaveLength(1);
    expect(explain.explain.candidateCounts.returned).toBe(1);

    await handleToolCall("memory_expire", { memoryId: saved.saved }, kv);
    const afterExpire = JSON.parse(
      (
        await handleToolCall(
          "memory_search_explain",
          { query: "ledger", project: "agentmemory" },
          kv,
        )
      ).content[0].text,
    );
    expect(afterExpire.results).toHaveLength(0);

    await handleToolCall("memory_restore", { memoryId: saved.saved }, kv);
    const history = JSON.parse(
      (
        await handleToolCall("memory_history", { memoryId: saved.saved }, kv)
      ).content[0].text,
    );
    expect(history.history.map((row: { action: string }) => row.action)).toEqual([
      "create",
      "update",
      "expire",
      "restore",
    ]);

    const ledger = JSON.parse(
      (
        await handleToolCall(
          "memory_ledger",
          { project: "agentmemory", state: "all" },
          kv,
        )
      ).content[0].text,
    );
    expect(ledger.rows[0].id).toBe(saved.saved);
  });

  it("memory_sessions honours the limit arg (#139)", async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 5; i++) {
      await kv.set("mem:sessions", `ses_${i}`, {
        id: `ses_${i}`,
        project: "demo",
      });
    }
    const result = await handleToolCall(
      "memory_sessions",
      { limit: 2 },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessions).toHaveLength(2);
  });

  it("parseLimit clamps bad/malicious limit values to a safe range", async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 150; i++) {
      await handleToolCall("memory_save", { content: `mem ${i}` }, kv);
    }

    // Negative / NaN / Infinity / string / object — all should fall back
    // to the default (10) for memory_smart_search.
    for (const bogus of [-1, NaN, Infinity, "abc", {}, true]) {
      const r = await handleToolCall(
        "memory_smart_search",
        { query: "mem", limit: bogus },
        kv,
      );
      expect(JSON.parse(r.content[0].text).results).toHaveLength(10);
    }

    // An absurdly large limit gets clamped to MAX_LIMIT (100).
    const huge = await handleToolCall(
      "memory_smart_search",
      { query: "mem", limit: 99999 },
      kv,
    );
    expect(JSON.parse(huge.content[0].text).results).toHaveLength(100);
  });

  it("memory_smart_search local fallback honors retrievalMode and asOf filters", async () => {
    const kv = new InMemoryKV();
    await kv.set("mem:memories", "mem_current_policy", {
      id: "mem_current_policy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "fact",
      title: "Billing policy",
      content: "Billing policy uses invoice holds.",
      concepts: ["billing", "policy"],
      files: ["src/billing.ts"],
      sessionIds: [],
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
      isLatest: true,
    });
    await kv.set("mem:memories", "mem_future_policy", {
      id: "mem_future_policy",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      type: "fact",
      title: "Billing policy future",
      content: "Billing policy starts later.",
      concepts: ["billing", "policy"],
      files: ["src/billing.ts"],
      sessionIds: [],
      validFrom: "2026-03-01T00:00:00.000Z",
      isLatest: true,
    });

    const result = await handleToolCall(
      "memory_smart_search",
      {
        query: "billing policy",
        retrievalMode: "as_of",
        asOf: "2026-02-01T00:00:00.000Z",
        explain: true,
      },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.results.map((memory: { id: string }) => memory.id)).toEqual([
      "mem_current_policy",
    ]);
    expect(parsed.queryPlan).toMatchObject({
      retrievalMode: "as_of",
      hardFilters: {
        temporalValidity: {
          source: "asOf",
          validAt: "2026-02-01T00:00:00.000Z",
        },
      },
    });
  });

  it("memory_governance_delete removes memories by id array (#139)", async () => {
    const kv = new InMemoryKV();
    const a = JSON.parse(
      (await handleToolCall("memory_save", { content: "one" }, kv)).content[0]
        .text,
    );
    const b = JSON.parse(
      (await handleToolCall("memory_save", { content: "two" }, kv)).content[0]
        .text,
    );
    const c = JSON.parse(
      (await handleToolCall("memory_save", { content: "three" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: [a.saved, c.saved] },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(2);
    expect(parsed.requested).toBe(2);

    const remaining = await kv.list<Record<string, unknown>>("mem:memories");
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe(b.saved);
  });

  it("memory_governance_delete accepts CSV-string memoryIds too", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (await handleToolCall("memory_save", { content: "x" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: saved.saved, reason: "test csv" },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(1);
    expect(parsed.reason).toBe("test csv");
  });

  it("memory_governance_delete throws when memoryIds is missing or empty", async () => {
    const kv = new InMemoryKV();
    await expect(
      handleToolCall("memory_governance_delete", {}, kv),
    ).rejects.toThrow("memoryIds is required");
    await expect(
      handleToolCall("memory_governance_delete", { memoryIds: [] }, kv),
    ).rejects.toThrow("memoryIds is required");
  });

  it("memory_governance_delete silently skips unknown ids", async () => {
    const kv = new InMemoryKV();
    const saved = JSON.parse(
      (await handleToolCall("memory_save", { content: "real" }, kv)).content[0]
        .text,
    );
    const result = await handleToolCall(
      "memory_governance_delete",
      { memoryIds: [saved.saved, "mem_does_not_exist"] },
      kv,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(1);
    expect(parsed.requested).toBe(2);
  });
});
