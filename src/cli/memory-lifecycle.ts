export type MemoryCliMethod = "GET" | "POST";

export interface MemoryCliRequest {
  method: MemoryCliMethod;
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
}

export interface MemoryCliRunOptions {
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  stdout?: Pick<NodeJS.WriteStream, "write">;
}

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
};

type ResponseLike = {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
};

export const MEMORY_CLI_HELP = `Usage:
  agentmemory memory create <content> [--type type] [--concepts a,b] [--files x,y] [--project name] [--lane lane] [--confidence N] [--privacy-scope scope] [--source-observation-ids a,b] [--source-uri uri] [--require-gate-pass]
  agentmemory memory inspect <memoryId>
  agentmemory memory history <memoryId>
  agentmemory memory update <memoryId> [--content text] [--title text] [--concepts a,b] [--files x,y] [--strength N] [--confidence N] [--lane lane] [--review-state state] [--privacy-scope scope] [--valid-from ISO] [--valid-until ISO] [--reason text]
  agentmemory memory expire <memoryId> [--expires-at ISO] [--reason text]
  agentmemory memory archive <memoryId> [--reason text]
  agentmemory memory restore <memoryId> [--reason text]
  agentmemory memory delete <memoryId> [--mode tombstone|hard] [--reason text] [--yes]
  agentmemory memory ledger [--project name] [--state active|archived|expired|tombstoned|quarantined|all] [--type type] [--lane lane] [--review-state state] [--include-source-cards] [--limit N] [--offset N]
  agentmemory memory review-queue [--project name] [--limit N]
  agentmemory memory search-explain <query> [--project name] [--limit N] [--search-mode fast|balanced|deep] [--files a,b] [--branch name] [--commit sha] [--memory-tier lane] [--privacy-scope scope] [--agent-id id]
`;

function toFlagKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function addFlag(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const normalized = toFlagKey(key);
  const existing = flags[normalized];
  if (existing === undefined) {
    flags[normalized] = value;
    return;
  }
  flags[normalized] = Array.isArray(existing)
    ? [...existing, String(value)]
    : [String(existing), String(value)];
}

export function parseMemoryCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs["flags"] = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      addFlag(flags, raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addFlag(flags, raw, next);
      i++;
    } else {
      addFlag(flags, raw, true);
    }
  }

  return { positionals, flags };
}

function requirePositional(
  positionals: string[],
  index: number,
  label: string,
): string {
  const value = positionals[index];
  if (!value || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function flagValue(
  flags: ParsedArgs["flags"],
  key: string,
): string | boolean | string[] | undefined {
  return flags[toFlagKey(key)];
}

function optionalString(
  flags: ParsedArgs["flags"],
  key: string,
): string | undefined {
  const value = flagValue(flags, key);
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function optionalNumber(
  flags: ParsedArgs["flags"],
  key: string,
): number | undefined {
  const raw = optionalString(flags, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${key} must be a number`);
  return n;
}

function optionalBoolean(
  flags: ParsedArgs["flags"],
  key: string,
): boolean | undefined {
  const value = flagValue(flags, key);
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (value === false) return false;
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`--${key} must be true or false`);
}

function optionalCsv(flags: ParsedArgs["flags"], key: string): string[] | undefined {
  const value = flagValue(flags, key);
  if (value === undefined || typeof value === "boolean") return undefined;
  const rawValues = Array.isArray(value) ? value : [value];
  const values = rawValues
    .flatMap((raw) => raw.split(","))
    .map((raw) => raw.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function compactBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

function queryString(
  flags: ParsedArgs["flags"],
  keys: string[],
): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of keys) {
    const value = flagValue(flags, key);
    if (value === undefined) continue;
    const normalized = toFlagKey(key);
    const raw = Array.isArray(value) ? value[value.length - 1] : value;
    query[normalized] = String(raw);
  }
  return query;
}

export function buildMemoryCliRequest(argv: string[]): MemoryCliRequest {
  const { positionals, flags } = parseMemoryCliArgs(argv);
  const command = positionals[0];

  switch (command) {
    case "create": {
      const content = optionalString(flags, "content") ?? positionals.slice(1).join(" ").trim();
      if (!content) throw new Error("content is required");
      return {
        method: "POST",
        path: "memory/create",
        body: compactBody({
          content,
          type: optionalString(flags, "type"),
          concepts: optionalCsv(flags, "concepts"),
          files: optionalCsv(flags, "files"),
          ttlDays: optionalNumber(flags, "ttl-days"),
          sourceObservationIds: optionalCsv(flags, "source-observation-ids"),
          agentId: optionalString(flags, "agent-id"),
          project: optionalString(flags, "project"),
          lane: optionalString(flags, "lane"),
          confidence: optionalNumber(flags, "confidence"),
          privacyScope: optionalString(flags, "privacy-scope"),
          ownerId: optionalString(flags, "owner-id"),
          branch: optionalString(flags, "branch"),
          commit: optionalString(flags, "commit"),
          sourceHash: optionalString(flags, "source-hash"),
          sourceType: optionalString(flags, "source-type"),
          sourceUri: optionalString(flags, "source-uri"),
          reviewState: optionalString(flags, "review-state"),
          requireGatePass: optionalBoolean(flags, "require-gate-pass"),
        }),
      };
    }
    case "inspect":
      return {
        method: "POST",
        path: "memory/inspect",
        body: { memoryId: requirePositional(positionals, 1, "memoryId") },
      };
    case "history":
      return {
        method: "POST",
        path: "memory/history",
        body: { memoryId: requirePositional(positionals, 1, "memoryId") },
      };
    case "update":
      return {
        method: "POST",
        path: "memory/update",
        body: compactBody({
          memoryId: requirePositional(positionals, 1, "memoryId"),
          content: optionalString(flags, "content"),
          title: optionalString(flags, "title"),
          concepts: optionalCsv(flags, "concepts"),
          files: optionalCsv(flags, "files"),
          strength: optionalNumber(flags, "strength"),
          confidence: optionalNumber(flags, "confidence"),
          lane: optionalString(flags, "lane"),
          reviewState: optionalString(flags, "review-state"),
          privacyScope: optionalString(flags, "privacy-scope"),
          validFrom: optionalString(flags, "valid-from"),
          validUntil: optionalString(flags, "valid-until"),
          reason: optionalString(flags, "reason"),
          actor: optionalString(flags, "actor"),
        }),
      };
    case "expire":
      return {
        method: "POST",
        path: "memory/expire",
        body: compactBody({
          memoryId: requirePositional(positionals, 1, "memoryId"),
          expiresAt: optionalString(flags, "expires-at"),
          reason: optionalString(flags, "reason"),
          actor: optionalString(flags, "actor"),
        }),
      };
    case "archive":
      return lifecycleMutation("archive", positionals, flags);
    case "restore":
      return lifecycleMutation("restore", positionals, flags);
    case "delete": {
      const mode = optionalString(flags, "mode") ?? "tombstone";
      if (mode !== "tombstone" && mode !== "hard") {
        throw new Error("--mode must be tombstone or hard");
      }
      if (mode === "hard" && flagValue(flags, "yes") !== true) {
        throw new Error("hard delete requires --yes");
      }
      return {
        method: "POST",
        path: "memory/delete",
        body: compactBody({
          memoryId: requirePositional(positionals, 1, "memoryId"),
          mode,
          reason: optionalString(flags, "reason"),
          actor: optionalString(flags, "actor"),
        }),
      };
    }
    case "ledger":
      return {
        method: "GET",
        path: "memory-ledger",
        query: queryString(flags, [
          "project",
          "state",
          "type",
          "lane",
          "review-state",
          "include-source-cards",
          "limit",
          "offset",
        ]),
      };
    case "review-queue":
      return {
        method: "GET",
        path: "memory-review-queue",
        query: queryString(flags, ["project", "limit"]),
      };
    case "search-explain": {
      const query = positionals.slice(1).join(" ").trim();
      if (!query) throw new Error("query is required");
      return {
        method: "POST",
        path: "search/explain",
        body: compactBody({
          query,
          project: optionalString(flags, "project"),
          limit: optionalNumber(flags, "limit"),
          includeLessons: optionalBoolean(flags, "include-lessons"),
          searchMode: optionalString(flags, "search-mode"),
          files: optionalCsv(flags, "files"),
          file: optionalString(flags, "file"),
          filePath: optionalString(flags, "file-path"),
          branch: optionalString(flags, "branch"),
          commit: optionalString(flags, "commit"),
          memoryTier: optionalString(flags, "memory-tier"),
          privacyScope: optionalString(flags, "privacy-scope"),
          agentId: optionalString(flags, "agent-id"),
          sessionId: optionalString(flags, "session-id"),
        }),
      };
    }
    default:
      throw new Error(`unknown memory command: ${command ?? "(missing)"}`);
  }
}

function lifecycleMutation(
  action: "archive" | "restore",
  positionals: string[],
  flags: ParsedArgs["flags"],
): MemoryCliRequest {
  return {
    method: "POST",
    path: `memory/${action}`,
    body: compactBody({
      memoryId: requirePositional(positionals, 1, "memoryId"),
      reason: optionalString(flags, "reason"),
      actor: optionalString(flags, "actor"),
    }),
  };
}

function buildUrl(baseUrl: string, request: MemoryCliRequest): string {
  const base = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}/agentmemory/${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function executeMemoryCliRequest(
  request: MemoryCliRequest,
  options: MemoryCliRunOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  const secret = options.env?.["AGENTMEMORY_SECRET"];
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  if (request.method === "POST") headers["Content-Type"] = "application/json";

  const response = (await fetchImpl(buildUrl(options.baseUrl, request), {
    method: request.method,
    headers,
    ...(request.method === "POST" && {
      body: JSON.stringify(request.body ?? {}),
    }),
  })) as ResponseLike;
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error?: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

export async function runMemoryCommand(
  argv: string[],
  options: MemoryCliRunOptions,
): Promise<void> {
  if (
    argv.length === 0 ||
    argv[0] === "help" ||
    argv[0] === "--help" ||
    argv[0] === "-h"
  ) {
    options.stdout?.write(MEMORY_CLI_HELP);
    return;
  }
  const request = buildMemoryCliRequest(argv);
  const result = await executeMemoryCliRequest(request, options);
  options.stdout?.write(`${JSON.stringify(result, null, 2)}\n`);
}
