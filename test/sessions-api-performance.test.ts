import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("sessions REST endpoint", () => {
  it("bulk-loads encrypted summaries without per-session state::get calls", async () => {
    const secret = "sessions-test-secret";
    const sdk = mockSdk();
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", { id: "ses_1", project: "one", cwd: "/one", startedAt: "2026-08-13T00:00:00Z", status: "completed", observationCount: 1 });
    await kv.set(KV.sessions, "ses_2", { id: "ses_2", project: "two", cwd: "/two", startedAt: "2026-08-13T00:00:00Z", status: "completed", observationCount: 0 });
    await kv.set(KV.sessions, "legacy_partial", { status: "completed", endedAt: "2026-08-13T00:00:00Z" });
    await kv.set(KV.summaries, "ses_1", { sessionId: "ses_1", title: "Summary one" });
    const getSpy = vi.spyOn(kv, "get");
    const listSpy = vi.spyOn(kv, "list");
    registerApiTriggers(sdk as never, kv as never, secret);

    const response = (await sdk.trigger("api::sessions", {
      headers: { authorization: `Bearer ${secret}` },
      query_params: {},
    })) as { status_code: number; body: { sessions: Array<{ id: string; summary?: { title: string } }> } };

    expect(response.status_code).toBe(200);
    expect(response.body.sessions).toHaveLength(2);
    expect(response.body.sessions.find((s) => s.id === "ses_1")?.summary?.title).toBe("Summary one");
    expect(response.body.sessions.find((s) => s.id === "ses_2")?.summary).toBeUndefined();
    expect(getSpy).not.toHaveBeenCalled();
    expect(listSpy.mock.calls.filter(([scope]) => scope === KV.summaries)).toHaveLength(1);
  });
});
