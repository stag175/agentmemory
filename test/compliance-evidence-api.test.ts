import { describe, expect, it } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("compliance evidence REST endpoint", () => {
  it("whitelists SOC2 evidence payload fields", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::compliance-evidence", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true, payload };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = (await sdk.trigger("api::compliance-soc2-evidence", {
      headers: {},
      body: {
        project: "alpha",
        workspaceRoot: "C:/repo",
        teamPolicy: { roles: { owner: ["*"] } },
        releaseGateEvidence: { releaseGate: { build: { status: "pass" } } },
        includeRuleContent: false,
        ignored: "drop me",
      },
    })) as { status_code: number; body: { success: boolean } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(payload).toEqual({
      project: "alpha",
      workspaceRoot: "C:/repo",
      teamPolicy: { roles: { owner: ["*"] } },
      releaseGateEvidence: { releaseGate: { build: { status: "pass" } } },
      includeRuleContent: false,
    });
  });

  it("rejects invalid includeRuleContent values", async () => {
    const sdk = mockSdk();
    sdk.registerFunction("mem::compliance-evidence", async () => ({ success: true }));
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = (await sdk.trigger("api::compliance-soc2-evidence", {
      headers: {},
      body: { includeRuleContent: "true" },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("includeRuleContent");
  });
});
