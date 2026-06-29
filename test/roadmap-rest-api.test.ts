import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("roadmap REST endpoint whitelists", () => {
  it("registers proposal, sync, OTEL, and deletion propagation routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const paths = sdk.registerTrigger.mock.calls.map(
      ([trigger]: [{ config?: { api_path?: string } }]) => trigger.config?.api_path,
    );

    expect(paths).toContain("/agentmemory/memory-proposals/create");
    expect(paths).toContain("/agentmemory/memory-proposals/apply");
    expect(paths).toContain("/agentmemory/sync/plan");
    expect(paths).toContain("/agentmemory/sync/local/apply");
    expect(paths).toContain("/agentmemory/sync/status");
    expect(paths).toContain("/agentmemory/lineage/otel/export");
    expect(paths).toContain("/agentmemory/lineage/otel/import");
    expect(paths).toContain("/agentmemory/governance/deletion-propagation");
    expect(paths).toContain("/agentmemory/memory/today");
    expect(paths).toContain("/agentmemory/memory/unlinked-mentions");
  });

  it("registers memory inspect POST and GET REST parity routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const routes = sdk.registerTrigger.mock.calls.map(
      ([trigger]: [{ config?: { api_path?: string; http_method?: string } }]) => ({
        path: trigger.config?.api_path,
        method: trigger.config?.http_method,
      }),
    );

    expect(routes).toContainEqual({
      path: "/agentmemory/memory/inspect",
      method: "POST",
    });
    expect(routes).toContainEqual({
      path: "/agentmemory/memory/inspect",
      method: "GET",
    });
  });

  it("whitelists memory inspect IDs from POST bodies and GET query params", async () => {
    const sdk = mockSdk();
    const seen: Record<string, unknown>[] = [];
    sdk.registerFunction("mem::memory-inspect", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true, memory: { id: (input as { memoryId: string }).memoryId } };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const post = (await sdk.trigger("api::memory-inspect", {
      headers: {},
      body: { memoryId: "mem_post", ignored: "drop" },
    })) as { status_code: number };
    const get = (await sdk.trigger("api::memory-inspect", {
      headers: {},
      query_params: { memoryId: "mem_get", ignored: "drop" },
    })) as { status_code: number };
    const missing = (await sdk.trigger("api::memory-inspect", {
      headers: {},
      body: { ignored: "drop" },
    })) as { status_code: number; body: { error: string } };

    expect(post.status_code).toBe(200);
    expect(get.status_code).toBe(200);
    expect(missing.status_code).toBe(400);
    expect(missing.body.error).toBe("memoryId is required");
    expect(seen).toEqual([{ memoryId: "mem_post" }, { memoryId: "mem_get" }]);
  });

  it("whitelists memory proposal payload fields", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::memory-proposal-create", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = (await sdk.trigger("api::memory-proposal-create", {
      headers: {},
      body: {
        project: "billing",
        action: "create",
        change: { content: "approved" },
        permissions: ["project:write"],
        ignored: "drop",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(payload).toEqual({
      project: "billing",
      action: "create",
      change: { content: "approved" },
      permissions: ["project:write"],
    });
  });

  it("whitelists sync and OTEL payload fields", async () => {
    const sdk = mockSdk();
    const seen: Record<string, unknown>[] = [];
    sdk.registerFunction("mem::sync-plan", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    sdk.registerFunction("mem::sync-local-apply", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    sdk.registerFunction("mem::otel-lineage-import", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    await sdk.trigger("api::sync-plan", {
      headers: {},
      body: { peerId: "peer_1", direction: "push", scopes: ["memories"], raw: "drop" },
    });
    await sdk.trigger("api::sync-local-apply", {
      headers: {},
      body: {
        peerId: "peer_1",
        workspaceId: "workspace_1",
        approved: true,
        conflictPolicy: "merge",
        exportData: { memories: [{ id: "mem_1" }] },
        raw: "drop",
      },
    });
    await sdk.trigger("api::otel-lineage-import", {
      headers: {},
      body: { spans: [{ traceId: "a" }], source: "test", payload: "drop" },
    });

    expect(seen).toEqual([
      { peerId: "peer_1", direction: "push", scopes: ["memories"] },
      {
        peerId: "peer_1",
        workspaceId: "workspace_1",
        approved: true,
        conflictPolicy: "merge",
        exportData: { memories: [{ id: "mem_1" }] },
      },
      { spans: [{ traceId: "a" }], source: "test" },
    ]);
  });

  it("rejects invalid whitelisted roadmap payload field types before dispatch", async () => {
    const sdk = mockSdk();
    let calls = 0;
    sdk.registerFunction("mem::sync-plan", async () => {
      calls++;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = (await sdk.trigger("api::sync-plan", {
      headers: {},
      body: { peerId: "peer_1", scopes: "memories" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toBe("scopes must be an array of strings");
    expect(calls).toBe(0);
  });

  it("whitelists deletion propagation payload fields and rejects non-object bodies", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::deletion-propagation-report", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = (await sdk.trigger("api::deletion-propagation-report", {
      headers: {},
      body: {
        memoryId: "mem_1",
        sourceObservationId: "obs_1",
        dryRun: true,
        apply: false,
        content: "drop",
      },
    })) as { status_code: number };
    const invalid = (await sdk.trigger("api::deletion-propagation-report", {
      headers: {},
      body: "bad",
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(200);
    expect(payload).toEqual({
      memoryId: "mem_1",
      sourceObservationId: "obs_1",
      dryRun: true,
      apply: false,
    });
    expect(invalid.status_code).toBe(400);
    expect(invalid.body.error).toBe("body must be an object");
  });

  it("whitelists today-in-memory and unlinked mention query fields", async () => {
    const sdk = mockSdk();
    const seen: Record<string, unknown>[] = [];
    sdk.registerFunction("mem::today-in-memory", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    sdk.registerFunction("mem::memory-unlinked-mentions", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    await sdk.trigger("api::today-in-memory", {
      headers: {},
      query_params: {
        project: "billing",
        agentId: "codex",
        sessionId: "ses_1",
        date: "2026-06-29",
        limit: "7",
        ignored: "drop",
      },
    });
    await sdk.trigger("api::memory-unlinked-mentions", {
      headers: {},
      query_params: {
        project: "billing",
        since: "2026-06-29T00:00:00Z",
        until: "2026-06-30T00:00:00Z",
        limit: "11",
        minMentions: "2",
        ignored: "drop",
      },
    });

    expect(seen).toEqual([
      {
        project: "billing",
        agentId: "codex",
        sessionId: "ses_1",
        date: "2026-06-29",
        since: undefined,
        until: undefined,
        limit: 7,
      },
      {
        project: "billing",
        agentId: undefined,
        sessionId: undefined,
        date: undefined,
        since: "2026-06-29T00:00:00Z",
        until: "2026-06-30T00:00:00Z",
        limit: 11,
        minMentions: 2,
      },
    ]);
  });

  it("rejects invalid numeric memory workbench query params", async () => {
    const sdk = mockSdk();
    sdk.registerFunction("mem::today-in-memory", async () => ({ success: true }));
    sdk.registerFunction("mem::memory-unlinked-mentions", async () => ({ success: true }));
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const badLimit = (await sdk.trigger("api::today-in-memory", {
      headers: {},
      query_params: { limit: "0" },
    })) as { status_code: number; body: { error: string } };
    const badMinMentions = (await sdk.trigger("api::memory-unlinked-mentions", {
      headers: {},
      query_params: { minMentions: "many" },
    })) as { status_code: number; body: { error: string } };

    expect(badLimit.status_code).toBe(400);
    expect(badLimit.body.error).toBe("invalid numeric parameter: limit");
    expect(badMinMentions.status_code).toBe(400);
    expect(badMinMentions.body.error).toBe("invalid numeric parameter: minMentions");
  });
});
