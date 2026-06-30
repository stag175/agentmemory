import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import type {
  ConnectAdapter,
  ConnectManifest,
  ConnectManifestEntry,
  ConnectOptions,
  ConnectResult,
  ConnectRollbackAction,
  ConnectTargetMutation,
} from "./types.js";

// Env values use ${VAR:-default} expansion so the wired MCP entry
// inherits AGENTMEMORY_URL / AGENTMEMORY_SECRET / AGENTMEMORY_TOOLS
// from the user's shell, but never fails parse when the var is unset
// (#510). Earlier `${VAR}` form caused Claude Code to silently drop the
// server when no shell-level export existed — per the Claude Code MCP
// docs, "If a required environment variable is not set and has no
// default value, Claude Code will fail to parse the config."
//
// Defaults match the documented runtime: localhost:3111 (no auth, all
// tools). One wired entry now serves local AND remote (Kubernetes /
// reverse-proxied) deployments without doctor-warning duplicates (#375)
// AND fresh installs that haven't exported envs (#510).
export const AGENTMEMORY_MCP_BLOCK = {
  command: "npx",
  args: ["-y", "@agentmemory/mcp"],
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
};

const COPILOT_MCP_COMMAND =
  process.platform === "win32"
    ? {
        command: process.env["ComSpec"] || process.env["COMSPEC"] || "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", "@agentmemory/mcp"],
      }
    : {
        command: "npx",
        args: ["-y", "@agentmemory/mcp"],
      };

export const AGENTMEMORY_COPILOT_MCP_BLOCK = {
  type: "local" as const,
  ...COPILOT_MCP_COMMAND,
  env: {
    AGENTMEMORY_URL: "${AGENTMEMORY_URL:-http://localhost:3111}",
    AGENTMEMORY_SECRET: "${AGENTMEMORY_SECRET:-}",
    AGENTMEMORY_TOOLS: "${AGENTMEMORY_TOOLS:-all}",
  },
  tools: ["*"],
};

export function backupsDir(): string {
  return join(homedir(), ".agentmemory", "backups");
}

export function connectManifestPath(home = homedir()): string {
  return join(home, ".agentmemory", "backups", "connect-manifest.json");
}

export function ensureBackupsDir(): string {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function backupFile(
  sourcePath: string,
  agent: string,
  ext = "json",
): string {
  ensureBackupsDir();
  const stamp = timestampSlug();
  const target = join(backupsDir(), `${agent}-${stamp}.${ext}`);
  copyFileSync(sourcePath, target);
  return target;
}

export function readJsonSafe<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export const CONNECT_MANIFEST_VERSION = 2;

export type ConnectRunMetadata = {
  runId: string;
  timestamp: string;
};

export type ConnectRollbackPlanItem = {
  agent?: string;
  target: string;
  backupPath?: string;
  timestamp?: string;
  runId?: string;
  action: "restore" | "remove-created-target" | "skip";
  reason?: string;
};

export type ConnectRollbackResult = {
  target: string;
  runId?: string;
  status: "restored" | "removed" | "skipped" | "failed";
};

export type AppliedConnectRollbackResult = ConnectRollbackResult & {
  message?: string;
};

export type ConnectRollbackEffectOutcome = {
  ok: boolean;
  message?: string;
};

export type ConnectRollbackEffects = {
  restoreBackup(backupPath: string, target: string): ConnectRollbackEffectOutcome;
  removeTarget(target: string): ConnectRollbackEffectOutcome;
};

export type ConnectRollbackPathKind =
  | "file"
  | "directory"
  | "symlink"
  | "missing"
  | "other";

export type ConnectRollbackPlanOptions = {
  home?: string;
  backupsDir?: string;
  pathExists?: (path: string) => boolean;
  pathKind?: (path: string) => ConnectRollbackPathKind;
  realPath?: (path: string) => string | null;
};

type NormalizedConnectRollbackPlanOptions = {
  home?: string;
  backupsDir?: string;
  pathExists?: (path: string) => boolean;
  pathKind?: (path: string) => ConnectRollbackPathKind;
  realPath?: (path: string) => string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntry(value: unknown): ConnectManifestEntry | null {
  if (!isRecord(value) || typeof value["target"] !== "string") return null;
  const entry: ConnectManifestEntry = { target: value["target"] };
  if (typeof value["agent"] === "string") entry.agent = value["agent"];
  if (typeof value["displayName"] === "string") {
    entry.displayName = value["displayName"];
  }
  if (typeof value["backupPath"] === "string") {
    entry.backupPath = value["backupPath"];
  }
  if (typeof value["timestamp"] === "string") {
    entry.timestamp = value["timestamp"];
  }
  if (typeof value["runId"] === "string") entry.runId = value["runId"];
  if (
    value["action"] === "created" ||
    value["action"] === "updated" ||
    value["action"] === "already-wired"
  ) {
    entry.action = value["action"];
  }
  if (
    value["rollback"] === "restore-backup" ||
    value["rollback"] === "remove-created-target" ||
    value["rollback"] === "none"
  ) {
    entry.rollback = value["rollback"];
  }
  if (typeof value["label"] === "string") entry.label = value["label"];
  if (typeof value["symlink"] === "boolean") entry.symlink = value["symlink"];
  if (isRecord(value["metadata"])) {
    entry.metadata = { ...value["metadata"] };
  }
  if (typeof value["rolledBackAt"] === "string") {
    entry.rolledBackAt = value["rolledBackAt"];
  }
  if (
    value["rollbackStatus"] === "restored" ||
    value["rollbackStatus"] === "removed" ||
    value["rollbackStatus"] === "skipped" ||
    value["rollbackStatus"] === "failed"
  ) {
    entry.rollbackStatus = value["rollbackStatus"];
  }
  return entry;
}

export function normalizeConnectManifest(
  value: unknown,
): ConnectManifest | null {
  if (!isRecord(value) || !Array.isArray(value["installed"])) return null;
  const installed = value["installed"]
    .map(normalizeEntry)
    .filter((entry): entry is ConnectManifestEntry => entry !== null);
  const history = Array.isArray(value["history"])
    ? value["history"]
        .map(normalizeEntry)
        .filter((entry): entry is ConnectManifestEntry => entry !== null)
    : undefined;
  const manifest: ConnectManifest = {
    version:
      typeof value["version"] === "number"
        ? value["version"]
        : CONNECT_MANIFEST_VERSION,
    installed,
  };
  if (typeof value["updatedAt"] === "string") {
    manifest.updatedAt = value["updatedAt"];
  }
  if (history !== undefined) manifest.history = history;
  return manifest;
}

export function readConnectManifest(home = homedir()): ConnectManifest | null {
  return normalizeConnectManifest(readJsonSafe(connectManifestPath(home)));
}

export function writeConnectManifest(
  manifest: ConnectManifest,
  home = homedir(),
): void {
  writeJsonAtomic(connectManifestPath(home), {
    ...manifest,
    version: CONNECT_MANIFEST_VERSION,
  });
}

export function createConnectRunMetadata(): ConnectRunMetadata {
  const timestamp = new Date().toISOString();
  return {
    timestamp,
    runId: `connect-${timestamp.replace(/[:.]/g, "-")}-${process.pid}`,
  };
}

function resultTargets(result: ConnectResult): ConnectTargetMutation[] {
  if (result.kind !== "installed" && result.kind !== "already-wired") return [];
  if (result.kind === "installed" && result.targets?.length) {
    return result.targets;
  }
  if (result.mutatedPath) {
    return [{ target: result.mutatedPath, backupPath: result.kind === "installed" ? result.backupPath : undefined }];
  }
  return [];
}

function entryKey(entry: ConnectManifestEntry): string {
  return `${entry.agent ?? ""}\u0000${entry.target}\u0000${entry.label ?? ""}`;
}

function resolveAction(
  result: ConnectResult,
  target: ConnectTargetMutation,
): {
  action: ConnectManifestEntry["action"];
  rollback: ConnectRollbackAction;
  previousExists: boolean;
} {
  if (result.kind === "already-wired") {
    return { action: "already-wired", rollback: "none", previousExists: true };
  }
  const previousExists = target.previousExists ?? Boolean(target.backupPath);
  if (target.backupPath) {
    return { action: "updated", rollback: "restore-backup", previousExists };
  }
  if (previousExists) {
    return { action: "updated", rollback: "none", previousExists };
  }
  return { action: "created", rollback: "remove-created-target", previousExists };
}

export function manifestEntriesForResult(
  adapter: Pick<ConnectAdapter, "name" | "displayName">,
  result: ConnectResult,
  opts: ConnectOptions,
  run: ConnectRunMetadata,
): ConnectManifestEntry[] {
  return resultTargets(result).map((target) => {
    const resolved = resolveAction(result, target);
    const entry: ConnectManifestEntry = {
      agent: adapter.name,
      displayName: adapter.displayName,
      target: target.target,
      timestamp: run.timestamp,
      runId: run.runId,
      action: resolved.action,
      rollback: resolved.rollback,
      metadata: {
        force: opts.force,
        withHooks: opts.withHooks === true,
        previousExists: resolved.previousExists,
        resultKind: result.kind,
      },
    };
    if (target.backupPath) entry.backupPath = target.backupPath;
    if (target.label) entry.label = target.label;
    return entry;
  });
}

export function mergeConnectManifestEntries(
  manifest: ConnectManifest | null,
  entries: ConnectManifestEntry[],
  updatedAt = new Date().toISOString(),
): ConnectManifest {
  const installed = [...(manifest?.installed ?? [])];
  for (const entry of entries) {
    const idx = installed.findIndex((candidate) => entryKey(candidate) === entryKey(entry));
    if (idx >= 0) installed[idx] = { ...installed[idx], ...entry };
    else installed.push(entry);
  }
  return {
    version: CONNECT_MANIFEST_VERSION,
    updatedAt,
    installed,
    history: [...(manifest?.history ?? []), ...entries],
  };
}

export function updateConnectManifest(
  entries: ConnectManifestEntry[],
  home = homedir(),
): ConnectManifest | null {
  if (entries.length === 0) return readConnectManifest(home);
  const next = mergeConnectManifestEntries(readConnectManifest(home), entries);
  writeConnectManifest(next, home);
  return next;
}

export function latestConnectManifestEntries(
  manifest: ConnectManifest,
): ConnectManifestEntry[] {
  const source = manifest.history?.length ? manifest.history : manifest.installed;
  if (source.length === 0) return [];
  const latest = source.reduce((best, entry) => {
    const bestStamp = best.timestamp ?? "";
    const entryStamp = entry.timestamp ?? "";
    return entryStamp >= bestStamp ? entry : best;
  });
  if (latest.runId) {
    return source.filter((entry) => entry.runId === latest.runId);
  }
  if (latest.timestamp) {
    return source.filter((entry) => entry.timestamp === latest.timestamp);
  }
  return source;
}

// Group manifest entries into runs (by runId, falling back to timestamp),
// ordered newest-first. Used by rollback so that when the newest run is a
// no-op (e.g. an `already-wired` run with nothing to undo) we can fall back to
// the most recent run that actually has rollbackable entries (#item19).
export function connectManifestRunsNewestFirst(
  manifest: ConnectManifest,
): ConnectManifestEntry[][] {
  const source = manifest.history?.length ? manifest.history : manifest.installed;
  if (source.length === 0) return [];
  const order: string[] = [];
  const groups = new Map<string, ConnectManifestEntry[]>();
  const sortKey = new Map<string, string>();
  for (const entry of source) {
    const key = entry.runId ?? entry.timestamp ?? `__entry-${order.length}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
      sortKey.set(key, entry.timestamp ?? "");
    }
    groups.get(key)!.push(entry);
    // Track the newest timestamp within the run for ordering.
    const current = sortKey.get(key) ?? "";
    const candidate = entry.timestamp ?? "";
    if (candidate > current) sortKey.set(key, candidate);
  }
  return order
    .slice()
    .sort((a, b) => {
      // ISO-8601 timestamps sort correctly as plain strings; newest first.
      const ta = sortKey.get(a) ?? "";
      const tb = sortKey.get(b) ?? "";
      if (ta === tb) return 0;
      return ta > tb ? -1 : 1;
    })
    .map((key) => groups.get(key)!);
}

function normalizeRollbackPlanOptions(
  options?: ConnectRollbackPlanOptions,
): NormalizedConnectRollbackPlanOptions {
  const home = options?.home ?? homedir();
  return {
    home,
    backupsDir: options?.backupsDir ?? join(home, ".agentmemory", "backups"),
    pathExists: options?.pathExists,
    pathKind: options?.pathKind,
    realPath: options?.realPath,
  };
}

function isPathUnderRoot(path: string, root: string, allowEqual = false): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return (
    (allowEqual || relativePath !== "") &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function rollbackPathKind(
  path: string,
  options: NormalizedConnectRollbackPlanOptions,
): ConnectRollbackPathKind | undefined {
  if (options.pathKind) return options.pathKind(path);
  if (options.pathExists && !options.pathExists(path)) return "missing";
  return undefined;
}

function nearestExistingAncestorRealPath(
  path: string,
  options: NormalizedConnectRollbackPlanOptions,
): string | null {
  if (!options.realPath) return null;
  let current = dirname(resolve(path));
  while (true) {
    const real = options.realPath(current);
    if (real) return real;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function validateRealTargetPath(
  target: string,
  kind: ConnectRollbackPathKind | undefined,
  options: NormalizedConnectRollbackPlanOptions,
): string | null {
  if (!options.home || !options.realPath) return null;
  const homeReal = options.realPath(options.home);
  if (!homeReal) return null;
  const targetReal =
    kind === "missing" ? nearestExistingAncestorRealPath(target, options) : options.realPath(target);
  if (targetReal && !isPathUnderRoot(targetReal, homeReal, true)) {
    return "target-outside-home";
  }
  return null;
}

function validateRealBackupPath(
  backupPath: string,
  options: NormalizedConnectRollbackPlanOptions,
): string | null {
  if (!options.backupsDir || !options.realPath) return null;
  const backupsReal = options.realPath(options.backupsDir);
  const backupReal = options.realPath(backupPath);
  if (
    backupsReal &&
    backupReal &&
    !isPathUnderRoot(backupReal, backupsReal)
  ) {
    return "backup-outside-backups";
  }
  return null;
}

function rollbackSkip(
  entry: ConnectManifestEntry,
  reason: string,
): ConnectRollbackPlanItem {
  return {
    agent: entry.agent,
    target: entry.target,
    backupPath: entry.backupPath,
    timestamp: entry.timestamp,
    runId: entry.runId,
    action: "skip",
    reason,
  };
}

function validateRollbackTarget(
  entry: ConnectManifestEntry,
  action: "restore" | "remove-created-target",
  options: NormalizedConnectRollbackPlanOptions,
): string | null {
  if (options.home && !isPathUnderRoot(entry.target, options.home)) {
    return "target-outside-home";
  }
  const kind = rollbackPathKind(entry.target, options);
  const realPathReason = validateRealTargetPath(entry.target, kind, options);
  if (realPathReason) return realPathReason;
  if (kind === "missing") {
    return action === "remove-created-target" ? "target-missing" : null;
  }
  if (kind === "symlink") return "target-symlink";
  if (kind === "directory") return "target-directory";
  if (kind === "other") return "target-kind-unsupported";
  return null;
}

function validateRollbackBackup(
  entry: ConnectManifestEntry,
  options: NormalizedConnectRollbackPlanOptions,
): string | null {
  if (!entry.backupPath) return "backup-missing";
  if (options.backupsDir && !isPathUnderRoot(entry.backupPath, options.backupsDir)) {
    return "backup-outside-backups";
  }
  const kind = rollbackPathKind(entry.backupPath, options);
  const realPathReason = validateRealBackupPath(entry.backupPath, options);
  if (realPathReason) return realPathReason;
  if (kind === "missing") return "backup-missing";
  if (kind === "symlink") return "backup-symlink";
  if (kind === "directory") return "backup-directory";
  if (kind === "other") return "backup-kind-unsupported";
  return null;
}

// Plan a rollback over an explicit set of entries (one run). Shared by the
// latest-run planner and the no-op fallback planner (#item19).
export function buildConnectRollbackPlanForEntries(
  entries: ConnectManifestEntry[],
  options?: ConnectRollbackPlanOptions,
): ConnectRollbackPlanItem[] {
  const validation = normalizeRollbackPlanOptions(options);
  return entries.map((entry) => {
    if (entry.rollback === "restore-backup" || entry.backupPath) {
      const targetReason = validateRollbackTarget(entry, "restore", validation);
      if (targetReason) return rollbackSkip(entry, targetReason);
      const backupReason = validateRollbackBackup(entry, validation);
      if (backupReason) return rollbackSkip(entry, backupReason);
      return {
        agent: entry.agent,
        target: entry.target,
        backupPath: entry.backupPath,
        timestamp: entry.timestamp,
        runId: entry.runId,
        action: "restore",
      };
    }
    if (entry.rollback === "remove-created-target" || entry.action === "created") {
      const targetReason = validateRollbackTarget(
        entry,
        "remove-created-target",
        validation,
      );
      if (targetReason) return rollbackSkip(entry, targetReason);
      return {
        agent: entry.agent,
        target: entry.target,
        timestamp: entry.timestamp,
        runId: entry.runId,
        action: "remove-created-target",
      };
    }
    return {
      agent: entry.agent,
      target: entry.target,
      timestamp: entry.timestamp,
      runId: entry.runId,
      action: "skip",
      reason: entry.action === "already-wired" ? "already-wired" : "not-rollbackable",
    };
  });
}

export function buildConnectRollbackPlan(
  manifest: ConnectManifest,
  options?: ConnectRollbackPlanOptions,
): ConnectRollbackPlanItem[] {
  return buildConnectRollbackPlanForEntries(
    latestConnectManifestEntries(manifest),
    options,
  );
}

// Build a rollback plan for the most recent run that actually has actionable
// (non-skip) entries. Returns null when no run is rollbackable. This is the
// no-op fallback: if the newest run was e.g. all `already-wired`, we look back
// to the most recent run we can actually undo (#item19).
export function buildLatestRollbackablePlan(
  manifest: ConnectManifest,
  options?: ConnectRollbackPlanOptions,
): ConnectRollbackPlanItem[] | null {
  for (const run of connectManifestRunsNewestFirst(manifest)) {
    const plan = buildConnectRollbackPlanForEntries(run, options);
    if (plan.some((item) => item.action !== "skip")) return plan;
  }
  return null;
}

export function formatConnectRollbackPlan(
  plan: ConnectRollbackPlanItem[],
): string {
  if (plan.length === 0) return "  No connect manifest entries found.";
  return plan
    .map((item, index) => {
      const label = item.agent ? `${item.agent}: ` : "";
      if (item.action === "restore") {
        return `  ${index + 1}. ${label}restore ${item.target}\n     from ${item.backupPath}`;
      }
      if (item.action === "remove-created-target") {
        return `  ${index + 1}. ${label}remove created target ${item.target}`;
      }
      return `  ${index + 1}. ${label}skip ${item.target} (${item.reason ?? "not rollbackable"})`;
    })
    .join("\n");
}

export function applyConnectRollbackPlan(
  plan: ConnectRollbackPlanItem[],
  effects: ConnectRollbackEffects,
): AppliedConnectRollbackResult[] {
  return plan.map((item) => {
    if (item.action === "skip") {
      return {
        target: item.target,
        runId: item.runId,
        status: "skipped",
        message: item.reason,
      };
    }
    if (item.action === "restore") {
      if (!item.backupPath) {
        return {
          target: item.target,
          runId: item.runId,
          status: "failed",
          message: "backup-missing",
        };
      }
      const outcome = effects.restoreBackup(item.backupPath, item.target);
      return {
        target: item.target,
        runId: item.runId,
        status: outcome.ok ? "restored" : "failed",
        ...(outcome.message !== undefined && { message: outcome.message }),
      };
    }
    const outcome = effects.removeTarget(item.target);
    return {
      target: item.target,
      runId: item.runId,
      status: outcome.ok ? "removed" : "failed",
      ...(outcome.message !== undefined && { message: outcome.message }),
    };
  });
}

export function markConnectRollbackResults(
  manifest: ConnectManifest,
  results: ConnectRollbackResult[],
  rolledBackAt = new Date().toISOString(),
): ConnectManifest {
  const resultFor = (entry: ConnectManifestEntry): ConnectRollbackResult | undefined =>
    results.find(
      (result) =>
        result.target === entry.target &&
        (result.runId === undefined || entry.runId === result.runId),
    );
  const mark = (entry: ConnectManifestEntry): ConnectManifestEntry => {
    const result = resultFor(entry);
    if (!result) return entry;
    return {
      ...entry,
      rolledBackAt,
      rollbackStatus: result.status,
    };
  };
  return {
    ...manifest,
    updatedAt: rolledBackAt,
    installed: manifest.installed.map(mark),
    history: manifest.history?.map(mark),
  };
}

export function logInstalled(label: string, target: string): void {
  p.log.success(`${label} → wired into ${target}`);
}

export function logAlreadyWired(label: string, target: string): void {
  p.log.info(`${label} already wired in ${target} (use --force to re-install)`);
}

export function logBackup(target: string): void {
  p.log.info(`Backup: ${target}`);
}
