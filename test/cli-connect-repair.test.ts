import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectJsonEntry } from "../src/cli/connect/inspect.js";
import {
  applyConnectRepairPlan,
  buildConnectRepairPlan,
} from "../src/cli/connect/repair.js";
import type { ConnectAdapter, ConnectInspection } from "../src/cli/connect/types.js";

const EXPECTED_ENTRY = {
  command: "npx",
  args: ["-y", "@agentmemory/mcp"],
  env: { AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}" },
};

describe("connect doctor inspection", () => {
  let home: string;
  let detectDir: string;
  let configPath: string;

  beforeEach(() => {
    home = join(tmpdir(), `am-connect-repair-${process.pid}-${Date.now()}`);
    detectDir = join(home, ".agent");
    configPath = join(detectDir, "mcp.json");
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function inspect() {
    return inspectJsonEntry({
      name: "demo",
      displayName: "Demo",
      detectDir,
      configPath,
      wrapperKey: "mcpServers",
      expectedEntry: EXPECTED_ENTRY,
      expectedMutation: `add mcpServers.agentmemory to ${configPath}`,
    });
  }

  it("reports not-detected before the agent directory exists", () => {
    expect(inspect()).toMatchObject({
      status: "not-detected",
      repairSafe: false,
    });
  });

  it("distinguishes missing, healthy, stale, and invalid JSON config", () => {
    mkdirSync(detectDir, { recursive: true });
    expect(inspect()).toMatchObject({ status: "missing", repairSafe: true });

    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { agentmemory: EXPECTED_ENTRY } }),
    );
    expect(inspect()).toMatchObject({ status: "healthy", repairSafe: true });

    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          agentmemory: { command: "npx", args: ["@agentmemory/mcp"] },
        },
      }),
    );
    expect(inspect()).toMatchObject({ status: "stale", repairSafe: true });

    writeFileSync(configPath, "{not-json");
    expect(inspect()).toMatchObject({ status: "invalid-config", repairSafe: true });
    expect(readFileSync(configPath, "utf-8")).toBe("{not-json");
  });
});

describe("connect repair planning", () => {
  const healthy: ConnectInspection = {
    agent: "healthy",
    displayName: "Healthy",
    status: "healthy",
    expectedMutation: "none",
    windowsSafe: true,
    repairSafe: true,
    reason: "ok",
  };

  function inspection(
    agent: string,
    status: ConnectInspection["status"],
    windowsSafe: boolean,
  ): ConnectInspection {
    return {
      agent,
      displayName: agent,
      status,
      configPath: `${agent}.json`,
      expectedMutation: `repair ${agent}`,
      windowsSafe,
      repairSafe: status !== "manual-only" && status !== "not-detected",
      reason: status,
    };
  }

  it("skips non-Windows-safe adapters during Windows auto-repair", () => {
    const plan = buildConnectRepairPlan(
      [
        inspection("codex", "missing", false),
        inspection("copilot-cli", "missing", true),
      ],
      { force: false, withHooks: false, isWindows: true },
    );

    expect(plan).toEqual([
      expect.objectContaining({
        agent: "codex",
        action: "skip",
        reason: "windows-repair-not-enabled",
      }),
      expect.objectContaining({
        agent: "copilot-cli",
        action: "repair",
        force: false,
      }),
    ]);
  });

  it("force-refreshes healthy adapters only when requested", () => {
    expect(
      buildConnectRepairPlan([healthy], {
        force: false,
        withHooks: false,
        isWindows: false,
      })[0],
    ).toMatchObject({ action: "skip", reason: "already-healthy" });
    expect(
      buildConnectRepairPlan([healthy], {
        force: true,
        withHooks: false,
        isWindows: false,
      })[0],
    ).toMatchObject({ action: "repair", reason: "force-refresh", force: true });
  });

  it("applies repairs through the existing adapter runner", async () => {
    const adapter: ConnectAdapter = {
      name: "codex",
      displayName: "Codex",
      category: "native",
      detect: () => true,
      install: async () => ({ kind: "installed", mutatedPath: "unused" }),
    };
    const runner = vi.fn(async () => ({ kind: "installed" as const, mutatedPath: "codex.json" }));
    const plan = buildConnectRepairPlan(
      [inspection("codex", "stale", true)],
      { force: false, withHooks: true, isWindows: false },
    );

    const applied = await applyConnectRepairPlan(
      plan,
      [adapter],
      { dryRun: false, withHooks: true },
      runner,
      { runId: "repair-test", timestamp: "2026-06-28T12:00:00.000Z" },
    );

    expect(runner).toHaveBeenCalledWith(
      adapter,
      { dryRun: false, force: true, withHooks: true },
      { runId: "repair-test", timestamp: "2026-06-28T12:00:00.000Z" },
    );
    expect(applied).toEqual([
      {
        agent: "codex",
        action: "repair",
        result: { kind: "installed", mutatedPath: "codex.json" },
      },
    ]);
  });
});
