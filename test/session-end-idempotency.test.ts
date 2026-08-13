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
});
