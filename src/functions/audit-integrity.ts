import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { AuditEntry } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_CHAIN_ALGORITHM = "sha256";
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);

const DEFAULT_AUDIT_CHAIN_LIMIT = 1000;
const MAX_AUDIT_CHAIN_LIMIT = 10000;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type AuditChainFilters = {
  operation?: string;
  functionId?: string;
  dateFrom?: string;
  dateTo?: string;
};

type ParsedAuditChainInput = AuditChainFilters & {
  offset: number;
  limit: number;
  includeLinks: boolean;
  dateFromMs?: number;
  dateToMs?: number;
};

export type AuditIntegrityIssue = {
  position: number;
  entryId?: string;
  field: string;
  message: string;
};

export type AuditHashChainLink = {
  position: number;
  entryId: string;
  timestamp: string;
  operation: string;
  functionId: string;
  targetCount: number;
  entryHash: string;
  previousHash: string;
  hash: string;
};

export type AuditHashChainReport = {
  success: true;
  version: typeof AUDIT_CHAIN_VERSION;
  algorithm: typeof AUDIT_CHAIN_ALGORITHM;
  generatedAt: string;
  genesisHash: string;
  headHash: string;
  firstEntryId?: string;
  lastEntryId?: string;
  scope: {
    totalRows: number;
    totalAuditEntries: number;
    filteredEntries: number;
    selectedEntries: number;
    offset: number;
    limit: number;
    truncated: boolean;
    filters: AuditChainFilters;
  };
  rowIssues: AuditIntegrityIssue[];
  links?: AuditHashChainLink[];
};

export type AuditHashChainVerifyResult = Omit<AuditHashChainReport, "links"> & {
  valid: boolean;
  anchor: {
    required: boolean;
    provided: boolean;
    allowUnanchored: boolean;
    sources: string[];
  };
  mismatches: Array<{
    kind: string;
    message: string;
    position?: number;
    entryId?: string;
    expected?: unknown;
    actual?: unknown;
  }>;
  links?: AuditHashChainLink[];
};

type AuditRow = {
  sourceIndex: number;
  entry: AuditEntry;
  entryId: string;
  timestamp: string;
  operation: string;
  functionId: string;
  targetCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (isRecord(value)) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (
        child === undefined ||
        typeof child === "function" ||
        typeof child === "symbol"
      ) {
        continue;
      }
      normalized[key] = normalizeJson(child);
    }
    return normalized;
  }
  return null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashLink(previousHash: string, entryHash: string): string {
  return sha256Hex(
    stableStringify({
      algorithm: AUDIT_CHAIN_ALGORITHM,
      entryHash,
      previousHash,
      version: AUDIT_CHAIN_VERSION,
    }),
  );
}

function parseBoolean(
  value: unknown,
  defaultValue: boolean,
  field: string,
): { value?: boolean; error?: string } {
  if (value === undefined || value === null) return { value: defaultValue };
  if (typeof value === "boolean") return { value };
  return { error: `${field} must be a boolean` };
}

function parseBoundedInt(
  value: unknown,
  defaultValue: number,
  field: string,
  opts: { min: number; max: number },
): { value?: number; error?: string } {
  if (value === undefined || value === null || value === "") {
    return { value: defaultValue };
  }
  const parsed = typeof value === "number" ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < opts.min || parsed > opts.max) {
    return {
      error: `${field} must be an integer between ${opts.min} and ${opts.max}`,
    };
  }
  return { value: parsed };
}

function parseOptionalString(
  value: unknown,
  field: string,
): { value?: string; error?: string } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return {};
  return { value: trimmed };
}

function parseOptionalDate(
  value: unknown,
  field: string,
): { value?: string; millis?: number; error?: string } {
  const parsed = parseOptionalString(value, field);
  if (parsed.error || !parsed.value) return parsed;
  const millis = Date.parse(parsed.value);
  if (Number.isNaN(millis)) return { error: `${field} must be a valid date` };
  return { value: parsed.value, millis };
}

function parseAuditChainInput(
  input: unknown,
  defaultIncludeLinks: boolean,
): { value?: ParsedAuditChainInput; error?: string } {
  if (input !== undefined && input !== null && !isRecord(input)) {
    return { error: "input must be an object" };
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const offset = parseBoundedInt(body.offset, 0, "offset", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (offset.error) return { error: offset.error };
  const limit = parseBoundedInt(
    body.limit,
    DEFAULT_AUDIT_CHAIN_LIMIT,
    "limit",
    { min: 1, max: MAX_AUDIT_CHAIN_LIMIT },
  );
  if (limit.error) return { error: limit.error };
  const includeLinks = parseBoolean(
    body.includeLinks,
    defaultIncludeLinks,
    "includeLinks",
  );
  if (includeLinks.error) return { error: includeLinks.error };
  const operation = parseOptionalString(body.operation, "operation");
  if (operation.error) return { error: operation.error };
  const functionId = parseOptionalString(body.functionId, "functionId");
  if (functionId.error) return { error: functionId.error };
  const dateFrom = parseOptionalDate(body.dateFrom, "dateFrom");
  if (dateFrom.error) return { error: dateFrom.error };
  const dateTo = parseOptionalDate(body.dateTo, "dateTo");
  if (dateTo.error) return { error: dateTo.error };
  if (
    dateFrom.millis !== undefined &&
    dateTo.millis !== undefined &&
    dateFrom.millis > dateTo.millis
  ) {
    return { error: "dateFrom must be before or equal to dateTo" };
  }
  return {
    value: {
      offset: offset.value ?? 0,
      limit: limit.value ?? DEFAULT_AUDIT_CHAIN_LIMIT,
      includeLinks: includeLinks.value ?? defaultIncludeLinks,
      ...(operation.value ? { operation: operation.value } : {}),
      ...(functionId.value ? { functionId: functionId.value } : {}),
      ...(dateFrom.value ? { dateFrom: dateFrom.value } : {}),
      ...(dateFrom.millis !== undefined ? { dateFromMs: dateFrom.millis } : {}),
      ...(dateTo.value ? { dateTo: dateTo.value } : {}),
      ...(dateTo.millis !== undefined ? { dateToMs: dateTo.millis } : {}),
    },
  };
}

function validateAuditRow(
  raw: unknown,
  sourceIndex: number,
): { row?: AuditRow; issues: AuditIntegrityIssue[] } {
  const issues: AuditIntegrityIssue[] = [];
  if (!isRecord(raw)) {
    return {
      issues: [
        {
          position: sourceIndex,
          field: "entry",
          message: "audit row must be an object",
        },
      ],
    };
  }

  const entryId =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : `invalid:${sourceIndex}`;
  if (typeof raw.id !== "string" || !raw.id.trim()) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "id",
      message: "id must be a non-empty string",
    });
  }
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "timestamp",
      message: "timestamp must be a valid date string",
    });
  }
  const operation = typeof raw.operation === "string" ? raw.operation : "";
  if (!operation) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "operation",
      message: "operation must be a string",
    });
  }
  const functionId = typeof raw.functionId === "string" ? raw.functionId : "";
  if (!functionId) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "functionId",
      message: "functionId must be a string",
    });
  }
  const targetIds = raw.targetIds;
  if (
    !Array.isArray(targetIds) ||
    targetIds.some((targetId) => typeof targetId !== "string")
  ) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "targetIds",
      message: "targetIds must be an array of strings",
    });
  }
  if (!isRecord(raw.details)) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "details",
      message: "details must be an object",
    });
  }

  return {
    row: {
      sourceIndex,
      entry: raw as unknown as AuditEntry,
      entryId,
      timestamp,
      operation,
      functionId,
      targetCount: Array.isArray(targetIds) ? targetIds.length : 0,
    },
    issues,
  };
}

function sortedRows(rows: AuditRow[]): AuditRow[] {
  return [...rows].sort((a, b) => {
    const timestamp = a.timestamp.localeCompare(b.timestamp);
    if (timestamp !== 0) return timestamp;
    const id = a.entryId.localeCompare(b.entryId);
    if (id !== 0) return id;
    return a.sourceIndex - b.sourceIndex;
  });
}

function filtersForScope(input: ParsedAuditChainInput): AuditChainFilters {
  return {
    ...(input.operation ? { operation: input.operation } : {}),
    ...(input.functionId ? { functionId: input.functionId } : {}),
    ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
    ...(input.dateTo ? { dateTo: input.dateTo } : {}),
  };
}

function matchesFilters(row: AuditRow, input: ParsedAuditChainInput): boolean {
  if (input.operation && row.operation !== input.operation) return false;
  if (input.functionId && row.functionId !== input.functionId) return false;
  const timestampMs = Date.parse(row.timestamp);
  if (input.dateFromMs !== undefined && timestampMs < input.dateFromMs) {
    return false;
  }
  if (input.dateToMs !== undefined && timestampMs > input.dateToMs) {
    return false;
  }
  return true;
}

function buildReportFromRows(
  rawRows: unknown[],
  input: ParsedAuditChainInput,
): AuditHashChainReport {
  const generatedAt = new Date().toISOString();
  const rowIssues: AuditIntegrityIssue[] = [];
  const rows: AuditRow[] = [];
  rawRows.forEach((raw, index) => {
    const validated = validateAuditRow(raw, index);
    rowIssues.push(...validated.issues);
    if (validated.row) rows.push(validated.row);
  });

  const filteredRows = sortedRows(rows.filter((row) => matchesFilters(row, input)));
  const selectedRows = filteredRows.slice(input.offset, input.offset + input.limit);
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;
  const links = selectedRows.map((row, index): AuditHashChainLink => {
    const entryHash = sha256Hex(stableStringify(row.entry));
    const hash = hashLink(previousHash, entryHash);
    const link = {
      position: input.offset + index,
      entryId: row.entryId,
      timestamp: row.timestamp,
      operation: row.operation,
      functionId: row.functionId,
      targetCount: row.targetCount,
      entryHash,
      previousHash,
      hash,
    };
    previousHash = hash;
    return link;
  });

  const report: AuditHashChainReport = {
    success: true,
    version: AUDIT_CHAIN_VERSION,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    generatedAt,
    genesisHash: AUDIT_CHAIN_GENESIS_HASH,
    headHash: links.at(-1)?.hash ?? AUDIT_CHAIN_GENESIS_HASH,
    ...(links[0] ? { firstEntryId: links[0].entryId } : {}),
    ...(links.at(-1) ? { lastEntryId: links.at(-1)!.entryId } : {}),
    scope: {
      totalRows: rawRows.length,
      totalAuditEntries: rows.length,
      filteredEntries: filteredRows.length,
      selectedEntries: selectedRows.length,
      offset: input.offset,
      limit: input.limit,
      truncated: input.offset + input.limit < filteredRows.length,
      filters: filtersForScope(input),
    },
    rowIssues,
  };
  if (input.includeLinks) report.links = links;
  return report;
}

function parseExpectedHash(
  value: unknown,
  field: string,
): { value?: string; error?: string } {
  const parsed = parseOptionalString(value, field);
  if (parsed.error || !parsed.value) return parsed;
  if (!/^[a-f0-9]{64}$/i.test(parsed.value)) {
    return { error: `${field} must be a SHA-256 hex digest` };
  }
  return { value: parsed.value.toLowerCase() };
}

function parseExpectedCount(
  value: unknown,
): { value?: number; error?: string } {
  if (value === undefined || value === null || value === "") return {};
  return parseBoundedInt(value, 0, "expectedCount", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
}

function compareExpectedString(
  mismatches: AuditHashChainVerifyResult["mismatches"],
  kind: string,
  field: string,
  expected: string | undefined,
  actual: string | undefined,
): void {
  if (expected === undefined || expected === actual) return;
  mismatches.push({
    kind,
    message: `${field} did not match`,
    expected,
    actual,
  });
}

function compareProvidedChain(
  expectedLinks: AuditHashChainLink[],
  provided: unknown,
  mismatches: AuditHashChainVerifyResult["mismatches"],
): void {
  if (provided === undefined) return;
  if (!Array.isArray(provided)) {
    mismatches.push({
      kind: "provided_chain_shape",
      message: "chain must be an array",
    });
    return;
  }
  if (provided.length !== expectedLinks.length) {
    mismatches.push({
      kind: "provided_chain_length",
      message: "provided chain length did not match selected audit entries",
      expected: expectedLinks.length,
      actual: provided.length,
    });
  }
  const max = Math.max(provided.length, expectedLinks.length);
  for (let index = 0; index < max; index++) {
    const expected = expectedLinks[index];
    const actual = provided[index];
    if (!expected) {
      mismatches.push({
        kind: "link_unexpected",
        message: "provided chain contains an extra link",
        position: index,
      });
      continue;
    }
    if (!isRecord(actual)) {
      mismatches.push({
        kind: "link_missing",
        message: "provided chain is missing a link",
        position: expected.position,
        entryId: expected.entryId,
      });
      continue;
    }
    for (const field of ["entryId", "entryHash", "previousHash", "hash"] as const) {
      if (actual[field] === expected[field]) continue;
      mismatches.push({
        kind: `link_${field}`,
        message: `provided link ${field} did not match`,
        position: expected.position,
        entryId: expected.entryId,
        expected: expected[field],
        actual: actual[field],
      });
    }
  }
}

export async function buildAuditHashChain(
  kv: StateKV,
  input: unknown = {},
): Promise<AuditHashChainReport | { success: false; error: string }> {
  const parsed = parseAuditChainInput(input, true);
  if (parsed.error || !parsed.value) {
    return { success: false, error: parsed.error ?? "invalid input" };
  }
  const rawRows = await kv.list<unknown>(KV.audit);
  return buildReportFromRows(rawRows, parsed.value);
}

export async function verifyAuditHashChain(
  kv: StateKV,
  input: unknown = {},
): Promise<AuditHashChainVerifyResult | { success: false; error: string }> {
  const parsed = parseAuditChainInput(input, false);
  if (parsed.error || !parsed.value) {
    return { success: false, error: parsed.error ?? "invalid input" };
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const expectedHeadHash = parseExpectedHash(
    body.expectedHeadHash,
    "expectedHeadHash",
  );
  if (expectedHeadHash.error) return { success: false, error: expectedHeadHash.error };
  const expectedCount = parseExpectedCount(body.expectedCount);
  if (expectedCount.error) return { success: false, error: expectedCount.error };
  const expectedFirstEntryId = parseOptionalString(
    body.expectedFirstEntryId,
    "expectedFirstEntryId",
  );
  if (expectedFirstEntryId.error) return { success: false, error: expectedFirstEntryId.error };
  const expectedLastEntryId = parseOptionalString(
    body.expectedLastEntryId,
    "expectedLastEntryId",
  );
  if (expectedLastEntryId.error) return { success: false, error: expectedLastEntryId.error };
  const allowUnanchored = parseBoolean(
    body.allowUnanchored,
    false,
    "allowUnanchored",
  );
  if (allowUnanchored.error) {
    return { success: false, error: allowUnanchored.error };
  }

  const rawRows = await kv.list<unknown>(KV.audit);
  const internalInput = { ...parsed.value, includeLinks: true };
  const report = buildReportFromRows(rawRows, internalInput);
  const links = report.links ?? [];
  const mismatches: AuditHashChainVerifyResult["mismatches"] =
    report.rowIssues.map((issue) => ({
      kind: "row_shape",
      message: issue.message,
      position: issue.position,
      entryId: issue.entryId,
      actual: issue.field,
    }));
  const anchorSources = [
    expectedHeadHash.value !== undefined ? "expectedHeadHash" : undefined,
    expectedCount.value !== undefined ? "expectedCount" : undefined,
    expectedFirstEntryId.value !== undefined ? "expectedFirstEntryId" : undefined,
    expectedLastEntryId.value !== undefined ? "expectedLastEntryId" : undefined,
    body.chain !== undefined ? "chain" : undefined,
  ].filter((source): source is string => source !== undefined);
  const anchorProvided = anchorSources.length > 0;
  if (!anchorProvided && allowUnanchored.value !== true) {
    mismatches.push({
      kind: "external_anchor_required",
      message:
        "audit verification requires a saved head/count/entry id or provided chain anchor; pass allowUnanchored=true only to compute the current chain without integrity proof",
    });
  }

  compareExpectedString(
    mismatches,
    "head_hash",
    "headHash",
    expectedHeadHash.value,
    report.headHash,
  );
  if (
    body.expectedCount !== undefined &&
    expectedCount.value !== undefined &&
    expectedCount.value !== report.scope.selectedEntries
  ) {
    mismatches.push({
      kind: "entry_count",
      message: "selected entry count did not match",
      expected: expectedCount.value,
      actual: report.scope.selectedEntries,
    });
  }
  compareExpectedString(
    mismatches,
    "first_entry",
    "firstEntryId",
    expectedFirstEntryId.value,
    report.firstEntryId,
  );
  compareExpectedString(
    mismatches,
    "last_entry",
    "lastEntryId",
    expectedLastEntryId.value,
    report.lastEntryId,
  );
  compareProvidedChain(links, body.chain, mismatches);

  const result: AuditHashChainVerifyResult = {
    ...report,
    valid: mismatches.length === 0,
    anchor: {
      required: allowUnanchored.value !== true,
      provided: anchorProvided,
      allowUnanchored: allowUnanchored.value === true,
      sources: anchorSources,
    },
    mismatches,
  };
  if (!parsed.value.includeLinks) {
    delete result.links;
  }
  return result;
}

export function registerAuditIntegrityFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::audit-chain", async (input: unknown = {}) =>
    buildAuditHashChain(kv, input),
  );
  sdk.registerFunction("mem::audit-chain-verify", async (input: unknown = {}) =>
    verifyAuditHashChain(kv, input),
  );
}
