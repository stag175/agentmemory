import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests } from "../src/mcp/rest-proxy.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const TEST_SECRET = "test-secret";
const AUTH_HEADERS = { authorization: `Bearer ${TEST_SECRET}` };

type FetchMock = ReturnType<typeof vi.fn>;

function installFetch(handler: (url: string, init?: RequestInit) => Response): FetchMock {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(url.toString(), init),
  );
  (globalThis as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch;
  return fn;
}

const BASE = "http://localhost:3111";
const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "rules-resolver-standalone-"));
  tempRoots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("@agentmemory/mcp standalone — server proxy (issue #159)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetHandleForTests();
    process.env["AGENTMEMORY_URL"] = BASE;
    delete process.env["AGENTMEMORY_SECRET"];
  });

  afterEach(() => {
    resetHandleForTests();
    globalThis.fetch = originalFetch;
    delete process.env["AGENTMEMORY_URL"];
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps health probes public while protecting sensitive REST routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const triggerCalls = (sdk.registerTrigger as unknown as ReturnType<typeof vi.fn>).mock
      .calls as Array<[{
        function_id: string;
        config: {
          api_path: string;
          middleware_function_ids?: string[];
        };
      }]>;
    const byPath = new Map(
      triggerCalls.map(([trigger]) => [trigger.config.api_path, trigger.config]),
    );

    expect(byPath.get("/agentmemory/livez")?.middleware_function_ids).toBeUndefined();
    expect(byPath.get("/agentmemory/health")?.middleware_function_ids).toBeUndefined();
    expect(byPath.get("/agentmemory/search")?.middleware_function_ids).toEqual([
      "middleware::api-auth",
    ]);
  });

  it("proxies memory_sessions to GET /agentmemory/sessions when server is up", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    installFetch((url, init) => {
      calls.push({ url, method: init?.method || "GET" });
      if (url.endsWith("/agentmemory/livez")) {
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/agentmemory/sessions")) {
        return new Response(
          JSON.stringify({ sessions: [{ id: "sess-1", observations: 69 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_sessions", { limit: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe("sess-1");
    expect(calls.find((c) => c.url.includes("/sessions"))).toBeDefined();
  });

  it("proxies memory_smart_search to POST /agentmemory/smart-search", async () => {
    let smartSearchBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/smart-search")) {
        const body = JSON.parse((init?.body as string) || "{}");
        smartSearchBody = body;
        return new Response(
          JSON.stringify({
            mode: "compact",
            query: body.query,
            results: [{ id: "m1", score: 0.9 }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });
    const res = await handleToolCall("memory_smart_search", {
      query: "auth bug",
      limit: 5,
      searchMode: "deep",
      retrievalMode: "global_community",
      project: "billing",
      cwd: "C:\\repo\\billing",
      files: "src/auth.ts, src/session.ts",
      branch: "main",
      commit: "abc123",
      memoryTier: "procedure",
      privacyScope: "project",
      agentId: "codex",
      sessionId: "sess_1",
      asOf: "2026-02-01T00:00:00.000Z",
      explain: true,
      includeReport: true,
      tokenBudget: 1200,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.query).toBe("auth bug");
    expect(body.results[0].id).toBe("m1");
    expect(smartSearchBody).toEqual({
      query: "auth bug",
      limit: 5,
      project: "billing",
      cwd: "C:\\repo\\billing",
      searchMode: "deep",
      retrievalMode: "global_community",
      files: ["src/auth.ts", "src/session.ts"],
      branch: "main",
      commit: "abc123",
      memoryTier: "procedure",
      privacyScope: "project",
      agentId: "codex",
      sessionId: "sess_1",
      asOf: "2026-02-01T00:00:00.000Z",
      explain: true,
      includeReport: true,
      tokenBudget: 1200,
    });
  });

  it("proxies memory_search_explain cwd to POST /agentmemory/search/explain", async () => {
    let explainBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/search/explain")) {
        explainBody = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({ success: true, explain: { queryPlan: { filters: explainBody } } }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    await handleToolCall("memory_search_explain", {
      query: "auth bug",
      cwd: "/repo/billing",
      files: "src/auth.ts",
    });

    expect(explainBody).toMatchObject({
      query: "auth bug",
      cwd: "/repo/billing",
      files: ["src/auth.ts"],
    });
  });

  it("proxies memory_create to POST /agentmemory/memory/create", async () => {
    let createBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/memory/create")) {
        createBody = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({
            success: true,
            memory: { id: "mem_created", content: createBody.content },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    });

    const res = await handleToolCall("memory_create", {
      content: "Use lifecycle create proxy",
      type: "fact",
      concepts: "lifecycle,create",
      files: "src/mcp/standalone.ts",
      project: "agentmemory",
      lane: "semantic_fact",
      confidence: 0.75,
      sourceObservationIds: "obs_1,obs_2",
      requireGatePass: true,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.memory.id).toBe("mem_created");
    expect(createBody).toMatchObject({
      content: "Use lifecycle create proxy",
      type: "fact",
      concepts: ["lifecycle", "create"],
      files: ["src/mcp/standalone.ts"],
      sourceObservationIds: ["obs_1", "obs_2"],
      project: "agentmemory",
      lane: "semantic_fact",
      confidence: 0.75,
      requireGatePass: true,
    });
  });

  it("proxies memory_rules_resolve to POST /agentmemory/rules/resolve", async () => {
    const root = tempDir();
    let rulesBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/rules/resolve")) {
        rulesBody = JSON.parse((init?.body as string) || "{}");
        return new Response(
          JSON.stringify({
            success: true,
            includeContent: false,
            workspaceRoot: rulesBody.workspaceRoot,
            scannedAt: "2026-06-28T00:00:00.000Z",
            rules: [],
            warnings: [],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const res = await handleToolCall("memory_rules_resolve", {
      workspaceRoot: root,
      instructionGlobs: "docs/*.md",
      maxBytes: 4096,
      includeContent: false,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(rulesBody).toEqual({
      workspaceRoot: resolve(root),
      instructionGlobs: ["docs/*.md"],
      maxFileBytes: 4096,
      includeContent: false,
    });
  });

  it("rejects invalid standalone searchMode before proxying search", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("", { status: 404 });
    });

    await expect(
      handleToolCall("memory_smart_search", {
        query: "auth bug",
        searchMode: "sideways",
      }),
    ).rejects.toThrow("searchMode must be one of: fast, balanced, deep");
  });

  it("REST context and smart-search adapters forward validated Context Router knobs", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let contextPayload: Record<string, unknown> | undefined;
    let smartPayload: Record<string, unknown> | undefined;

    sdk.registerFunction("mem::context", async (payload) => {
      contextPayload = payload as Record<string, unknown>;
      return { ok: true };
    });
    sdk.registerFunction("mem::smart-search", async (payload) => {
      smartPayload = payload as Record<string, unknown>;
      return { ok: true };
    });
    registerApiTriggers(sdk as never, kv as never, TEST_SECRET);

    const context = await sdk.trigger("api::context", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        sessionId: "sess_1",
        project: "billing",
        tokenBudget: "600",
        explain: "true",
        includeReport: true,
        ignored: "drop me",
      },
    });
    expect(context).toMatchObject({ status_code: 200 });
    expect(contextPayload).toEqual({
      sessionId: "sess_1",
      project: "billing",
      budget: 600,
      tokenBudget: 600,
      explain: true,
      includeReport: true,
    });

    const smart = await sdk.trigger("api::smart-search", {
      headers: { ...AUTH_HEADERS, "x-agentmemory-source": "viewer" },
      query_params: {},
      body: {
        query: "auth bug",
        limit: 7,
        searchMode: "FAST",
        retrievalMode: "global_community",
        explain: "false",
        includeReport: "yes",
        budget: "900",
        files: ["src/auth.ts"],
        cwd: "C:\\repo\\billing",
        branch: "main",
        memoryTier: "procedure",
        privacyScope: "project",
        asOf: "2026-02-01T00:00:00.000Z",
        ignored: "drop me",
      },
    });
    expect(smart).toMatchObject({ status_code: 200 });
    expect(smartPayload).toMatchObject({
      query: "auth bug",
      limit: 7,
      searchMode: "fast",
      retrievalMode: "global_community",
      explain: false,
      includeReport: true,
      tokenBudget: 900,
      files: ["src/auth.ts"],
      cwd: "C:\\repo\\billing",
      branch: "main",
      memoryTier: "procedure",
      privacyScope: "project",
      asOf: "2026-02-01T00:00:00.000Z",
      source: "viewer",
    });
    expect(smartPayload).not.toHaveProperty("ignored");

    const explain = await sdk.trigger("api::search-explain", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        query: "auth bug",
        searchMode: "deep",
        retrievalMode: "as_of",
        explain: false,
        includeReport: true,
        tokenBudget: 300,
        filePath: "src/auth.ts",
        cwd: "/repo/billing",
        validAt: "2026-02-01T00:00:00.000Z",
        agentId: "codex",
        sessionId: "sess_1",
      },
    });
    expect(explain).toMatchObject({ status_code: 200 });
    expect(smartPayload).toMatchObject({
      query: "auth bug",
      searchMode: "deep",
      retrievalMode: "as_of",
      explain: true,
      includeReport: true,
      tokenBudget: 300,
      filePath: "src/auth.ts",
      cwd: "/repo/billing",
      validAt: "2026-02-01T00:00:00.000Z",
      agentId: "codex",
      sessionId: "sess_1",
    });

    const rejected = await sdk.trigger("api::smart-search", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: { query: "auth bug", searchMode: "sideways" },
    });
    expect(rejected).toMatchObject({
      status_code: 400,
      body: { error: "searchMode must be one of: fast, balanced, deep" },
    });

    const rejectedRetrievalMode = await sdk.trigger("api::smart-search", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: { query: "auth bug", retrievalMode: "sideways" },
    });
    expect(rejectedRetrievalMode).toMatchObject({
      status_code: 400,
      body: {
        error: "retrievalMode must be one of: basic, local_graph, global_community, drift, as_of",
      },
    });
  });

  it("REST memory-create forwards only the explicit create payload", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let createPayload: Record<string, unknown> | undefined;

    sdk.registerFunction("mem::memory-create", async (payload) => {
      createPayload = payload as Record<string, unknown>;
      return { success: true, memory: { id: "mem_created" } };
    });
    registerApiTriggers(sdk as never, kv as never, TEST_SECRET);

    const created = await sdk.trigger("api::memory-create", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        content: "Use REST lifecycle create",
        type: "fact",
        concepts: ["rest", "create"],
        files: ["src/triggers/api.ts"],
        project: "agentmemory",
        sourceObservationIds: ["obs_1"],
        requireGatePass: true,
        ignored: "drop me",
      },
    });

    expect(created).toMatchObject({ status_code: 201 });
    expect(createPayload).toEqual({
      content: "Use REST lifecycle create",
      type: "fact",
      concepts: ["rest", "create"],
      files: ["src/triggers/api.ts"],
      sourceObservationIds: ["obs_1"],
      project: "agentmemory",
      requireGatePass: true,
    });

    const rejected = await sdk.trigger("api::memory-create", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        content: "bad gate flag",
        requireGatePass: "true",
      },
    });
    expect(rejected).toMatchObject({
      status_code: 400,
      body: { error: "requireGatePass must be a boolean" },
    });
  });

  it("REST memory-delete forwards source selectors and rejects invalid dryRun", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    let deletePayload: Record<string, unknown> | undefined;

    sdk.registerFunction("mem::memory-delete", async (payload) => {
      deletePayload = payload as Record<string, unknown>;
      return { success: true, deleted: 2 };
    });
    registerApiTriggers(sdk as never, kv as never, TEST_SECRET);

    const deleted = await sdk.trigger("api::memory-delete", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        sourceObservationId: "obs_1",
        sourceHash: "hash_1",
        sourceUri: "file:///repo/source.md",
        project: "billing",
        agentId: "codex-a",
        mode: "hard",
        dryRun: true,
        reason: "source removed upstream",
        actor: "operator",
        ignored: "drop me",
      },
    });

    expect(deleted).toMatchObject({ status_code: 200 });
    expect(deletePayload).toEqual({
      memoryId: undefined,
      sourceObservationId: "obs_1",
      sourceHash: "hash_1",
      sourceUri: "file:///repo/source.md",
      project: "billing",
      agentId: "codex-a",
      mode: "hard",
      reason: "source removed upstream",
      actor: "operator",
      dryRun: true,
    });

    const missingSelector = await sdk.trigger("api::memory-delete", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: { reason: "missing target" },
    });
    expect(missingSelector).toMatchObject({
      status_code: 400,
      body: { error: "memoryId or source selector is required" },
    });

    const rejected = await sdk.trigger("api::memory-delete", {
      headers: AUTH_HEADERS,
      query_params: {},
      body: {
        sourceObservationId: "obs_1",
        project: "billing",
        dryRun: "true",
      },
    });
    expect(rejected).toMatchObject({
      status_code: 400,
      body: { error: "dryRun must be a boolean" },
    });
  });

  it("proxies memory_recall to POST /agentmemory/search and forwards format/token_budget (#507)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/agentmemory/search")) {
        return new Response(
          JSON.stringify({
            mode: "full",
            facts: [{ id: "m1" }],
            narrative: "n",
            concepts: ["c"],
            files: ["f"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const res = await handleToolCall("memory_recall", {
      query: "auth bug",
      limit: 5,
      format: "full",
      token_budget: 800,
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe("full");
    expect(body.facts[0].id).toBe("m1");
    const searchCall = calls.find((c) => c.url.endsWith("/agentmemory/search"));
    expect(searchCall).toBeDefined();
    expect(searchCall?.body).toEqual({
      query: "auth bug",
      limit: 5,
      format: "full",
      token_budget: 800,
    });
    expect(calls.find((c) => c.url.endsWith("/agentmemory/smart-search"))).toBeUndefined();
  });

  it("memory_recall defaults format to 'full' when omitted (#507)", async () => {
    let recallBody: Record<string, unknown> | undefined;
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/search")) {
        recallBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify({ mode: "full", facts: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    await handleToolCall("memory_recall", { query: "x" });
    expect(recallBody?.["format"]).toBe("full");
    expect(recallBody).not.toHaveProperty("token_budget");
  });

  it("proxies memory_governance_delete to the DELETE REST endpoint", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    installFetch((url, init) => {
      const method = init?.method || "GET";
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/agentmemory/governance/memories") && method === "DELETE") {
        return new Response(JSON.stringify({ success: true, deleted: 2 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("method not allowed", { status: 405, statusText: "Method Not Allowed" });
    });

    const res = await handleToolCall("memory_governance_delete", {
      memoryIds: "mem_1, mem_2",
      reason: "cleanup stale test data",
    });

    expect(JSON.parse(res.content[0].text)).toEqual({ success: true, deleted: 2 });
    expect(calls).toEqual([
      {
        url: `${BASE}/agentmemory/governance/memories`,
        method: "DELETE",
        body: {
          memoryIds: ["mem_1", "mem_2"],
          reason: "cleanup stale test data",
        },
      },
    ]);
  });

  it("proxies memory_delete source selectors to the REST endpoint", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    installFetch((url, init) => {
      const method = init?.method || "GET";
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (url.endsWith("/agentmemory/memory/delete") && method === "POST") {
        return new Response(
          JSON.stringify({ success: true, deleted: 2, dryRun: true }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("method not allowed", { status: 405, statusText: "Method Not Allowed" });
    });

    const res = await handleToolCall("memory_delete", {
      sourceObservationId: "obs_1",
      sourceHash: "hash_1",
      sourceUri: "file:///repo/source.md",
      project: "billing",
      agentId: "codex-a",
      mode: "hard",
      dryRun: "true",
      reason: "source removed upstream",
    });

    expect(JSON.parse(res.content[0].text)).toEqual({
      success: true,
      deleted: 2,
      dryRun: true,
    });
    expect(calls).toEqual([
      {
        url: `${BASE}/agentmemory/memory/delete`,
        method: "POST",
        body: {
          sourceObservationId: "obs_1",
          sourceHash: "hash_1",
          sourceUri: "file:///repo/source.md",
          project: "billing",
          agentId: "codex-a",
          mode: "hard",
          reason: "source removed upstream",
          dryRun: true,
        },
      },
    ]);
  });

  it("surfaces a 4xx memory_delete rejection and does NOT tombstone the local copy", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    installFetch((url, init) => {
      const method = init?.method || "GET";
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      calls.push({ url, method });
      if (url.endsWith("/agentmemory/memory/delete")) {
        return new Response(
          JSON.stringify({ success: false, error: "memory is governance-locked" }),
          { status: 403, statusText: "Forbidden", headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    // Seed a local copy that the buggy fallback would silently tombstone.
    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:memories", "mem_local_1", {
      id: "mem_local_1",
      content: "do not tombstone me",
      lifecycleState: "active",
    });

    await expect(
      handleToolCall("memory_delete", { memoryId: "mem_local_1" }, localKv),
    ).rejects.toThrow(/403/);

    // Server was consulted exactly once, and no local mutation happened.
    expect(calls.filter((c) => c.url.endsWith("/agentmemory/memory/delete"))).toHaveLength(1);
    const stored = await localKv.get<Record<string, unknown>>("mem:memories", "mem_local_1");
    expect(stored).not.toBeNull();
    expect(stored?.["lifecycleState"]).toBe("active");
    expect(stored?.["deletedAt"]).toBeUndefined();
    const tombstones = (await localKv.list<Record<string, unknown>>("mem:memories")).filter(
      (m) => m["lifecycleState"] === "tombstoned",
    );
    expect(tombstones).toHaveLength(0);
  });

  it("surfaces a 5xx memory_delete failure rather than mutating local state", async () => {
    installFetch((url, init) => {
      const method = init?.method || "GET";
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/memory/delete") && method === "POST") {
        return new Response("boom", { status: 500, statusText: "Internal Server Error" });
      }
      return new Response("not found", { status: 404 });
    });

    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:memories", "mem_local_2", {
      id: "mem_local_2",
      content: "survive the 5xx",
      lifecycleState: "active",
    });

    await expect(
      handleToolCall("memory_delete", { memoryId: "mem_local_2" }, localKv),
    ).rejects.toThrow(/500/);

    const stored = await localKv.get<Record<string, unknown>>("mem:memories", "mem_local_2");
    expect(stored?.["lifecycleState"]).toBe("active");
  });

  it("surfaces a 4xx read rejection instead of serving stale local results", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      if (url.endsWith("/agentmemory/search")) {
        return new Response(
          JSON.stringify({ error: "project quota exceeded" }),
          { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const localKv = new InMemoryKV(undefined);
    await localKv.set("mem:memories", "mem_local_3", {
      id: "mem_local_3",
      content: "stale local hit",
      lifecycleState: "active",
    });

    await expect(
      handleToolCall("memory_recall", { query: "stale" }, localKv),
    ).rejects.toThrow(/400/);
  });

  it("local fallback returns the same shape as proxy for memory_smart_search", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "shape-check entry" }, localKv);
    const res = await handleToolCall("memory_smart_search", { query: "shape" }, localKv);
    const body = JSON.parse(res.content[0].text);
    expect(body).toHaveProperty("mode", "compact");
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results[0].content).toBe("shape-check entry");
  });

  it("local memory_search_explain honors and reports cwd filters", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall(
      "memory_save",
      { content: "cwd-only shape", cwd: "/repo/billing" },
      localKv,
    );

    const res = await handleToolCall(
      "memory_search_explain",
      { query: "cwd-only", cwd: "/repo/other" },
      localKv,
    );
    const body = JSON.parse(res.content[0].text);

    expect(body.results).toEqual([]);
    expect(body.explain.queryPlan.filters.cwd).toBe("/repo/other");
  });

  it("local fallback resolves rules from an explicit workspace root", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    const res = await handleToolCall("memory_rules_resolve", {
      workspaceRoot: root,
      includeContent: false,
    }, new InMemoryKV(undefined));
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.fallback).toBe(true);
    // The trusted same-user CLI fallback resolves the user's requested root even
    // though it is outside process.cwd() — it must not be rejected as a
    // forbidden_root the way the network surface would reject it.
    expect(body.workspaceRoot).toBe(resolve(root));
    expect(body.rules[0].relativePath).toBe("AGENTS.md");
    expect(body.rules[0]).not.toHaveProperty("content");
  });

  it("local fallback honors caller includeContent for the requested root (allowCallerOptions)", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    const res = await handleToolCall(
      "memory_rules_resolve",
      { workspaceRoot: root, includeContent: true },
      new InMemoryKV(undefined),
    );
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.includeContent).toBe(true);
    // includeContent is honored locally (allowCallerOptions:true), so the rule
    // content is returned rather than stripped to metadata-only.
    expect(body.rules[0].relativePath).toBe("AGENTS.md");
    expect(body.rules[0].content).toContain("codex instructions");
  });

  it("attaches Bearer token on the proxied tool request, not just the probe", async () => {
    process.env["AGENTMEMORY_SECRET"] = "s3cret";
    const authByPath = new Map<string, string | undefined>();
    installFetch((url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.[
        "authorization"
      ];
      const u = new URL(url);
      authByPath.set(u.pathname, auth);
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    });
    await handleToolCall("memory_sessions", {});
    expect(authByPath.get("/agentmemory/livez")).toBe("Bearer s3cret");
    expect(authByPath.get("/agentmemory/sessions")).toBe("Bearer s3cret");
  });

  it("falls back to local InMemoryKV when server is unreachable", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await handleToolCall("memory_save", { content: "local only" }, localKv);
    const recall = await handleToolCall("memory_recall", { query: "local" }, localKv);
    const out = JSON.parse(recall.content[0].text);
    expect(out.mode).toBe("compact");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].content).toBe("local only");
  });

  it("invalidates the handle on a 5xx proxy failure, so the next call re-probes", async () => {
    let probeCount = 0;
    let serverUp = true;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeCount++;
        return serverUp ? new Response("ok", { status: 200 }) : new Response("", { status: 500 });
      }
      return new Response("boom", { status: 500, statusText: "Internal Server Error" });
    });
    const localKv = new InMemoryKV(undefined);
    // memory_recall is read-only, so a 5xx degrades to a local read (no throw)
    // while still invalidating the handle.
    await handleToolCall("memory_recall", { query: "first fallback" }, localKv);
    expect(probeCount).toBe(1);
    serverUp = false;
    await handleToolCall("memory_recall", { query: "second fallback" }, localKv);
    expect(probeCount).toBe(2);
  });

  it("forwards non-essential tools to /agentmemory/mcp/call (#234)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    installFetch((url, init) => {
      if (url.endsWith("/agentmemory/livez")) {
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/agentmemory/mcp/call")) {
        const body = init?.body ? JSON.parse(init.body as string) : null;
        calls.push({ url, body });
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({ saved: "lesson_xyz" }),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const res = await handleToolCall("memory_lesson_save", {
      title: "Always pin lockfiles",
      content: "...",
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.saved).toBe("lesson_xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      name: "memory_lesson_save",
      arguments: { title: "Always pin lockfiles", content: "..." },
    });
  });

  it("rejects non-essential tools when no server is reachable (#234)", async () => {
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_lesson_save", { title: "x" }, localKv),
    ).rejects.toThrow(/Unknown tool: memory_lesson_save/);
  });

  it("does not retry local after a validation error", async () => {
    const fetchFn = installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) return new Response("ok", { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const localKv = new InMemoryKV(undefined);
    await expect(
      handleToolCall("memory_save", { content: "" }, localKv),
    ).rejects.toThrow("content is required");
    const remembersCalled = fetchFn.mock.calls.some(([url]) =>
      String(url).endsWith("/agentmemory/remember"),
    );
    expect(remembersCalled).toBe(false);
  });

  it("AGENTMEMORY_FORCE_PROXY=1 skips livez probe and trusts the server", async () => {
    process.env["AGENTMEMORY_FORCE_PROXY"] = "1";
    const calls: string[] = [];
    installFetch((url, init) => {
      calls.push(url);
      if (url.endsWith("/agentmemory/livez")) {
        throw new Error("probe should be skipped");
      }
      if (url.endsWith("/agentmemory/remember")) {
        return new Response(JSON.stringify({ id: "m-1", action: "created" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      await handleToolCall("memory_save", { content: "force-proxy" });
      expect(calls.some((u) => u.endsWith("/agentmemory/livez"))).toBe(false);
      expect(calls.some((u) => u.endsWith("/agentmemory/remember"))).toBe(true);
    } finally {
      delete process.env["AGENTMEMORY_FORCE_PROXY"];
    }
  });

  it("logs probe failure to stderr so sandboxed clients can diagnose silently dropped tools", async () => {
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        throw new Error("ECONNREFUSED 127.0.0.1:3111");
      }
      return new Response("not found", { status: 404 });
    });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const localKv = new InMemoryKV(undefined);
      await handleToolCall("memory_save", { content: "diag" }, localKv);
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = writes.join("");
    expect(joined).toMatch(/livez probe .* failed/);
    expect(joined).toMatch(/AGENTMEMORY_FORCE_PROXY/);
  });

  it("local fallback tools/list returns the implemented fallback tools regardless of AGENTMEMORY_TOOLS env (#234)", async () => {
    const { handleToolsList } = await import("../src/mcp/standalone.js");
    installFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    delete process.env["AGENTMEMORY_TOOLS"];
    const before = await handleToolsList();
    const beforeTools = before.tools as Array<{ name: string }>;
    expect(beforeTools.map((t) => t.name).sort()).toEqual([
      "memory_archive",
      "memory_audit",
      "memory_create",
      "memory_delete",
      "memory_expire",
      "memory_export",
      "memory_governance_delete",
      "memory_history",
      "memory_inspect",
      "memory_ledger",
      "memory_recall",
      "memory_restore",
      "memory_review_queue",
      "memory_rules_resolve",
      "memory_save",
      "memory_search_explain",
      "memory_sessions",
      "memory_smart_search",
      "memory_update",
    ]);
    expect(beforeTools).toHaveLength(19);

    resetHandleForTests();
    process.env["AGENTMEMORY_TOOLS"] = "core";
    const core = await handleToolsList();
    expect((core.tools as unknown[]).length).toBe(19);
    delete process.env["AGENTMEMORY_TOOLS"];
  });

  it("AGENTMEMORY_PROBE_TIMEOUT_MS overrides the default probe timeout", async () => {
    process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"] = "50";
    let probeStarted = 0;
    installFetch((url) => {
      if (url.endsWith("/agentmemory/livez")) {
        probeStarted++;
        return new Response("ok", { status: 200 });
      }
      // The probe reports the server is up, so a state-changing tool must reach
      // the server. Return a successful remember response — a 4xx here would now
      // (correctly) surface rather than absorb into a local mutation.
      if (url.endsWith("/agentmemory/remember")) {
        return new Response(JSON.stringify({ id: "m-1", action: "created" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      const localKv = new InMemoryKV(undefined);
      await handleToolCall("memory_save", { content: "timeout-knob" }, localKv);
      expect(probeStarted).toBe(1);
    } finally {
      delete process.env["AGENTMEMORY_PROBE_TIMEOUT_MS"];
    }
  });
});
