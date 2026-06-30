import { createHash } from "node:crypto";
import { lstat, readdir, readFile as nodeReadFile, realpath as nodeRealpath } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ISdk } from "iii-sdk";

export type RuleHost =
  | "codex"
  | "claude"
  | "cursor"
  | "cline"
  | "roo"
  | "windsurf"
  | "devin"
  | "conventions"
  | "custom";

export type RuleSourceKind =
  | "agents-md"
  | "claude-md"
  | "cursor-rules"
  | "cline-rules"
  | "roo-rules"
  | "windsurf-rules"
  | "devin-rules"
  | "conventions-md"
  | "custom-glob";

export type RuleActivationMode =
  | "always"
  | "glob"
  | "agent-requested"
  | "manual"
  | "unknown";

export type RuleScopeKind = "workspace" | "directory" | "glob";

export type RuleResolverWarningCode =
  | "workspace_missing"
  | "workspace_not_directory"
  | "workspace_symlink"
  | "unreadable_directory"
  | "unreadable_file"
  | "oversized_file"
  | "symlink_skipped"
  | "outside_workspace";

export interface RuleActivation {
  mode: RuleActivationMode;
  globs: string[];
  description?: string;
}

export interface RuleScope {
  kind: RuleScopeKind;
  path: string;
  globs: string[];
}

export interface RuleMetadata {
  bytes: number;
  mtimeMs: number;
  mtimeIso: string;
  contentHash: string;
  staleHint: "fresh" | "aged" | "old" | "unknown";
}

export interface NormalizedRuleRecord {
  id: string;
  host: RuleHost;
  sourceKind: RuleSourceKind;
  sourcePath: string;
  relativePath: string;
  scope: RuleScope;
  precedence: number;
  activation: RuleActivation;
  contentHash: string;
  metadata: RuleMetadata;
  content: string;
}

export interface RuleResolverWarning {
  code: RuleResolverWarningCode;
  message: string;
  path?: string;
  relativePath?: string;
}

export interface RulesResolution {
  workspaceRoot: string;
  scannedAt: string;
  rules: NormalizedRuleRecord[];
  warnings: RuleResolverWarning[];
}

export interface RulesResolverOptions {
  instructionGlobs?: string[];
  ignoreDirectories?: string[];
  maxDepth?: number;
  maxFileBytes?: number;
  now?: Date;
  readFile?: (path: string) => Promise<Buffer | string>;
}

export interface RulesResolvePayload {
  workspaceRoot: string;
  instructionGlobs?: string[];
  ignoreDirectories?: string[];
  maxDepth?: number;
  maxFileBytes?: number;
  includeContent: boolean;
}

export type RulesResolveResult =
  | ({
      success: true;
      includeContent: boolean;
      rules: Array<NormalizedRuleRecord | Omit<NormalizedRuleRecord, "content">>;
    } & Omit<RulesResolution, "rules">)
  | {
      success: false;
      code: "invalid_input" | "forbidden_root";
      error: string;
    };

export interface RulesResolveRequestOptions {
  defaultCwd?: string;
  /**
   * Absolute roots that a requested workspaceRoot must resolve inside of.
   * Defaults to [defaultCwd ?? process.cwd()] when not provided.
   */
  allowedRoots?: string[];
  /**
   * When true, caller-supplied instructionGlobs and includeContent are honored.
   * Defaults to false so untrusted/network callers cannot widen the scan surface
   * or request raw rule content. In-process callers pass true explicitly.
   */
  allowCallerOptions?: boolean;
}

interface SourceDefinition {
  host: RuleHost;
  kind: RuleSourceKind;
}

interface CandidateRule {
  source: SourceDefinition;
  scopeRoot: string;
}

interface Frontmatter {
  alwaysApply?: string | string[];
  always_apply?: string | string[];
  globs?: string | string[];
  glob?: string | string[];
  description?: string | string[];
  activation?: string | string[];
  apply?: string | string[];
  when?: string | string[];
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const MAX_PUBLIC_MAX_DEPTH = 50;
const MAX_PUBLIC_FILE_BYTES = 1024 * 1024;
const MAX_PUBLIC_GLOBS = 50;
const MAX_PUBLIC_GLOB_LENGTH = 512;
const STALE_AGED_DAYS = 90;
const STALE_OLD_DAYS = 365;

const DEFAULT_IGNORE_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const FILE_SOURCES = new Map<string, SourceDefinition>([
  ["AGENTS.md", { host: "codex", kind: "agents-md" }],
  ["CLAUDE.md", { host: "claude", kind: "claude-md" }],
  [".clinerules", { host: "cline", kind: "cline-rules" }],
  ["CONVENTIONS.md", { host: "conventions", kind: "conventions-md" }],
]);

const RULE_DIRECTORY_SOURCES: Array<{
  marker: string;
  source: SourceDefinition;
}> = [
  { marker: ".cursor/rules", source: { host: "cursor", kind: "cursor-rules" } },
  { marker: ".clinerules", source: { host: "cline", kind: "cline-rules" } },
  { marker: ".roo/rules", source: { host: "roo", kind: "roo-rules" } },
  { marker: ".windsurf/rules", source: { host: "windsurf", kind: "windsurf-rules" } },
  { marker: ".devin/rules", source: { host: "devin", kind: "devin-rules" } },
];

const HOST_PRECEDENCE: Record<RuleHost, number> = {
  conventions: 10,
  custom: 20,
  devin: 30,
  windsurf: 35,
  roo: 40,
  cline: 45,
  cursor: 50,
  claude: 60,
  codex: 70,
};

const registeredRulesResolverSdks = new WeakSet<object>();

export function registerRulesResolverFunction(
  sdk: Pick<ISdk, "registerFunction">,
  options: { allowedRoots?: string[] } = {},
): void {
  const key = sdk as object;
  if (registeredRulesResolverSdks.has(key)) return;
  registeredRulesResolverSdks.add(key);
  const allowedRoots = options.allowedRoots;
  sdk.registerFunction("mem::rules-resolve", async (data: unknown) =>
    resolveRulesRequest(data, {
      defaultCwd: process.cwd(),
      ...(allowedRoots !== undefined && { allowedRoots }),
    }),
  );
}

export function normalizeRulesResolveInput(
  raw: unknown,
  options: { defaultCwd?: string } = {},
): RulesResolvePayload {
  const input = isPlainRecord(raw) ? raw : {};
  const workspaceRoot = normalizeWorkspaceRoot(input, options.defaultCwd ?? process.cwd());
  const instructionGlobs = normalizeGlobList(input["instructionGlobs"], "instructionGlobs");
  const ignoreDirectories = normalizePlainStringList(input["ignoreDirectories"], "ignoreDirectories");
  const maxDepth = normalizeOptionalInteger(input["maxDepth"], "maxDepth", {
    min: 0,
    max: MAX_PUBLIC_MAX_DEPTH,
  });
  const maxBytes = normalizeOptionalInteger(
    input["maxBytes"] ?? input["maxFileBytes"],
    "maxBytes",
    { min: 1, max: MAX_PUBLIC_FILE_BYTES },
  );
  const includeContent = normalizeOptionalBoolean(input["includeContent"], "includeContent") ?? false;

  return {
    workspaceRoot,
    ...(instructionGlobs !== undefined && { instructionGlobs }),
    ...(ignoreDirectories !== undefined && { ignoreDirectories }),
    ...(maxDepth !== undefined && { maxDepth }),
    ...(maxBytes !== undefined && { maxFileBytes: maxBytes }),
    includeContent,
  };
}

export async function resolveRulesRequest(
  raw: unknown,
  options: RulesResolveRequestOptions = {},
): Promise<RulesResolveResult> {
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const allowCallerOptions = options.allowCallerOptions === true;
  let payload: RulesResolvePayload;
  try {
    payload = normalizeRulesResolveInput(raw, { defaultCwd });
    await assertWorkspaceDirectory(payload.workspaceRoot);
  } catch (error) {
    return {
      success: false,
      code: "invalid_input",
      error: errorMessage(error),
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await assertRootWithinAllowed(
      payload.workspaceRoot,
      options.allowedRoots ?? [defaultCwd],
    );
  } catch (error) {
    return {
      success: false,
      code: "forbidden_root",
      error: errorMessage(error),
    };
  }

  const includeContent = allowCallerOptions ? payload.includeContent : false;
  const instructionGlobs = allowCallerOptions ? payload.instructionGlobs : undefined;

  const resolution = await resolveWorkspaceRules(canonicalRoot, {
    instructionGlobs,
    ignoreDirectories: payload.ignoreDirectories,
    maxDepth: payload.maxDepth,
    maxFileBytes: payload.maxFileBytes,
  });

  return {
    success: true,
    includeContent,
    workspaceRoot: resolution.workspaceRoot,
    scannedAt: resolution.scannedAt,
    rules: includeContent
      ? resolution.rules
      : resolution.rules.map(stripRuleContent),
    warnings: resolution.warnings,
  };
}

export async function resolveWorkspaceRules(
  workspaceRoot: string,
  options: RulesResolverOptions = {},
): Promise<RulesResolution> {
  const root = resolve(workspaceRoot);
  const now = options.now ?? new Date();
  const warnings: RuleResolverWarning[] = [];
  const readFile = options.readFile ?? nodeReadFile;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const ignoreDirectories = new Set([
    ...DEFAULT_IGNORE_DIRECTORIES,
    ...(options.ignoreDirectories ?? []),
  ]);
  const customMatchers = (options.instructionGlobs ?? []).map(globToRegExp);

  let rootStats: Stats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    warnings.push({
      code: "workspace_missing",
      path: root,
      message: `Workspace root could not be read: ${errorMessage(error)}`,
    });
    return {
      workspaceRoot: root,
      scannedAt: now.toISOString(),
      rules: [],
      warnings,
    };
  }

  if (rootStats.isSymbolicLink()) {
    warnings.push({
      code: "workspace_symlink",
      path: root,
      message: "Workspace root is a symlink and was not scanned",
    });
    return {
      workspaceRoot: root,
      scannedAt: now.toISOString(),
      rules: [],
      warnings,
    };
  }

  if (!rootStats.isDirectory()) {
    warnings.push({
      code: "workspace_not_directory",
      path: root,
      message: "Workspace root is not a directory",
    });
    return {
      workspaceRoot: root,
      scannedAt: now.toISOString(),
      rules: [],
      warnings,
    };
  }

  const rules: NormalizedRuleRecord[] = [];

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        code: "unreadable_directory",
        path: directory,
        relativePath: portableRelative(root, directory),
        message: `Directory could not be read: ${errorMessage(error)}`,
      });
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = join(directory, entry.name);
        const relativePath = portableRelative(root, absolutePath);

        if (!isInside(root, absolutePath)) {
          warnings.push({
            code: "outside_workspace",
            path: absolutePath,
            relativePath,
            message: "Path resolved outside the workspace and was skipped",
          });
          return;
        }

        let stats: Stats;
        try {
          stats = await lstat(absolutePath);
        } catch (error) {
          warnings.push({
            code: entry.isDirectory() ? "unreadable_directory" : "unreadable_file",
            path: absolutePath,
            relativePath,
            message: `Path could not be inspected: ${errorMessage(error)}`,
          });
          return;
        }

        if (stats.isSymbolicLink()) {
          warnings.push({
            code: "symlink_skipped",
            path: absolutePath,
            relativePath,
            message: "Symlink was skipped",
          });
          return;
        }

        if (stats.isDirectory()) {
          if (!ignoreDirectories.has(entry.name)) {
            await walk(absolutePath, depth + 1);
          }
          return;
        }

        if (!stats.isFile()) return;

        const candidate = detectCandidate(root, absolutePath, customMatchers);
        if (!candidate) return;

        if (stats.size > maxFileBytes) {
          warnings.push({
            code: "oversized_file",
            path: absolutePath,
            relativePath,
            message: `Rule file is ${stats.size} bytes, above the ${maxFileBytes} byte limit`,
          });
          return;
        }

        let rawContent: Buffer | string;
        try {
          rawContent = await readFile(absolutePath);
        } catch (error) {
          const code = errorCode(error) === "ELOOP" ? "symlink_skipped" : "unreadable_file";
          warnings.push({
            code,
            path: absolutePath,
            relativePath,
            message: `Rule file could not be read: ${errorMessage(error)}`,
          });
          return;
        }

        const record = buildRuleRecord({
          root,
          absolutePath,
          stats,
          rawContent,
          candidate,
          now,
        });
        rules.push(record);
      }),
    );
  }

  await walk(root, 0);
  rules.sort((a, b) => b.precedence - a.precedence || a.relativePath.localeCompare(b.relativePath));

  return {
    workspaceRoot: root,
    scannedAt: now.toISOString(),
    rules,
    warnings,
  };
}

function detectCandidate(
  root: string,
  absolutePath: string,
  customMatchers: RegExp[],
): CandidateRule | null {
  const fileName = basename(absolutePath);
  const directSource = FILE_SOURCES.get(fileName);
  if (directSource) {
    return { source: directSource, scopeRoot: dirname(absolutePath) };
  }

  const relativePath = portableRelative(root, absolutePath);
  const lowerRelativePath = relativePath.toLowerCase();
  for (const { marker, source } of RULE_DIRECTORY_SOURCES) {
    const markerWithSlash = `${marker}/`;
    const markerIndex = lowerRelativePath.indexOf(markerWithSlash);
    if (markerIndex >= 0) {
      const scopePrefix = relativePath.slice(0, markerIndex).replace(/\/$/, "");
      return {
        source,
        scopeRoot: scopePrefix ? join(root, ...scopePrefix.split("/")) : root,
      };
    }
  }

  for (const matcher of customMatchers) {
    if (matcher.test(relativePath) || matcher.test(fileName)) {
      return {
        source: { host: "custom", kind: "custom-glob" },
        scopeRoot: dirname(absolutePath),
      };
    }
  }

  return null;
}

function buildRuleRecord(input: {
  root: string;
  absolutePath: string;
  stats: Stats;
  rawContent: Buffer | string;
  candidate: CandidateRule;
  now: Date;
}): NormalizedRuleRecord {
  const buffer = Buffer.isBuffer(input.rawContent)
    ? input.rawContent
    : Buffer.from(input.rawContent, "utf8");
  const contentHash = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  const content = stripBom(buffer.toString("utf8"));
  const frontmatter = parseFrontmatter(content);
  const activation = inferActivation(input.candidate.source.host, frontmatter);
  const scope = inferScope(input.root, input.candidate.scopeRoot, activation);
  const precedence = buildPrecedence(input.candidate.source.host, scope, activation);
  const relativePath = portableRelative(input.root, input.absolutePath);

  return {
    id: `${input.candidate.source.kind}:${relativePath}:${contentHash.slice("sha256:".length, "sha256:".length + 12)}`,
    host: input.candidate.source.host,
    sourceKind: input.candidate.source.kind,
    sourcePath: input.absolutePath,
    relativePath,
    scope,
    precedence,
    activation,
    contentHash,
    metadata: {
      bytes: input.stats.size,
      mtimeMs: input.stats.mtimeMs,
      mtimeIso: input.stats.mtime.toISOString(),
      contentHash,
      staleHint: staleHint(input.stats.mtimeMs, input.now.getTime()),
    },
    content,
  };
}

function inferActivation(host: RuleHost, frontmatter: Frontmatter): RuleActivation {
  const globs = parseList(frontmatter.globs ?? frontmatter.glob);
  const description = parseString(frontmatter.description);
  const explicitActivation = parseString(frontmatter.activation ?? frontmatter.apply ?? frontmatter.when)
    ?.toLowerCase()
    .trim();
  const alwaysApply = parseBoolean(frontmatter.alwaysApply ?? frontmatter.always_apply);

  if (alwaysApply === true || explicitActivation === "always") {
    return { mode: "always", globs, description };
  }
  if (globs.length > 0 || explicitActivation === "glob" || explicitActivation === "auto") {
    return { mode: "glob", globs, description };
  }
  if (description || explicitActivation === "agent-requested" || explicitActivation === "agent") {
    return { mode: "agent-requested", globs, description };
  }
  if (alwaysApply === false || explicitActivation === "manual") {
    return { mode: "manual", globs, description };
  }
  if (host === "cursor") {
    return { mode: "manual", globs, description };
  }
  return { mode: "always", globs, description };
}

function inferScope(root: string, scopeRoot: string, activation: RuleActivation): RuleScope {
  const scopePath = portableRelative(root, scopeRoot);
  if (activation.mode === "glob" && activation.globs.length > 0) {
    return {
      kind: "glob",
      path: scopePath,
      globs: activation.globs,
    };
  }
  return {
    kind: scopePath === "." ? "workspace" : "directory",
    path: scopePath,
    globs: [],
  };
}

function buildPrecedence(host: RuleHost, scope: RuleScope, activation: RuleActivation): number {
  const depth = scope.path === "." ? 0 : scope.path.split("/").filter(Boolean).length;
  const scopeBoost = depth * 1000;
  const activationBoost = activation.mode === "glob" ? 100 : activation.mode === "always" ? 50 : 0;
  return scopeBoost + activationBoost + HOST_PRECEDENCE[host];
}

function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return {};

  const values: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "---" || line.trim() === "...") break;

    const listMatch = line.match(/^\s*-\s*(.+?)\s*$/);
    if (currentListKey && listMatch) {
      const existing = values[currentListKey];
      values[currentListKey] = [
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
        unquote(listMatch[1]),
      ];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!keyMatch) {
      currentListKey = null;
      continue;
    }

    const key = keyMatch[1];
    const value = keyMatch[2];
    if (!value) {
      values[key] = [];
      currentListKey = key;
      continue;
    }

    values[key] = unquote(value);
    currentListKey = null;
  }

  return values as Frontmatter;
}

function parseBoolean(value: string | string[] | undefined): boolean | undefined {
  const parsed = parseString(value)?.toLowerCase().trim();
  if (parsed === "true" || parsed === "yes" || parsed === "on") return true;
  if (parsed === "false" || parsed === "no" || parsed === "off") return false;
  return undefined;
}

function parseList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(unquote).map((item) => item.trim()).filter(Boolean);

  const trimmed = value.trim();
  const withoutBrackets = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;

  return withoutBrackets
    .split(",")
    .map(unquote)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseString(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : undefined;
  const parsed = unquote(value).trim();
  return parsed || undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function staleHint(
  mtimeMs: number,
  nowMs: number,
): RuleMetadata["staleHint"] {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "unknown";
  const ageDays = (nowMs - mtimeMs) / (24 * 60 * 60 * 1000);
  if (ageDays < STALE_AGED_DAYS) return "fresh";
  if (ageDays < STALE_OLD_DAYS) return "aged";
  return "old";
}

function stripBom(content: string): string {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function portableRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel ? toPortablePath(rel) : ".";
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  const normalized = toPortablePath(glob);
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === "*") {
      if (next === "*") {
        const after = normalized[index + 2];
        if (after === "/") {
          pattern += "(?:.*/)?";
          index += 2;
        } else {
          pattern += ".*";
          index++;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += escapeRegExp(char);
  }
  pattern += "$";
  return new RegExp(pattern, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function stripRuleContent(
  rule: NormalizedRuleRecord,
): Omit<NormalizedRuleRecord, "content"> {
  const copy: Partial<NormalizedRuleRecord> = { ...rule };
  delete copy.content;
  return copy as Omit<NormalizedRuleRecord, "content">;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkspaceRoot(
  input: Record<string, unknown>,
  defaultCwd: string,
): string {
  const candidates = [
    ["workspaceRoot", input["workspaceRoot"]],
    ["root", input["root"]],
    ["cwd", input["cwd"]],
  ] as const;
  const found = candidates.find(([, value]) => value !== undefined);
  const field = found?.[0] ?? "workspaceRoot";
  const rawValue = found?.[1] ?? defaultCwd;
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    throw new Error(`${field} must be a non-empty absolute path`);
  }
  const trimmed = rawValue.trim();
  rejectNul(trimmed, field);
  if (!isAbsolute(trimmed)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return resolve(trimmed);
}

async function assertWorkspaceDirectory(workspaceRoot: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(workspaceRoot);
  } catch (error) {
    throw new Error(`workspaceRoot could not be read: ${errorMessage(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error("workspaceRoot must not be a symlink");
  }
  if (!stats.isDirectory()) {
    throw new Error("workspaceRoot must be a directory");
  }
}

async function canonicalize(path: string): Promise<string> {
  try {
    return await nodeRealpath(path);
  } catch {
    return resolve(path);
  }
}

async function assertRootWithinAllowed(
  workspaceRoot: string,
  allowedRoots: string[],
): Promise<string> {
  const normalizedAllowed = allowedRoots
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => resolve(entry.trim()));
  if (normalizedAllowed.length === 0) {
    throw new Error("workspaceRoot is not within an allowed root");
  }

  const canonicalRoot = await canonicalize(workspaceRoot);
  const canonicalAllowed = await Promise.all(normalizedAllowed.map(canonicalize));

  const permitted = canonicalAllowed.some(
    (allowed) => canonicalRoot === allowed || isInside(allowed, canonicalRoot),
  );
  if (!permitted) {
    throw new Error("workspaceRoot is not within an allowed root");
  }
  return canonicalRoot;
}

function normalizeGlobList(value: unknown, field: string): string[] | undefined {
  const items = normalizePlainStringList(value, field);
  if (items === undefined) return undefined;
  if (items.length > MAX_PUBLIC_GLOBS) {
    throw new Error(`${field} must contain at most ${MAX_PUBLIC_GLOBS} entries`);
  }
  for (const item of items) {
    if (item.length > MAX_PUBLIC_GLOB_LENGTH) {
      throw new Error(`${field} entries must be ${MAX_PUBLIC_GLOB_LENGTH} characters or less`);
    }
    if (isAbsolute(item)) {
      throw new Error(`${field} entries must be relative globs`);
    }
    const segments = toPortablePath(item).split("/");
    if (segments.includes("..")) {
      throw new Error(`${field} entries must not contain parent-directory traversal`);
    }
  }
  return items;
}

function normalizePlainStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (!values) {
    throw new Error(`${field} must be a string or an array of strings`);
  }
  const strings = values.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`${field} must contain only strings`);
    }
    const trimmed = item.trim();
    rejectNul(trimmed, field);
    return trimmed;
  }).filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function normalizeOptionalInteger(
  value: unknown,
  field: string,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (
    !Number.isInteger(numberValue) ||
    numberValue < bounds.min ||
    numberValue > bounds.max
  ) {
    throw new Error(`${field} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return numberValue;
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  throw new Error(`${field} must be a boolean`);
}

function rejectNul(value: string, field: string): void {
  if (value.includes("\0")) {
    throw new Error(`${field} must not contain NUL bytes`);
  }
}
