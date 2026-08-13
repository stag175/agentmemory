import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("session end integrity", () => {
  it("does not create a partial row when the session does not exist", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::session::end", {
      headers: { authorization: "Bearer secret" },
      body: { sessionId: "ses_missing" },
      query_params: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(404);
    await expect(kv.get(KV.sessions, "ses_missing")).resolves.toBeNull();
    await expect(kv.list(KV.agentEvents)).resolves.toEqual([]);
  });

  it("surfaces session storage failures instead of converting them to a false 404", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const storageError = new Error("state backend unavailable");
    vi.spyOn(kv, "get").mockRejectedValueOnce(storageError);
    registerApiTriggers(sdk as never, kv as never, "secret");

    await expect(
      sdk.trigger("api::session::end", {
        headers: { authorization: "Bearer secret" },
        body: { sessionId: "ses_unknown" },
        query_params: {},
      }),
    ).rejects.toThrow("state backend unavailable");
  });

  it("is idempotent for an already completed session", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const triggerSpy = vi.spyOn(sdk, "trigger");
    await kv.set(KV.sessions, "ses_done", {
      id: "ses_done",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-05-13T12:00:00Z",
      endedAt: "2026-05-13T12:30:00Z",
      status: "completed",
      observationCount: 3,
    });
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::session::end", {
      headers: { authorization: "Bearer secret" },
      body: { sessionId: "ses_done" },
      query_params: {},
    })) as { status_code: number; body: { alreadyEnded?: boolean } };

    expect(response).toMatchObject({ status_code: 200, body: { alreadyEnded: true } });
    await expect(kv.get(KV.sessions, "ses_done")).resolves.toMatchObject({
      endedAt: "2026-05-13T12:30:00Z",
      status: "completed",
    });
    expect(triggerSpy.mock.calls.filter(([name]) => name === "event::session::stopped")).toHaveLength(0);
    await expect(kv.list(KV.agentEvents)).resolves.toEqual([]);
  });

  it("records the end as the session's latest activity", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("event::session::stopped", async () => ({ success: true }));
    await kv.set(KV.sessions, "ses_active", {
      id: "ses_active",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-05-13T12:00:00Z",
      updatedAt: "2026-05-13T12:10:00Z",
      status: "active",
      observationCount: 3,
    });
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::session::end", {
      headers: { authorization: "Bearer secret" },
      body: { sessionId: "ses_active" },
      query_params: {},
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    const ended = await kv.get<{
      status: string;
      endedAt: string;
      updatedAt: string;
    }>(KV.sessions, "ses_active");
    expect(ended?.status).toBe("completed");
    expect(ended?.updatedAt).toBe(ended?.endedAt);
  });
});
