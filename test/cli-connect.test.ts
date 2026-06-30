import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  ADAPTERS,
  knownAgents,
  resolveAdapter,
} from "../src/cli/connect/index.js";
import type { ConnectAdapter } from "../src/cli/connect/types.js";
import {
  applyConnectRollbackPlan,
  buildConnectRollbackPlan,
  buildLatestRollbackablePlan,
  connectManifestRunsNewestFirst,
  markConnectRollbackResults,
  mergeConnectManifestEntries,
  readConnectManifest,
  type ConnectRollbackPathKind,
} from "../src/cli/connect/util.js";

const EXPECTED_COPILOT_MCP_COMMAND =
  process.platform === "win32"
    ? {
        command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
      }
    : {
        command: "npx",
        args: ["-y", "@agentmemory/mcp"],
      };

describe("agentmemory connect — dispatcher", () => {
  it("resolves every known agent by lowercase name", () => {
    for (const name of knownAgents()) {
      const a = resolveAdapter(name);
      expect(a, `expected adapter for ${name}`).not.toBeNull();
      expect(a!.name).toBe(name);
    }
  });

  it("resolves case-insensitively", () => {
    expect(resolveAdapter("Claude-Code")?.name).toBe("claude-code");
    expect(resolveAdapter("CURSOR")?.name).toBe("cursor");
  });

  it("returns null for unknown agents", () => {
    expect(resolveAdapter("nonexistent-agent")).toBeNull();
    expect(resolveAdapter("")).toBeNull();
  });

  it("ships the supported agent list", () => {
    expect(knownAgents().sort()).toEqual(
      [
        "antigravity",
        "claude-code",
        "cline",
        "copilot-cli",
        "codex",
        "continue",
        "cursor",
        "droid",
        "gemini-cli",
        "hermes",
        "kiro",
        "opencode",
        "openclaw",
        "openhuman",
        "pi",
        "qwen",
        "warp",
        "zed",
      ].sort(),
    );
    expect(ADAPTERS.length).toBe(18);
  });

  it("every adapter exposes detect() and install()", () => {
    for (const a of ADAPTERS) {
      expect(typeof a.detect).toBe("function");
      expect(typeof a.install).toBe("function");
      expect(typeof a.name).toBe("string");
      expect(typeof a.displayName).toBe("string");
    }
  });

  it("every adapter declares a category so onboarding never needs a separate list (#872)", () => {
    for (const a of ADAPTERS) {
      expect(
        ["native", "mcp"].includes(a.category as string),
        `adapter ${a.name} must set category to "native" or "mcp"`,
      ).toBe(true);
    }
  });
});

describe("agentmemory connect — claude-code adapter (mock filesystem)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-connect-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/claude-code.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("detect() returns false when ~/.claude doesn't exist", async () => {
    const a = await loadAdapter();
    expect(a.detect()).toBe(false);
  });

  it("install() writes mcpServers.agentmemory into ~/.claude.json and is idempotent", async () => {
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    expect(config.mcpServers.agentmemory.command).toBe("npx");
    expect(config.mcpServers.agentmemory.args).toContain("@agentmemory/mcp");
    expect(config.mcpServers.other.command).toBe("x");

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("install() writes env passthrough block for AGENTMEMORY_URL + AGENTMEMORY_SECRET (#375)", async () => {
    // Remote deployments (k8s, reverse proxy) set AGENTMEMORY_URL +
    // AGENTMEMORY_SECRET in the shell. The wired MCP entry must honour
    // those via ${VAR} expansion so a single entry covers both local
    // and remote without the user needing to add a duplicate config
    // that triggers a /doctor duplicate-server warning.
    const claudeDir = join(tmpHome, ".claude");
    require("node:fs").mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(tmpHome, ".claude.json"), JSON.stringify({}));

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(readFileSync(join(tmpHome, ".claude.json"), "utf-8"));
    const entry = config.mcpServers.agentmemory;
    expect(entry.env).toBeDefined();
    // env interpolation must carry a default so Claude Code
    // doesn't silently drop the server when the user hasn't exported
    // AGENTMEMORY_URL / AGENTMEMORY_SECRET. Defaults match the
    // documented runtime (localhost:3111, no auth, all tools).
    expect(entry.env.AGENTMEMORY_URL).toBe(
      "${AGENTMEMORY_URL:-http://localhost:3111}",
    );
    expect(entry.env.AGENTMEMORY_SECRET).toBe("${AGENTMEMORY_SECRET:-}");
    expect(entry.env.AGENTMEMORY_TOOLS).toBe("${AGENTMEMORY_TOOLS:-all}");
  });

  it("install() with --force re-writes even when already wired", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          agentmemory: { command: "npx", args: ["-y", "@agentmemory/mcp"] },
        },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");
  });

  it("install() with --dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(join(tmpHome, ".claude.json"), before);

    const a = await loadAdapter();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");

    const after = readFileSync(join(tmpHome, ".claude.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("install() creates a backup file under ~/.agentmemory/backups/", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath!).toContain(join(".agentmemory", "backups"));
    }
  });

  it("runAdapter writes a v2 connect manifest for real installs", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const a = await loadAdapter();
    const { runAdapter } = await import("../src/cli/connect/index.js?t=" + Date.now());
    const result = await runAdapter(
      a,
      { dryRun: false, force: false },
      { runId: "test-run", timestamp: "2026-06-28T12:00:00.000Z" },
    );

    expect(result.kind).toBe("installed");
    const manifest = readConnectManifest(tmpHome);
    expect(manifest?.version).toBe(2);
    expect(manifest?.installed).toHaveLength(1);
    expect(manifest?.history).toHaveLength(1);
    expect(manifest?.installed[0]).toMatchObject({
      agent: "claude-code",
      target: join(tmpHome, ".claude.json"),
      action: "updated",
      rollback: "restore-backup",
      runId: "test-run",
    });
    expect(manifest?.installed[0]?.backupPath).toContain(
      join(".agentmemory", "backups"),
    );
  });

  it("runAdapter dry-run does not write a connect manifest", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(join(tmpHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));

    const a = await loadAdapter();
    const { runAdapter } = await import("../src/cli/connect/index.js?t=" + Date.now());
    await runAdapter(
      a,
      { dryRun: true, force: false },
      { runId: "dry-run", timestamp: "2026-06-28T12:00:00.000Z" },
    );

    expect(readConnectManifest(tmpHome)).toBeNull();
  });
});

describe("agentmemory connect — rollback helpers", () => {
  function rollbackOptions(
    home: string,
    kinds: Map<string, ConnectRollbackPathKind>,
    realPaths?: Map<string, string>,
  ) {
    return {
      home,
      backupsDir: join(home, ".agentmemory", "backups"),
      pathKind: (path: string): ConnectRollbackPathKind =>
        kinds.get(path) ?? "missing",
      realPath: realPaths
        ? (path: string): string | null =>
            realPaths.get(path) ?? realPaths.get(resolve(path)) ?? null
        : undefined,
    };
  }

  it("plans rollback for the latest run only", () => {
    const oldTarget = join("home", ".old.json");
    const latestTarget = join("home", ".claude.json");
    const latestCreated = join("home", ".codex", "hooks.json");
    const latestBackup = join("home", ".agentmemory", "backups", "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target: oldTarget,
        backupPath: join("home", ".agentmemory", "backups", "old.json"),
        timestamp: "2026-06-27T12:00:00.000Z",
        runId: "old-run",
        action: "updated",
        rollback: "restore-backup",
      },
      {
        agent: "claude-code",
        target: latestTarget,
        backupPath: latestBackup,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
      {
        agent: "codex",
        target: latestCreated,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "created",
        rollback: "remove-created-target",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(
        join("home"),
        new Map([
          [latestBackup, "file"],
          [latestTarget, "file"],
          [latestCreated, "file"],
        ]),
      ),
    );

    expect(plan).toEqual([
      {
        agent: "claude-code",
        target: latestTarget,
        backupPath: latestBackup,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "restore",
      },
      {
        agent: "codex",
        target: latestCreated,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "remove-created-target",
      },
    ]);
  });

  it("orders runs newest-first by timestamp (#item19 no-op fallback)", () => {
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target: join("home", ".claude.json"),
        timestamp: "2026-06-27T12:00:00.000Z",
        runId: "older-run",
        action: "updated",
        rollback: "restore-backup",
      },
      {
        agent: "cursor",
        target: join("home", ".cursor", "mcp.json"),
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "newest-run",
        action: "already-wired",
        rollback: "none",
      },
    ]);

    const runs = connectManifestRunsNewestFirst(manifest);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.[0]?.runId).toBe("newest-run");
    expect(runs[1]?.[0]?.runId).toBe("older-run");
  });

  it("falls back to the most recent run with rollbackable changes when latest is a no-op (#item19)", () => {
    const home = join("home");
    const olderTarget = join(home, ".claude.json");
    const olderBackup = join(home, ".agentmemory", "backups", "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      // Older run actually changed a file (rollbackable).
      {
        agent: "claude-code",
        target: olderTarget,
        backupPath: olderBackup,
        timestamp: "2026-06-27T12:00:00.000Z",
        runId: "older-run",
        action: "updated",
        rollback: "restore-backup",
      },
      // Newest run is a pure no-op: already-wired, nothing to undo.
      {
        agent: "cursor",
        target: join(home, ".cursor", "mcp.json"),
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "newest-run",
        action: "already-wired",
        rollback: "none",
      },
    ]);

    // The latest-run plan is all skips.
    const latest = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(home, new Map([[olderBackup, "file"], [olderTarget, "file"]])),
    );
    expect(latest.every((item) => item.action === "skip")).toBe(true);

    // The fallback planner reaches back to the older, rollbackable run.
    const fallback = buildLatestRollbackablePlan(
      manifest,
      rollbackOptions(home, new Map([[olderBackup, "file"], [olderTarget, "file"]])),
    );
    expect(fallback).not.toBeNull();
    expect(fallback!.some((item) => item.action === "restore")).toBe(true);
    expect(fallback!.find((item) => item.action === "restore")?.runId).toBe(
      "older-run",
    );
  });

  it("returns null from the fallback planner when no run is rollbackable (#item19)", () => {
    const home = join("home");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "cursor",
        target: join(home, ".cursor", "mcp.json"),
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "noop-run",
        action: "already-wired",
        rollback: "none",
      },
    ]);
    expect(
      buildLatestRollbackablePlan(manifest, rollbackOptions(home, new Map())),
    ).toBeNull();
  });

  it("skips rollback restore targets outside the user home", () => {
    const home = join("home");
    const target = join(home, "..", "outside.json");
    const backupPath = join(home, ".agentmemory", "backups", "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target,
        backupPath,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(home, new Map([[backupPath, "file"]])),
    );

    expect(plan).toEqual([
      expect.objectContaining({
        target,
        backupPath,
        action: "skip",
        reason: "target-outside-home",
      }),
    ]);
  });

  it("skips rollback restore backups outside the backup root", () => {
    const home = join("home");
    const target = join(home, ".claude.json");
    const backupPath = join(home, ".agentmemory", "not-backups", "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target,
        backupPath,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(
        home,
        new Map([
          [target, "file"],
          [backupPath, "file"],
        ]),
      ),
    );

    expect(plan).toEqual([
      expect.objectContaining({
        target,
        backupPath,
        action: "skip",
        reason: "backup-outside-backups",
      }),
    ]);
  });

  it("skips rollback restore when a target parent resolves outside home", () => {
    const home = join("home");
    const target = join(home, "linked", "settings.json");
    const backupRoot = join(home, ".agentmemory", "backups");
    const backupPath = join(backupRoot, "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target,
        backupPath,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(
        home,
        new Map([[backupPath, "file"]]),
        new Map([
          [home, resolve(home)],
          [resolve(home, "linked"), resolve("outside")],
          [backupRoot, resolve(backupRoot)],
          [backupPath, resolve(backupPath)],
        ]),
      ),
    );

    expect(plan).toEqual([
      expect.objectContaining({
        target,
        backupPath,
        action: "skip",
        reason: "target-outside-home",
      }),
    ]);
  });

  it("skips rollback restore when a backup real path escapes the backup root", () => {
    const home = join("home");
    const target = join(home, ".claude.json");
    const backupRoot = join(home, ".agentmemory", "backups");
    const backupPath = join(backupRoot, "linked", "claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target,
        backupPath,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(
        home,
        new Map([
          [target, "file"],
          [backupPath, "file"],
        ]),
        new Map([
          [home, resolve(home)],
          [target, resolve(target)],
          [backupRoot, resolve(backupRoot)],
          [backupPath, resolve("outside", "claude.json")],
        ]),
      ),
    );

    expect(plan).toEqual([
      expect.objectContaining({
        target,
        backupPath,
        action: "skip",
        reason: "backup-outside-backups",
      }),
    ]);
  });

  it("skips created-target rollback removal for symlinks and directories", () => {
    const home = join("home");
    const symlinkTarget = join(home, ".codex", "hooks.json");
    const directoryTarget = join(home, ".claude");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "codex",
        target: symlinkTarget,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "created",
        rollback: "remove-created-target",
      },
      {
        agent: "claude-code",
        target: directoryTarget,
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "created",
        rollback: "remove-created-target",
      },
    ]);

    const plan = buildConnectRollbackPlan(
      manifest,
      rollbackOptions(
        home,
        new Map([
          [symlinkTarget, "symlink"],
          [directoryTarget, "directory"],
        ]),
      ),
    );

    expect(plan).toEqual([
      expect.objectContaining({
        target: symlinkTarget,
        action: "skip",
        reason: "target-symlink",
      }),
      expect.objectContaining({
        target: directoryTarget,
        action: "skip",
        reason: "target-directory",
      }),
    ]);
  });

  it("marks restored and removed rollback results back onto the manifest", () => {
    const target = join("home", ".claude.json");
    const manifest = mergeConnectManifestEntries(null, [
      {
        agent: "claude-code",
        target,
        backupPath: join("home", ".agentmemory", "backups", "claude.json"),
        timestamp: "2026-06-28T12:00:00.000Z",
        runId: "latest-run",
        action: "updated",
        rollback: "restore-backup",
      },
    ]);

    const updated = markConnectRollbackResults(
      manifest,
      [{ target, runId: "latest-run", status: "restored" }],
      "2026-06-28T12:05:00.000Z",
    );

    expect(updated.installed[0]?.rollbackStatus).toBe("restored");
    expect(updated.installed[0]?.rolledBackAt).toBe("2026-06-28T12:05:00.000Z");
    expect(updated.history?.[0]?.rollbackStatus).toBe("restored");
  });

  it("applies restore and remove actions through injectable effects", () => {
    const operations: string[] = [];
    const results = applyConnectRollbackPlan(
      [
        {
          agent: "claude-code",
          target: "target.json",
          backupPath: "backup.json",
          runId: "latest-run",
          action: "restore",
        },
        {
          agent: "codex",
          target: "created.json",
          runId: "latest-run",
          action: "remove-created-target",
        },
      ],
      {
        restoreBackup(backupPath, target) {
          operations.push(`restore:${backupPath}:${target}`);
          return { ok: true, message: "restored" };
        },
        removeTarget(target) {
          operations.push(`remove:${target}`);
          return { ok: true, message: "removed" };
        },
      },
    );

    expect(operations).toEqual([
      "restore:backup.json:target.json",
      "remove:created.json",
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "restored",
      "removed",
    ]);
  });
});

describe("agentmemory connect — opencode adapter (#872)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-opencode-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  const cfgPath = () =>
    join(tmpHome, ".config", "opencode", "opencode.json");

  async function loadOpencode(): Promise<ConnectAdapter> {
    const mod = await import("../src/cli/connect/opencode.js?t=" + Date.now());
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("writes the opencode `mcp` schema (command as array) and preserves other servers", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".config", "opencode"), {
      recursive: true,
    });
    writeFileSync(
      cfgPath(),
      JSON.stringify({ mcp: { other: { type: "local", command: ["x"] } } }),
    );

    const a = await loadOpencode();
    expect(a.name).toBe("opencode");
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    const entry = config.mcp.agentmemory;
    expect(entry.type).toBe("local");
    expect(Array.isArray(entry.command)).toBe(true);
    expect(entry.command).toContain("@agentmemory/mcp");
    expect(entry.enabled).toBe(true);
    expect(config.mcp.other.command).toEqual(["x"]);

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".config", "opencode"), {
      recursive: true,
    });
    const before = JSON.stringify({ mcp: {} });
    writeFileSync(cfgPath(), before);

    const a = await loadOpencode();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });
});

describe("agentmemory connect — copilot-cli adapter (mock filesystem)", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let originalCopilotHome: string | undefined;
  let importCounter = 0;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "am-connect-"));
    originalHome = process.env["HOME"];
    originalUserprofile = process.env["USERPROFILE"];
    originalCopilotHome = process.env["COPILOT_HOME"];
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    delete process.env["COPILOT_HOME"];
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalUserprofile !== undefined)
      process.env["USERPROFILE"] = originalUserprofile;
    else delete process.env["USERPROFILE"];
    if (originalCopilotHome !== undefined)
      process.env["COPILOT_HOME"] = originalCopilotHome;
    else delete process.env["COPILOT_HOME"];
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  async function loadAdapter(): Promise<ConnectAdapter> {
    const mod = await import(
      "../src/cli/connect/copilot-cli.js?t=" + Date.now() + "-" + importCounter++
    );
    return (mod as { adapter: ConnectAdapter }).adapter;
  }

  it("detect() returns false when ~/.copilot doesn't exist", async () => {
    const a = await loadAdapter();
    expect(a.detect()).toBe(false);
  });

  it("install() writes mcpServers.agentmemory into ~/.copilot/mcp-config.json and is idempotent", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const first = await a.install({ dryRun: false, force: false });
    expect(first.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.mcpServers.agentmemory).toEqual({
      type: "local",
      ...EXPECTED_COPILOT_MCP_COMMAND,
      env: {
        AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
        AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
        AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
      },
      tools: ["*"],
    });

    const second = await a.install({ dryRun: false, force: false });
    expect(second.kind).toBe("already-wired");
  });

  it("honors COPILOT_HOME when locating mcp-config.json", async () => {
    const customCopilotHome = join(tmpHome, "custom-copilot-home");
    process.env["COPILOT_HOME"] = customCopilotHome;
    require("node:fs").mkdirSync(customCopilotHome, { recursive: true });

    const a = await loadAdapter();
    expect(a.detect()).toBe(true);

    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    expect(result.mutatedPath).toBe(join(customCopilotHome, "mcp-config.json"));
    expect(existsSync(join(customCopilotHome, "mcp-config.json"))).toBe(true);
    expect(existsSync(join(tmpHome, ".copilot", "mcp-config.json"))).toBe(false);
  });

  it("install() preserves unrelated top-level keys and mcpServers entries", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({
        otherTopLevel: { keep: true },
        mcpServers: { other: { type: "local", command: "other" } },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.otherTopLevel).toEqual({ keep: true });
    expect(config.mcpServers.other).toEqual({ type: "local", command: "other" });
    expect(config.mcpServers.agentmemory.command).toBe(
      EXPECTED_COPILOT_MCP_COMMAND.command,
    );
  });

  it("install() writes env passthrough block for AGENTMEMORY_URL + AGENTMEMORY_SECRET", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    const entry = config.mcpServers.agentmemory;
    expect(entry.env.AGENTMEMORY_URL).toBe(
      "${AGENTMEMORY_URL:-http://localhost:3111}",
    );
    expect(entry.env.AGENTMEMORY_SECRET).toBe("${AGENTMEMORY_SECRET:-}");
    expect(entry.env.AGENTMEMORY_TOOLS).toBe("${AGENTMEMORY_TOOLS:-all}");
  });

  it("install() with --force rewrites even when already wired", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          agentmemory: {
            type: "local",
            ...EXPECTED_COPILOT_MCP_COMMAND,
            env: {
              AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
              AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
              AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
            },
            tools: ["memory_save"],
          },
        },
      }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: true });
    expect(result.kind).toBe("installed");

    const config = JSON.parse(
      readFileSync(join(tmpHome, ".copilot", "mcp-config.json"), "utf-8"),
    );
    expect(config.mcpServers.agentmemory.tools).toEqual(["*"]);
  });

  it("install() with --dry-run does not mutate the file", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    const before = JSON.stringify({ mcpServers: {} });
    writeFileSync(join(tmpHome, ".copilot", "mcp-config.json"), before);

    const a = await loadAdapter();
    const result = await a.install({ dryRun: true, force: false });
    expect(result.kind).toBe("installed");

    const after = readFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("install() creates a backup file when config pre-exists", async () => {
    require("node:fs").mkdirSync(join(tmpHome, ".copilot"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".copilot", "mcp-config.json"),
      JSON.stringify({ mcpServers: {} }),
    );

    const a = await loadAdapter();
    const result = await a.install({ dryRun: false, force: false });
    expect(result.kind).toBe("installed");
    if (result.kind === "installed") {
      expect(result.backupPath).toBeDefined();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(result.backupPath!).toContain(join(".agentmemory", "backups"));
    }
  });
});

describe("agentmemory connect — stub adapters log + return stub", () => {
  it("hermes adapter returns stub regardless of detect", async () => {
    const { adapter } = await import("../src/cli/connect/hermes.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });

  it("openhuman adapter returns stub", async () => {
    const { adapter } = await import("../src/cli/connect/openhuman.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });

  it("pi adapter returns stub", async () => {
    const { adapter } = await import("../src/cli/connect/pi.js");
    const result = await adapter.install({ dryRun: false, force: false });
    expect(result.kind).toBe("stub");
  });
});

// Item 5 (curl|sh RCE) is enforced inside src/cli.ts, which is a top-level
// executable script (it dispatches a command on import), so we can't import
// it without side effects. Static source assertions are the established
// pattern in this repo for cli.ts behaviors (see stop-worker-pidfile.test.ts).
describe("agentmemory cli — install does not pipe a mutable remote script to sh (item 5)", () => {
  const cliSrc = readFileSync("src/cli.ts", "utf-8");

  it("never executes the mutable /main/ console install script", () => {
    // The /main/ script is still PRINTED as a manual hint, but must never be
    // fed to a shell via runCommand. The old code ran:
    //   runCommand(shBin, ["-c", III_CONSOLE_INSTALL_CMD], ...)
    expect(cliSrc).not.toMatch(/runCommand\([^)]*III_CONSOLE_INSTALL_CMD/);
    expect(cliSrc).not.toMatch(/\[\s*"-c"\s*,\s*III_CONSOLE_INSTALL_CMD\s*\]/);
    // Console install path prints the hint instead.
    expect(cliSrc).toMatch(/iiiConsoleInstallHint\(\)/);
  });

  it("never pipes a remote curl stream into tar/sh for the engine download", () => {
    // The old engine installer EXECUTED `curl -fsSL "${releaseUrl}" | tar -xz
    // -C "${binDir}"` via runCommand(shBin, ["-c", installCmd]). That executed
    // pipe-to-tar (into the managed binDir) must be gone. NOTE: the same
    // curl|tar form still appears as a copy-paste MANUAL instruction the user
    // reviews + runs themselves — that's allowed; only auto-execution is not.
    expect(cliSrc).not.toMatch(/\|\s*tar -xz -C "\$\{binDir\}"/);
    // The installer no longer constructs a shell `installCmd` to execute.
    expect(cliSrc).not.toMatch(/const installCmd\s*=/);
    // It also no longer resolves a shell/curl binary to run the install.
    expect(cliSrc).not.toMatch(/whichBinary\("sh"\)/);
  });

  it("verifies a published SHA-256 before extracting the engine (gating)", () => {
    expect(cliSrc).toMatch(/fetchIiiReleaseChecksum/);
    expect(cliSrc).toMatch(/downloadAndVerifyIiiAsset/);
    expect(cliSrc).toMatch(/createHash\("sha256"\)/);
    // Refuse when no checksum is available.
    expect(cliSrc).toMatch(/No published SHA-256 checksum/);
    // .sha256 sidecar convention + env override.
    expect(cliSrc).toMatch(/\.sha256/);
    expect(cliSrc).toMatch(/AGENTMEMORY_III_SHA256/);
    // Extraction reads the LOCAL verified file, not a remote stream.
    expect(cliSrc).toMatch(/"-xzf",\s*verifiedTarball/);
  });

  it("gates non-interactive auto-install behind AGENTMEMORY_AUTO_INSTALL_ENGINE=1", () => {
    expect(cliSrc).toMatch(/AGENTMEMORY_AUTO_INSTALL_ENGINE/);
    expect(cliSrc).toMatch(/autoInstallEngineOptIn/);
    // The non-interactive path refuses unless the opt-in is set.
    expect(cliSrc).toMatch(
      /!interactive\s*&&\s*!autoInstallEngineOptIn\(\)/,
    );
  });
});

describe("agentmemory cli — rollback safety (item 19)", () => {
  const cliSrc = readFileSync("src/cli.ts", "utf-8");

  it("requires interactive confirmation before applying a rollback", () => {
    // Mirrors runRemove: a p.confirm gate that --force bypasses.
    expect(cliSrc).toMatch(/Apply rollback to/);
    expect(cliSrc).toMatch(/Cancelled\. No files changed\./);
  });

  it("restores JSON targets surgically instead of whole-file copy", () => {
    expect(cliSrc).toMatch(/surgicalJsonRestore/);
    // Deletes only the agentmemory entry, preserving other keys.
    expect(cliSrc).toMatch(/delete nextWrapper\["agentmemory"\]/);
    expect(cliSrc).toMatch(/other keys preserved/);
  });

  it("falls back to the most recent rollbackable run when latest is a no-op", () => {
    expect(cliSrc).toMatch(/buildLatestRollbackablePlan/);
  });
});
