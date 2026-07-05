import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const TEST_SECRET = "test-secret";
const AUTH_HEADERS = { authorization: `Bearer ${TEST_SECRET}` };

describe("roadmap REST endpoint whitelists", () => {
  it("registers proposal, sync, OTEL, and deletion propagation routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);
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
    expect(paths).toContain("/agentmemory/handoffs/status");
    // item 6 (sync recovery) + item 3 (audit-chain exposure)
    expect(paths).toContain("/agentmemory/sync/peer/set-status");
    expect(paths).toContain("/agentmemory/audit/chain");
    expect(paths).toContain("/agentmemory/audit/chain/verify");
  });

  it("registers the audit-chain GET read and verify POST routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);
    const routes = sdk.registerTrigger.mock.calls.map(
      ([trigger]: [{ config?: { api_path?: string; http_method?: string } }]) => ({
        path: trigger.config?.api_path,
        method: trigger.config?.http_method,
      }),
    );

    expect(routes).toContainEqual({
      path: "/agentmemory/audit/chain",
      method: "GET",
    });
    expect(routes).toContainEqual({
      path: "/agentmemory/audit/chain/verify",
      method: "POST",
    });
    expect(routes).toContainEqual({
      path: "/agentmemory/sync/peer/set-status",
      method: "POST",
    });
  });

  it("registers memory inspect POST and GET REST parity routes", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const post = (await sdk.trigger("api::memory-inspect", {
      headers: AUTH_HEADERS,
      body: { memoryId: "mem_post", ignored: "drop" },
    })) as { status_code: number };
    const get = (await sdk.trigger("api::memory-inspect", {
      headers: AUTH_HEADERS,
      query_params: { memoryId: "mem_get", ignored: "drop" },
    })) as { status_code: number };
    const missing = (await sdk.trigger("api::memory-inspect", {
      headers: AUTH_HEADERS,
      body: { ignored: "drop" },
    })) as { status_code: number; body: { error: string } };

    expect(post.status_code).toBe(200);
    expect(get.status_code).toBe(200);
    expect(missing.status_code).toBe(400);
    expect(missing.body.error).toBe("memoryId is required");
    expect(seen).toEqual([{ memoryId: "mem_post" }, { memoryId: "mem_get" }]);
  });

  it("strips body authorization and resolves the principal server-side", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::memory-proposal-create", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const response = (await sdk.trigger("api::memory-proposal-create", {
      headers: { ...AUTH_HEADERS, "x-actor-id": "alice" },
      body: {
        project: "billing",
        action: "create",
        change: { content: "approved" },
        // Forged authorization fields must be stripped and must NOT widen the
        // principal: the server grants the fixed trusted-operator set only.
        permissions: ["governance:delete", "*"],
        roles: ["admin"],
        roleGrants: { admin: true },
        teamPolicy: { allowSelfApproval: true },
        auth: { sub: "attacker" },
        access: "all",
        actor: { id: "attacker" },
        requestContext: { trusted: true },
        ignored: "drop",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    // Only proposal-content fields survive; the principal is injected by the
    // server, never derived from the body.
    expect(payload).toEqual({
      project: "billing",
      action: "create",
      change: { content: "approved" },
      principal: {
        actorId: "alice",
        permissions: ["project:read", "project:write", "governance:delete"],
        teamPolicy: { allowSelfApproval: false },
      },
    });
    // The forged "*" wildcard never reaches the function.
    expect(
      (payload?.principal as { permissions: string[] }).permissions,
    ).not.toContain("*");
  });

  it("falls back to body.actorId then 'operator' for the audit identity label", async () => {
    const sdk = mockSdk();
    const seen: Record<string, unknown>[] = [];
    sdk.registerFunction("mem::memory-proposal-approve", async (input) => {
      seen.push(input as Record<string, unknown>);
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    // No x-actor-id header: actorId falls back to body.actorId (identity label
    // only — carries no authorization).
    await sdk.trigger("api::memory-proposal-approve", {
      headers: AUTH_HEADERS,
      body: { proposalId: "prop_1", actorId: "bob" },
    });
    // No header and no body.actorId: defaults to "operator".
    await sdk.trigger("api::memory-proposal-approve", {
      headers: AUTH_HEADERS,
      body: { proposalId: "prop_2" },
    });

    expect((seen[0]?.principal as { actorId: string }).actorId).toBe("bob");
    expect((seen[1]?.principal as { actorId: string }).actorId).toBe(
      "operator",
    );
    // body.actorId is an identity label, not a whitelisted content field, so it
    // is not forwarded as a top-level payload key.
    expect(seen[0]).not.toHaveProperty("actorId");
  });

  it("honors AGENTMEMORY_ALLOW_SELF_APPROVAL for the resolved teamPolicy", async () => {
    const prev = process.env.AGENTMEMORY_ALLOW_SELF_APPROVAL;
    process.env.AGENTMEMORY_ALLOW_SELF_APPROVAL = "true";
    try {
      const sdk = mockSdk();
      let payload: Record<string, unknown> | undefined;
      sdk.registerFunction("mem::memory-proposal-approve", async (input) => {
        payload = input as Record<string, unknown>;
        return { success: true };
      });
      registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

      await sdk.trigger("api::memory-proposal-approve", {
        headers: AUTH_HEADERS,
        body: { proposalId: "prop_1" },
      });

      expect(
        (payload?.principal as { teamPolicy: { allowSelfApproval: boolean } })
          .teamPolicy.allowSelfApproval,
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGENTMEMORY_ALLOW_SELF_APPROVAL;
      else process.env.AGENTMEMORY_ALLOW_SELF_APPROVAL = prev;
    }
  });

  it("whitelists handoff status update payload fields", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::handoff-update", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const response = (await sdk.trigger("api::handoff-update", {
      headers: AUTH_HEADERS,
      body: {
        signalId: "sig_1",
        agentId: "codex",
        status: "accepted",
        reason: "taking over",
        metadata: { lane: "lineage" },
        rawPayload: "drop",
      },
    })) as { status_code: number };
    const invalid = (await sdk.trigger("api::handoff-update", {
      headers: AUTH_HEADERS,
      body: { signalId: ["sig_1"], agentId: "codex", status: "accepted" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(200);
    expect(payload).toEqual({
      signalId: "sig_1",
      agentId: "codex",
      status: "accepted",
      reason: "taking over",
      metadata: { lane: "lineage" },
    });
    expect(invalid.status_code).toBe(400);
    expect(invalid.body.error).toBe("signalId must be a string");
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    await sdk.trigger("api::sync-plan", {
      headers: AUTH_HEADERS,
      body: { peerId: "peer_1", direction: "push", scopes: ["memories"], raw: "drop" },
    });
    await sdk.trigger("api::sync-local-apply", {
      headers: AUTH_HEADERS,
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
      headers: AUTH_HEADERS,
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const response = (await sdk.trigger("api::sync-plan", {
      headers: AUTH_HEADERS,
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const response = (await sdk.trigger("api::deletion-propagation-report", {
      headers: AUTH_HEADERS,
      body: {
        memoryId: "mem_1",
        sourceObservationId: "obs_1",
        dryRun: true,
        apply: false,
        content: "drop",
      },
    })) as { status_code: number };
    const invalid = (await sdk.trigger("api::deletion-propagation-report", {
      headers: AUTH_HEADERS,
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    await sdk.trigger("api::today-in-memory", {
      headers: AUTH_HEADERS,
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
      headers: AUTH_HEADERS,
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
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const badLimit = (await sdk.trigger("api::today-in-memory", {
      headers: AUTH_HEADERS,
      query_params: { limit: "0" },
    })) as { status_code: number; body: { error: string } };
    const badMinMentions = (await sdk.trigger("api::memory-unlinked-mentions", {
      headers: AUTH_HEADERS,
      query_params: { minMentions: "many" },
    })) as { status_code: number; body: { error: string } };

    expect(badLimit.status_code).toBe(400);
    expect(badLimit.body.error).toBe("invalid numeric parameter: limit");
    expect(badMinMentions.status_code).toBe(400);
    expect(badMinMentions.body.error).toBe("invalid numeric parameter: minMentions");
  });

  it("whitelists sync peer set-status payload to peerId + enabled (item 6)", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::sync-peer-set-status", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const ok = (await sdk.trigger("api::sync-peer-set-status", {
      headers: AUTH_HEADERS,
      body: { peerId: "peer_1", enabled: false, status: "drop", reason: "drop" },
    })) as { status_code: number };
    const badEnabled = (await sdk.trigger("api::sync-peer-set-status", {
      headers: AUTH_HEADERS,
      body: { peerId: "peer_1", enabled: "false" },
    })) as { status_code: number; body: { error: string } };

    expect(ok.status_code).toBe(200);
    expect(payload).toEqual({ peerId: "peer_1", enabled: false });
    expect(badEnabled.status_code).toBe(400);
    expect(badEnabled.body.error).toBe("enabled must be a boolean");
  });

  it("forwards whitelisted audit-chain read filters from GET query params (item 3)", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::audit-chain", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true, headHash: "abc", entries: [] };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const response = (await sdk.trigger("api::audit-chain", {
      headers: AUTH_HEADERS,
      query_params: {
        offset: "0",
        limit: "25",
        includeLinks: "true",
        operation: "memory.write",
        functionId: "mem::remember",
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        secret: "drop",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    // Query params arrive as strings; mem::audit-chain coerces them. The REST
    // layer only forwards whitelisted keys and drops "secret".
    expect(payload).toEqual({
      offset: "0",
      limit: "25",
      includeLinks: "true",
      operation: "memory.write",
      functionId: "mem::remember",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
  });

  it("whitelists audit-chain verify anchors and rejects bad field types (item 3)", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::audit-chain-verify", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true, checked: {}, mismatches: [] };
    });
    registerApiTriggers(sdk as never, mockKV() as never, TEST_SECRET);

    const ok = (await sdk.trigger("api::audit-chain-verify", {
      headers: AUTH_HEADERS,
      body: {
        expectedHeadHash: "head_hash",
        expectedCount: 12,
        expectedFirstEntryId: "first",
        expectedLastEntryId: "last",
        chain: [{ entryHash: "h1" }],
        allowUnanchored: false,
        offset: 0,
        limit: 50,
        includeLinks: true,
        operation: "memory.write",
        functionId: "mem::remember",
        dateFrom: "2026-06-01",
        dateTo: "2026-06-30",
        secret: "drop",
      },
    })) as { status_code: number };
    const badCount = (await sdk.trigger("api::audit-chain-verify", {
      headers: AUTH_HEADERS,
      body: { expectedCount: "twelve" },
    })) as { status_code: number; body: { error: string } };
    const badChain = (await sdk.trigger("api::audit-chain-verify", {
      headers: AUTH_HEADERS,
      body: { chain: "not-an-array" },
    })) as { status_code: number; body: { error: string } };

    expect(ok.status_code).toBe(200);
    expect(payload).toEqual({
      expectedHeadHash: "head_hash",
      expectedCount: 12,
      expectedFirstEntryId: "first",
      expectedLastEntryId: "last",
      chain: [{ entryHash: "h1" }],
      allowUnanchored: false,
      offset: 0,
      limit: 50,
      includeLinks: true,
      operation: "memory.write",
      functionId: "mem::remember",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    expect(badCount.status_code).toBe(400);
    expect(badCount.body.error).toBe("expectedCount must be an integer");
    expect(badChain.status_code).toBe(400);
    expect(badChain.body.error).toBe("chain must be an array");
  });
});
