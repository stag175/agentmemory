import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  LONG_RUNNING_TIMEOUT_MS,
  WORK_QUEUES,
  positiveTimeoutMs,
} from "../src/backpressure.js";
import { callTimeoutMs } from "../src/mcp/rest-proxy.js";

describe("long-running backpressure defaults", () => {
  afterEach(() => {
    delete process.env["AGENTMEMORY_CALL_TIMEOUT_MS"];
  });

  it("uses a 30-minute common timeout above observed 85.591s work", () => {
    expect(LONG_RUNNING_TIMEOUT_MS).toBe(1_800_000);
    expect(positiveTimeoutMs(undefined)).toBe(1_800_000);
    expect(positiveTimeoutMs("bad")).toBe(1_800_000);
  });

  it("keeps valid explicit timeout overrides", () => {
    expect(positiveTimeoutMs(" 95000 ")).toBe(95_000);
  });

  it("applies the common default and env override to MCP calls", () => {
    expect(callTimeoutMs()).toBe(1_800_000);
    process.env["AGENTMEMORY_CALL_TIMEOUT_MS"] = "2400000";
    expect(callTimeoutMs()).toBe(2_400_000);
  });

  it("assigns separate named queues to long-running work classes", () => {
    expect(new Set(Object.values(WORK_QUEUES)).size).toBe(4);
    expect(WORK_QUEUES.compression).toBe("agentmemory-compression");
    expect(WORK_QUEUES.sessionLifecycle).toBe("agentmemory-session-lifecycle");
  });

  it("declares every named queue in persistent iii configuration", () => {
    const config = readFileSync("iii-config.yaml", "utf8");
    for (const queue of Object.values(WORK_QUEUES)) {
      expect(config).toContain(`${queue}:`);
    }
    expect(config).toMatch(/store_method:\s*file_based/);
    expect(config).toMatch(/file_path:\s*\.\/data\/queue_store/);
    const compressionBlock = config.match(
      /agentmemory-compression:[\s\S]*?backoff_ms:\s*(\d+)/,
    );
    expect(Number(compressionBlock?.[1])).toBeGreaterThan(30_000);
  });

  it("does not keep a hidden 30-second consolidation timeout", () => {
    const source = readFileSync("src/functions/consolidate.ts", "utf8");
    expect(source).toContain('getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS")');
    expect(source).not.toContain('new Error("compress timeout")');
    expect(source).not.toMatch(/setTimeout\([\s\S]{0,120}30_000/);
  });
});
