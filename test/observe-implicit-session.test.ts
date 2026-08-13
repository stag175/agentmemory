import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    store,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    update: async (scope: string, key: string, updates: Array<{ path: string; value: unknown }>) => {
      const m = store.get(scope);
      if (!m) return;
      const v = (m.get(key) as Record<string, unknown>) ?? {};
      for (const u of updates) v[u.path] = u.value;
      m.set(key, v);
    },
    delete: async (scope: string, key: string) => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const m = store.get(scope);
      return m ? (Array.from(m.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    fns,
    registerFunction: (
      idOrOpts: string | { id: string },
      fn: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      fns.set(id, fn);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown; action?: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = fns.get(id);
      if (fn) return fn(payload);
      return null;
    },
  };
}

describe("observe implicit session create (#638)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the session on first observe when project+cwd present and session record missing", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_opencode_abc",
      project: "/home/user/myrepo",
      cwd: "/home/user/myrepo",
      hookType: "prompt_submit",
      timestamp: new Date().toISOString(),
      data: { prompt: "ship the helm chart" },
    })) as { observationId: string };

    expect(result.observationId).toBeTruthy();

    const sessionScope = kv.store.get("mem:sessions");
    expect(sessionScope).toBeTruthy();
    const session = sessionScope!.get("ses_opencode_abc") as Record<string, unknown>;
    expect(session).toBeTruthy();
    expect(session.id).toBe("ses_opencode_abc");
    expect(session.project).toBe("/home/user/myrepo");
    expect(session.cwd).toBe("/home/user/myrepo");
    expect(session.status).toBe("active");
    expect(session.observationCount).toBe(1);
    expect(session.firstPrompt).toBe("ship the helm chart");
  });

  it("does not implicit-create when project+cwd missing (test-payload back-compat)", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await sdk.trigger("mem::observe", {
      sessionId: "ses_no_project",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read", tool_input: { file_path: "x.ts" } },
    });

    const sessionScope = kv.store.get("mem:sessions");
    // Either no scope at all, or no entry for this session
    expect(sessionScope?.get("ses_no_project")).toBeUndefined();
  });

  it("does not overwrite an existing session when one already exists", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_existing", {
      id: "ses_existing",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-01-01T00:00:00Z",
      status: "active",
      observationCount: 7,
      firstPrompt: "original first prompt",
    });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_existing",
      project: "/different/project",
      cwd: "/different/cwd",
      hookType: "post_tool_use",
      timestamp: new Date().toISOString(),
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_existing") as Record<string, unknown>;
    // Original project + firstPrompt preserved
    expect(session.project).toBe("/orig/project");
    expect(session.firstPrompt).toBe("original first prompt");
    // Counter bumped, updatedAt refreshed
    expect(session.observationCount).toBe(8);
    expect(session.updatedAt).toBeTruthy();
  });

  it("reopens a completed session for a strictly newer observation and reconciles its count", async () => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_resumed", {
      id: "ses_resumed",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-08-13T12:00:00.000Z",
      endedAt: "2026-08-13T12:30:00.000Z",
      updatedAt: "2026-08-13T12:30:00.000Z",
      status: "completed",
      observationCount: 99,
      model: "model-that-must-survive",
      tags: ["preserve-me"],
      summary: "preserved summary",
    });
    await kv.set("mem:obs:ses_resumed", "obs_existing_1", { id: "obs_existing_1" });
    await kv.set("mem:obs:ses_resumed", "obs_existing_2", { id: "obs_existing_2" });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_resumed",
      project: "/different/project",
      cwd: "/different/cwd",
      hookType: "post_tool_use",
      timestamp: "2026-08-13T12:30:00.001Z",
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_resumed") as Record<string, unknown>;
    expect(session).toMatchObject({
      id: "ses_resumed",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:30:00.001Z",
      status: "active",
      observationCount: 3,
      model: "model-that-must-survive",
      tags: ["preserve-me"],
      summary: "preserved summary",
    });
    expect(session).not.toHaveProperty("endedAt");

    const events = Array.from(
      kv.store.get("mem:agent-events")?.values() ?? [],
    ) as Array<Record<string, unknown>>;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session_started",
        timestamp: "2026-08-13T12:30:00.001Z",
        sessionId: "ses_resumed",
        functionId: "mem::observe",
        metadata: expect.objectContaining({
          resumed: true,
          previousEndedAt: "2026-08-13T12:30:00.000Z",
          observationCount: 3,
        }),
      }),
    );
  });

  it.each([
    "2026-08-13T12:30:00.000Z",
    "2026-08-13T12:29:59.999Z",
  ])("keeps a completed session closed for a delayed observation at %s", async (timestamp) => {
    const { registerObserveFunction } = await import("../src/functions/observe.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_delayed", {
      id: "ses_delayed",
      project: "/orig/project",
      cwd: "/orig/cwd",
      startedAt: "2026-08-13T12:00:00.000Z",
      endedAt: "2026-08-13T12:30:00.000Z",
      updatedAt: "2026-08-13T12:30:00.000Z",
      status: "completed",
      observationCount: 99,
    });
    await kv.set("mem:obs:ses_delayed", "obs_existing", { id: "obs_existing" });

    await sdk.trigger("mem::observe", {
      sessionId: "ses_delayed",
      project: "/orig/project",
      cwd: "/orig/cwd",
      hookType: "post_tool_use",
      timestamp,
      data: { tool_name: "Read" },
    });

    const session = kv.store.get("mem:sessions")!.get("ses_delayed") as Record<string, unknown>;
    expect(session).toMatchObject({
      endedAt: "2026-08-13T12:30:00.000Z",
      updatedAt: "2026-08-13T12:30:00.000Z",
      status: "completed",
      observationCount: 2,
    });
    const events = Array.from(
      kv.store.get("mem:agent-events")?.values() ?? [],
    ) as Array<Record<string, unknown>>;
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "session_started",
        metadata: expect.objectContaining({ resumed: true }),
      }),
    );
  });
});
