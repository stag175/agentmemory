import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerMcpEndpoints } from "../src/mcp/server.js";
import type { Session, SessionSummary, Memory } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) {
        return triggerOverrides.get(id)!(payload);
      }
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
    getFunction: (id: string) => functions.get(id),
  };
}

function makeReq(body?: unknown, headers?: Record<string, string>) {
  return {
    body,
    headers: headers || {},
    query_params: {},
  };
}

describe("MCP Resources", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerMcpEndpoints(sdk as never, kv as never);
  });

  it("lists 6 resources", async () => {
    const fn = sdk.getFunction("mcp::resources::list")!;
    const result = (await fn(makeReq())) as {
      status_code: number;
      body: { resources: unknown[] };
    };

    expect(result.status_code).toBe(200);
    expect(result.body.resources).toHaveLength(6);
  });

  it("reads agentmemory://status", async () => {
    const session: Session = {
      id: "ses_1",
      project: "/test",
      cwd: "/test",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 5,
    };
    await kv.set("mem:sessions", "ses_1", session);

    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(makeReq({ uri: "agentmemory://status" }))) as {
      status_code: number;
      body: { contents: Array<{ text: string }> };
    };

    expect(result.status_code).toBe(200);
    const data = JSON.parse(result.body.contents[0].text);
    expect(data.sessionCount).toBe(1);
    expect(data.encryption).toMatchObject({
      status: "fail",
      storageWired: false,
      remoteMode: false,
    });
    expect(data.encryption.missingFields).toContain("storage.encryptionWired");
  });

  it("reads agentmemory://project/{name}/profile", async () => {
    sdk.overrideTrigger("mem::profile", async () => ({
      project: "/myapp",
      topConcepts: [{ concept: "auth", frequency: 5 }],
    }));

    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({ uri: "agentmemory://project/myapp/profile" }),
    )) as {
      status_code: number;
      body: { contents: Array<{ text: string }> };
    };

    expect(result.status_code).toBe(200);
    const data = JSON.parse(result.body.contents[0].text);
    expect(data.project).toBe("/myapp");
  });

  it("reads agentmemory://project/{name}/recent with sorted summaries", async () => {
    const summaries: SessionSummary[] = [
      {
        sessionId: "ses_1",
        project: "myapp",
        createdAt: "2026-01-01T00:00:00Z",
        title: "Old session",
        narrative: "old",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
      },
      {
        sessionId: "ses_2",
        project: "myapp",
        createdAt: "2026-02-01T00:00:00Z",
        title: "New session",
        narrative: "new",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 2,
      },
      {
        sessionId: "ses_3",
        project: "other",
        createdAt: "2026-02-15T00:00:00Z",
        title: "Other project",
        narrative: "other",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 3,
      },
    ];
    for (const s of summaries) {
      await kv.set("mem:summaries", s.sessionId, s);
    }

    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({ uri: "agentmemory://project/myapp/recent" }),
    )) as {
      status_code: number;
      body: { contents: Array<{ text: string }> };
    };

    expect(result.status_code).toBe(200);
    const data = JSON.parse(result.body.contents[0].text);
    expect(data).toHaveLength(2);
    expect(data[0].sessionId).toBe("ses_2");
  });

  it("reads agentmemory://memories/latest", async () => {
    const memories: Memory[] = [
      {
        id: "mem_1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        type: "pattern",
        title: "Latest pattern",
        content: "content",
        concepts: [],
        files: [],
        sessionIds: [],
        strength: 5,
        version: 1,
        isLatest: true,
      },
      {
        id: "mem_2",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-15T00:00:00Z",
        type: "bug",
        title: "Old bug",
        content: "content",
        concepts: [],
        files: [],
        sessionIds: [],
        strength: 3,
        version: 2,
        isLatest: false,
      },
    ];
    for (const m of memories) {
      await kv.set("mem:memories", m.id, m);
    }

    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({ uri: "agentmemory://memories/latest" }),
    )) as {
      status_code: number;
      body: { contents: Array<{ text: string }> };
    };

    expect(result.status_code).toBe(200);
    const data = JSON.parse(result.body.contents[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("mem_1");
    expect(data[0].title).toBe("Latest pattern");
  });

  it("returns 404 for unknown URI", async () => {
    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({ uri: "agentmemory://nonexistent" }),
    )) as { status_code: number };

    expect(result.status_code).toBe(404);
  });

  it("returns 401 when auth fails", async () => {
    const authedSdk = mockSdk();
    const authedKv = mockKV();
    registerMcpEndpoints(authedSdk as never, authedKv as never, "test-secret");

    const fn = authedSdk.getFunction("mcp::resources::list")!;
    const result = (await fn(makeReq())) as { status_code: number };
    expect(result.status_code).toBe(401);

    const authedResult = (await fn(
      makeReq(undefined, { authorization: "Bearer test-secret" }),
    )) as { status_code: number };
    expect(authedResult.status_code).toBe(200);
  });

  it("forwards cwd hard filters from smart-search MCP tools", async () => {
    const seen: Record<string, unknown>[] = [];
    sdk.overrideTrigger("mem::smart-search", async (payload: unknown) => {
      seen.push(payload as Record<string, unknown>);
      return { results: [] };
    });

    const fn = sdk.getFunction("mcp::tools::call")!;
    await fn(
      makeReq({
        name: "memory_smart_search",
        arguments: { query: "auth bug", cwd: "C:\\repo\\billing" },
      }),
    );
    await fn(
      makeReq({
        name: "memory_search_explain",
        arguments: { query: "auth bug", cwd: "/repo/billing" },
      }),
    );

    expect(seen[0]).toMatchObject({ cwd: "C:\\repo\\billing" });
    expect(seen[1]).toMatchObject({ cwd: "/repo/billing", explain: true });
  });

  it("dispatches the governance/control-plane tools to their iii functions", async () => {
    const calls: Array<{ id: string; payload: Record<string, unknown> }> = [];
    for (const id of [
      "mem::audit-chain",
      "mem::audit-chain-verify",
      "mem::sync-peer-set-status",
      "mem::agent-event-prune",
    ]) {
      sdk.overrideTrigger(id, async (payload: unknown) => {
        calls.push({ id, payload: payload as Record<string, unknown> });
        return { success: true, id };
      });
    }
    const fn = sdk.getFunction("mcp::tools::call")!;

    const chain = (await fn(
      makeReq({
        name: "memory_audit_chain",
        arguments: { limit: 50, includeLinks: false, operation: "delete" },
      }),
    )) as { status_code: number };
    expect(chain.status_code).toBe(200);

    const verify = (await fn(
      makeReq({
        name: "memory_audit_chain_verify",
        arguments: { expectedCount: 3, allowUnanchored: true },
      }),
    )) as { status_code: number };
    expect(verify.status_code).toBe(200);

    const peer = (await fn(
      makeReq({
        name: "memory_sync_peer_set_status",
        arguments: { peerId: "peer_1", enabled: false },
      }),
    )) as { status_code: number };
    expect(peer.status_code).toBe(200);

    const prune = (await fn(
      makeReq({
        name: "memory_agent_event_prune",
        arguments: { maxAgeDays: 30, dryRun: true },
      }),
    )) as { status_code: number };
    expect(prune.status_code).toBe(200);

    expect(calls.map((c) => c.id)).toEqual([
      "mem::audit-chain",
      "mem::audit-chain-verify",
      "mem::sync-peer-set-status",
      "mem::agent-event-prune",
    ]);
    expect(calls[0].payload).toMatchObject({ limit: 50, includeLinks: false, operation: "delete" });
    expect(calls[2].payload).toEqual({ peerId: "peer_1", enabled: false });
    expect(calls[3].payload).toEqual({ maxAgeDays: 30, dryRun: true });
  });

  it("memory_sync_peer_set_status requires peerId and validates enabled", async () => {
    const fn = sdk.getFunction("mcp::tools::call")!;
    const missing = (await fn(
      makeReq({ name: "memory_sync_peer_set_status", arguments: {} }),
    )) as { status_code: number; body: { error: string } };
    expect(missing.status_code).toBe(400);
    expect(missing.body.error).toBe("peerId is required");

    const badEnabled = (await fn(
      makeReq({
        name: "memory_sync_peer_set_status",
        arguments: { peerId: "p", enabled: "maybe" },
      }),
    )) as { status_code: number; body: { error: string } };
    expect(badEnabled.status_code).toBe(400);
    expect(badEnabled.body.error).toBe("enabled must be a boolean");
  });

  it("resolves the proposal principal server-side and never trusts body permissions", async () => {
    let seen: Record<string, unknown> | undefined;
    sdk.overrideTrigger("mem::memory-proposal-approve", async (payload: unknown) => {
      seen = payload as Record<string, unknown>;
      return { success: true };
    });
    const fn = sdk.getFunction("mcp::tools::call")!;

    const res = (await fn(
      makeReq(
        {
          name: "memory_proposal_approve",
          arguments: {
            proposalId: "mpr_1",
            // Forged authorization fields must be ignored.
            permissions: ["*"],
            roles: ["admin"],
            actorId: "from-args",
          },
        },
        { "x-actor-id": "reviewer-7" },
      ),
    )) as { status_code: number };
    expect(res.status_code).toBe(200);

    const principal = seen?.["principal"] as {
      actorId: string;
      permissions: string[];
      teamPolicy: { allowSelfApproval: boolean };
    };
    // Header identity wins over args; permissions are the fixed trusted set.
    expect(principal.actorId).toBe("reviewer-7");
    expect(principal.permissions).toEqual([
      "project:read",
      "project:write",
      "governance:delete",
    ]);
    expect(principal.teamPolicy.allowSelfApproval).toBe(false);
    expect(seen).not.toHaveProperty("permissions");
    expect(seen).not.toHaveProperty("roles");
    expect(seen).toMatchObject({ proposalId: "mpr_1" });
  });

  it("proposal principal falls back to args.actorId then 'operator' and honors self-approval env", async () => {
    let seen: Record<string, unknown> | undefined;
    sdk.overrideTrigger("mem::memory-proposal-create", async (payload: unknown) => {
      seen = payload as Record<string, unknown>;
      return { success: true };
    });
    const fn = sdk.getFunction("mcp::tools::call")!;

    await fn(
      makeReq({
        name: "memory_proposal_create",
        arguments: {
          action: "create",
          change: { content: "team fact" },
          project: "billing",
          actorId: "alice",
        },
      }),
    );
    expect((seen?.["principal"] as { actorId: string }).actorId).toBe("alice");
    expect(seen).toMatchObject({ action: "create", project: "billing" });
    expect((seen?.["change"] as { content: string }).content).toBe("team fact");

    await fn(
      makeReq({
        name: "memory_proposal_create",
        arguments: { action: "create", change: { content: "x" } },
      }),
    );
    expect((seen?.["principal"] as { actorId: string }).actorId).toBe("operator");

    const prev = process.env["AGENTMEMORY_ALLOW_SELF_APPROVAL"];
    process.env["AGENTMEMORY_ALLOW_SELF_APPROVAL"] = "true";
    try {
      await fn(
        makeReq({
          name: "memory_proposal_create",
          arguments: { action: "create", change: { content: "y" } },
        }),
      );
      expect(
        (seen?.["principal"] as { teamPolicy: { allowSelfApproval: boolean } }).teamPolicy
          .allowSelfApproval,
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["AGENTMEMORY_ALLOW_SELF_APPROVAL"];
      else process.env["AGENTMEMORY_ALLOW_SELF_APPROVAL"] = prev;
    }
  });

  it("rules-resolve returns 400 for a forbidden_root outside allowedRoots", async () => {
    sdk.overrideTrigger("mem::rules-resolve", async () => ({
      success: false,
      code: "forbidden_root",
      error: "workspaceRoot is not within an allowed root",
    }));
    const fn = sdk.getFunction("mcp::tools::call")!;
    const res = (await fn(
      makeReq({
        name: "memory_rules_resolve",
        arguments: { workspaceRoot: "/etc" },
      }),
    )) as { status_code: number; body: { error: string } };
    expect(res.status_code).toBe(400);
    expect(res.body.error).toBe("workspaceRoot is not within an allowed root");
  });

  it("handles URI with special characters via decodeURIComponent", async () => {
    sdk.overrideTrigger("mem::profile", async (data: any) => ({
      project: data.project,
      topConcepts: [],
    }));

    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({
        uri: "agentmemory://project/my%20app%2Fsubdir/profile",
      }),
    )) as {
      status_code: number;
      body: { contents: Array<{ text: string }> };
    };

    expect(result.status_code).toBe(200);
    const data = JSON.parse(result.body.contents[0].text);
    expect(data.project).toBe("my app/subdir");
  });

  it("returns 400 for malformed percent-encoding in URI", async () => {
    const fn = sdk.getFunction("mcp::resources::read")!;
    const result = (await fn(
      makeReq({
        uri: "agentmemory://project/bad%E0encoding/profile",
      }),
    )) as { status_code: number; body: { error: string } };

    expect(result.status_code).toBe(400);
    expect(result.body.error).toContain("percent-encoding");
  });
});
