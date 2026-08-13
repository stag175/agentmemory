import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerObserveFunction } from "../src/functions/observe.js";
import { registerAgentEventFunctions } from "../src/functions/agent-events.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("concurrent durable hook delivery", () => {
  let lockDir = "";

  beforeEach(async () => {
    lockDir = await mkdtemp(join(tmpdir(), "agentmemory-hook-locks-"));
    process.env["AGENTMEMORY_LOCK_DIR"] = lockDir;
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    process.env["AGENTMEMORY_CAPTURE_CONSENT"] = "true";
  });

  afterEach(async () => {
    delete process.env["AGENTMEMORY_LOCK_DIR"];
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    delete process.env["AGENTMEMORY_CAPTURE_CONSENT"];
    await rm(lockDir, { recursive: true, force: true });
  });

  it("serializes one delivery id across receipt check, mutation, and receipt", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    sdk.registerFunction("stream::set", async () => ({ success: true }));
    sdk.registerFunction("stream::send", async () => ({ success: true }));
    registerObserveFunction(sdk as never, kv as never);
    registerAgentEventFunctions(sdk as never, kv as never);
    registerApiTriggers(sdk as never, kv as never, "secret");
    const headers = {
      authorization: "Bearer secret",
      "x-agentmemory-delivery-id": "delivery-concurrent-observe-0001",
    };
    const request = (sessionId: string) => ({
      headers,
      query_params: {},
      body: {
        hookType: "prompt_submit",
        sessionId,
        project: "billing",
        cwd: "/repo/billing",
        timestamp: "2026-08-13T12:00:00.000Z",
        data: { prompt: sessionId },
      },
    });

    const observeResponses = (await Promise.all([
      sdk.trigger("api::observe", request("ses_a")),
      sdk.trigger("api::observe", request("ses_b")),
    ])) as Array<{ status_code: number }>;
    expect(observeResponses.map((item) => item.status_code).sort()).toEqual([
      201, 409,
    ]);
    const observations = [
      ...(await kv.list(KV.observations("ses_a"))),
      ...(await kv.list(KV.observations("ses_b"))),
    ];
    expect(observations).toHaveLength(1);

    const eventHeaders = {
      authorization: "Bearer secret",
      "x-agentmemory-delivery-id": "delivery-concurrent-event-0001",
    };
    const eventRequest = (status: string) => ({
      headers: eventHeaders,
      query_params: {},
      body: {
        type: "custom",
        status,
        sessionId: "ses_a",
        timestamp: "2026-08-13T12:00:01.000Z",
        metadata: { status },
      },
    });
    const eventResponses = (await Promise.all([
      sdk.trigger("api::agent-event-record", eventRequest("ok")),
      sdk.trigger("api::agent-event-record", eventRequest("error")),
    ])) as Array<{ status_code: number }>;
    expect(eventResponses.map((item) => item.status_code).sort()).toEqual([
      201, 409,
    ]);
    const customEvents = (await kv.list<{ type: string }>(KV.agentEvents)).filter(
      (event) => event.type === "custom",
    );
    expect(customEvents).toHaveLength(1);
  });
});
