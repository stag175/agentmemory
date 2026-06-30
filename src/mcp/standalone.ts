#!/usr/bin/env node

import { InMemoryKV } from "./in-memory-kv.js";
import { createStdioTransport } from "./transport.js";
import { getAllTools } from "./tools-registry.js";
import { configureStateEncryptionRuntime } from "../state/encryption-runtime.js";
import type { StateKVLike } from "../state/encrypted-kv.js";
import {
  getAgentId,
  getStandalonePersistPath,
  isAgentScopeIsolated,
} from "../config.js";
import { VERSION } from "../version.js";
import { generateId } from "../state/schema.js";
import type {
  Memory,
  MemoryLifecycleState,
  RetrievalMode,
  SearchMode,
} from "../types.js";
import {
  defaultMemoryLane,
  isMemorySearchable,
  isMemoryTemporallyCompatible,
  normalizeMemoryLane,
  normalizeMemoryPrivacyScope,
  normalizeMemoryReviewState,
  normalizeTemporalValidityFilter,
  temporalValidityHardFilter,
} from "../state/memory-utils.js";
import {
  redactOptionalString,
  redactStringArray,
  scanPrivateData,
  summarizePrivacyScans,
} from "../functions/privacy.js";
import {
  normalizeRulesResolveInput,
  resolveRulesRequest,
  type RulesResolvePayload,
} from "../functions/rules-resolver.js";
import {
  resolveHandle,
  invalidateHandle,
  ProxyHttpError,
  type Handle,
  type ProxyHandle,
} from "./rest-proxy.js";

const IMPLEMENTED_TOOLS = new Set([
  "memory_save",
  "memory_recall",
  "memory_smart_search",
  "memory_sessions",
  "memory_export",
  "memory_audit",
  "memory_governance_delete",
  "memory_create",
  "memory_inspect",
  "memory_history",
  "memory_update",
  "memory_expire",
  "memory_archive",
  "memory_restore",
  "memory_delete",
  "memory_search_explain",
  "memory_ledger",
  "memory_review_queue",
  "memory_rules_resolve",
]);

// Tools whose proxy path performs no server-side mutation. A proxy failure on
// one of these may safely fall through to the local InMemoryKV read path. A
// proxy failure on a state-changing tool (memory_save/create/update/delete/...)
// must NOT silently mutate local state — a server 4xx business rejection there
// would otherwise be "absorbed" into a divergent local copy.
const READ_ONLY_TOOLS = new Set([
  "memory_recall",
  "memory_smart_search",
  "memory_sessions",
  "memory_export",
  "memory_audit",
  "memory_inspect",
  "memory_history",
  "memory_search_explain",
  "memory_ledger",
  "memory_review_queue",
  "memory_rules_resolve",
]);

/**
 * Decides whether a proxy-mode failure should fall through to the local KV.
 *
 * - A {@link ProxyHttpError} with a 4xx status is a business rejection (unknown
 *   tool, validation, auth). Local fallback would silently diverge from the
 *   server's decision, so we surface the error instead — always.
 * - For any other proxy failure (network, timeout, 5xx), read-only tools may
 *   serve a degraded local view; state-changing tools must surface the error
 *   rather than mutate a local copy the server never accepted.
 */
function shouldFallBackToLocal(toolName: string, err: unknown): boolean {
  if (err instanceof ProxyHttpError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return READ_ONLY_TOOLS.has(toolName);
}

const SERVER_INFO = {
  name: "agentmemory",
  version: VERSION,
  protocolVersion: "2024-11-05",
};

type StandaloneKV = StateKVLike & { persist(): void };

const rawKv = new InMemoryKV(getStandalonePersistPath());
const encryptionRuntime = configureStateEncryptionRuntime(rawKv);
const persistRawKv = rawKv.persist.bind(rawKv);
const kv = Object.assign(encryptionRuntime.kv, {
  persist: persistRawKv,
}) as StandaloneKV;
if (encryptionRuntime.encrypted) {
  process.stderr.write(
    `[@agentmemory/mcp] local fallback storage encryption enabled (${encryptionRuntime.keyRef ?? "configured key"})\n`,
  );
}
let modeAnnounced = false;

function displayAgentmemoryUrl(): string {
  // Match the literal-placeholder guard in rest-proxy.ts so log lines
  // don't show `${AGENTMEMORY_URL}` when an MCP host passed the
  // placeholder through unexpanded.
  const raw = process.env["AGENTMEMORY_URL"];
  if (!raw || (raw.startsWith("${") && raw.endsWith("}"))) {
    return "http://localhost:3111";
  }
  return raw;
}

function announceMode(handle: Handle): void {
  if (modeAnnounced) return;
  modeAnnounced = true;
  if (handle.mode === "proxy") {
    process.stderr.write(
      `[@agentmemory/mcp] proxying to agentmemory server at ${handle.baseUrl}\n`,
    );
  } else {
    const fullToolCount = getAllTools().length;
    process.stderr.write(
      `[@agentmemory/mcp] no server reachable at ${displayAgentmemoryUrl()}; running reduced LOCAL FALLBACK with ${IMPLEMENTED_TOOLS.size} of ${fullToolCount} tools. Start 'npx @agentmemory/agentmemory' (and point AGENTMEMORY_URL at it) to unlock all ${fullToolCount} tools.\n`,
    );
  }
}

function normalizeList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
function parseLimit(raw: unknown, fallback = DEFAULT_LIMIT): number {
  if (typeof raw !== "number" && typeof raw !== "string") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function parseOffset(raw: unknown): number | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return undefined;
}

const SEARCH_MODES = new Set<SearchMode>(["fast", "balanced", "deep"]);
const RETRIEVAL_MODES = new Set<RetrievalMode>([
  "basic",
  "local_graph",
  "global_community",
  "drift",
  "as_of",
]);

function parseSearchMode(raw: unknown): SearchMode | undefined {
  const value = optionalString(raw)?.toLowerCase();
  if (!value) return undefined;
  if (!SEARCH_MODES.has(value as SearchMode)) {
    throw new Error("searchMode must be one of: fast, balanced, deep");
  }
  return value as SearchMode;
}

function parseRetrievalMode(raw: unknown): RetrievalMode | undefined {
  const value = optionalString(raw)?.toLowerCase();
  if (!value) return undefined;
  if (!RETRIEVAL_MODES.has(value as RetrievalMode)) {
    throw new Error("retrievalMode must be one of: basic, local_graph, global_community, drift, as_of");
  }
  return value as RetrievalMode;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

function scopedReadAgentId(toolName: string, explicit?: string): string | undefined {
  if (explicit === "*") return explicit;
  const isolated = isAgentScopeIsolated();
  const envAgentId = isolated ? getAgentId() : undefined;
  if (isolated && !explicit && !envAgentId) {
    throw new Error(
      `${toolName}: AGENTMEMORY_AGENT_SCOPE=isolated is set but no agent id is available`,
    );
  }
  return explicit ?? envAgentId;
}

function scopedWriteAgentId(toolName: string, explicit?: string): string | undefined {
  if (explicit === "*") {
    throw new Error(`${toolName}: agentId "*" is only valid for scoped reads`);
  }
  const isolated = isAgentScopeIsolated();
  const envAgentId = isolated ? getAgentId() : undefined;
  if (isolated && !explicit && !envAgentId) {
    throw new Error(
      `${toolName}: AGENTMEMORY_AGENT_SCOPE=isolated is set but no agent id is available`,
    );
  }
  return explicit ?? envAgentId;
}

function parseNumber(raw: unknown): number | undefined {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeMemoryState(raw: unknown): MemoryLifecycleState | "all" | undefined {
  const value = optionalString(raw);
  if (!value) return undefined;
  if (value === "all") return "all";
  if (
    value === "active" ||
    value === "quarantined" ||
    value === "archived" ||
    value === "expired" ||
    value === "tombstoned" ||
    value === "deleted" ||
    value === "superseded"
  ) {
    return value;
  }
  return undefined;
}

function redactRevisionMeta(data: { actor?: string; reason?: string }) {
  const actor = redactOptionalString(data.actor);
  const reason = redactOptionalString(data.reason);
  return { actor: actor.value, reason: reason.value };
}

function memorySnapshot(memory: Memory): Partial<Memory> {
  return {
    id: memory.id,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    type: memory.type,
    lane: memory.lane,
    lifecycleState: memory.lifecycleState,
    reviewState: memory.reviewState,
    title: memory.title,
    content: memory.content,
    concepts: [...memory.concepts],
    files: [...memory.files],
    sessionIds: [...memory.sessionIds],
    strength: memory.strength,
    confidence: memory.confidence,
    version: memory.version,
    parentId: memory.parentId,
    supersedes: memory.supersedes ? [...memory.supersedes] : undefined,
    sourceObservationIds: memory.sourceObservationIds
      ? [...memory.sourceObservationIds]
      : undefined,
    isLatest: memory.isLatest,
    forgetAfter: memory.forgetAfter,
    archivedAt: memory.archivedAt,
    deletedAt: memory.deletedAt,
    restoredAt: memory.restoredAt,
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    privacyScope: memory.privacyScope,
    redactionApplied: memory.redactionApplied,
    sensitivityLabels: memory.sensitivityLabels
      ? [...memory.sensitivityLabels]
      : undefined,
    ownerId: memory.ownerId,
    branch: memory.branch,
    commit: memory.commit,
    sourceHash: memory.sourceHash,
    sourceType: memory.sourceType,
    sourceUri: memory.sourceUri,
    agentId: memory.agentId,
    project: memory.project,
  };
}

async function saveLocalRevision(
  kvInstance: StandaloneKV,
  memoryId: string,
  action: string,
  prior?: Memory | null,
  next?: Memory | null,
  meta: { actor?: string; reason?: string } = {},
): Promise<void> {
  const safeMeta = redactRevisionMeta(meta);
  const id = generateId("mrev");
  await kvInstance.set("mem:memory-history", id, {
    id,
    memoryId,
    action,
    createdAt: new Date().toISOString(),
    actor: safeMeta.actor,
    reason: safeMeta.reason,
    prior: prior ? memorySnapshot(prior) : undefined,
    next: next ? memorySnapshot(next) : undefined,
  });
}

async function localMemoryHistory(
  kvInstance: StandaloneKV,
  memoryId: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await kvInstance.list<Record<string, unknown>>(
    "mem:memory-history",
  );
  return rows
    .filter((row) => row["memoryId"] === memoryId)
    .sort((a, b) =>
      String(a["createdAt"] ?? "").localeCompare(String(b["createdAt"] ?? "")),
    );
}

async function deleteLocalMemory(
  kvInstance: StandaloneKV,
  existing: Memory,
  v: Pick<Validated, "mode" | "actor" | "reason">,
): Promise<{
  success: true;
  deleted: true;
  mode: string;
  memory?: Memory;
  purgedRevisionCount?: number;
  fallback: true;
}> {
  if (v.mode === "hard") {
    const history = await localMemoryHistory(kvInstance, existing.id);
    for (const revision of history) {
      if (typeof revision["id"] === "string") {
        await kvInstance.delete("mem:memory-history", revision["id"]);
      }
    }
    await kvInstance.delete("mem:memories", existing.id);
    return {
      success: true,
      deleted: true,
      mode: "hard",
      purgedRevisionCount: history.length,
      fallback: true,
    };
  }
  const now = new Date().toISOString();
  const tombstone: Memory = {
    ...existing,
    updatedAt: now,
    deletedAt: now,
    lifecycleState: "tombstoned",
    reviewState: "rejected",
    isLatest: false,
    title: `[deleted] ${existing.id}`,
    content: "",
    concepts: [],
    files: [],
  };
  await kvInstance.set("mem:memories", tombstone.id, tombstone);
  await saveLocalRevision(
    kvInstance,
    tombstone.id,
    "tombstone",
    existing,
    tombstone,
    { actor: v.actor, reason: v.reason },
  );
  return {
    success: true,
    deleted: true,
    mode: "tombstone",
    memory: tombstone,
    fallback: true,
  };
}

function localReviewReasons(memory: Memory): string[] {
  const reasons: string[] = [];
  if ((memory.lifecycleState ?? "active") === "quarantined") {
    reasons.push("sensitive_quarantine");
  }
  if (memory.redactionApplied) reasons.push("redaction_applied");
  if (!memory.sourceObservationIds || memory.sourceObservationIds.length === 0) {
    reasons.push("missing_source_evidence");
  }
  if ((memory.confidence ?? 1) < 0.5) reasons.push("low_confidence");
  if (memory.reviewState === "needs_review") reasons.push("explicit_review");
  if (memory.lifecycleState === undefined) reasons.push("legacy_lifecycle");
  return reasons;
}

const MEMORY_TYPES = new Set<Memory["type"]>([
  "pattern",
  "preference",
  "architecture",
  "bug",
  "workflow",
  "fact",
]);

function normalizeMemoryType(value: unknown): Memory["type"] {
  return typeof value === "string" && MEMORY_TYPES.has(value as Memory["type"])
    ? (value as Memory["type"])
    : "fact";
}

function buildLocalMemoryFromSave(v: Validated): Memory {
  const memType = normalizeMemoryType(v.type);
  const contentScan = scanPrivateData(v.content ?? "");
  const concepts = redactStringArray(v.concepts);
  const files = redactStringArray(v.files);
  const sourceObservationIds = redactStringArray(v.sourceObservationIds);
  const project = redactOptionalString(v.project);
  const agentId = redactOptionalString(v.agentId);
  const ownerId = redactOptionalString(v.ownerId);
  const branch = redactOptionalString(v.branch);
  const commit = redactOptionalString(v.commit);
  const sourceHash = redactOptionalString(v.sourceHash);
  const sourceType = redactOptionalString(v.sourceType);
  const sourceUri = redactOptionalString(v.sourceUri);
  const laneText = redactOptionalString(v.lane);
  const privacyScopeText = redactOptionalString(v.privacyScope);
  const reviewStateText = redactOptionalString(v.reviewState);
  const lane = normalizeMemoryLane(laneText.value);
  const privacyScope = normalizeMemoryPrivacyScope(privacyScopeText.value);
  const reviewState = normalizeMemoryReviewState(reviewStateText.value);
  const summary = summarizePrivacyScans(
    contentScan,
    concepts.scan,
    files.scan,
    sourceObservationIds.scan,
    project.scan,
    agentId.scan,
    ownerId.scan,
    branch.scan,
    commit.scan,
    sourceHash.scan,
    sourceType.scan,
    sourceUri.scan,
    laneText.scan,
    privacyScopeText.scan,
    reviewStateText.scan,
  );
  const isoNow = new Date().toISOString();
  const memory: Memory = {
    id: generateId("mem"),
    type: memType,
    lane: lane ?? defaultMemoryLane(memType),
    lifecycleState: summary.redactionApplied ? "quarantined" : "active",
    reviewState: summary.redactionApplied
      ? "needs_review"
      : reviewState ?? "unreviewed",
    title: contentScan.redacted.slice(0, 80),
    content: contentScan.redacted,
    concepts: concepts.values,
    files: files.values,
    createdAt: isoNow,
    updatedAt: isoNow,
    strength:
      typeof v.strength === "number" && Number.isFinite(v.strength)
        ? Math.max(0, Math.min(10, v.strength))
        : 7,
    confidence:
      typeof v.confidence === "number" && Number.isFinite(v.confidence)
        ? Math.max(0, Math.min(1, v.confidence))
        : undefined,
    version: 1,
    isLatest: true,
    sessionIds: [],
    sourceObservationIds: sourceObservationIds.values.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
    ...(project.value ? { project: project.value } : {}),
    ...(agentId.value ? { agentId: agentId.value } : {}),
    ...(ownerId.value ? { ownerId: ownerId.value } : {}),
    ...(branch.value ? { branch: branch.value } : {}),
    ...(commit.value ? { commit: commit.value } : {}),
    ...(sourceHash.value ? { sourceHash: sourceHash.value } : {}),
    ...(sourceType.value ? { sourceType: sourceType.value } : {}),
    ...(sourceUri.value ? { sourceUri: sourceUri.value } : {}),
    ...(privacyScope ? { privacyScope } : {}),
    ...(summary.redactionApplied
      ? {
          privacyScope: "user" as const,
          redactionApplied: true,
          sensitivityLabels: summary.labels,
        }
      : {}),
  };
  if (v.ttlDays && v.ttlDays > 0) {
    memory.forgetAfter = new Date(Date.now() + v.ttlDays * 86400000).toISOString();
  }
  return memory;
}

function coerceLocalMemory(raw: Record<string, unknown>): Memory {
  const type = normalizeMemoryType(raw["type"]);
  const state = normalizeMemoryState(raw["lifecycleState"]);
  const now = new Date().toISOString();
  return {
    id: typeof raw["id"] === "string" ? raw["id"] : generateId("mem"),
    createdAt:
      typeof raw["createdAt"] === "string" ? raw["createdAt"] : now,
    updatedAt:
      typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : now,
    type,
    lane: normalizeMemoryLane(raw["lane"]) ?? defaultMemoryLane(type),
    lifecycleState: state && state !== "all" ? state : "active",
    reviewState: normalizeMemoryReviewState(raw["reviewState"]) ?? "unreviewed",
    title: typeof raw["title"] === "string" ? raw["title"] : "",
    content: typeof raw["content"] === "string" ? raw["content"] : "",
    concepts: Array.isArray(raw["concepts"])
      ? raw["concepts"].filter((v): v is string => typeof v === "string")
      : [],
    files: Array.isArray(raw["files"])
      ? raw["files"].filter((v): v is string => typeof v === "string")
      : [],
    sessionIds: Array.isArray(raw["sessionIds"])
      ? raw["sessionIds"].filter((v): v is string => typeof v === "string")
      : [],
    strength:
      typeof raw["strength"] === "number" && Number.isFinite(raw["strength"])
        ? raw["strength"]
        : 7,
    confidence:
      typeof raw["confidence"] === "number" && Number.isFinite(raw["confidence"])
        ? raw["confidence"]
        : undefined,
    version:
      typeof raw["version"] === "number" && Number.isFinite(raw["version"])
        ? raw["version"]
        : 1,
    isLatest: raw["isLatest"] === false ? false : true,
    sourceObservationIds: Array.isArray(raw["sourceObservationIds"])
      ? raw["sourceObservationIds"].filter((v): v is string => typeof v === "string")
      : [],
    forgetAfter:
      typeof raw["forgetAfter"] === "string" ? raw["forgetAfter"] : undefined,
    archivedAt:
      typeof raw["archivedAt"] === "string" ? raw["archivedAt"] : undefined,
    deletedAt:
      typeof raw["deletedAt"] === "string" ? raw["deletedAt"] : undefined,
    restoredAt:
      typeof raw["restoredAt"] === "string" ? raw["restoredAt"] : undefined,
    validFrom:
      typeof raw["validFrom"] === "string" ? raw["validFrom"] : undefined,
    validUntil:
      typeof raw["validUntil"] === "string" ? raw["validUntil"] : undefined,
    privacyScope: normalizeMemoryPrivacyScope(raw["privacyScope"]),
    redactionApplied: raw["redactionApplied"] === true || undefined,
    sensitivityLabels: Array.isArray(raw["sensitivityLabels"])
      ? raw["sensitivityLabels"].filter((v): v is string => typeof v === "string")
      : undefined,
    project: typeof raw["project"] === "string" ? raw["project"] : undefined,
    branch: typeof raw["branch"] === "string" ? raw["branch"] : undefined,
    commit: typeof raw["commit"] === "string" ? raw["commit"] : undefined,
    ownerId: typeof raw["ownerId"] === "string" ? raw["ownerId"] : undefined,
    sourceHash: typeof raw["sourceHash"] === "string" ? raw["sourceHash"] : undefined,
    sourceType: typeof raw["sourceType"] === "string" ? raw["sourceType"] : undefined,
    sourceUri: typeof raw["sourceUri"] === "string" ? raw["sourceUri"] : undefined,
    agentId: typeof raw["agentId"] === "string" ? raw["agentId"] : undefined,
  };
}

function applyLocalMemoryUpdate(existing: Memory, v: Validated): Memory {
  const contentScan =
    v.content !== undefined ? scanPrivateData(v.content) : undefined;
  const titleScan = v.title !== undefined ? scanPrivateData(v.title) : undefined;
  const concepts =
    v.concepts !== undefined ? redactStringArray(v.concepts) : undefined;
  const files = v.files !== undefined ? redactStringArray(v.files) : undefined;
  const laneText = redactOptionalString(v.lane);
  const reviewText = redactOptionalString(v.reviewState);
  const privacyText = redactOptionalString(v.privacyScope);
  const actorText = redactOptionalString(v.actor);
  const reasonText = redactOptionalString(v.reason);
  const summary = summarizePrivacyScans(
    contentScan,
    titleScan,
    concepts?.scan,
    files?.scan,
    laneText.scan,
    reviewText.scan,
    privacyText.scan,
    actorText.scan,
    reasonText.scan,
  );
  const lane = normalizeMemoryLane(laneText.value);
  const reviewState = normalizeMemoryReviewState(reviewText.value);
  const privacyScope = normalizeMemoryPrivacyScope(privacyText.value);
  const labels = Array.from(
    new Set([...(existing.sensitivityLabels ?? []), ...summary.labels]),
  );
  return {
    ...existing,
    updatedAt: new Date().toISOString(),
    title: titleScan?.redacted ?? v.title ?? existing.title,
    content: contentScan?.redacted ?? v.content ?? existing.content,
    concepts: concepts?.values ?? existing.concepts,
    files: files?.values ?? existing.files,
    confidence:
      typeof v.confidence === "number" && Number.isFinite(v.confidence)
        ? Math.max(0, Math.min(1, v.confidence))
        : existing.confidence,
    strength:
      typeof v.strength === "number" && Number.isFinite(v.strength)
        ? Math.max(0, Math.min(10, v.strength))
        : existing.strength,
    lane: lane ?? existing.lane ?? defaultMemoryLane(existing.type),
    lifecycleState: summary.redactionApplied
      ? "quarantined"
      : existing.lifecycleState ?? "active",
    reviewState: summary.redactionApplied
      ? "needs_review"
      : reviewState ?? existing.reviewState,
    privacyScope:
      privacyScope ??
      existing.privacyScope ??
      (summary.redactionApplied ? "user" : undefined),
    redactionApplied:
      existing.redactionApplied || summary.redactionApplied || undefined,
    sensitivityLabels: labels.length > 0 ? labels : undefined,
    version: (existing.version ?? 1) + 1,
  };
}

function localMemoryMatchesQuery(memory: Memory, query: string): boolean {
  const text = [
    memory.title,
    memory.content,
    memory.files.join(" "),
    memory.concepts.join(" "),
    memory.sessionIds.join(" "),
    memory.id,
    memory.project ?? "",
    memory.branch ?? "",
    memory.commit ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return query
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

function localMemoryMatchesFilters(memory: Memory, v: Validated): boolean {
  if (!isMemorySearchable(memory)) return false;
  if (v.agentId && v.agentId !== "*" && memory.agentId !== v.agentId) return false;
  if (v.project && memory.project !== v.project) return false;
  if (v.cwd) return false;
  if (v.branch && memory.branch !== v.branch) return false;
  if (v.commit && memory.commit !== v.commit) return false;
  if (v.memoryTier && (memory.lane ?? defaultMemoryLane(memory.type)) !== v.memoryTier) {
    return false;
  }
  if (v.privacyScope && (memory.privacyScope ?? "project") !== v.privacyScope) {
    return false;
  }
  const temporal = normalizeTemporalValidityFilter({
    asOf: v.asOf,
    validAt: v.validAt,
  });
  if (temporal.filter && !isMemoryTemporallyCompatible(memory, temporal.filter)) {
    return false;
  }
  if (v.files && v.files.length > 0) {
    const wanted = v.files.map((file) => file.toLowerCase());
    const have = memory.files.map((file) => file.toLowerCase());
    if (!wanted.some((file) => have.some((candidate) => candidate.includes(file)))) {
      return false;
    }
  }
  return true;
}

function localMemoryMatchesSourceSelector(memory: Memory, v: Validated): boolean {
  if (
    v.sourceObservationId &&
    !(memory.sourceObservationIds ?? []).includes(v.sourceObservationId)
  ) {
    return false;
  }
  if (v.sourceHash && memory.sourceHash !== v.sourceHash) return false;
  if (v.sourceUri && memory.sourceUri !== v.sourceUri) return false;
  return true;
}

function localMemoryMatchesDeleteScope(memory: Memory, v: Validated): boolean {
  if (v.project && memory.project !== v.project) return false;
  if (v.agentId && memory.agentId !== v.agentId) return false;
  return true;
}

function localScopeValues(
  memories: Memory[],
  field: "project" | "agentId",
): string[] {
  return Array.from(
    new Set(memories.map((memory) => memory[field] ?? "(unscoped)")),
  ).sort();
}

function localDeleteTarget(memory: Memory): {
  memoryId: string;
  project?: string;
  agentId?: string;
  lifecycleState: MemoryLifecycleState;
  sourceObservationIds: string[];
  sourceHash?: string;
  sourceUri?: string;
} {
  return {
    memoryId: memory.id,
    project: memory.project,
    agentId: memory.agentId,
    lifecycleState: memory.lifecycleState ?? (memory.isLatest === false ? "superseded" : "active"),
    sourceObservationIds: memory.sourceObservationIds ?? [],
    sourceHash: memory.sourceHash,
    sourceUri: memory.sourceUri,
  };
}

function localSourceDeleteReport(data: {
  v: Validated;
  mode: string;
  dryRun: boolean;
  sourceMatches: Memory[];
  scopedMatches: Memory[];
  deletedIds?: string[];
}): {
  selector: {
    sourceObservationId?: string;
    sourceHash?: string;
    sourceUri?: string;
  };
  scope: { project?: string; agentId?: string };
  mode: string;
  dryRun: boolean;
  matched: number;
  wouldDelete: number;
  deletedIds: string[];
  targetIds: string[];
  targets: ReturnType<typeof localDeleteTarget>[];
  projectScopes: string[];
  agentScopes: string[];
  mutationAllowed: boolean;
  blockers: string[];
} {
  const projectScopes = localScopeValues(data.scopedMatches, "project");
  const agentScopes = localScopeValues(data.scopedMatches, "agentId");
  const blockers: string[] = [];
  if (data.scopedMatches.length > 0 && !data.v.project && !data.v.agentId) {
    blockers.push("project or agentId is required for source-linked delete");
  }
  if (!data.v.project && projectScopes.length > 1) {
    blockers.push("project is required when selector matches multiple project scopes");
  }
  if (!data.v.agentId && agentScopes.length > 1) {
    blockers.push("agentId is required when selector matches multiple agent scopes");
  }
  return {
    selector: {
      sourceObservationId: data.v.sourceObservationId,
      sourceHash: data.v.sourceHash,
      sourceUri: data.v.sourceUri,
    },
    scope: { project: data.v.project, agentId: data.v.agentId },
    mode: data.mode,
    dryRun: data.dryRun,
    matched: data.sourceMatches.length,
    wouldDelete: data.scopedMatches.length,
    deletedIds: data.deletedIds ?? [],
    targetIds: data.scopedMatches.map((memory) => memory.id),
    targets: data.scopedMatches.map(localDeleteTarget),
    projectScopes,
    agentScopes,
    mutationAllowed: blockers.length === 0,
    blockers,
  };
}

function textResponse(payload: unknown, pretty = false): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, pretty ? 2 : 0) },
    ],
  };
}

interface Validated {
  tool: string;
  content?: string;
  title?: string;
  type?: string;
  concepts?: string[];
  files?: string[];
  ttlDays?: number;
  sourceObservationIds?: string[];
  sourceObservationId?: string;
  query?: string;
  limit?: number;
  offset?: number;
  format?: string;
  tokenBudget?: number;
  memoryIds?: string[];
  memoryId?: string;
  reason?: string;
  actor?: string;
  expiresAt?: string;
  mode?: string;
  project?: string;
  cwd?: string;
  state?: MemoryLifecycleState | "all";
  lane?: string;
  reviewState?: string;
  privacyScope?: string;
  branch?: string;
  commit?: string;
  memoryTier?: string;
  searchMode?: string;
  retrievalMode?: RetrievalMode;
  asOf?: string;
  validAt?: string;
  explain?: boolean;
  includeReport?: boolean;
  agentId?: string;
  sessionId?: string;
  includeSourceCards?: boolean;
  confidence?: number;
  strength?: number;
  ownerId?: string;
  sourceHash?: string;
  sourceType?: string;
  sourceUri?: string;
  requireGatePass?: boolean;
  dryRun?: boolean;
  rulesResolvePayload?: RulesResolvePayload;
}

function validate(toolName: string, args: Record<string, unknown>): Validated {
  if (!IMPLEMENTED_TOOLS.has(toolName)) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const v: Validated = { tool: toolName };
  switch (toolName) {
    case "memory_save": {
      const content = args["content"];
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("content is required");
      }
      v.content = content;
      v.type = (args["type"] as string) || "fact";
      v.concepts = normalizeList(args["concepts"]);
      v.files = normalizeList(args["files"]);
      v.project = optionalString(args["project"]);
      v.agentId = scopedWriteAgentId(toolName, optionalString(args["agentId"]));
      return v;
    }
    case "memory_create": {
      const content = args["content"];
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("content is required");
      }
      v.content = content;
      v.type = optionalString(args["type"]) ?? "fact";
      if (args["concepts"] !== undefined) v.concepts = normalizeList(args["concepts"]);
      if (args["files"] !== undefined) v.files = normalizeList(args["files"]);
      v.ttlDays = parseNumber(args["ttlDays"]);
      if (args["sourceObservationIds"] !== undefined) {
        v.sourceObservationIds = normalizeList(args["sourceObservationIds"]);
      }
      v.agentId = optionalString(args["agentId"]);
      v.project = optionalString(args["project"]);
      v.lane = optionalString(args["lane"]);
      v.confidence = parseNumber(args["confidence"]);
      v.privacyScope = optionalString(args["privacyScope"]);
      v.ownerId = optionalString(args["ownerId"]);
      v.branch = optionalString(args["branch"]);
      v.commit = optionalString(args["commit"]);
      v.sourceHash = optionalString(args["sourceHash"]);
      v.sourceType = optionalString(args["sourceType"]);
      v.sourceUri = optionalString(args["sourceUri"]);
      v.reviewState = optionalString(args["reviewState"]);
      v.requireGatePass = parseBoolean(args["requireGatePass"]);
      return v;
    }
    case "memory_recall":
    case "memory_smart_search": {
      const query = args["query"];
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("query is required");
      }
      v.query = query.trim();
      v.limit = parseLimit(args["limit"]);
      v.project = optionalString(args["project"]);
      v.cwd = optionalString(args["cwd"]);
      v.agentId = scopedReadAgentId(toolName, optionalString(args["agentId"]));
      v.asOf = optionalString(args["asOf"]);
      v.validAt = optionalString(args["validAt"]);
      const temporal = normalizeTemporalValidityFilter({
        asOf: v.asOf,
        validAt: v.validAt,
      });
      if (temporal.error) throw new Error(temporal.error);
      const fmt = args["format"];
      if (typeof fmt === "string" && fmt.trim()) {
        v.format = fmt.trim().toLowerCase();
      }
      const budget = args["token_budget"] ?? args["tokenBudget"] ?? (
        toolName === "memory_smart_search" ? args["budget"] : undefined
      );
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
        v.tokenBudget = Math.floor(budget);
      } else if (typeof budget === "string" && budget.trim()) {
        const n = Number(budget);
        if (Number.isFinite(n) && n > 0) v.tokenBudget = Math.floor(n);
      }
      if (toolName === "memory_smart_search") {
        v.searchMode = parseSearchMode(args["searchMode"]);
        v.retrievalMode = parseRetrievalMode(args["retrievalMode"]);
        v.files = [
          ...normalizeList(args["files"]),
          ...normalizeList(args["file"]),
          ...normalizeList(args["filePath"]),
        ];
        v.branch = optionalString(args["branch"]);
        v.commit = optionalString(args["commit"]);
        v.memoryTier = optionalString(args["memoryTier"]);
        v.privacyScope = optionalString(args["privacyScope"]);
        v.sessionId = optionalString(args["sessionId"]);
        v.explain = parseBoolean(args["explain"]);
        v.includeReport = parseBoolean(args["includeReport"]);
      }
      return v;
    }
    case "memory_search_explain": {
      const query = args["query"];
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("query is required");
      }
      v.query = query.trim();
      v.limit = parseLimit(args["limit"]);
      v.project = optionalString(args["project"]);
      v.searchMode = parseSearchMode(args["searchMode"]);
      v.retrievalMode = parseRetrievalMode(args["retrievalMode"]);
      v.files = [
        ...normalizeList(args["files"]),
        ...normalizeList(args["file"]),
        ...normalizeList(args["filePath"]),
      ];
      v.cwd = optionalString(args["cwd"]);
      v.branch = optionalString(args["branch"]);
      v.commit = optionalString(args["commit"]);
      v.memoryTier = optionalString(args["memoryTier"]);
      v.privacyScope = optionalString(args["privacyScope"]);
      v.asOf = optionalString(args["asOf"]);
      v.validAt = optionalString(args["validAt"]);
      const temporal = normalizeTemporalValidityFilter({
        asOf: v.asOf,
        validAt: v.validAt,
      });
      if (temporal.error) throw new Error(temporal.error);
      v.agentId = optionalString(args["agentId"]);
      v.sessionId = optionalString(args["sessionId"]);
      v.includeReport = parseBoolean(args["includeReport"]);
      const budget = args["tokenBudget"] ?? args["token_budget"] ?? args["budget"];
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
        v.tokenBudget = Math.floor(budget);
      } else if (typeof budget === "string" && budget.trim()) {
        const n = Number(budget);
        if (Number.isFinite(n) && n > 0) v.tokenBudget = Math.floor(n);
      }
      return v;
    }
    case "memory_sessions": {
      v.limit = parseLimit(args["limit"], 20);
      return v;
    }
    case "memory_governance_delete": {
      const ids = normalizeList(args["memoryIds"]);
      if (ids.length === 0) throw new Error("memoryIds is required");
      v.memoryIds = ids;
      v.reason = (args["reason"] as string) || "plugin skill request";
      return v;
    }
    case "memory_export":
      return v;
    case "memory_audit": {
      v.limit = parseLimit(args["limit"], 50);
      return v;
    }
    case "memory_inspect":
    case "memory_history": {
      const memoryId = optionalString(args["memoryId"]);
      if (!memoryId) throw new Error("memoryId is required");
      v.memoryId = memoryId;
      return v;
    }
    case "memory_update": {
      const memoryId = optionalString(args["memoryId"]);
      if (!memoryId) throw new Error("memoryId is required");
      v.memoryId = memoryId;
      v.content = optionalString(args["content"]);
      v.title = optionalString(args["title"]);
      if (args["concepts"] !== undefined) v.concepts = normalizeList(args["concepts"]);
      if (args["files"] !== undefined) v.files = normalizeList(args["files"]);
      v.confidence = parseNumber(args["confidence"]);
      v.strength = parseNumber(args["strength"]);
      v.lane = optionalString(args["lane"]);
      v.reviewState = optionalString(args["reviewState"]);
      v.privacyScope = optionalString(args["privacyScope"]);
      v.reason = optionalString(args["reason"]);
      v.actor = optionalString(args["actor"]);
      return v;
    }
    case "memory_expire":
    case "memory_archive":
    case "memory_restore": {
      const memoryId = optionalString(args["memoryId"]);
      if (!memoryId) throw new Error("memoryId is required");
      v.memoryId = memoryId;
      v.reason = optionalString(args["reason"]);
      v.actor = optionalString(args["actor"]);
      v.expiresAt = optionalString(args["expiresAt"]);
      return v;
    }
    case "memory_delete": {
      const memoryId = optionalString(args["memoryId"]);
      v.memoryId = memoryId;
      v.sourceObservationId = optionalString(args["sourceObservationId"]);
      v.sourceHash = optionalString(args["sourceHash"]);
      v.sourceUri = optionalString(args["sourceUri"]);
      if (!v.memoryId && !v.sourceObservationId && !v.sourceHash && !v.sourceUri) {
        throw new Error("memoryId or source selector is required");
      }
      v.project = optionalString(args["project"]);
      v.agentId = optionalString(args["agentId"]);
      v.mode = optionalString(args["mode"]) === "hard" ? "hard" : "tombstone";
      v.reason = optionalString(args["reason"]);
      v.actor = optionalString(args["actor"]);
      v.dryRun = parseBoolean(args["dryRun"]);
      if (args["dryRun"] !== undefined && v.dryRun === undefined) {
        throw new Error("dryRun must be a boolean");
      }
      return v;
    }
    case "memory_ledger": {
      v.project = optionalString(args["project"]);
      v.state = normalizeMemoryState(args["state"]);
      v.type = optionalString(args["type"]);
      v.lane = optionalString(args["lane"]);
      v.reviewState = optionalString(args["reviewState"]);
      v.includeSourceCards = parseBoolean(args["includeSourceCards"]);
      v.limit = parseLimit(args["limit"], 100);
      v.offset = parseOffset(args["offset"]);
      return v;
    }
    case "memory_review_queue": {
      v.project = optionalString(args["project"]);
      v.limit = parseLimit(args["limit"], 50);
      return v;
    }
    case "memory_rules_resolve": {
      v.rulesResolvePayload = normalizeRulesResolveInput(args, {
        defaultCwd: process.cwd(),
      });
      return v;
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleProxy(
  v: Validated,
  handle: ProxyHandle,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (v.tool) {
    case "memory_save": {
      const result = await handle.call("/agentmemory/remember", {
        method: "POST",
        body: JSON.stringify({
          content: v.content,
          type: v.type,
          concepts: v.concepts,
          files: v.files,
          project: v.project,
          agentId: v.agentId,
        }),
      });
      return textResponse(result);
    }
    case "memory_create": {
      const result = await handle.call("/agentmemory/memory/create", {
        method: "POST",
        body: JSON.stringify({
          content: v.content,
          type: v.type,
          concepts: v.concepts,
          files: v.files,
          ttlDays: v.ttlDays,
          sourceObservationIds: v.sourceObservationIds,
          agentId: v.agentId,
          project: v.project,
          lane: v.lane,
          confidence: v.confidence,
          privacyScope: v.privacyScope,
          ownerId: v.ownerId,
          branch: v.branch,
          commit: v.commit,
          sourceHash: v.sourceHash,
          sourceType: v.sourceType,
          sourceUri: v.sourceUri,
          reviewState: v.reviewState,
          requireGatePass: v.requireGatePass,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_recall": {
      const body: Record<string, unknown> = {
        query: v.query,
        limit: v.limit,
        format: v.format ?? "full",
        project: v.project,
        cwd: v.cwd,
        agentId: v.agentId,
      };
      if (v.tokenBudget != null) body["token_budget"] = v.tokenBudget;
      const result = await handle.call("/agentmemory/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return textResponse(result, true);
    }
    case "memory_smart_search": {
      const body: Record<string, unknown> = {
        query: v.query,
        limit: v.limit,
        project: v.project,
        cwd: v.cwd,
        searchMode: v.searchMode,
        retrievalMode: v.retrievalMode,
        files: v.files && v.files.length > 0 ? v.files : undefined,
        branch: v.branch,
        commit: v.commit,
        memoryTier: v.memoryTier,
        privacyScope: v.privacyScope,
        asOf: v.asOf,
        validAt: v.validAt,
        agentId: v.agentId,
        sessionId: v.sessionId,
        explain: v.explain,
        includeReport: v.includeReport,
      };
      if (v.format != null) body["format"] = v.format;
      if (v.tokenBudget != null) body["tokenBudget"] = v.tokenBudget;
      const result = await handle.call("/agentmemory/smart-search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return textResponse(result, true);
    }
    case "memory_search_explain": {
      const body: Record<string, unknown> = {
        query: v.query,
        limit: v.limit,
        project: v.project,
        cwd: v.cwd,
        searchMode: v.searchMode,
        retrievalMode: v.retrievalMode,
        files: v.files && v.files.length > 0 ? v.files : undefined,
        branch: v.branch,
        commit: v.commit,
        memoryTier: v.memoryTier,
        privacyScope: v.privacyScope,
        asOf: v.asOf,
        validAt: v.validAt,
        agentId: v.agentId,
        sessionId: v.sessionId,
        includeReport: v.includeReport,
      };
      if (v.tokenBudget != null) body["tokenBudget"] = v.tokenBudget;
      const result = await handle.call("/agentmemory/search/explain", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return textResponse(result, true);
    }
    case "memory_sessions": {
      const result = await handle.call(
        `/agentmemory/sessions?limit=${v.limit}`,
        { method: "GET" },
      );
      return textResponse(result, true);
    }
    case "memory_governance_delete": {
      const result = await handle.call("/agentmemory/governance/memories", {
        method: "DELETE",
        body: JSON.stringify({ memoryIds: v.memoryIds, reason: v.reason }),
      });
      return textResponse(result);
    }
    case "memory_export": {
      const result = await handle.call("/agentmemory/export", { method: "GET" });
      return textResponse(result, true);
    }
    case "memory_audit": {
      const result = await handle.call(
        `/agentmemory/audit?limit=${v.limit}`,
        { method: "GET" },
      );
      return textResponse(result, true);
    }
    case "memory_inspect": {
      const result = await handle.call("/agentmemory/memory/inspect", {
        method: "POST",
        body: JSON.stringify({ memoryId: v.memoryId }),
      });
      return textResponse(result, true);
    }
    case "memory_history": {
      const result = await handle.call("/agentmemory/memory/history", {
        method: "POST",
        body: JSON.stringify({ memoryId: v.memoryId }),
      });
      return textResponse(result, true);
    }
    case "memory_update": {
      const result = await handle.call("/agentmemory/memory/update", {
        method: "POST",
        body: JSON.stringify({
          memoryId: v.memoryId,
          content: v.content,
          title: v.title,
          concepts: v.concepts,
          files: v.files,
          confidence: v.confidence,
          strength: v.strength,
          lane: v.lane,
          reviewState: v.reviewState,
          privacyScope: v.privacyScope,
          reason: v.reason,
          actor: v.actor,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_expire": {
      const result = await handle.call("/agentmemory/memory/expire", {
        method: "POST",
        body: JSON.stringify({
          memoryId: v.memoryId,
          expiresAt: v.expiresAt,
          reason: v.reason,
          actor: v.actor,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_archive": {
      const result = await handle.call("/agentmemory/memory/archive", {
        method: "POST",
        body: JSON.stringify({
          memoryId: v.memoryId,
          reason: v.reason,
          actor: v.actor,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_restore": {
      const result = await handle.call("/agentmemory/memory/restore", {
        method: "POST",
        body: JSON.stringify({
          memoryId: v.memoryId,
          reason: v.reason,
          actor: v.actor,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_delete": {
      const result = await handle.call("/agentmemory/memory/delete", {
        method: "POST",
        body: JSON.stringify({
          memoryId: v.memoryId,
          sourceObservationId: v.sourceObservationId,
          sourceHash: v.sourceHash,
          sourceUri: v.sourceUri,
          project: v.project,
          agentId: v.agentId,
          mode: v.mode,
          reason: v.reason,
          actor: v.actor,
          dryRun: v.dryRun,
        }),
      });
      return textResponse(result, true);
    }
    case "memory_ledger": {
      const params = new URLSearchParams();
      if (v.project) params.set("project", v.project);
      if (v.state) params.set("state", v.state);
      if (v.type) params.set("type", v.type);
      if (v.lane) params.set("lane", v.lane);
      if (v.reviewState) params.set("reviewState", v.reviewState);
      if (v.includeSourceCards !== undefined) {
        params.set("includeSourceCards", String(v.includeSourceCards));
      }
      if (v.limit !== undefined) params.set("limit", String(v.limit));
      if (v.offset !== undefined) params.set("offset", String(v.offset));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const result = await handle.call(`/agentmemory/memory-ledger${suffix}`, {
        method: "GET",
      });
      return textResponse(result, true);
    }
    case "memory_review_queue": {
      const params = new URLSearchParams();
      if (v.project) params.set("project", v.project);
      if (v.limit !== undefined) params.set("limit", String(v.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const result = await handle.call(
        `/agentmemory/memory-review-queue${suffix}`,
        { method: "GET" },
      );
      return textResponse(result, true);
    }
    case "memory_rules_resolve": {
      const result = await handle.call("/agentmemory/rules/resolve", {
        method: "POST",
        body: JSON.stringify(v.rulesResolvePayload ?? {}),
      });
      return textResponse(result, true);
    }
    default:
      throw new Error(`Unknown tool: ${v.tool}`);
  }
}

async function handleLocal(
  v: Validated,
  kvInstance: StandaloneKV,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  switch (v.tool) {
    case "memory_save": {
      const memory = buildLocalMemoryFromSave(v);
      await kvInstance.set("mem:memories", memory.id, memory);
      await saveLocalRevision(kvInstance, memory.id, "create", null, memory);
      kvInstance.persist();
      return textResponse({ saved: memory.id, memory });
    }

    case "memory_create": {
      const memory = buildLocalMemoryFromSave(v);
      await kvInstance.set("mem:memories", memory.id, memory);
      await saveLocalRevision(kvInstance, memory.id, "create", null, memory);
      const history = await localMemoryHistory(kvInstance, memory.id);
      kvInstance.persist();
      return textResponse(
        {
          success: true,
          memory,
          sourceCard: {
            memoryId: memory.id,
            sourceType: memory.sourceType ?? "manual",
            sourceUri: memory.sourceUri,
            sourceHash: memory.sourceHash,
            project: memory.project,
            branch: memory.branch,
            commit: memory.commit,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            sourceObservationIds: memory.sourceObservationIds ?? [],
            sessions: [],
            observations: [],
          },
          history,
          searchable: isMemorySearchable(memory),
          fallback: true,
        },
        true,
      );
    }

    case "memory_recall":
    case "memory_smart_search": {
      const query = (v.query || "").toLowerCase();
      const limit = v.limit ?? DEFAULT_LIMIT;
      const all =
        await kvInstance.list<Record<string, unknown>>("mem:memories");
      const results = all
        .map(coerceLocalMemory)
        .filter((m) => isMemorySearchable(m))
        .filter((m) => localMemoryMatchesFilters(m, v))
        .filter((m) => localMemoryMatchesQuery(m, query))
        .slice(0, limit);
      const response: Record<string, unknown> = { mode: "compact", results };
      if (v.tool === "memory_smart_search" && v.explain) {
        response["queryPlan"] = {
          mode: "search",
          searchMode: v.searchMode ?? "fast",
          retrievalMode: v.retrievalMode ?? "basic",
          streams: ["local_memory"],
          filterStage: "local hard filters before response packing",
          hardFilters: {
            agentId: v.agentId,
            project: v.project,
            cwd: v.cwd,
            files: v.files,
            branch: v.branch,
            commit: v.commit,
            memoryTier: v.memoryTier,
            privacyScope: v.privacyScope,
            temporalValidity: temporalValidityHardFilter(
              normalizeTemporalValidityFilter({
                asOf: v.asOf,
                validAt: v.validAt,
              }).filter,
            ),
          },
          limits: { requested: limit, overFetch: limit },
        };
        response["rankedEvidence"] = results.map((memory, index) => ({
          id: memory.id,
          sourceType: "memory",
          rank: index + 1,
          title: memory.title,
          content: memory.content,
          score: 1 / (index + 1),
          reasons: ["local substring match"],
        }));
      }
      return textResponse(response, true);
    }

    case "memory_sessions": {
      const sessions =
        await kvInstance.list<Record<string, unknown>>("mem:sessions");
      const limit = v.limit ?? 20;
      return textResponse({ sessions: sessions.slice(0, limit) }, true);
    }

    case "memory_governance_delete": {
      let deleted = 0;
      for (const id of v.memoryIds || []) {
        const existing = await kvInstance.get("mem:memories", id);
        if (existing) {
          await kvInstance.delete("mem:memories", id);
          deleted++;
        }
      }
      kvInstance.persist();
      return textResponse({
        deleted,
        requested: (v.memoryIds || []).length,
        reason: v.reason,
      });
    }

    case "memory_export": {
      const memories = await kvInstance.list("mem:memories");
      const sessions = await kvInstance.list("mem:sessions");
      return textResponse({ version: VERSION, memories, sessions }, true);
    }

    case "memory_audit": {
      const entries = await kvInstance.list("mem:audit");
      const limit = v.limit ?? 50;
      return textResponse(
        {
          entries: (entries as Array<Record<string, unknown>>).slice(0, limit),
        },
        true,
      );
    }

    case "memory_inspect": {
      const raw = await kvInstance.get<Record<string, unknown>>(
        "mem:memories",
        v.memoryId!,
      );
      if (!raw) return textResponse({ success: false, error: "memory not found" }, true);
      const memory = coerceLocalMemory(raw);
      const history = await localMemoryHistory(kvInstance, memory.id);
      return textResponse(
        {
          success: true,
          memory,
          sourceCard: {
            memoryId: memory.id,
            sourceType: memory.sourceType ?? "manual",
            sourceUri: memory.sourceUri,
            sourceHash: memory.sourceHash,
            project: memory.project,
            branch: memory.branch,
            commit: memory.commit,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            sourceObservationIds: memory.sourceObservationIds ?? [],
            sessions: [],
            observations: [],
          },
          history,
          searchable: isMemorySearchable(memory),
          fallback: true,
        },
        true,
      );
    }

    case "memory_history": {
      return textResponse(
        {
          success: true,
          history: await localMemoryHistory(kvInstance, v.memoryId!),
          fallback: true,
        },
        true,
      );
    }

    case "memory_update": {
      const raw = await kvInstance.get<Record<string, unknown>>(
        "mem:memories",
        v.memoryId!,
      );
      if (!raw) return textResponse({ success: false, error: "memory not found" }, true);
      const existing = coerceLocalMemory(raw);
      const updated = applyLocalMemoryUpdate(existing, v);
      await kvInstance.set("mem:memories", updated.id, updated);
      await saveLocalRevision(kvInstance, updated.id, "update", existing, updated, {
        actor: v.actor,
        reason: v.reason,
      });
      kvInstance.persist();
      return textResponse({ success: true, memory: updated, fallback: true }, true);
    }

    case "memory_expire":
    case "memory_archive":
    case "memory_restore": {
      const raw = await kvInstance.get<Record<string, unknown>>(
        "mem:memories",
        v.memoryId!,
      );
      if (!raw) return textResponse({ success: false, error: "memory not found" }, true);
      const existing = coerceLocalMemory(raw);
      const now = new Date().toISOString();
      const action =
        v.tool === "memory_expire"
          ? "expire"
          : v.tool === "memory_archive"
            ? "archive"
            : "restore";
      const updated: Memory = {
        ...existing,
        updatedAt: now,
        lifecycleState:
          v.tool === "memory_expire"
            ? "expired"
            : v.tool === "memory_archive"
              ? "archived"
              : "active",
        isLatest: v.tool === "memory_restore" ? true : false,
        ...(v.tool === "memory_expire"
          ? {
              forgetAfter: redactOptionalString(v.expiresAt).value ?? now,
              validUntil: redactOptionalString(v.expiresAt).value ?? now,
            }
          : {}),
        ...(v.tool === "memory_archive" ? { archivedAt: now } : {}),
        ...(v.tool === "memory_restore"
          ? {
              restoredAt: now,
              archivedAt: undefined,
              deletedAt: undefined,
              forgetAfter: undefined,
            }
          : {}),
      };
      await kvInstance.set("mem:memories", updated.id, updated);
      await saveLocalRevision(kvInstance, updated.id, action, existing, updated, {
        actor: v.actor,
        reason: v.reason,
      });
      kvInstance.persist();
      return textResponse({ success: true, memory: updated, fallback: true }, true);
    }

    case "memory_delete": {
      const hasSourceSelector = Boolean(
        v.sourceObservationId || v.sourceHash || v.sourceUri,
      );
      if (hasSourceSelector && !v.memoryId) {
        const sourceMatches = (
          await kvInstance.list<Record<string, unknown>>("mem:memories")
        )
          .map(coerceLocalMemory)
          .filter((memory) => localMemoryMatchesSourceSelector(memory, v));
        const scopedMatches = sourceMatches
          .filter((memory) => localMemoryMatchesDeleteScope(memory, v))
          .sort((a, b) => a.id.localeCompare(b.id));
        const report = localSourceDeleteReport({
          v,
          mode: v.mode ?? "tombstone",
          dryRun: v.dryRun === true,
          sourceMatches,
          scopedMatches,
        });
        if (v.dryRun) {
          return textResponse(
            {
              success: true,
              deleted: 0,
              mode: v.mode ?? "tombstone",
              dryRun: true,
              wouldDelete: scopedMatches.length,
              propagation: report,
              fallback: true,
            },
            true,
          );
        }
        if (!report.mutationAllowed) {
          return textResponse(
            {
              success: false,
              error: report.blockers[0] ?? "source-linked delete is not scoped",
              deleted: 0,
              mode: v.mode ?? "tombstone",
              dryRun: false,
              wouldDelete: scopedMatches.length,
              propagation: report,
              fallback: true,
            },
            true,
          );
        }
        const deletedIds: string[] = [];
        for (const target of scopedMatches) {
          const raw = await kvInstance.get<Record<string, unknown>>(
            "mem:memories",
            target.id,
          );
          if (!raw) continue;
          const existing = coerceLocalMemory(raw);
          if (!localMemoryMatchesSourceSelector(existing, v)) continue;
          if (!localMemoryMatchesDeleteScope(existing, v)) continue;
          await deleteLocalMemory(kvInstance, existing, v);
          deletedIds.push(existing.id);
        }
        kvInstance.persist();
        return textResponse(
          {
            success: true,
            deleted: deletedIds.length,
            mode: v.mode ?? "tombstone",
            dryRun: false,
            wouldDelete: scopedMatches.length,
            propagation: localSourceDeleteReport({
              v,
              mode: v.mode ?? "tombstone",
              dryRun: false,
              sourceMatches,
              scopedMatches,
              deletedIds,
            }),
            fallback: true,
          },
          true,
        );
      }
      const raw = await kvInstance.get<Record<string, unknown>>(
        "mem:memories",
        v.memoryId!,
      );
      if (!raw) return textResponse({ success: false, error: "memory not found" }, true);
      const existing = coerceLocalMemory(raw);
      if (
        hasSourceSelector &&
        (!localMemoryMatchesSourceSelector(existing, v) ||
          !localMemoryMatchesDeleteScope(existing, v))
      ) {
        return textResponse(
          {
            success: false,
            error: "memory does not match source selector",
            fallback: true,
          },
          true,
        );
      }
      if (v.dryRun) {
        return textResponse(
          {
            success: true,
            deleted: false,
            mode: v.mode ?? "tombstone",
            dryRun: true,
            wouldDelete: 1,
            target: localDeleteTarget(existing),
            fallback: true,
          },
          true,
        );
      }
      const result = await deleteLocalMemory(kvInstance, existing, v);
      kvInstance.persist();
      return textResponse(result, true);
    }

    case "memory_search_explain": {
      const query = (v.query || "").toLowerCase();
      const limit = v.limit ?? DEFAULT_LIMIT;
      const all = (await kvInstance.list<Record<string, unknown>>("mem:memories"))
        .map(coerceLocalMemory);
      const filtered = all
        .filter((m) => localMemoryMatchesFilters(m, v))
        .filter((m) => localMemoryMatchesQuery(m, query));
      const results = filtered.slice(0, limit).map((memory, index) => ({
        ...memory,
        score: 1 / (index + 1),
        why: ["local substring match", "hard filters applied before packing"],
      }));
      return textResponse(
        {
          mode: "compact",
          query: v.query,
          results,
          explain: {
            queryPlan: {
              searchMode: v.searchMode ?? "fast",
              retrievalMode: v.retrievalMode ?? "basic",
              filters: {
                agentId: v.agentId,
                project: v.project,
                cwd: v.cwd,
                files: v.files,
                branch: v.branch,
                commit: v.commit,
                memoryTier: v.memoryTier,
                privacyScope: v.privacyScope,
                temporalValidity: temporalValidityHardFilter(
                  normalizeTemporalValidityFilter({
                    asOf: v.asOf,
                    validAt: v.validAt,
                  }).filter,
                ),
              },
              filterStage: "local hard filters before response packing",
            },
            streams: [{ name: "local_memory", candidates: all.length }],
            candidateCounts: {
              beforeFilters: all.length,
              afterFilters: filtered.length,
              returned: results.length,
            },
            warnings: ["standalone local fallback uses substring search only"],
          },
          fallback: true,
        },
        true,
      );
    }

    case "memory_ledger": {
      let memories = (await kvInstance.list<Record<string, unknown>>("mem:memories"))
        .map(coerceLocalMemory);
      if (v.project) memories = memories.filter((m) => m.project === v.project);
      if (v.type) memories = memories.filter((m) => m.type === v.type);
      if (v.lane) {
        memories = memories.filter(
          (m) => (m.lane ?? defaultMemoryLane(m.type)) === v.lane,
        );
      }
      if (v.reviewState) {
        memories = memories.filter((m) => (m.reviewState ?? "unreviewed") === v.reviewState);
      }
      if (v.state && v.state !== "all") {
        memories = memories.filter((m) => (m.lifecycleState ?? "active") === v.state);
      } else if (!v.state) {
        memories = memories.filter((m) => (m.lifecycleState ?? "active") === "active");
      }
      memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const offset = v.offset ?? 0;
      const limit = v.limit ?? 100;
      const rows = memories.slice(offset, offset + limit).map((memory) => ({
        id: memory.id,
        title: memory.title,
        type: memory.type,
        lane: memory.lane ?? defaultMemoryLane(memory.type),
        lifecycleState: memory.lifecycleState ?? "active",
        reviewState: memory.reviewState ?? "unreviewed",
        project: memory.project,
        branch: memory.branch,
        commit: memory.commit,
        confidence: memory.confidence,
        strength: memory.strength,
        redactionApplied: memory.redactionApplied === true,
        sensitivityLabels: memory.sensitivityLabels ?? [],
        sourceObservationCount: memory.sourceObservationIds?.length ?? 0,
        sessionCount: memory.sessionIds.length,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        sourceCard: v.includeSourceCards
          ? {
              memoryId: memory.id,
              sourceType: memory.sourceType ?? "manual",
              sourceUri: memory.sourceUri,
              sourceHash: memory.sourceHash,
              project: memory.project,
              branch: memory.branch,
              commit: memory.commit,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
              sourceObservationIds: memory.sourceObservationIds ?? [],
              sessions: [],
              observations: [],
            }
          : undefined,
      }));
      return textResponse(
        { success: true, rows, total: memories.length, offset, limit, fallback: true },
        true,
      );
    }

    case "memory_review_queue": {
      const limit = v.limit ?? 50;
      const queue = (await kvInstance.list<Record<string, unknown>>("mem:memories"))
        .map(coerceLocalMemory)
        .filter((memory) => isMemorySearchable(memory) || memory.lifecycleState === "quarantined")
        .filter((memory) => !v.project || memory.project === v.project)
        .map((memory) => ({
          memory,
          reasons: localReviewReasons(memory),
          score: localReviewReasons(memory).length,
        }))
        .filter((row) => row.reasons.length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return textResponse({ success: true, queue, total: queue.length, fallback: true }, true);
    }

    case "memory_rules_resolve": {
      // Item 4 (STANDALONE LOCAL fallback): this is a trusted same-user CLI
      // invocation of the user's own tool, not a network request. Allow the
      // user's requested workspaceRoot (allowedRoots includes the requested
      // root) and honor caller options (allowCallerOptions:true) so
      // includeContent and custom instructionGlobs work — otherwise the local
      // developer workflow breaks. The network surface stays locked down
      // separately in src/mcp/server.ts.
      const payload = v.rulesResolvePayload ?? normalizeRulesResolveInput({}, {
        defaultCwd: process.cwd(),
      });
      const result = await resolveRulesRequest(payload, {
        defaultCwd: process.cwd(),
        allowedRoots: [process.cwd(), payload.workspaceRoot],
        allowCallerOptions: true,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
      return textResponse({ ...result, fallback: true }, true);
    }

    default:
      throw new Error(`Unknown tool: ${v.tool}`);
  }
}

async function handleProxyGeneric(
  toolName: string,
  args: Record<string, unknown>,
  handle: ProxyHandle,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Forward to the server's full MCP surface so non-Claude clients can
  // reach the full tool surface (lessons, sentinels, slots, signals, graph, ...)
  // instead of being capped at the reduced IMPLEMENTED_TOOLS set baked into
  // this shim. The server validates arguments per tool.
  const result = (await handle.call("/agentmemory/mcp/call", {
    method: "POST",
    body: JSON.stringify({ name: toolName, arguments: args }),
  })) as { content?: Array<{ type: string; text: string }> } | null;
  if (result && Array.isArray(result.content)) {
    return { content: result.content };
  }
  return textResponse(result, true);
}

export async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
  kvInstance: StandaloneKV = kv,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const handle = await resolveHandle();
  announceMode(handle);

  // Tools the local InMemoryKV fallback doesn't implement: forward straight
  // to the server. Local validation would otherwise raise "Unknown tool"
  // (issue #234).
  if (!IMPLEMENTED_TOOLS.has(toolName)) {
    if (handle.mode === "proxy") {
      try {
        return await handleProxyGeneric(toolName, args, handle);
      } catch (err) {
        process.stderr.write(
          `[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        // A 4xx is a definitive server answer; keep the handle warm. Other
        // failures may mean the server is gone — re-probe on the next call.
        const is4xx =
          err instanceof ProxyHttpError && err.status >= 400 && err.status < 500;
        if (!is4xx) invalidateHandle();
        throw err;
      }
    }
    throw new Error(
      `Unknown tool: ${toolName} (local fallback supports only ${[...IMPLEMENTED_TOOLS].join(", ")}; start an agentmemory server and set AGENTMEMORY_URL to use the full tool set)`,
    );
  }

  const validated = validate(toolName, args);
  if (handle.mode === "proxy") {
    try {
      return await handleProxy(validated, handle);
    } catch (err) {
      const is4xx =
        err instanceof ProxyHttpError && err.status >= 400 && err.status < 500;
      // A 4xx is a definitive server answer (the connection is fine), so keep
      // the proxy handle warm. Any other failure means the server may be
      // unreachable — drop the handle so the next call re-probes.
      if (!is4xx) invalidateHandle();
      if (!shouldFallBackToLocal(toolName, err)) {
        process.stderr.write(
          `[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}; surfacing server error (no local mutation)\n`,
        );
        throw err;
      }
      process.stderr.write(
        `[@agentmemory/mcp] proxy call failed for ${toolName}: ${err instanceof Error ? err.message : String(err)}; falling back to local KV (read-only)\n`,
      );
    }
  }
  return handleLocal(validated, kvInstance);
}

export async function handleToolsList(): Promise<{ tools: unknown[] }> {
  const debug = process.env["AGENTMEMORY_DEBUG"] === "1" || process.env["AGENTMEMORY_DEBUG"] === "true";
  const handle = await resolveHandle();
  announceMode(handle);
  if (debug) {
    process.stderr.write(
      `[@agentmemory/mcp] tools/list: handle.mode=${handle.mode}${handle.mode === "proxy" ? ` baseUrl=${handle.baseUrl}` : ""}\n`,
    );
  }
  if (handle.mode === "proxy") {
    try {
      const remote = (await handle.call("/agentmemory/mcp/tools", {
        method: "GET",
      })) as { tools?: unknown } | null;
      if (debug) {
        const shape = remote === null
          ? "null"
          : typeof remote !== "object"
            ? typeof remote
            : `keys=${Object.keys(remote as object).join(",")} toolsType=${Array.isArray((remote as { tools?: unknown }).tools) ? `array(len=${((remote as { tools: unknown[] }).tools).length})` : typeof (remote as { tools?: unknown }).tools}`;
        process.stderr.write(
          `[@agentmemory/mcp] tools/list: remote response shape: ${shape}\n`,
        );
      }
      if (remote && Array.isArray(remote.tools)) {
        if (debug) {
          process.stderr.write(
            `[@agentmemory/mcp] tools/list: returning ${remote.tools.length} tools from server\n`,
          );
        }
        return { tools: remote.tools };
      }
      process.stderr.write(
        `[@agentmemory/mcp] tools/list: server returned unexpected shape (no .tools array); falling back to local IMPLEMENTED_TOOLS list. Set AGENTMEMORY_DEBUG=1 to inspect response.\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[@agentmemory/mcp] tools/list proxy failed: ${err instanceof Error ? err.message : String(err)}; falling back to local list\n`,
      );
      invalidateHandle();
    }
  }
  const fallback = getAllTools().filter((t) => IMPLEMENTED_TOOLS.has(t.name));
  if (debug) {
    process.stderr.write(
      `[@agentmemory/mcp] tools/list: returning ${fallback.length} local fallback tools (${fallback.map((t) => t.name).join(",")})\n`,
    );
  }
  return { tools: fallback };
}

const transport = createStdioTransport(async (method, params) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: SERVER_INFO.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: SERVER_INFO.name,
          version: SERVER_INFO.version,
        },
      };

    case "notifications/initialized":
      return {};

    case "tools/list":
      return handleToolsList();

    case "tools/call": {
      const toolName = params.name as string;
      const toolArgs = (params.arguments as Record<string, unknown>) || {};
      try {
        return await handleToolCall(toolName, toolArgs);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
});

process.stderr.write(
  `[@agentmemory/mcp] Standalone MCP server v${SERVER_INFO.version} starting...\n`,
);
transport.start();

process.on("SIGINT", () => {
  kv.persist();
  process.exit(0);
});
process.on("SIGTERM", () => {
  kv.persist();
  process.exit(0);
});
