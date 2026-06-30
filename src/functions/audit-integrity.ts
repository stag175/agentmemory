import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { AuditChainHead, AuditEntry } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";

export const AUDIT_CHAIN_VERSION = 1;
export const AUDIT_CHAIN_ALGORITHM = "sha256";
export const AUDIT_CHAIN_GENESIS_HASH = "0".repeat(64);
// Fixed single-row key for the audit-chain head pointer (KV.auditChainHead).
export const AUDIT_CHAIN_HEAD_KEY = "current";

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
  seq: number;
  entryId: string;
  timestamp: string;
  operation: string;
  functionId: string;
  targetCount: number;
  entryHash: string;
  previousHash: string;
  // Recomputed chain hash for this link (sha256(previousHash||entryHash||seq)).
  hash: string;
  // chainHash persisted on the row at append time. When the row is intact
  // this equals `hash`; a mismatch means the row was tampered with after
  // append. undefined for legacy rows written before tamper-evidence existed.
  storedChainHash?: string;
};

export type AuditHashChainReport = {
  success: true;
  version: typeof AUDIT_CHAIN_VERSION;
  algorithm: typeof AUDIT_CHAIN_ALGORITHM;
  generatedAt: string;
  genesisHash: string;
  // headHash is computed over the ENTIRE filtered set, independent of the
  // offset/limit window, so pagination can never weaken the integrity proof.
  headHash: string;
  firstEntryId?: string;
  lastEntryId?: string;
  // The persisted head pointer (KV.auditChainHead), if present. Verification
  // diffs the recomputed full-set head against this to detect a fully
  // rewritten log even when every row is internally self-consistent.
  storedHead?: AuditChainHead;
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
  // Which integrity properties were actually checked. valid:true requires
  // BOTH a head hash AND an entry count to have been verified.
  checked: {
    headHash: boolean;
    entryCount: boolean;
    firstEntryId: boolean;
    lastEntryId: boolean;
    providedChain: boolean;
    persistedHead: boolean;
    chainContinuity: boolean;
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
  // Persisted tamper-evidence. seq is the append-order counter the chain is
  // ordered/verified by (NOT the mutable timestamp). hasSeq/storedChainHash
  // capture whether the row predates tamper-evidence (legacy rows are flagged
  // as violations during verification).
  seq: number;
  hasSeq: boolean;
  storedChainHash?: string;
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

// Canonical hash of an audit entry's content. The derived chainHash is
// omitted so the entry hash is stable across append (when chainHash is not
// yet known) and verification. seq IS included so a row cannot be silently
// renumbered without changing its hash. Shared with recordAudit so the
// append-time and verify-time hashes are computed identically.
export function computeAuditEntryHash(entry: AuditEntry): string {
  const { chainHash: _chainHash, ...content } = entry;
  void _chainHash;
  return sha256Hex(stableStringify(content));
}

// chainHash links an entry to the prior head:
//   sha256(prevChainHash || entryHash || seq)
// Shared by recordAudit (append) and the verifier (recompute) so a tampered
// or reordered row produces a chainHash that no longer matches the persisted
// value or the persisted head.
export function computeAuditChainHash(
  previousChainHash: string,
  entryHash: string,
  seq: number,
): string {
  return sha256Hex(
    stableStringify({
      algorithm: AUDIT_CHAIN_ALGORITHM,
      entryHash,
      previousChainHash,
      seq,
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

  const hasSeq = typeof raw.seq === "number";
  if (!hasSeq || !Number.isInteger(raw.seq) || (raw.seq as number) < 1) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "seq",
      message: "seq must be a positive integer persisted at append time",
    });
  }
  const storedChainHash =
    typeof raw.chainHash === "string" ? raw.chainHash : undefined;
  if (!storedChainHash) {
    issues.push({
      position: sourceIndex,
      entryId,
      field: "chainHash",
      message: "chainHash must be persisted at append time",
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
      seq: hasSeq && Number.isInteger(raw.seq) ? (raw.seq as number) : -1,
      hasSeq: hasSeq && Number.isInteger(raw.seq) && (raw.seq as number) >= 1,
      storedChainHash,
    },
    issues,
  };
}

// Order by persisted append-time seq, NOT the mutable timestamp. Rows that
// carry a valid seq sort by seq ascending; legacy rows missing seq (already
// flagged as violations) sort deterministically after them by timestamp/id so
// the chain build stays stable.
function sortedRows(rows: AuditRow[]): AuditRow[] {
  return [...rows].sort((a, b) => {
    if (a.hasSeq && b.hasSeq) {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.sourceIndex - b.sourceIndex;
    }
    if (a.hasSeq !== b.hasSeq) return a.hasSeq ? -1 : 1;
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
  storedHead?: AuditChainHead | null,
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

  // Walk the ENTIRE filtered set in seq order to recompute the chain. headHash
  // is the last link's recomputed hash over the full set, so it is independent
  // of the offset/limit window and pagination can never weaken the proof.
  // Gaps and duplicate seq values are recorded as violations.
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;
  let expectedSeq: number | undefined;
  const allLinks = filteredRows.map((row, index): AuditHashChainLink => {
    if (row.hasSeq) {
      if (expectedSeq !== undefined) {
        if (row.seq === expectedSeq - 1) {
          rowIssues.push({
            position: index,
            entryId: row.entryId,
            field: "seq",
            message: `duplicate or non-monotonic seq ${row.seq}`,
          });
        } else if (row.seq !== expectedSeq) {
          rowIssues.push({
            position: index,
            entryId: row.entryId,
            field: "seq",
            message: `seq gap: expected ${expectedSeq} but found ${row.seq}`,
          });
        }
      }
      expectedSeq = row.seq + 1;
    }
    const entryHash = computeAuditEntryHash(row.entry);
    const hash = computeAuditChainHash(previousHash, entryHash, row.seq);
    const link: AuditHashChainLink = {
      position: index,
      seq: row.seq,
      entryId: row.entryId,
      timestamp: row.timestamp,
      operation: row.operation,
      functionId: row.functionId,
      targetCount: row.targetCount,
      entryHash,
      previousHash,
      hash,
      ...(row.storedChainHash !== undefined
        ? { storedChainHash: row.storedChainHash }
        : {}),
    };
    previousHash = hash;
    return link;
  });

  const headHash = allLinks.at(-1)?.hash ?? AUDIT_CHAIN_GENESIS_HASH;
  const windowedLinks = allLinks.slice(input.offset, input.offset + input.limit);

  const report: AuditHashChainReport = {
    success: true,
    version: AUDIT_CHAIN_VERSION,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    generatedAt,
    genesisHash: AUDIT_CHAIN_GENESIS_HASH,
    headHash,
    ...(allLinks[0] ? { firstEntryId: allLinks[0].entryId } : {}),
    ...(allLinks.at(-1) ? { lastEntryId: allLinks.at(-1)!.entryId } : {}),
    ...(storedHead ? { storedHead } : {}),
    scope: {
      totalRows: rawRows.length,
      totalAuditEntries: rows.length,
      filteredEntries: filteredRows.length,
      selectedEntries: windowedLinks.length,
      offset: input.offset,
      limit: input.limit,
      truncated: input.offset + input.limit < filteredRows.length,
      filters: filtersForScope(input),
    },
    rowIssues,
  };
  if (input.includeLinks) report.links = windowedLinks;
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

// Validate a caller-supplied chain on its own terms before diffing it against
// the recomputed chain: every link's hash must equal
// sha256(previousHash||entryHash||seq), the first link must anchor to the
// genesis hash, and each subsequent previousHash must equal the prior hash.
// This catches a chain that was internally edited to look self-consistent in
// isolation but breaks the recomputation rule.
function validateProvidedChainContinuity(
  provided: unknown[],
  mismatches: AuditHashChainVerifyResult["mismatches"],
): void {
  let previousHash = AUDIT_CHAIN_GENESIS_HASH;
  provided.forEach((actual, index) => {
    if (!isRecord(actual)) return;
    const entryHash =
      typeof actual.entryHash === "string" ? actual.entryHash : "";
    const seq = typeof actual.seq === "number" ? actual.seq : -1;
    const claimedPrevious =
      typeof actual.previousHash === "string" ? actual.previousHash : "";
    const claimedHash = typeof actual.hash === "string" ? actual.hash : "";
    if (claimedPrevious !== previousHash) {
      mismatches.push({
        kind: "provided_chain_continuity",
        message: "provided link previousHash did not chain from the prior link",
        position: index,
        entryId: typeof actual.entryId === "string" ? actual.entryId : undefined,
        expected: previousHash,
        actual: claimedPrevious,
      });
    }
    const recomputed = computeAuditChainHash(claimedPrevious, entryHash, seq);
    if (recomputed !== claimedHash) {
      mismatches.push({
        kind: "provided_chain_link_hash",
        message: "provided link hash is not a valid hash of its own contents",
        position: index,
        entryId: typeof actual.entryId === "string" ? actual.entryId : undefined,
        expected: recomputed,
        actual: claimedHash,
      });
    }
    previousHash = claimedHash;
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
  validateProvidedChainContinuity(provided, mismatches);
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
    for (const field of [
      "seq",
      "entryId",
      "entryHash",
      "previousHash",
      "hash",
    ] as const) {
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
  const storedHead = await kv.get<AuditChainHead>(
    KV.auditChainHead,
    AUDIT_CHAIN_HEAD_KEY,
  );
  return buildReportFromRows(rawRows, parsed.value, storedHead);
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
  const storedHead = await kv.get<AuditChainHead>(
    KV.auditChainHead,
    AUDIT_CHAIN_HEAD_KEY,
  );
  const internalInput = { ...parsed.value, includeLinks: true };
  const report = buildReportFromRows(rawRows, internalInput, storedHead);
  const links = report.links ?? [];
  const mismatches: AuditHashChainVerifyResult["mismatches"] =
    report.rowIssues.map((issue) => ({
      kind: "row_shape",
      message: issue.message,
      position: issue.position,
      entryId: issue.entryId,
      actual: issue.field,
    }));

  // Internal consistency of the persisted chain: each row's recomputed hash
  // must equal the chainHash stored on it at append time. A middle-row edit
  // changes that row's entryHash (and every downstream hash) so the stored
  // value no longer matches — detected even without an external anchor.
  for (const link of links) {
    if (link.storedChainHash === undefined) continue;
    if (link.storedChainHash !== link.hash) {
      mismatches.push({
        kind: "stored_chain_hash",
        message: "persisted chainHash does not match the recomputed chain",
        position: link.position,
        entryId: link.entryId,
        expected: link.hash,
        actual: link.storedChainHash,
      });
    }
  }

  // Caller-supplied external anchors (what the verifier was asked to compare
  // against). The persisted head is an internal anchor and is tracked
  // separately via checked.persistedHead.
  const anchorSources = [
    expectedHeadHash.value !== undefined ? "expectedHeadHash" : undefined,
    expectedCount.value !== undefined ? "expectedCount" : undefined,
    expectedFirstEntryId.value !== undefined ? "expectedFirstEntryId" : undefined,
    expectedLastEntryId.value !== undefined ? "expectedLastEntryId" : undefined,
    body.chain !== undefined ? "chain" : undefined,
  ].filter((source): source is string => source !== undefined);
  const anchorProvided = anchorSources.length > 0;
  // Integrity can be proven from a caller anchor OR the persisted head pointer
  // (atomically written per append). Only flag "anchor required" when neither
  // exists and the caller did not opt into compute-only mode.
  const canProveIntegrity = anchorProvided || Boolean(storedHead);
  if (!canProveIntegrity && allowUnanchored.value !== true) {
    mismatches.push({
      kind: "external_anchor_required",
      message:
        "audit verification requires a persisted/saved head, count, entry id or provided chain anchor; pass allowUnanchored=true only to compute the current chain without integrity proof",
    });
  }

  // A windowed (paginated) verify cannot prove integrity over the whole log.
  // Treat truncation as a hard mismatch whenever integrity is being proven.
  if (canProveIntegrity && report.scope.truncated) {
    mismatches.push({
      kind: "scope_truncated",
      message:
        "verification window is truncated; verify the full chain (offset=0 with a limit covering all rows) before trusting the result",
      expected: report.scope.filteredEntries,
      actual: report.scope.selectedEntries,
    });
  }

  // headHash and count are evaluated over the ENTIRE filtered chain, not the
  // page window, so pagination cannot weaken the proof.
  const fullCount = report.scope.filteredEntries;

  compareExpectedString(
    mismatches,
    "head_hash",
    "headHash",
    expectedHeadHash.value,
    report.headHash,
  );
  if (
    expectedCount.value !== undefined &&
    expectedCount.value !== fullCount
  ) {
    mismatches.push({
      kind: "entry_count",
      message: "audit entry count did not match",
      expected: expectedCount.value,
      actual: fullCount,
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

  // Diff against the persisted head pointer. Because the head is updated
  // atomically per append, a fully rewritten log (rows re-keyed with fresh
  // seq/chainHash) recomputes to a different head than the one persisted.
  let persistedHeadChecked = false;
  if (storedHead) {
    persistedHeadChecked = true;
    if (storedHead.chainHash !== report.headHash) {
      mismatches.push({
        kind: "persisted_head_hash",
        message: "persisted head chainHash does not match the recomputed head",
        expected: storedHead.chainHash,
        actual: report.headHash,
      });
    }
    if (storedHead.count !== fullCount) {
      mismatches.push({
        kind: "persisted_head_count",
        message: "persisted head count does not match the audit row count",
        expected: storedHead.count,
        actual: fullCount,
      });
    }
  }

  const providedChainChecked = body.chain !== undefined;
  compareProvidedChain(links, body.chain, mismatches);

  const headHashChecked =
    expectedHeadHash.value !== undefined || persistedHeadChecked;
  const entryCountChecked =
    expectedCount.value !== undefined || persistedHeadChecked;
  const chainContinuityChecked = links.some(
    (link) => link.storedChainHash !== undefined,
  );

  // valid:true requires BOTH a head hash AND an entry count to have actually
  // been checked (in addition to no mismatches), so a caller that anchors on
  // only a partial property cannot get an unconditional "valid".
  const integrityProven =
    allowUnanchored.value === true || (headHashChecked && entryCountChecked);

  const result: AuditHashChainVerifyResult = {
    ...report,
    valid: mismatches.length === 0 && integrityProven,
    anchor: {
      required: allowUnanchored.value !== true,
      provided: anchorProvided,
      allowUnanchored: allowUnanchored.value === true,
      sources: anchorSources,
    },
    checked: {
      headHash: headHashChecked,
      entryCount: entryCountChecked,
      firstEntryId: expectedFirstEntryId.value !== undefined,
      lastEntryId: expectedLastEntryId.value !== undefined,
      providedChain: providedChainChecked,
      persistedHead: persistedHeadChecked,
      chainContinuity: chainContinuityChecked,
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
