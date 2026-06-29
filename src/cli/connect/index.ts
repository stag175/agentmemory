import { platform } from "node:os";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import { formatInspectionSummary, inspectAdapter } from "./inspect.js";
import {
  applyConnectRepairPlan,
  buildConnectRepairPlan,
  formatConnectRepairPlan,
} from "./repair.js";
import {
  createConnectRunMetadata,
  manifestEntriesForResult,
  updateConnectManifest,
  type ConnectRunMetadata,
} from "./util.js";
import {
  FRAMEWORK_ADAPTERS,
  formatFrameworkAdapterList,
  formatFrameworkSetup,
} from "./frameworks.js";
import { adapter as antigravity } from "./antigravity.js";
import { adapter as claudeCode } from "./claude-code.js";
import { adapter as cline } from "./cline.js";
import { adapter as copilotCli } from "./copilot-cli.js";
import { adapter as codex } from "./codex.js";
import { adapter as continueDev } from "./continue.js";
import { adapter as cursor } from "./cursor.js";
import { adapter as droid } from "./droid.js";
import { adapter as geminiCli } from "./gemini-cli.js";
import { adapter as hermes } from "./hermes.js";
import { adapter as kiro } from "./kiro.js";
import { adapter as openclaw } from "./openclaw.js";
import { adapter as opencode } from "./opencode.js";
import { adapter as openhuman } from "./openhuman.js";
import { adapter as pi } from "./pi.js";
import { adapter as qwen } from "./qwen.js";
import { adapter as warp } from "./warp.js";
import { adapter as zed } from "./zed.js";

export const ADAPTERS: readonly ConnectAdapter[] = [
  claudeCode,
  copilotCli,
  codex,
  cursor,
  geminiCli,
  qwen,
  antigravity,
  kiro,
  warp,
  cline,
  continueDev,
  zed,
  droid,
  opencode,
  openclaw,
  hermes,
  pi,
  openhuman,
];

export function resolveAdapter(name: string): ConnectAdapter | null {
  const lower = name.toLowerCase();
  return ADAPTERS.find((a) => a.name === lower) ?? null;
}

export function knownAgents(): string[] {
  return ADAPTERS.map((a) => a.name);
}

function parseFlags(args: string[]): {
  dryRun: boolean;
  force: boolean;
  all: boolean;
  withHooks: boolean;
  positional: string[];
} {
  const positional: string[] = [];
  let dryRun = false;
  let force = false;
  let all = false;
  let withHooks = false;
  for (const a of args) {
    if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--all") all = true;
    else if (a === "--with-hooks") withHooks = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  return { dryRun, force, all, withHooks, positional };
}

function parseDoctorFlags(args: string[]): {
  all: boolean;
  json: boolean;
  positional: string[];
} {
  const positional: string[] = [];
  let all = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--all") all = true;
    else if (arg === "--json") json = true;
    else if (!arg.startsWith("-")) positional.push(arg);
  }
  return { all, json, positional };
}

function selectAdapters(
  positional: string[],
  all: boolean,
): ConnectAdapter[] {
  if (all || positional.length === 0) return [...ADAPTERS];
  const adapter = resolveAdapter(positional[0]!);
  return adapter ? [adapter] : [];
}

export async function runAdapter(
  adapter: ConnectAdapter,
  opts: ConnectOptions,
  run: ConnectRunMetadata = createConnectRunMetadata(),
): Promise<ConnectResult> {
  if (!adapter.detect()) {
    p.log.warn(
      `${adapter.displayName}: not detected on this machine (skipping).${adapter.docs ? ` Docs: ${adapter.docs}` : ""}`,
    );
    return { kind: "skipped", reason: "not-detected" };
  }
  p.log.step(`Wiring ${adapter.displayName}…`);
  if (adapter.protocolNote) {
    p.log.message(adapter.protocolNote);
  }
  try {
    const result = await adapter.install(opts);
    if (!opts.dryRun) {
      const entries = manifestEntriesForResult(adapter, result, opts, run);
      if (entries.length > 0) {
        updateConnectManifest(entries);
      }
    }
    return result;
  } catch (err) {
    p.log.error(
      `${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "skipped", reason: "exception" };
  }
}

export async function runConnect(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand === "doctor") {
    await runConnectDoctor(args.slice(1));
    return;
  }
  if (subcommand === "repair") {
    await runConnectRepair(args.slice(1));
    return;
  }
  if (subcommand === "framework" || subcommand === "frameworks") {
    runConnectFrameworks(args.slice(1));
    return;
  }

  const { dryRun, force, all, withHooks, positional } = parseFlags(args);
  const run = createConnectRunMetadata();
  const allowWindowsAdapter =
    positional.length === 1 && positional[0]?.toLowerCase() === "copilot-cli";
  if (platform() === "win32" && !allowWindowsAdapter) {
    p.intro("agentmemory connect");
    p.log.warn(
      "Windows: automated `connect` is not supported yet. See https://github.com/rohitg00/agentmemory#other-agents for manual install steps.",
    );
    p.outro("Windows: manual install required — see docs");
    return;
  }

  const opts: ConnectOptions = { dryRun, force, withHooks };

  p.intro("agentmemory connect");

  if (positional.length === 0 && !all) {
    const detected = ADAPTERS.filter((a) => a.detect());
    if (detected.length === 0) {
      p.log.error("No supported agents detected on this machine.");
      p.outro(`Supported: ${knownAgents().join(", ")}`);
      process.exit(1);
    }
    const picked = await p.multiselect<string>({
      message: "Wire agentmemory into which agents?",
      options: detected.map((a) => ({ value: a.name, label: a.displayName })),
      required: true,
    });
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.");
      return;
    }
    const results: { name: string; result: ConnectResult }[] = [];
    for (const name of picked as string[]) {
      const adapter = resolveAdapter(name);
      if (!adapter) continue;
      results.push({ name, result: await runAdapter(adapter, opts, run) });
    }
    summarize(results);
    return;
  }

  if (all) {
    const detected = ADAPTERS.filter((a) => a.detect());
    if (detected.length === 0) {
      p.log.error("No supported agents detected on this machine.");
      process.exit(1);
    }
    const results: { name: string; result: ConnectResult }[] = [];
    for (const adapter of detected) {
      results.push({
        name: adapter.name,
        result: await runAdapter(adapter, opts, run),
      });
    }
    summarize(results);
    return;
  }

  const agentName = positional[0]!;
  const adapter = resolveAdapter(agentName);
  if (!adapter) {
    p.log.error(`Unknown agent: ${agentName}`);
    p.outro(`Supported: ${knownAgents().join(", ")}`);
    process.exit(1);
  }

  const result = await runAdapter(adapter, opts, run);
  summarize([{ name: agentName, result }]);
  if (result.kind === "skipped" && (result as { reason: string }).reason !== "not-detected") {
    process.exit(1);
  }
}

export function runConnectFrameworks(args: string[]): void {
  const json = args.includes("--json");
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const name = positional[0];

  if (json) {
    process.stdout.write(`${JSON.stringify({ adapters: FRAMEWORK_ADAPTERS }, null, 2)}\n`);
    return;
  }

  p.intro("agentmemory connect frameworks");
  if (!name) {
    p.note(formatFrameworkAdapterList(), "framework adapters");
    p.outro("Read-only helper complete.");
    return;
  }

  const setup = formatFrameworkSetup(name);
  if (!setup) {
    p.log.error(`Unknown framework adapter: ${name}`);
    p.outro("Supported: " + FRAMEWORK_ADAPTERS.map((adapter) => adapter.name).join(", "));
    process.exit(1);
  }

  p.note(setup, "framework setup");
  p.outro("Read-only helper complete. No files changed.");
}

export async function runConnectDoctor(args: string[]): Promise<void> {
  const { all, json, positional } = parseDoctorFlags(args);
  const adapters = selectAdapters(positional, all);
  if (adapters.length === 0 && positional[0]) {
    p.log.error(`Unknown agent: ${positional[0]}`);
    p.outro(`Supported: ${knownAgents().join(", ")}`);
    process.exit(1);
  }

  const inspections = adapters.map(inspectAdapter);
  if (json) {
    process.stdout.write(`${JSON.stringify({ adapters: inspections }, null, 2)}\n`);
    return;
  }

  p.intro("agentmemory connect doctor");
  p.note(formatInspectionSummary(inspections), "diagnosis");
  p.outro("Read-only diagnosis complete.");
}

export async function runConnectRepair(args: string[]): Promise<void> {
  const { dryRun, force, all, withHooks, positional } = parseFlags(args);
  const adapters = selectAdapters(positional, all);
  if (adapters.length === 0 && positional[0]) {
    p.log.error(`Unknown agent: ${positional[0]}`);
    p.outro(`Supported: ${knownAgents().join(", ")}`);
    process.exit(1);
  }

  const inspections = adapters.map(inspectAdapter);
  const plan = buildConnectRepairPlan(inspections, { force, withHooks });

  p.intro("agentmemory connect repair");
  p.note(formatConnectRepairPlan(plan), dryRun ? "dry-run plan" : "repair plan");
  if (dryRun) {
    p.outro("Dry run complete. No files changed.");
    return;
  }

  const run = createConnectRunMetadata();
  const applied = await applyConnectRepairPlan(
    plan,
    adapters,
    { dryRun: false, withHooks },
    runAdapter,
    run,
  );
  const repaired = applied.filter((item) => item.action === "repair");
  const failed = repaired.filter(
    (item) =>
      item.result?.kind === "skipped" &&
      (item.result as { reason?: string }).reason !== "not-detected",
  );
  const repairedResults: { name: string; result: ConnectResult }[] = [];
  for (const item of repaired) {
    if (item.result) repairedResults.push({ name: item.agent, result: item.result });
  }
  if (repairedResults.length > 0) {
    summarize(repairedResults);
  } else {
    p.outro("No auto-repairable connect issues found.");
  }
  if (failed.length > 0) process.exit(1);
}

function summarize(
  results: { name: string; result: ConnectResult }[],
): void {
  const lines = results.map(({ name, result }) => {
    switch (result.kind) {
      case "installed":
        return `  ✓ ${name}${result.mutatedPath ? ` → ${result.mutatedPath}` : ""}`;
      case "already-wired":
        return `  ✓ ${name} (already wired)`;
      case "stub":
        return `  ⚠ ${name} (manual install required: ${result.reason})`;
      case "skipped":
        return `  ✗ ${name} (skipped: ${result.reason})`;
    }
  });
  p.note(lines.join("\n"), "summary");

  const stubs = results.filter((r) => r.result.kind === "stub");
  if (stubs.length > 0) {
    p.log.info(
      `${stubs.length} agent(s) require manual install — see docs links above.`,
    );
  }

  const wiredAny = results.some(
    (r) => r.result.kind === "installed" || r.result.kind === "already-wired",
  );
  if (wiredAny) {
    p.log.info(
      "Next: install agentmemory's 15 skills into the same agent(s) so they know when to call the tools:\n  npx skills add rohitg00/agentmemory -y",
    );
  }

  p.outro("Restart any wired agent (or open a new session) to pick up agentmemory.");
}
