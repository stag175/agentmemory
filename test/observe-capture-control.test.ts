import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

const CAPTURE_CONTROL_ENV_KEYS = [
  "AGENTMEMORY_HOME",
  "AGENTMEMORY_INCOGNITO",
  "AGENTMEMORY_CAPTURE_INCOGNITO",
  "AGENTMEMORY_CAPTURE_PAUSED",
  "AGENTMEMORY_PAUSE_CAPTURE",
  "AGENTMEMORY_CAPTURE_CONSENT",
  "AGENTMEMORY_CONSENT_CAPTURE",
  "AGENTMEMORY_CAPTURE",
  "AGENTMEMORY_AUTO_CAPTURE",
  "AGENTMEMORY_ENABLE_CAPTURE",
  "AGENTMEMORY_CAPTURE_ENABLED",
  "AGENTMEMORY_REQUIRE_CAPTURE_CONSENT",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  CAPTURE_CONTROL_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof CAPTURE_CONTROL_ENV_KEYS)[number], string | undefined>;

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("automatic capture control", () => {
  let sandboxHome: string;

  beforeEach(() => {
    vi.resetModules();
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-capture-"));
    restoreEnv();
    process.env["AGENTMEMORY_HOME"] = sandboxHome;
    for (const key of CAPTURE_CONTROL_ENV_KEYS) {
      if (key !== "AGENTMEMORY_HOME") delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv();
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("skips mem::observe writes when automatic capture is paused", async () => {
    process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "true";
    const { registerObserveFunction } = await import(
      "../src/functions/observe.js"
    );
    const { KV } = await import("../src/state/schema.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerObserveFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::observe", {
      sessionId: "ses_paused",
      hookType: "post_tool_use",
      timestamp: "2026-06-28T10:00:00Z",
      data: { tool_name: "Read", tool_input: { file_path: "src/config.ts" } },
    })) as {
      success: boolean;
      skipped: boolean;
      reason: string;
      source: string;
    };

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      reason: "paused",
      source: "AGENTMEMORY_CAPTURE_PAUSED",
    });
    await expect(kv.list(KV.observations("ses_paused"))).resolves.toEqual([]);
    await expect(kv.get(KV.sessions, "ses_paused")).resolves.toBeNull();
  });

  it("skips automatic session endpoint writes when capture is paused", async () => {
    process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "true";
    const { registerApiTriggers } = await import("../src/triggers/api.js");
    const { KV } = await import("../src/state/schema.js");
    const sdk = mockSdk();
    const kv = mockKV();
    registerApiTriggers(sdk as never, kv as never, "secret");

    const started = (await sdk.trigger("api::session::start", {
      body: {
        sessionId: "ses_paused",
        project: "billing",
        cwd: "/repo/billing",
        captureSource: "automatic_hook",
        hookType: "session_start",
      },
    })) as {
      status_code: number;
      body: { success: boolean; skipped: boolean; reason: string };
    };
    const ended = (await sdk.trigger("api::session::end", {
      body: {
        sessionId: "ses_paused",
        captureSource: "automatic_hook",
        hookType: "session_end",
      },
    })) as {
      status_code: number;
      body: { success: boolean; skipped: boolean; reason: string };
    };

    expect(started).toMatchObject({
      status_code: 200,
      body: { success: true, skipped: true, reason: "paused" },
    });
    expect(ended).toMatchObject({
      status_code: 200,
      body: { success: true, skipped: true, reason: "paused" },
    });
    await expect(kv.get(KV.sessions, "ses_paused")).resolves.toBeNull();
    await expect(kv.list(KV.agentEvents)).resolves.toEqual([]);
  });

  it("still allows explicit mem::remember saves while automatic capture is paused", async () => {
    process.env["AGENTMEMORY_CAPTURE_PAUSED"] = "true";
    const { registerRememberFunction } = await import(
      "../src/functions/remember.js"
    );
    const { getSearchIndex, setIndexPersistence } = await import(
      "../src/functions/search.js"
    );
    const { KV } = await import("../src/state/schema.js");
    getSearchIndex().clear();
    setIndexPersistence(null);
    const sdk = mockSdk();
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::remember", {
      content: "Explicit memory saves are allowed while automatic capture is paused",
      type: "fact",
      concepts: ["capture-control"],
    })) as { success: boolean; memory: { id: string; content: string } };

    expect(result.success).toBe(true);
    expect(result.memory.id).toMatch(/^mem_/);
    await expect(kv.list(KV.memories)).resolves.toHaveLength(1);
    await expect(kv.get(KV.memories, result.memory.id)).resolves.toMatchObject({
      content: result.memory.content,
    });
  });
});
