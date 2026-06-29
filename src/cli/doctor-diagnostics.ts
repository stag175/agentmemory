// Doctor v2 diagnostic catalog.
//
// Each entry is a self-describing diagnostic: a check function that returns
// `{ ok, detail? }`, a human-readable message, an inline fix preview, and
// an `apply` function that runs the fix. The list is exported as a pure
// data structure so unit tests can assert on shape without bringing
// @clack/prompts into the test harness.
//
// The runtime (src/cli.ts -> runDoctor) iterates the list, prompts the user
// per check, and only re-runs the SAME diagnostic after a fix — never the
// whole suite. Each fix returns `{ ok, message? }` so we can show a one-line
// outcome before moving on.
//
// Doctor v2 surface:
//   agentmemory doctor             # interactive: Fix/Skip/More/Quit per failed check
//   agentmemory doctor --all       # apply every available fix without prompting (CI)
//   agentmemory doctor --dry-run   # show what each fix WOULD do; execute nothing

export type DiagnosticStatus = {
  ok: boolean;
  /** Short status detail (one line). Shown alongside the check name. */
  detail?: string;
};

export type DiagnosticFixResult = {
  ok: boolean;
  message?: string;
};

export type DoctorContext = {
  /** Base URL for the running engine, e.g. http://localhost:3111 */
  baseUrl: string;
  /** Viewer URL, e.g. http://localhost:3113 */
  viewerUrl: string;
  /** Path to ~/.agentmemory/.env */
  envPath: string;
  /** Path to ~/.agentmemory/iii.pid */
  pidfilePath: string;
  /** Path to ~/.agentmemory/engine-state.json */
  enginePath: string;
  /** Pinned engine version (e.g. "0.11.2"). */
  pinnedVersion: string;
};

export type Diagnostic = {
  /** Stable id. Used in --json and tests. */
  id: string;
  /** One-line problem statement shown to the user. */
  message: string;
  /** One-line description of WHAT the fix will do. Shown before the prompt. */
  fixPreview: string;
  /** Longer explanation shown when the user picks [?] More info. */
  moreInfo: string;
  /** Run the check; return ok=true if everything's fine, ok=false otherwise. */
  check: (ctx: DoctorContext) => Promise<DiagnosticStatus>;
  /** Apply the fix. Returns ok=true on success. */
  fix: (ctx: DoctorContext) => Promise<DiagnosticFixResult>;
  /** True when there's nothing to auto-fix (we only suggest). */
  manualOnly?: boolean;
};

// Diagnostic ids are stable for testing and machine-readable doctor output.
export const DIAGNOSTIC_IDS = [
  "env-missing",
  "no-llm-provider-key",
  "engine-version-mismatch",
  "viewer-unreachable",
  "stale-pidfile",
  "env-placeholder-keys",
  "iii-on-path-not-local-bin",
] as const;

export type DiagnosticId = (typeof DIAGNOSTIC_IDS)[number];

// Pure helpers (no I/O) — exported for direct unit testing.
// ---------------------------------------------------------------------------

/** Common placeholder values shipped in .env.example. */
const PLACEHOLDER_VALUES = new Set([
  "",
  "your-key-here",
  "sk-ant-...",
  "sk-...",
  "changeme",
  "todo",
  "xxx",
]);

const PROVIDER_KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
] as const;

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Returns the list of provider keys that look real (non-placeholder). */
export function realProviderKeys(env: Record<string, string>): string[] {
  return PROVIDER_KEY_NAMES.filter((k) => {
    const v = (env[k] ?? "").trim();
    if (!v) return false;
    if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return false;
    // Reject values that are just dots/placeholders like "xxxx-xxxx".
    if (/^x+$/i.test(v.replace(/[-_]/g, ""))) return false;
    return true;
  });
}

/** Returns the list of provider key NAMES that exist but are placeholders. */
export function placeholderProviderKeys(env: Record<string, string>): string[] {
  return PROVIDER_KEY_NAMES.filter((k) => {
    const v = (env[k] ?? "").trim();
    if (!v) return false;
    if (PLACEHOLDER_VALUES.has(v.toLowerCase())) return true;
    if (/^x+$/i.test(v.replace(/[-_]/g, ""))) return true;
    return false;
  });
}

/**
 * Build the canonical diagnostic catalog.
 *
 * The factory takes the side-effect helpers as injected functions so tests
 * can swap them with stubs. Production callers pass real implementations
 * from src/cli.ts.
 */
export type DoctorEffects = {
  /** Does ~/.agentmemory/.env exist? */
  envFileExists: () => boolean;
  /** Read ~/.agentmemory/.env and return parsed key=value pairs. */
  readEnvFile: () => Record<string, string>;
  /** Is the iii engine PID in the pidfile still alive? */
  pidfilePidIsAlive: () => boolean | null;
  /** Does the pidfile exist on disk? */
  pidfileExists: () => boolean;
  /** Resolve the iii binary on PATH; return null if not found. */
  findIiiBinary: () => string | null;
  /** Path to ~/.agentmemory/bin/iii (the private install location). */
  localBinIiiPath: () => string;
  /** Run `iii --version`; null if it fails. */
  iiiBinaryVersion: (binPath: string) => string | null;
  /** Probe the viewer URL; true if it returns OK within timeoutMs. */
  viewerReachable: (timeoutMs?: number) => Promise<boolean>;
  /** Run init logic (copies .env.example). */
  runInit: () => Promise<DiagnosticFixResult>;
  /** Open a file in $EDITOR (or fallback). Resolves when editor exits. */
  openEditor: (path: string) => Promise<DiagnosticFixResult>;
  /** Run the iii installer. */
  runIiiInstaller: () => Promise<DiagnosticFixResult>;
  /** Stop the running engine cleanly. */
  runStop: () => Promise<DiagnosticFixResult>;
  /** Start the engine (waits for /livez). */
  runStart: () => Promise<DiagnosticFixResult>;
  /** Clear pidfile + engine-state. */
  clearEnginePidAndState: () => void;
};

export function buildDiagnostics(effects: DoctorEffects): Diagnostic[] {
  return [
    {
      id: "env-missing",
      message: "~/.agentmemory/.env is missing.",
      fixPreview: "Copy .env.example into ~/.agentmemory/.env (your keys file).",
      moreInfo:
        "agentmemory reads provider API keys (Anthropic, OpenAI, Gemini, …) from ~/.agentmemory/.env. " +
        "Without this file the daemon falls back to BM25-only search and no LLM-backed enrichment runs.",
      check: async () => ({
        ok: effects.envFileExists(),
        detail: effects.envFileExists() ? undefined : "no env file",
      }),
      fix: () => effects.runInit(),
    },
    {
      id: "no-llm-provider-key",
      message: "No LLM provider API key found in ~/.agentmemory/.env.",
      fixPreview: "Open ~/.agentmemory/.env in $EDITOR and paste your key, then re-check.",
      moreInfo:
        "Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, " +
        "OPENROUTER_API_KEY, MINIMAX_API_KEY. The daemon picks the first that resolves " +
        "to a real (non-placeholder) value at startup.",
      check: async () => {
        if (!effects.envFileExists()) {
          return { ok: false, detail: "env file missing (run env-missing fix first)" };
        }
        const env = effects.readEnvFile();
        const real = realProviderKeys(env);
        return {
          ok: real.length > 0,
          detail: real.length > 0 ? `found: ${real.join(", ")}` : "no provider key set",
        };
      },
      fix: (ctx) => effects.openEditor(ctx.envPath),
    },
    {
      id: "engine-version-mismatch",
      message: "iii binary on PATH doesn't match the version agentmemory pins to.",
      fixPreview:
        "Re-run the iii installer for the pinned version and restart the engine.",
      moreInfo:
        "agentmemory pins the iii engine to a specific release because newer engines " +
        "use a different worker model. Running a mismatched binary surfaces as EPIPE " +
        "reconnect loops and empty search results.",
      check: async (ctx) => {
        const bin = effects.findIiiBinary();
        if (!bin) return { ok: false, detail: "iii not on PATH" };
        const v = effects.iiiBinaryVersion(bin);
        if (!v) return { ok: false, detail: "iii on PATH but --version failed" };
        return {
          ok: v === ctx.pinnedVersion,
          detail: `${v} (pinned ${ctx.pinnedVersion})`,
        };
      },
      fix: async () => {
        const r = await effects.runIiiInstaller();
        if (!r.ok) return r;
        // Best-effort restart: stop then start.
        await effects.runStop();
        return effects.runStart();
      },
    },
    {
      id: "viewer-unreachable",
      message: "Viewer port not reachable.",
      fixPreview: "Stop the engine, restart it, and retry the viewer probe.",
      moreInfo:
        "The viewer is served on REST port + 2 (default 3113). If it never came up " +
        "the most common cause is port collision; a sibling PR ships auto-bump for " +
        "this case. If that lands first this check just verifies; otherwise restart " +
        "the engine to retry binding.",
      check: async () => ({
        ok: await effects.viewerReachable(),
        detail: undefined,
      }),
      fix: async () => {
        const stopped = await effects.runStop();
        if (!stopped.ok) return stopped;
        return effects.runStart();
      },
    },
    {
      id: "stale-pidfile",
      message: "Stale pidfile: pid recorded but the process is gone.",
      fixPreview: "Clear ~/.agentmemory/iii.pid + engine-state.json, then restart.",
      moreInfo:
        "When the engine crashes hard (kill -9, OOM, host reboot) the pidfile sticks " +
        "around. agentmemory refuses to start a second engine on top of a stale pid, " +
        "so this state must be cleared explicitly.",
      check: async () => {
        if (!effects.pidfileExists()) return { ok: true, detail: "no pidfile" };
        const alive = effects.pidfilePidIsAlive();
        if (alive === null) return { ok: true, detail: "pidfile unreadable" };
        return {
          ok: alive,
          detail: alive ? "pid is alive" : "pid is gone",
        };
      },
      fix: async () => {
        effects.clearEnginePidAndState();
        return effects.runStart();
      },
    },
    {
      id: "env-placeholder-keys",
      message: "~/.agentmemory/.env contains placeholder/empty API keys.",
      fixPreview: "Open ~/.agentmemory/.env in $EDITOR to paste real values.",
      moreInfo:
        "Lines like ANTHROPIC_API_KEY=sk-ant-... or =your-key-here are treated as " +
        "absent. The daemon will fall back to BM25-only search. Replace placeholders " +
        "with real keys or comment the line out.",
      check: async () => {
        if (!effects.envFileExists()) {
          return { ok: true, detail: "env file missing (handled by env-missing)" };
        }
        const env = effects.readEnvFile();
        const placeholders = placeholderProviderKeys(env);
        return {
          ok: placeholders.length === 0,
          detail:
            placeholders.length === 0
              ? undefined
              : `placeholder: ${placeholders.join(", ")}`,
        };
      },
      fix: (ctx) => effects.openEditor(ctx.envPath),
    },
    {
      id: "iii-on-path-not-local-bin",
      message:
        "iii is on PATH but not at agentmemory's private install path.",
      fixPreview:
        "Install the pinned version to ~/.agentmemory/bin — won't touch your PATH.",
      moreInfo:
        "agentmemory installs its pinned engine to ~/.agentmemory/bin/iii so a " +
        "user-managed iii on PATH (homebrew, cargo, manual install) stays untouched. " +
        "When agentmemory needs the pin and PATH doesn't have it, it falls back to the " +
        "private install. If neither exists, run the installer.",
      manualOnly: true,
      check: async () => {
        const bin = effects.findIiiBinary();
        if (!bin) return { ok: true, detail: "iii not on PATH (handled elsewhere)" };
        const localBin = effects.localBinIiiPath();
        return {
          ok: bin === localBin,
          detail: bin === localBin ? undefined : `iii at: ${bin}`,
        };
      },
      fix: async () =>
        effects.runIiiInstaller().then((r) => ({
          ok: r.ok,
          message:
            r.message ??
            "Installer wrote to ~/.agentmemory/bin/iii. Your PATH wasn't modified.",
        })),
    },
  ];
}

export type DoctorRunMode = "interactive" | "all" | "dry-run";

/**
 * Run all diagnostics and return their initial status (no fixes applied).
 * Useful for tests and for `--dry-run` mode.
 */
export async function runAllChecks(
  ctx: DoctorContext,
  diagnostics: Diagnostic[],
): Promise<Array<{ diagnostic: Diagnostic; status: DiagnosticStatus }>> {
  const results: Array<{ diagnostic: Diagnostic; status: DiagnosticStatus }> = [];
  for (const d of diagnostics) {
    const status = await d.check(ctx);
    results.push({ diagnostic: d, status });
  }
  return results;
}

/**
 * Dry-run output: each failing check's fix preview, prefixed by the diagnostic
 * message. Pure function so we can snapshot-test the format.
 */
export function dryRunPlan(
  ctx: DoctorContext,
  results: Array<{ diagnostic: Diagnostic; status: DiagnosticStatus }>,
): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const { diagnostic, status } of results) {
    if (status.ok) continue;
    n++;
    lines.push(`${n}. [${diagnostic.id}] ${diagnostic.message}`);
    lines.push(`   would fix: ${diagnostic.fixPreview}`);
    if (status.detail) lines.push(`   detail: ${status.detail}`);
  }
  if (lines.length === 0) {
    lines.push(`All checks passing for ${ctx.baseUrl} — no fixes to run.`);
  }
  return lines;
}

export type ReleaseGateCliStatus = "pass" | "fail" | "blocked" | "not_run";

export type ReleaseGateCliKey =
  | "build"
  | "test"
  | "docs"
  | "packSmoke"
  | "redactionForget"
  | "retrievalScope"
  | "restMcpParity";

export type ReleaseGateCliEvidence = Partial<
  Record<
    ReleaseGateCliKey,
    {
      status?: ReleaseGateCliStatus;
      message?: string;
      evidence?: string[];
      failures?: string[];
      blockers?: string[];
    }
  >
>;

export type DiagnoseCliPlan = {
  help: boolean;
  json: boolean;
  releaseGate: boolean;
  payload: {
    categories?: string[];
    releaseGateEvidence?: ReleaseGateCliEvidence;
  };
};

export type ReleaseGateCliCheck = {
  status: ReleaseGateCliStatus;
  message: string;
  evidence?: string[];
  failures?: string[];
  blockers?: string[];
  nextAction?: string;
};

export type ReleaseGateCliReport = {
  overall: ReleaseGateCliStatus;
  summary?: Record<ReleaseGateCliStatus, number>;
  checks?: Partial<Record<ReleaseGateCliKey, ReleaseGateCliCheck>>;
  blockingFindings?: Array<
    ReleaseGateCliCheck & {
      key: ReleaseGateCliKey;
    }
  >;
  nextActions?: string[];
};

export type VersionsReport = {
  agentmemoryVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  rest: {
    baseUrl: string;
    reachable: boolean;
    version?: string;
    status?: string;
    error?: string;
  };
  iii: {
    pinnedVersion: string;
    override: boolean;
  };
  tools: {
    all: number;
    core: number;
  };
};

type CliFlags = Record<string, string | boolean | string[]>;

const RELEASE_GATE_CLI_STATUSES = new Set<ReleaseGateCliStatus>([
  "pass",
  "fail",
  "blocked",
  "not_run",
]);

const RELEASE_GATE_CLI_KEYS: ReleaseGateCliKey[] = [
  "build",
  "test",
  "docs",
  "packSmoke",
  "redactionForget",
  "retrievalScope",
  "restMcpParity",
];

const RELEASE_GATE_FLAG_NAMES: Record<ReleaseGateCliKey, string> = {
  build: "build",
  test: "test",
  docs: "docs",
  packSmoke: "pack-smoke",
  redactionForget: "redaction-forget",
  retrievalScope: "retrieval-scope",
  restMcpParity: "rest-mcp-parity",
};

export const DIAGNOSE_CLI_HELP = `Usage:
  agentmemory diagnose [--json] [--categories a,b]
  agentmemory diagnose --categories security [--json]
  agentmemory diagnose --release-gate [--json] [--build status] [--test status] [--docs status] [--pack-smoke status] [--rest-mcp-parity status]

Categories: actions, leases, sentinels, sketches, signals, sessions, memories, lessons, summaries, semantic, procedural, crystals, insights, mesh, security.
Security diagnostics include encryption readiness; JSON responses include security.encryption when the daemon supports it.
Release gate statuses: pass, fail, blocked, not_run.
Evidence flags: --<check>-message text, --<check>-evidence text, --<check>-failure text, --<check>-blocker text.
`;

export function parseCliFlags(argv: string[]): {
  positionals: string[];
  flags: CliFlags;
} {
  const positionals: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      addCliFlag(flags, raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addCliFlag(flags, raw, next);
      i++;
    } else {
      addCliFlag(flags, raw, true);
    }
  }
  return { positionals, flags };
}

function addCliFlag(flags: CliFlags, key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  flags[key] = Array.isArray(existing)
    ? [...existing, String(value)]
    : [String(existing), String(value)];
}

function cliFlagValue(flags: CliFlags, key: string): string | boolean | string[] | undefined {
  return flags[key];
}

function cliString(flags: CliFlags, key: string): string | undefined {
  const value = cliFlagValue(flags, key);
  if (Array.isArray(value)) return value[value.length - 1]?.trim() || undefined;
  if (typeof value === "string") return value.trim() || undefined;
  return undefined;
}

function cliStringList(flags: CliFlags, key: string): string[] {
  const value = cliFlagValue(flags, key);
  if (value === undefined || typeof value === "boolean") return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => item.trim()).filter(Boolean);
}

function csv(value: string | undefined): string[] | undefined {
  const values = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function asReleaseGateCliStatus(value: string, flag: string): ReleaseGateCliStatus {
  if (RELEASE_GATE_CLI_STATUSES.has(value as ReleaseGateCliStatus)) {
    return value as ReleaseGateCliStatus;
  }
  throw new Error(`--${flag} must be one of: pass, fail, blocked, not_run`);
}

export function buildDiagnoseCliPlan(argv: string[]): DiagnoseCliPlan {
  const { flags } = parseCliFlags(argv);
  const help = flags.help === true || flags.h === true;
  const json = flags.json === true;
  const releaseGate = flags["release-gate"] === true;
  const categories = csv(cliString(flags, "categories") ?? cliString(flags, "category"));
  const releaseGateEvidence: ReleaseGateCliEvidence = {};

  for (const key of RELEASE_GATE_CLI_KEYS) {
    const flag = RELEASE_GATE_FLAG_NAMES[key];
    const rawStatus = cliString(flags, flag);
    const message = cliString(flags, `${flag}-message`);
    const evidence = cliStringList(flags, `${flag}-evidence`);
    const failures = cliStringList(flags, `${flag}-failure`);
    const blockers = cliStringList(flags, `${flag}-blocker`);
    if (
      rawStatus === undefined &&
      message === undefined &&
      evidence.length === 0 &&
      failures.length === 0 &&
      blockers.length === 0
    ) {
      continue;
    }
    if (rawStatus === undefined) {
      throw new Error(`--${flag} status is required when supplying ${flag} evidence`);
    }
    releaseGateEvidence[key] = {
      status: asReleaseGateCliStatus(rawStatus, flag),
      ...(message !== undefined && { message }),
      ...(evidence.length > 0 && { evidence }),
      ...(failures.length > 0 && { failures }),
      ...(blockers.length > 0 && { blockers }),
    };
  }

  return {
    help,
    json,
    releaseGate,
    payload: {
      ...(categories && { categories }),
      ...(Object.keys(releaseGateEvidence).length > 0 && { releaseGateEvidence }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type DiagnoseCheckStatus = "pass" | "warn" | "fail";

type DiagnoseCliCheck = {
  name: string;
  category: string;
  status: DiagnoseCheckStatus;
  message: string;
  fixable?: boolean;
};

const DIAGNOSE_CHECK_STATUSES = new Set<DiagnoseCheckStatus>([
  "pass",
  "warn",
  "fail",
]);

function extractDiagnoseChecks(result: unknown): DiagnoseCliCheck[] {
  if (!isRecord(result) || !Array.isArray(result.checks)) return [];
  return result.checks.flatMap((item) => {
    if (!isRecord(item)) return [];
    const { name, category, status, message, fixable } = item;
    if (
      typeof name !== "string" ||
      typeof category !== "string" ||
      typeof message !== "string" ||
      !DIAGNOSE_CHECK_STATUSES.has(status as DiagnoseCheckStatus)
    ) {
      return [];
    }
    return [
      {
        name,
        category,
        status: status as DiagnoseCheckStatus,
        message,
        ...(typeof fixable === "boolean" && { fixable }),
      },
    ];
  });
}

function diagnosticFindings(result: unknown): DiagnoseCliCheck[] {
  return extractDiagnoseChecks(result).filter((check) => check.status !== "pass");
}

function formatDiagnosticCheck(check: DiagnoseCliCheck): string {
  return `- ${check.name} [${check.status}]: ${check.message}${check.fixable ? " (fixable)" : ""}`;
}

function appendDiagnosticSections(
  lines: string[],
  result: unknown,
  options: { includePassingSecurity: boolean },
): void {
  const checks = extractDiagnoseChecks(result);
  const securityChecks = checks.filter((check) => check.category === "security");
  const visibleSecurityChecks = options.includePassingSecurity
    ? securityChecks
    : securityChecks.filter((check) => check.status !== "pass");

  if (visibleSecurityChecks.length > 0) {
    lines.push("Security:");
    for (const check of visibleSecurityChecks) {
      lines.push(formatDiagnosticCheck(check));
    }
  }

  const findings = checks.filter(
    (check) => check.status !== "pass" && check.category !== "security",
  );
  if (findings.length > 0) {
    lines.push("Diagnostic findings:");
    for (const check of findings) {
      lines.push(formatDiagnosticCheck(check));
    }
  }
}

export function extractReleaseGateReport(result: unknown): ReleaseGateCliReport | null {
  if (!isRecord(result) || !isRecord(result.releaseGate)) return null;
  const gate = result.releaseGate;
  const overall = gate.overall;
  if (!RELEASE_GATE_CLI_STATUSES.has(overall as ReleaseGateCliStatus)) return null;
  return gate as ReleaseGateCliReport;
}

export function releaseGateExitCode(report: ReleaseGateCliReport | null): number {
  return report?.overall === "pass" ? 0 : 1;
}

export function formatDiagnoseJson(result: unknown, releaseGateOnly: boolean): string {
  const gate = releaseGateOnly ? extractReleaseGateReport(result) : null;
  const findings = releaseGateOnly ? diagnosticFindings(result) : [];
  const value = releaseGateOnly
    ? gate
      ? {
          ...gate,
          ...(findings.length > 0 && { diagnosticFindings: findings }),
        }
      : {
          success: false,
          error: "releaseGate unavailable in diagnostics response",
        }
    : result;
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatDiagnoseText(result: unknown, releaseGateOnly: boolean): string {
  const gate = extractReleaseGateReport(result);
  const lines: string[] = [];
  if (!releaseGateOnly && isRecord(result) && isRecord(result.summary)) {
    const summary = result.summary as Record<string, unknown>;
    lines.push(
      `Diagnostics: pass=${summary.pass ?? 0}, warn=${summary.warn ?? 0}, fail=${summary.fail ?? 0}, fixable=${summary.fixable ?? 0}`,
    );
  }
  const appendReleaseGateDiagnostics = () => {
    if (releaseGateOnly) {
      appendDiagnosticSections(lines, result, { includePassingSecurity: false });
    }
  };
  if (!releaseGateOnly) {
    appendDiagnosticSections(lines, result, { includePassingSecurity: true });
  }
  if (!gate) {
    if (releaseGateOnly) lines.push("Release gate: unavailable");
    appendReleaseGateDiagnostics();
    return lines.join("\n");
  }
  lines.push(`Release gate: ${gate.overall}`);
  if (gate.summary) {
    lines.push(
      `Summary: pass=${gate.summary.pass}, fail=${gate.summary.fail}, blocked=${gate.summary.blocked}, not_run=${gate.summary.not_run}`,
    );
  }
  const findingsFromChecks = RELEASE_GATE_CLI_KEYS.flatMap((key) => {
    const check = gate.checks?.[key];
    return check && check.status !== "pass" ? [{ key, ...check }] : [];
  });
  const findings =
    gate.blockingFindings && gate.blockingFindings.length > 0
      ? gate.blockingFindings
      : findingsFromChecks;
  if (findings.length === 0) {
    lines.push("Blocking findings: none");
    appendReleaseGateDiagnostics();
    return lines.join("\n");
  }
  lines.push("Blocking findings:");
  for (const finding of findings) {
    lines.push(`- ${finding.key} [${finding.status}]: ${finding.message}`);
    if (finding.failures?.length) {
      lines.push(`  failures: ${finding.failures.join("; ")}`);
    }
    if (finding.blockers?.length) {
      lines.push(`  blockers: ${finding.blockers.join("; ")}`);
    }
    if (finding.nextAction) {
      lines.push(`  next: ${finding.nextAction}`);
    }
  }
  appendReleaseGateDiagnostics();
  return lines.join("\n");
}

export function buildVersionsReport(input: {
  agentmemoryVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  baseUrl: string;
  pinnedIiiVersion: string;
  iiiVersionOverridden: boolean;
  allToolsCount: number;
  coreToolsCount: number;
  restHealth?: unknown;
  restError?: string;
}): VersionsReport {
  const restHealth = isRecord(input.restHealth) ? input.restHealth : undefined;
  return {
    agentmemoryVersion: input.agentmemoryVersion,
    nodeVersion: input.nodeVersion,
    platform: input.platform,
    arch: input.arch,
    rest: {
      baseUrl: input.baseUrl,
      reachable: Boolean(restHealth),
      ...(typeof restHealth?.version === "string" && { version: restHealth.version }),
      ...(typeof restHealth?.status === "string" && { status: restHealth.status }),
      ...(!restHealth && input.restError && { error: input.restError }),
    },
    iii: {
      pinnedVersion: input.pinnedIiiVersion,
      override: input.iiiVersionOverridden,
    },
    tools: {
      all: input.allToolsCount,
      core: input.coreToolsCount,
    },
  };
}

export function formatVersionsReport(report: VersionsReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `agentmemory: ${report.agentmemoryVersion}`,
    `node: ${report.nodeVersion}`,
    `platform: ${report.platform}/${report.arch}`,
    `iii pinned: ${report.iii.pinnedVersion}${report.iii.override ? " (env override)" : ""}`,
    `REST: ${report.rest.reachable ? `${report.rest.version ?? "?"} at ${report.rest.baseUrl} (${report.rest.status ?? "unknown"})` : `unreachable at ${report.rest.baseUrl}`}`,
    `tools: ${report.tools.all} all, ${report.tools.core} core`,
  ].join("\n");
}
