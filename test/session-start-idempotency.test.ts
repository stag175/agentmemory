import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import type { Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("session start reconnect safety", () => {
  it("reactivates an existing session without erasing its history", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const original: Session = {
      id: "ses_resume",
      project: "old-project",
      cwd: "/repo/old",
      startedAt: "2026-08-13T12:00:00.000Z",
      endedAt: "2026-08-13T12:30:00.000Z",
      status: "completed",
      observationCount: 17,
      firstPrompt: "Keep this prompt",
      summary: "Keep this summary",
      commitShas: ["abc123"],
      agentId: "original-agent",
    };
    await kv.set(KV.sessions, original.id, original);
    sdk.registerFunction("mem::context", async () => ({ context: "recalled" }));
    registerApiTriggers(sdk as never, kv as never, "secret");

    const response = (await sdk.trigger("api::session::start", {
      headers: { authorization: "Bearer secret" },
      query_params: {},
      body: {
        sessionId: original.id,
        project: "new-project",
        cwd: "/repo/new",
        title: "Do not overwrite preserved fields",
        agentId: "explicit-agent",
      },
    })) as { status_code: number; body: { session: Session; context: string } };

    expect(response.status_code).toBe(200);
    expect(response.body.context).toBe("recalled");
    expect(response.body.session).toMatchObject({
      id: original.id,
      project: "new-project",
      cwd: "/repo/new",
      startedAt: original.startedAt,
      status: "active",
      observationCount: 17,
      firstPrompt: original.firstPrompt,
      summary: original.summary,
      commitShas: ["abc123"],
      agentId: "explicit-agent",
    });
    expect(response.body.session).not.toHaveProperty("endedAt");
    await expect(kv.get<Session>(KV.sessions, original.id)).resolves.toEqual(
      response.body.session,
    );

    const events = await kv.list<{ metadata?: Record<string, unknown> }>(
      KV.agentEvents,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      resumed: true,
      restarted: true,
      previousStatus: "completed",
      observationCount: 17,
    });
  });
});
