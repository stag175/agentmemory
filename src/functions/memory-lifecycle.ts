import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  Memory,
  MemoryLifecycleState,
  MemoryRelation,
  MemoryRevision,
  MemoryReviewState,
  MemorySourceCard,
  Session,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import {
  defaultMemoryLane,
  isMemorySearchable,
  memoryToObservation,
  normalizeMemoryLane,
  normalizeMemoryPrivacyScope,
  normalizeMemoryReviewState,
} from "../state/memory-utils.js";
import {
  flushIndexSave,
  getSearchIndex,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "./search.js";
import { getAccessLog, deleteAccessLog } from "./access-tracker.js";
import { recordAudit, safeAudit } from "./audit.js";
import {
  redactOptionalString,
  redactStringArray,
  scanPrivateData,
  summarizePrivacyScans,
} from "./privacy.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import { safeRecordAgentEvent } from "./agent-events.js";

type LifecycleAction =
  | "update"
  | "expire"
  | "archive"
  | "restore"
  | "tombstone"
  | "delete";

type RevisionOptions = {
  actor?: string;
  reason?: string;
};

type TemporalStatus =
  | "current"
  | "not_yet_valid"
  | "expired"
  | "invalid_window";

type TemporalReview = {
  status: TemporalStatus;
  reasons: string[];
  searchable: boolean;
};

type TimestampValidation = {
  ok: true;
  value?: string;
  scan: ReturnType<typeof redactOptionalString>["scan"];
} | {
  ok: false;
  error: string;
  scan: ReturnType<typeof redactOptionalString>["scan"];
};

type WriteGateMetadata = {
  pass?: unknown;
  reasons?: unknown;
  flags?: unknown;
};

type MemoryCreateInput = {
  content?: unknown;
  type?: unknown;
  concepts?: unknown;
  files?: unknown;
  ttlDays?: unknown;
  sourceObservationIds?: unknown;
  agentId?: unknown;
  project?: unknown;
  lane?: unknown;
  confidence?: unknown;
  privacyScope?: unknown;
  ownerId?: unknown;
  branch?: unknown;
  commit?: unknown;
  sourceHash?: unknown;
  sourceType?: unknown;
  sourceUri?: unknown;
  reviewState?: unknown;
  requireGatePass?: unknown;
  writeGate?: unknown;
};

type DeleteMode = "tombstone" | "hard";

type MemoryDeleteInput = {
  memoryId?: unknown;
  mode?: unknown;
  reason?: unknown;
  actor?: unknown;
  sourceObservationId?: unknown;
  sourceHash?: unknown;
  sourceUri?: unknown;
  project?: unknown;
  agentId?: unknown;
  dryRun?: unknown;
};

type SourceDeleteSelector = {
  sourceObservationId?: string;
  sourceHash?: string;
  sourceUri?: string;
  project?: string;
  agentId?: string;
};

type SourceDeleteReport = {
  selector: {
    sourceObservationId?: string;
    sourceHash?: string;
    sourceUri?: string;
  };
  scope: {
    project?: string;
    agentId?: string;
  };
  mode: DeleteMode;
  dryRun: boolean;
  matched: number;
  wouldDelete: number;
  deletedIds: string[];
  targetIds: string[];
  targets: Array<{
    memoryId: string;
    project?: string;
    agentId?: string;
    lifecycleState: MemoryLifecycleState;
    sourceObservationIds: string[];
    sourceHash?: string;
    sourceUri?: string;
  }>;
  projectScopes: string[];
  agentScopes: string[];
  mutationAllowed: boolean;
  blockers: string[];
};

type DateWindow = {
  date: string;
  since: string;
  until: string;
  sinceMs: number;
  untilMs: number;
};

type DailyInboxInput = {
  project?: unknown;
  agentId?: unknown;
  sessionId?: unknown;
  date?: unknown;
  since?: unknown;
  until?: unknown;
  limit?: unknown;
};

type UnlinkedMentionsInput = DailyInboxInput & {
  minMentions?: unknown;
};

type ObservationRow = {
  session: Session;
  observation: CompressedObservation;
};

type ReviewQueueRow = {
  memory: Memory;
  reasons: string[];
  score: number;
  temporalStatus: TemporalStatus;
};

type ProposalLike = {
  id: string;
  teamId?: string;
  project?: string;
  action?: string;
  status?: string;
  title?: string;
  reason?: string;
  targetMemoryId?: string;
  proposedAt?: string;
  updatedAt?: string;
};

const MEMORY_CREATE_FIELDS = [
  "content",
  "type",
  "concepts",
  "files",
  "ttlDays",
  "sourceObservationIds",
  "agentId",
  "project",
  "lane",
  "confidence",
  "privacyScope",
  "ownerId",
  "branch",
  "commit",
  "sourceHash",
  "sourceType",
  "sourceUri",
  "reviewState",
  "requireGatePass",
  "writeGate",
] as const;

const REVIEW_QUEUE_REASONS = new Set([
  "expired_lifecycle",
  "expired_valid_window",
  "stale_valid_window",
  "stale_forget_after",
  "stale_superseded_memory",
  "not_yet_valid_window",
  "invalid_valid_from",
  "invalid_valid_until",
  "invalid_valid_window",
  "conflicting_relation",
  "suspected_write_gate",
  "suspected_low_novelty",
  "suspected_low_quality",
  "suspected_low_score",
  "suspected_near_duplicate",
]);

function redactRevisionOptions(opts: RevisionOptions): RevisionOptions {
  const actor = redactOptionalString(opts.actor);
  const reason = redactOptionalString(opts.reason);
  return {
    actor: actor.value,
    reason: reason.value,
  };
}

function pickMemorySnapshot(memory: Memory): Partial<Memory> {
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
    relatedIds: memory.relatedIds ? [...memory.relatedIds] : undefined,
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
    sourceLineRange: memory.sourceLineRange
      ? { ...memory.sourceLineRange }
      : undefined,
    agentId: memory.agentId,
    project: memory.project,
  };
}

export async function recordMemoryRevision(
  kv: StateKV,
  memoryId: string,
  action: MemoryRevision["action"],
  prior?: Memory | Partial<Memory> | null,
  next?: Memory | Partial<Memory> | null,
  opts: RevisionOptions = {},
): Promise<MemoryRevision> {
  const safeOpts = redactRevisionOptions(opts);
  const revision: MemoryRevision = {
    id: generateId("mrev"),
    memoryId,
    action,
    createdAt: new Date().toISOString(),
    actor: safeOpts.actor,
    reason: safeOpts.reason,
    prior: prior ? pickMemorySnapshot(prior as Memory) : undefined,
    next: next ? pickMemorySnapshot(next as Memory) : undefined,
  };
  await kv.set(KV.memoryHistory, revision.id, revision);
  return revision;
}

async function memoryHistory(
  kv: StateKV,
  memoryId: string,
): Promise<MemoryRevision[]> {
  const all = await kv.list<MemoryRevision>(KV.memoryHistory).catch(() => []);
  return all
    .filter((r) => r.memoryId === memoryId)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

async function findObservation(
  kv: StateKV,
  obsId: string,
  sessionHints: string[] = [],
): Promise<CompressedObservation | null> {
  for (const sid of sessionHints) {
    const obs = await kv
      .get<CompressedObservation>(KV.observations(sid), obsId)
      .catch(() => null);
    if (obs) return obs;
  }
  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  for (const session of sessions) {
    if (sessionHints.includes(session.id)) continue;
    const obs = await kv
      .get<CompressedObservation>(KV.observations(session.id), obsId)
      .catch(() => null);
    if (obs) return obs;
  }
  return null;
}

async function buildSourceCard(
  kv: StateKV,
  memory: Memory,
): Promise<MemorySourceCard> {
  const sessions = (
    await Promise.all(
      memory.sessionIds.map((sid) =>
        kv.get<Session>(KV.sessions, sid).catch(() => null),
      ),
    )
  ).filter((s): s is Session => s !== null);

  const observations = (
    await Promise.all(
      (memory.sourceObservationIds ?? []).map((obsId) =>
        findObservation(kv, obsId, memory.sessionIds),
      ),
    )
  )
    .filter((o): o is CompressedObservation => o !== null)
    .map((o) => ({
      id: o.id,
      sessionId: o.sessionId,
      title: o.title,
      type: o.type,
      timestamp: o.timestamp,
      files: o.files,
      confidence: o.confidence,
    }));

  const access = await getAccessLog(kv, memory.id);
  const card: MemorySourceCard = {
    memoryId: memory.id,
    sourceType:
      memory.sourceType ??
      (memory.sourceObservationIds?.length ? "observation" : "manual"),
    sourceUri: memory.sourceUri,
    sourceHash: memory.sourceHash,
    project: memory.project,
    branch: memory.branch,
    commit: memory.commit,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    sourceObservationIds: memory.sourceObservationIds ?? [],
    sessions: sessions.map((s) => ({
      id: s.id,
      project: s.project,
      cwd: s.cwd,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      commitShas: s.commitShas,
    })),
    observations,
  };
  if (access.count > 0) card.access = access;
  return card;
}

function normalizeLifecycleState(
  memory: Memory,
): MemoryLifecycleState {
  if (memory.lifecycleState) return memory.lifecycleState;
  if (memory.isLatest === false) return "superseded";
  return "active";
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function validateOptionalTimestamp(
  field: string,
  raw: unknown,
): TimestampValidation {
  const redacted = redactOptionalString(raw);
  if (raw === undefined) return { ok: true, scan: redacted.scan };
  if (raw === null) return { ok: true, scan: redacted.scan };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be an ISO timestamp`, scan: redacted.scan };
  }
  const value = redacted.value?.trim();
  if (!value) return { ok: true, scan: redacted.scan };
  if (timestampMs(value) === undefined) {
    return { ok: false, error: `${field} must be an ISO timestamp`, scan: redacted.scan };
  }
  return { ok: true, value, scan: redacted.scan };
}

function temporalReview(memory: Memory, nowMs: number): TemporalReview {
  const reasons: string[] = [];
  const fromMs = timestampMs(memory.validFrom);
  const untilMs = timestampMs(memory.validUntil);
  const hasInvalidFrom = Boolean(memory.validFrom) && fromMs === undefined;
  const hasInvalidUntil = Boolean(memory.validUntil) && untilMs === undefined;

  if (hasInvalidFrom) reasons.push("invalid_valid_from");
  if (hasInvalidUntil) reasons.push("invalid_valid_until");
  if (
    fromMs !== undefined &&
    untilMs !== undefined &&
    fromMs > untilMs
  ) {
    reasons.push("invalid_valid_window");
  }
  if (reasons.length > 0) {
    return { status: "invalid_window", reasons, searchable: false };
  }
  if (fromMs !== undefined && fromMs > nowMs) {
    return {
      status: "not_yet_valid",
      reasons: ["not_yet_valid_window"],
      searchable: false,
    };
  }
  if (untilMs !== undefined && untilMs <= nowMs) {
    return {
      status: "expired",
      reasons: ["expired_valid_window", "stale_valid_window"],
      searchable: false,
    };
  }
  return { status: "current", reasons: [], searchable: true };
}

function isMemorySearchableAt(memory: Memory, nowMs = Date.now()): boolean {
  return isMemorySearchable(memory) && temporalReview(memory, nowMs).searchable;
}

function writeGateMetadata(memory: Memory): WriteGateMetadata | undefined {
  const raw = (memory as { writeGate?: unknown }).writeGate;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as WriteGateMetadata;
}

function writeGateReviewReasons(memory: Memory): string[] {
  const gate = writeGateMetadata(memory);
  if (!gate) return [];
  const reasons = Array.isArray(gate.reasons)
    ? gate.reasons.filter((r): r is string => typeof r === "string")
    : [];
  const flags = Array.isArray(gate.flags)
    ? gate.flags.filter((f): f is string => typeof f === "string")
    : [];
  const reviewReasons: string[] = [];
  if (gate.pass === false) reviewReasons.push("suspected_write_gate");
  if (reasons.includes("low_novelty")) {
    reviewReasons.push("suspected_low_novelty");
  }
  if (reasons.includes("low_quality")) {
    reviewReasons.push("suspected_low_quality");
  }
  if (reasons.includes("low_composite_score")) {
    reviewReasons.push("suspected_low_score");
  }
  if (flags.includes("near_duplicate")) {
    reviewReasons.push("suspected_near_duplicate");
  }
  return reviewReasons;
}

function conflictReviewReasons(
  memory: Memory,
  relations: MemoryRelation[] = [],
): string[] {
  const hasConflict = relations.some((relation) => {
    const relationType = String(relation.type);
    return (
      (relationType === "contradicts" || relationType === "conflicts_with") &&
      (relation.sourceId === memory.id || relation.targetId === memory.id)
    );
  });
  return hasConflict ? ["conflicting_relation"] : [];
}

async function reindexMemory(memory: Memory): Promise<void> {
  getSearchIndex().remove(memory.id);
  vectorIndexRemove(memory.id);
  if (!isMemorySearchableAt(memory)) {
    await flushIndexSave();
    return;
  }
  getSearchIndex().add(memoryToObservation(memory));
  await vectorIndexAddGuarded(
    memory.id,
    memory.sessionIds?.[0] ?? "memory",
    `${memory.title} ${memory.content}`,
    { kind: "memory", logId: memory.id },
  );
  await flushIndexSave();
}

function restoreSnapshot(memoryId: string, history: MemoryRevision[]): Memory | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const candidate = history[i].prior ?? history[i].next;
    if (!candidate || !candidate.content || !candidate.title) continue;
    return {
      ...(candidate as Memory),
      id: memoryId,
      concepts: Array.isArray(candidate.concepts) ? candidate.concepts : [],
      files: Array.isArray(candidate.files) ? candidate.files : [],
      sessionIds: Array.isArray(candidate.sessionIds)
        ? candidate.sessionIds
        : [],
      sourceObservationIds: Array.isArray(candidate.sourceObservationIds)
        ? candidate.sourceObservationIds
        : [],
      isLatest: true,
    };
  }
  return null;
}

function reviewReasons(
  memory: Memory,
  accessCount: number,
  nowMs: number,
  relations: MemoryRelation[] = [],
): string[] {
  const state = normalizeLifecycleState(memory);
  if (state === "tombstoned" || state === "deleted") return [];
  const reasons: string[] = [];
  const temporal = temporalReview(memory, nowMs);
  reasons.push(...temporal.reasons);
  if (state === "expired") reasons.push("expired_lifecycle");
  if (state === "superseded" || memory.isLatest === false) {
    reasons.push("stale_superseded_memory");
  }
  const forgetAfter = timestampMs(memory.forgetAfter);
  if (forgetAfter !== undefined && forgetAfter <= nowMs) {
    reasons.push("stale_forget_after");
  }
  if (state === "quarantined") {
    reasons.push("sensitive_quarantine");
  }
  if (memory.redactionApplied) reasons.push("redaction_applied");
  if (!memory.sourceObservationIds || memory.sourceObservationIds.length === 0) {
    reasons.push("missing_source_evidence");
  }
  if ((memory.confidence ?? 1) < 0.5) reasons.push("low_confidence");
  if (memory.reviewState === "needs_review") reasons.push("explicit_review");
  if (accessCount >= 5 && memory.reviewState !== "reviewed") {
    reasons.push("often_retrieved_unreviewed");
  }
  if (memory.lifecycleState === undefined) reasons.push("legacy_lifecycle");
  reasons.push(...conflictReviewReasons(memory, relations));
  reasons.push(...writeGateReviewReasons(memory));
  return Array.from(new Set(reasons));
}

function shouldIncludeReviewQueue(memory: Memory, reasons: string[], nowMs: number): boolean {
  if (reasons.length === 0) return false;
  const state = normalizeLifecycleState(memory);
  if (state === "tombstoned" || state === "deleted") return false;
  if (isMemorySearchableAt(memory, nowMs)) return true;
  if (state === "quarantined") return true;
  return reasons.some((reason) => REVIEW_QUEUE_REASONS.has(reason));
}

function mergeLabels(...groups: Array<string[] | undefined>): string[] | undefined {
  const labels = Array.from(new Set(groups.flatMap((g) => g ?? [])));
  return labels.length > 0 ? labels : undefined;
}

function inputString(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function inputStringError(field: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  return inputString(raw) ? undefined : `${field} must be a non-empty string`;
}

function inputPositiveInt(
  raw: unknown,
  fallback: number,
  max: number,
  field: string,
): { value?: number; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { value: fallback };
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { error: `${field} must be a positive integer` };
  }
  return { value: Math.min(value, max) };
}

function addUtcDays(date: string, days: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.toISOString().slice(0, 10) !== date) return undefined;
  return new Date(start.getTime() + days * 86_400_000).toISOString();
}

function parseDateWindow(data?: DailyInboxInput): {
  ok: true;
  value: DateWindow;
} | {
  ok: false;
  error: string;
} {
  const since = inputString(data?.since);
  const until = inputString(data?.until);
  const date = inputString(data?.date) ?? new Date().toISOString().slice(0, 10);
  if (data?.date !== undefined && !addUtcDays(date, 0)) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }
  const startIso = since ?? addUtcDays(date, 0);
  const endIso = until ?? addUtcDays(date, 1);
  if (!startIso || !endIso) {
    return { ok: false, error: "date must be YYYY-MM-DD" };
  }
  const sinceMs = timestampMs(startIso);
  const untilMs = timestampMs(endIso);
  if (sinceMs === undefined) return { ok: false, error: "since must be an ISO timestamp" };
  if (untilMs === undefined) return { ok: false, error: "until must be an ISO timestamp" };
  if (sinceMs >= untilMs) return { ok: false, error: "since must be before until" };
  return {
    ok: true,
    value: {
      date,
      since: startIso,
      until: endIso,
      sinceMs,
      untilMs,
    },
  };
}

function timestampInWindow(value: string | undefined, window: DateWindow): boolean {
  const ms = timestampMs(value);
  return ms !== undefined && ms >= window.sinceMs && ms < window.untilMs;
}

function scopeMatchesProject(project: string | undefined, filter?: string): boolean {
  return !filter || project === filter;
}

function scopeMatchesAgent(agentId: string | undefined, filter?: string): boolean {
  return !filter || agentId === filter;
}

function sessionMatchesScope(
  session: Session,
  opts: { project?: string; agentId?: string; sessionId?: string },
): boolean {
  return (
    scopeMatchesProject(session.project, opts.project) &&
    scopeMatchesAgent(session.agentId, opts.agentId) &&
    (!opts.sessionId || session.id === opts.sessionId)
  );
}

function memoryMatchesScope(
  memory: Memory,
  opts: { project?: string; agentId?: string },
): boolean {
  return (
    scopeMatchesProject(memory.project, opts.project) &&
    scopeMatchesAgent(memory.agentId, opts.agentId)
  );
}

function activeMemory(memory: Memory): boolean {
  const state = normalizeLifecycleState(memory);
  return state !== "deleted" && state !== "tombstoned";
}

async function scopedObservationRows(
  kv: StateKV,
  window: DateWindow,
  opts: { project?: string; agentId?: string; sessionId?: string },
): Promise<ObservationRow[]> {
  const sessions = (await kv.list<Session>(KV.sessions).catch(() => []))
    .filter((session) => sessionMatchesScope(session, opts));
  const batches = await Promise.all(
    sessions.map(async (session) => {
      const observations = await kv
        .list<CompressedObservation>(KV.observations(session.id))
        .catch(() => []);
      return observations
        .filter((observation) => timestampInWindow(observation.timestamp, window))
        .filter((observation) => scopeMatchesAgent(observation.agentId ?? session.agentId, opts.agentId))
        .map((observation) => ({ session, observation }));
    }),
  );
  return batches.flat().sort((a, b) =>
    b.observation.timestamp.localeCompare(a.observation.timestamp),
  );
}

function observationText(observation: CompressedObservation): string {
  return [
    observation.title,
    observation.subtitle,
    observation.narrative,
    ...observation.facts,
    ...observation.concepts,
    ...observation.files,
  ]
    .filter(Boolean)
    .join(" ");
}

const FAILURE_TEXT = /\b(fail(?:ed|ure|ing)?|error|exception|timeout|timed out|exit code|denied|blocked)\b/i;
const SUCCESS_FIX_TEXT = /\b(fix(?:ed|es)?|resolved|success(?:ful)?|passed|green|verified|completed|restored)\b/i;
const UNRESOLVED_TEXT = /\b(unresolved|unverified|needs verification|open question|todo|blocked|unknown|suspected|claim)\b/i;

function isFailedCommand(row: ObservationRow): boolean {
  return (
    row.observation.type === "error" ||
    (row.observation.type === "command_run" &&
      FAILURE_TEXT.test(observationText(row.observation)))
  );
}

function isSuccessfulFix(row: ObservationRow): boolean {
  return SUCCESS_FIX_TEXT.test(observationText(row.observation));
}

function isUnresolvedObservation(row: ObservationRow): boolean {
  return UNRESOLVED_TEXT.test(observationText(row.observation));
}

function summarizeObservation(row: ObservationRow): Record<string, unknown> {
  return {
    id: row.observation.id,
    sessionId: row.observation.sessionId,
    project: row.session.project,
    agentId: row.observation.agentId ?? row.session.agentId,
    timestamp: row.observation.timestamp,
    type: row.observation.type,
    title: row.observation.title,
    importance: row.observation.importance,
    confidence: row.observation.confidence,
    concepts: row.observation.concepts,
    files: row.observation.files,
  };
}

function summarizeMemory(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    title: memory.title,
    type: memory.type,
    lane: memory.lane ?? defaultMemoryLane(memory.type),
    lifecycleState: normalizeLifecycleState(memory),
    reviewState: memory.reviewState ?? "unreviewed",
    project: memory.project,
    agentId: memory.agentId,
    confidence: memory.confidence,
    concepts: memory.concepts,
    files: memory.files,
    sourceObservationIds: memory.sourceObservationIds ?? [],
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function normalizeMention(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function conceptInMemory(memory: Memory, concept: string): boolean {
  const normalized = normalizeMention(concept);
  if (memory.concepts.some((c) => normalizeMention(c) === normalized)) return true;
  const text = `${memory.title} ${memory.content}`.toLowerCase();
  return text.includes(normalized);
}

async function buildReviewQueue(
  kv: StateKV,
  opts: { project?: string; limit: number },
): Promise<{ rows: ReviewQueueRow[]; total: number }> {
  const [memories, relations] = await Promise.all([
    kv.list<Memory>(KV.memories).catch(() => []),
    kv.list<MemoryRelation>(KV.relations).catch(() => []),
  ]);
  const nowMs = Date.now();
  const rows: ReviewQueueRow[] = [];
  for (const memory of memories) {
    if (opts.project && memory.project !== opts.project) continue;
    const access = await getAccessLog(kv, memory.id);
    const reasons = reviewReasons(memory, access.count, nowMs, relations);
    if (!shouldIncludeReviewQueue(memory, reasons, nowMs)) continue;
    const temporal = temporalReview(memory, nowMs);
    rows.push({
      memory: {
        ...memory,
        lane: memory.lane ?? defaultMemoryLane(memory.type),
        lifecycleState: normalizeLifecycleState(memory),
        reviewState: memory.reviewState ?? "unreviewed",
      },
      reasons,
      score: reasons.length + Math.min(access.count / 10, 2),
      temporalStatus: temporal.status,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  return { rows: rows.slice(0, opts.limit), total: rows.length };
}

function flattenProposalValues(values: unknown[]): ProposalLike[] {
  return values.flatMap((value) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ProposalLike[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      const id = inputString(row.id);
      if (!id) return [];
      return [{
        id,
        teamId: inputString(row.teamId),
        project: inputString(row.project),
        action: inputString(row.action),
        status: inputString(row.status),
        title: inputString(row.title),
        reason: inputString(row.reason),
        targetMemoryId: inputString(row.targetMemoryId),
        proposedAt: inputString(row.proposedAt),
        updatedAt: inputString(row.updatedAt),
      }];
    });
  });
}

function summarizeProposal(proposal: ProposalLike): Record<string, unknown> {
  return {
    id: proposal.id,
    teamId: proposal.teamId,
    project: proposal.project,
    action: proposal.action,
    status: proposal.status,
    title: proposal.title,
    reason: proposal.reason,
    targetMemoryId: proposal.targetMemoryId,
    proposedAt: proposal.proposedAt,
    updatedAt: proposal.updatedAt,
  };
}

function redactLifecycleMetadata(data: {
  actor?: string;
  reason?: string;
  expiresAt?: string;
}): {
  actor?: string;
  reason?: string;
  expiresAt?: string;
  error?: string;
} {
  const actor = redactOptionalString(data.actor);
  const reason = redactOptionalString(data.reason);
  const expiresAt = validateOptionalTimestamp("expiresAt", data.expiresAt);
  return {
    actor: actor.value,
    reason: reason.value,
    expiresAt: expiresAt.ok ? expiresAt.value : undefined,
    error: expiresAt.ok ? undefined : expiresAt.error,
  };
}

function normalizeDeleteString(
  field: keyof MemoryDeleteInput,
  raw: unknown,
): { value?: string; error?: string } {
  const redacted = redactOptionalString(raw);
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: `${field} must be a non-empty string` };
  }
  const value = redacted.value?.trim();
  if (!value) return { error: `${field} must be a non-empty string` };
  return { value };
}

function normalizeDeleteDryRun(raw: unknown): {
  value: boolean;
  error?: string;
} {
  if (raw === undefined || raw === null || raw === "") return { value: false };
  if (typeof raw === "boolean") return { value: raw };
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (!value) return { value: false };
    if (value === "true" || value === "1" || value === "yes") {
      return { value: true };
    }
    if (value === "false" || value === "0" || value === "no") {
      return { value: false };
    }
  }
  return { value: false, error: "dryRun must be a boolean" };
}

function normalizeDeleteRequest(data: MemoryDeleteInput): {
  ok: true;
  memoryId?: string;
  mode: DeleteMode;
  meta: ReturnType<typeof redactLifecycleMetadata>;
  selector?: SourceDeleteSelector;
  dryRun: boolean;
} | {
  ok: false;
  error: string;
} {
  const memoryId = normalizeDeleteString("memoryId", data.memoryId);
  if (memoryId.error) return { ok: false, error: memoryId.error };
  const sourceObservationId = normalizeDeleteString(
    "sourceObservationId",
    data.sourceObservationId,
  );
  if (sourceObservationId.error) {
    return { ok: false, error: sourceObservationId.error };
  }
  const sourceHash = normalizeDeleteString("sourceHash", data.sourceHash);
  if (sourceHash.error) return { ok: false, error: sourceHash.error };
  const sourceUri = normalizeDeleteString("sourceUri", data.sourceUri);
  if (sourceUri.error) return { ok: false, error: sourceUri.error };
  const project = normalizeDeleteString("project", data.project);
  if (project.error) return { ok: false, error: project.error };
  const agentId = normalizeDeleteString("agentId", data.agentId);
  if (agentId.error) return { ok: false, error: agentId.error };
  const dryRun = normalizeDeleteDryRun(data.dryRun);
  if (dryRun.error) return { ok: false, error: dryRun.error };
  const hasSourceSelector = Boolean(
    sourceObservationId.value || sourceHash.value || sourceUri.value,
  );
  if (!memoryId.value && !hasSourceSelector) {
    return {
      ok: false,
      error: "memoryId or source selector is required",
    };
  }
  const meta = redactLifecycleMetadata({
    actor: typeof data.actor === "string" ? data.actor : undefined,
    reason: typeof data.reason === "string" ? data.reason : undefined,
  });
  if (meta.error) return { ok: false, error: meta.error };
  const selector = hasSourceSelector
    ? {
        sourceObservationId: sourceObservationId.value,
        sourceHash: sourceHash.value,
        sourceUri: sourceUri.value,
        project: project.value,
        agentId: agentId.value,
      }
    : undefined;
  return {
    ok: true,
    memoryId: memoryId.value,
    mode: data.mode === "hard" ? "hard" : "tombstone",
    meta,
    selector,
    dryRun: dryRun.value,
  };
}

function sourceSelectorOnly(selector: SourceDeleteSelector): {
  sourceObservationId?: string;
  sourceHash?: string;
  sourceUri?: string;
} {
  return {
    sourceObservationId: selector.sourceObservationId,
    sourceHash: selector.sourceHash,
    sourceUri: selector.sourceUri,
  };
}

function selectorScope(selector: SourceDeleteSelector): {
  project?: string;
  agentId?: string;
} {
  return {
    project: selector.project,
    agentId: selector.agentId,
  };
}

function matchesSourceSelector(
  memory: Memory,
  selector: SourceDeleteSelector,
): boolean {
  if (
    selector.sourceObservationId &&
    !(memory.sourceObservationIds ?? []).includes(selector.sourceObservationId)
  ) {
    return false;
  }
  if (selector.sourceHash && memory.sourceHash !== selector.sourceHash) {
    return false;
  }
  if (selector.sourceUri && memory.sourceUri !== selector.sourceUri) {
    return false;
  }
  return true;
}

function matchesDeleteScope(
  memory: Memory,
  selector: SourceDeleteSelector,
): boolean {
  if (selector.project && memory.project !== selector.project) return false;
  if (selector.agentId && memory.agentId !== selector.agentId) return false;
  return true;
}

function scopeValues(
  memories: Memory[],
  field: "project" | "agentId",
): string[] {
  return Array.from(
    new Set(memories.map((memory) => memory[field] ?? "(unscoped)")),
  ).sort();
}

function summarizeDeleteTarget(memory: Memory): SourceDeleteReport["targets"][number] {
  return {
    memoryId: memory.id,
    project: memory.project,
    agentId: memory.agentId,
    lifecycleState: normalizeLifecycleState(memory),
    sourceObservationIds: memory.sourceObservationIds ?? [],
    sourceHash: memory.sourceHash,
    sourceUri: memory.sourceUri,
  };
}

function buildSourceDeleteReport(data: {
  selector: SourceDeleteSelector;
  mode: DeleteMode;
  dryRun: boolean;
  sourceMatches: Memory[];
  scopedMatches: Memory[];
  deletedIds?: string[];
}): SourceDeleteReport {
  const projectScopes = scopeValues(data.scopedMatches, "project");
  const agentScopes = scopeValues(data.scopedMatches, "agentId");
  const blockers: string[] = [];
  if (
    data.scopedMatches.length > 0 &&
    !data.selector.project &&
    !data.selector.agentId
  ) {
    blockers.push("project or agentId is required for source-linked delete");
  }
  if (!data.selector.project && projectScopes.length > 1) {
    blockers.push("project is required when selector matches multiple project scopes");
  }
  if (!data.selector.agentId && agentScopes.length > 1) {
    blockers.push("agentId is required when selector matches multiple agent scopes");
  }
  return {
    selector: sourceSelectorOnly(data.selector),
    scope: selectorScope(data.selector),
    mode: data.mode,
    dryRun: data.dryRun,
    matched: data.sourceMatches.length,
    wouldDelete: data.scopedMatches.length,
    deletedIds: data.deletedIds ?? [],
    targetIds: data.scopedMatches.map((memory) => memory.id),
    targets: data.scopedMatches.map(summarizeDeleteTarget),
    projectScopes,
    agentScopes,
    mutationAllowed: blockers.length === 0,
    blockers,
  };
}

function sourceLinkedAuditDetails(
  context: {
    selector: SourceDeleteSelector;
    targetIds: string[];
  } | undefined,
): Record<string, unknown> {
  if (!context) return {};
  return {
    sourceLinked: true,
    sourceSelector: sourceSelectorOnly(context.selector),
    scope: selectorScope(context.selector),
    propagationTargetCount: context.targetIds.length,
    propagationTargetIds: context.targetIds,
  };
}

function shouldClearValidUntilOnRestore(
  base: Memory,
  existing: Memory | null | undefined,
  nowMs: number,
): boolean {
  if (existing?.lifecycleState === "expired" || base.lifecycleState === "expired") {
    return true;
  }
  const validUntil = existing?.validUntil ?? base.validUntil;
  if (!validUntil) return false;
  const validUntilMs = timestampMs(validUntil);
  return validUntilMs === undefined || validUntilMs <= nowMs;
}

function pickMemoryCreatePayload(data: MemoryCreateInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of MEMORY_CREATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      payload[field] = data[field];
    }
  }
  return payload;
}

function isMemoryCreateSuccess(
  result: unknown,
): result is { success: true; memory: Memory } {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { success?: unknown }).success === true &&
    Boolean((result as { memory?: unknown }).memory) &&
    typeof (result as { memory?: { id?: unknown } }).memory?.id === "string"
  );
}

async function deleteOneMemory(data: {
  kv: StateKV;
  existing: Memory;
  mode: DeleteMode;
  meta: ReturnType<typeof redactLifecycleMetadata>;
  auditContext?: {
    selector: SourceDeleteSelector;
    targetIds: string[];
  };
}): Promise<{
  success: true;
  deleted: true;
  mode: DeleteMode;
  memory?: Memory;
  purgedRevisionCount?: number;
}> {
  const auditDetails = sourceLinkedAuditDetails(data.auditContext);
  if (data.mode === "hard") {
    const history = await memoryHistory(data.kv, data.existing.id);
    await Promise.all(
      history.map((revision) =>
        data.kv.delete(KV.memoryHistory, revision.id),
      ),
    );
    await data.kv.delete(KV.memories, data.existing.id);
    await deleteAccessLog(data.kv, data.existing.id);
    getSearchIndex().remove(data.existing.id);
    vectorIndexRemove(data.existing.id);
    await flushIndexSave();
    const now = new Date().toISOString();
    await recordAudit(data.kv, "delete", "mem::memory-delete", [data.existing.id], {
      action: "hard_delete",
      reason: data.meta.reason,
      purgedRevisionCount: history.length,
      ...auditDetails,
    });
    await safeRecordAgentEvent(data.kv, {
      type: "memory_deleted",
      timestamp: now,
      project: data.existing.project,
      agentId: data.existing.agentId,
      functionId: "mem::memory-delete",
      targetIds: [data.existing.id],
      memoryIds: [data.existing.id],
      metadata: {
        actor: data.meta.actor,
        reason: data.meta.reason,
        mode: data.mode,
        purgedRevisionCount: history.length,
        ...auditDetails,
      },
    });
    logger.info("Memory hard-deleted", { memoryId: data.existing.id });
    return {
      success: true,
      deleted: true,
      mode: data.mode,
      purgedRevisionCount: history.length,
    };
  }
  const now = new Date().toISOString();
  const tombstone: Memory = {
    ...data.existing,
    updatedAt: now,
    deletedAt: now,
    lifecycleState: "tombstoned",
    reviewState: "rejected",
    isLatest: false,
    title: `[deleted] ${data.existing.id}`,
    content: "",
    concepts: [],
    files: [],
  };
  await data.kv.set(KV.memories, tombstone.id, tombstone);
  await recordMemoryRevision(
    data.kv,
    tombstone.id,
    "tombstone",
    data.existing,
    tombstone,
    { actor: data.meta.actor, reason: data.meta.reason },
  );
  await safeAudit(data.kv, "memory_lifecycle", "mem::memory-delete", [tombstone.id], {
    action: "tombstone",
    reason: data.meta.reason,
    ...auditDetails,
  });
  await safeRecordAgentEvent(data.kv, {
    type: "memory_tombstoned",
    timestamp: now,
    project: data.existing.project,
    agentId: data.existing.agentId,
    functionId: "mem::memory-delete",
    targetIds: [tombstone.id],
    memoryIds: [tombstone.id],
    metadata: {
      actor: data.meta.actor,
      reason: data.meta.reason,
      mode: data.mode,
      lifecycleState: tombstone.lifecycleState,
      ...auditDetails,
    },
  });
  await reindexMemory(tombstone);
  return {
    success: true,
    deleted: true,
    mode: data.mode,
    memory: tombstone,
  };
}

async function deleteBySourceSelector(data: {
  kv: StateKV;
  selector: SourceDeleteSelector;
  mode: DeleteMode;
  meta: ReturnType<typeof redactLifecycleMetadata>;
  dryRun: boolean;
}): Promise<{
  success: boolean;
  error?: string;
  deleted: number;
  mode: DeleteMode;
  dryRun: boolean;
  wouldDelete: number;
  propagation: SourceDeleteReport;
}> {
  const memories = await data.kv.list<Memory>(KV.memories).catch(() => []);
  const sourceMatches = memories.filter((memory) =>
    matchesSourceSelector(memory, data.selector),
  );
  const scopedMatches = sourceMatches
    .filter((memory) => matchesDeleteScope(memory, data.selector))
    .sort((a, b) => a.id.localeCompare(b.id));
  const targetIds = scopedMatches.map((memory) => memory.id);
  const report = buildSourceDeleteReport({
    selector: data.selector,
    mode: data.mode,
    dryRun: data.dryRun,
    sourceMatches,
    scopedMatches,
  });
  if (data.dryRun) {
    return {
      success: true,
      deleted: 0,
      mode: data.mode,
      dryRun: true,
      wouldDelete: scopedMatches.length,
      propagation: report,
    };
  }
  if (!report.mutationAllowed) {
    return {
      success: false,
      error: report.blockers[0] ?? "source-linked delete is not scoped",
      deleted: 0,
      mode: data.mode,
      dryRun: false,
      wouldDelete: scopedMatches.length,
      propagation: report,
    };
  }
  const deletedIds: string[] = [];
  for (const target of scopedMatches) {
    const deleted = await withKeyedLock(`mem:memory:${target.id}`, async () => {
      const existing = await data.kv.get<Memory>(KV.memories, target.id);
      if (!existing) return false;
      if (!matchesSourceSelector(existing, data.selector)) return false;
      if (!matchesDeleteScope(existing, data.selector)) return false;
      await deleteOneMemory({
        kv: data.kv,
        existing,
        mode: data.mode,
        meta: data.meta,
        auditContext: {
          selector: data.selector,
          targetIds,
        },
      });
      return true;
    });
    if (deleted) deletedIds.push(target.id);
  }
  return {
    success: true,
    deleted: deletedIds.length,
    mode: data.mode,
    dryRun: false,
    wouldDelete: scopedMatches.length,
    propagation: buildSourceDeleteReport({
      selector: data.selector,
      mode: data.mode,
      dryRun: false,
      sourceMatches,
      scopedMatches,
      deletedIds,
    }),
  };
}

export function registerMemoryLifecycleFunctions(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction(
    "mem::memory-create",
    async (data: MemoryCreateInput) => {
      if (
        !data.content ||
        typeof data.content !== "string" ||
        !data.content.trim()
      ) {
        return { success: false, error: "content is required" };
      }
      const created = await sdk.trigger({
        function_id: "mem::remember",
        payload: pickMemoryCreatePayload(data),
      });
      if (!isMemoryCreateSuccess(created)) return created;

      const inspected = await sdk.trigger({
        function_id: "mem::memory-inspect",
        payload: { memoryId: created.memory.id },
      });
      if (
        inspected &&
        typeof inspected === "object" &&
        (inspected as { success?: unknown }).success === true
      ) {
        return {
          ...created,
          memory: (inspected as { memory?: Memory }).memory ?? created.memory,
          sourceCard: (inspected as { sourceCard?: unknown }).sourceCard,
          history: (inspected as { history?: unknown }).history,
          searchable: (inspected as { searchable?: unknown }).searchable,
          review: (inspected as { review?: unknown }).review,
        };
      }
      return created;
    },
  );

  sdk.registerFunction("mem::memory-inspect", async (data: { memoryId: string }) => {
    if (!data.memoryId || typeof data.memoryId !== "string") {
      return { success: false, error: "memoryId is required" };
    }
    const memory = await kv.get<Memory>(KV.memories, data.memoryId);
    if (!memory) return { success: false, error: "memory not found" };
    const [history, sourceCard, access, relations] = await Promise.all([
      memoryHistory(kv, memory.id),
      buildSourceCard(kv, memory),
      getAccessLog(kv, memory.id),
      kv.list<MemoryRelation>(KV.relations).catch(() => []),
    ]);
    const nowMs = Date.now();
    const temporal = temporalReview(memory, nowMs);
    const reasons = reviewReasons(memory, access.count, nowMs, relations);
    return {
      success: true,
      memory: {
        ...memory,
        lane: memory.lane ?? defaultMemoryLane(memory.type),
        lifecycleState: normalizeLifecycleState(memory),
        reviewState: memory.reviewState ?? "unreviewed",
      },
      sourceCard,
      history,
      searchable: isMemorySearchableAt(memory, nowMs),
      review: {
        reasons,
        temporalStatus: temporal.status,
      },
    };
  });

  sdk.registerFunction("mem::memory-history", async (data: { memoryId: string }) => {
    if (!data.memoryId || typeof data.memoryId !== "string") {
      return { success: false, error: "memoryId is required" };
    }
    return { success: true, history: await memoryHistory(kv, data.memoryId) };
  });

  sdk.registerFunction(
    "mem::memory-update",
    async (data: {
      memoryId: string;
      content?: string;
      title?: string;
      concepts?: string[];
      files?: string[];
      strength?: number;
      confidence?: number;
      lane?: Memory["lane"];
      reviewState?: MemoryReviewState;
      privacyScope?: Memory["privacyScope"];
      validFrom?: string | null;
      validUntil?: string | null;
      reason?: string;
      actor?: string;
    }) => {
      if (!data.memoryId || typeof data.memoryId !== "string") {
        return { success: false, error: "memoryId is required" };
      }
      return withKeyedLock(`mem:memory:${data.memoryId}`, async () => {
        const existing = await kv.get<Memory>(KV.memories, data.memoryId);
        if (!existing) return { success: false, error: "memory not found" };
        if (data.content !== undefined && typeof data.content !== "string") {
          return { success: false, error: "content must be a string" };
        }
        if (data.title !== undefined && typeof data.title !== "string") {
          return { success: false, error: "title must be a string" };
        }
        if (data.concepts !== undefined && !Array.isArray(data.concepts)) {
          return { success: false, error: "concepts must be an array" };
        }
        if (data.files !== undefined && !Array.isArray(data.files)) {
          return { success: false, error: "files must be an array" };
        }
        const contentScan =
          data.content !== undefined ? scanPrivateData(data.content) : undefined;
        const titleScan =
          data.title !== undefined ? scanPrivateData(data.title) : undefined;
        const conceptRedaction =
          data.concepts !== undefined ? redactStringArray(data.concepts) : undefined;
        const fileRedaction =
          data.files !== undefined ? redactStringArray(data.files) : undefined;
        const laneRedaction = redactOptionalString(data.lane);
        const reviewStateRedaction = redactOptionalString(data.reviewState);
        const privacyScopeRedaction = redactOptionalString(data.privacyScope);
        const actorRedaction = redactOptionalString(data.actor);
        const reasonRedaction = redactOptionalString(data.reason);
        const validFromProvided = Object.prototype.hasOwnProperty.call(
          data,
          "validFrom",
        );
        const validUntilProvided = Object.prototype.hasOwnProperty.call(
          data,
          "validUntil",
        );
        const validFromValidation = validFromProvided
          ? validateOptionalTimestamp("validFrom", data.validFrom)
          : undefined;
        const validUntilValidation = validUntilProvided
          ? validateOptionalTimestamp("validUntil", data.validUntil)
          : undefined;
        if (validFromValidation && !validFromValidation.ok) {
          return { success: false, error: validFromValidation.error };
        }
        if (validUntilValidation && !validUntilValidation.ok) {
          return { success: false, error: validUntilValidation.error };
        }
        const nextValidFrom = validFromProvided
          ? validFromValidation?.ok
            ? validFromValidation.value
            : undefined
          : existing.validFrom;
        const nextValidUntil = validUntilProvided
          ? validUntilValidation?.ok
            ? validUntilValidation.value
            : undefined
          : existing.validUntil;
        const nextFromMs = timestampMs(nextValidFrom);
        const nextUntilMs = timestampMs(nextValidUntil);
        if (
          nextFromMs !== undefined &&
          nextUntilMs !== undefined &&
          nextFromMs > nextUntilMs
        ) {
          return {
            success: false,
            error: "validFrom must be before validUntil",
          };
        }
        const lane = normalizeMemoryLane(laneRedaction.value);
        const reviewState = normalizeMemoryReviewState(
          reviewStateRedaction.value,
        );
        const privacyScope = normalizeMemoryPrivacyScope(
          privacyScopeRedaction.value,
        );
        const privacySummary = summarizePrivacyScans(
          contentScan,
          titleScan,
          conceptRedaction?.scan,
          fileRedaction?.scan,
          laneRedaction.scan,
          reviewStateRedaction.scan,
          privacyScopeRedaction.scan,
          actorRedaction.scan,
          reasonRedaction.scan,
          validFromValidation?.scan,
          validUntilValidation?.scan,
        );
        const foundSensitive = privacySummary.redactionApplied;
        const sensitivityLabels = mergeLabels(
          existing.sensitivityLabels,
          privacySummary.labels,
        );
        const now = new Date().toISOString();
        const updated: Memory = {
          ...existing,
          updatedAt: now,
          title: titleScan?.redacted ?? data.title ?? existing.title,
          content: contentScan?.redacted ?? data.content ?? existing.content,
          concepts: conceptRedaction?.values ?? existing.concepts,
          files: fileRedaction?.values ?? existing.files,
          strength:
            typeof data.strength === "number" && Number.isFinite(data.strength)
              ? Math.max(0, Math.min(10, data.strength))
              : existing.strength,
          confidence:
            typeof data.confidence === "number" &&
            Number.isFinite(data.confidence)
              ? Math.max(0, Math.min(1, data.confidence))
              : existing.confidence,
          lane: lane ?? existing.lane ?? defaultMemoryLane(existing.type),
          lifecycleState: foundSensitive
            ? "quarantined"
            : existing.lifecycleState ?? "active",
          reviewState: foundSensitive
            ? "needs_review"
            : reviewState ?? existing.reviewState,
          privacyScope:
            privacyScope ??
            existing.privacyScope ??
            (foundSensitive ? "user" : undefined),
          redactionApplied: existing.redactionApplied || foundSensitive || undefined,
          sensitivityLabels,
          validFrom: nextValidFrom,
          validUntil: nextValidUntil,
          version: (existing.version ?? 1) + 1,
        };
        await kv.set(KV.memories, updated.id, updated);
        await recordMemoryRevision(kv, updated.id, "update", existing, updated, {
          actor: actorRedaction.value,
          reason: reasonRedaction.value,
        });
        await safeAudit(kv, "memory_lifecycle", "mem::memory-update", [updated.id], {
          action: "update",
          reason: reasonRedaction.value,
          version: updated.version,
          lifecycleState: updated.lifecycleState,
          validFrom: updated.validFrom,
          validUntil: updated.validUntil,
          temporalStatus: temporalReview(updated, Date.now()).status,
          redactionApplied: foundSensitive,
          sensitivityLabels: sensitivityLabels ?? [],
        });
        await safeRecordAgentEvent(kv, {
          type: "memory_updated",
          timestamp: now,
          project: updated.project,
          agentId: updated.agentId,
          functionId: "mem::memory-update",
          targetIds: [updated.id],
          memoryIds: [updated.id],
          metadata: {
            actor: actorRedaction.value,
            reason: reasonRedaction.value,
            version: updated.version,
            lifecycleState: updated.lifecycleState,
            reviewState: updated.reviewState,
            validFrom: updated.validFrom,
            validUntil: updated.validUntil,
            redactionApplied: foundSensitive,
          },
        });
        await reindexMemory(updated);
        return { success: true, memory: updated };
      });
    },
  );

  sdk.registerFunction(
    "mem::memory-expire",
    async (data: {
      memoryId: string;
      expiresAt?: string;
      reason?: string;
      actor?: string;
    }) => lifecycleStateChange(kv, data, "expire", "expired"),
  );

  sdk.registerFunction(
    "mem::memory-archive",
    async (data: { memoryId: string; reason?: string; actor?: string }) =>
      lifecycleStateChange(kv, data, "archive", "archived"),
  );

  sdk.registerFunction(
    "mem::memory-restore",
    async (data: { memoryId: string; reason?: string; actor?: string }) => {
      if (!data.memoryId || typeof data.memoryId !== "string") {
        return { success: false, error: "memoryId is required" };
      }
      const meta = redactLifecycleMetadata(data);
      if (meta.error) return { success: false, error: meta.error };
      return withKeyedLock(`mem:memory:${data.memoryId}`, async () => {
        const existing = await kv.get<Memory>(KV.memories, data.memoryId);
        const history = await memoryHistory(kv, data.memoryId);
        const restoredSnapshot =
          existing?.lifecycleState === "tombstoned" || !existing?.content
            ? restoreSnapshot(data.memoryId, history)
            : null;
        const base = restoredSnapshot ?? existing ?? restoreSnapshot(data.memoryId, history);
        if (!base) return { success: false, error: "memory not found" };
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const clearValidUntil = shouldClearValidUntilOnRestore(
          base,
          existing,
          nowMs,
        );
        const restored: Memory = {
          ...base,
          updatedAt: now,
          restoredAt: now,
          lifecycleState: "active",
          reviewState: base.reviewState ?? "needs_review",
          lane: base.lane ?? defaultMemoryLane(base.type),
          isLatest: true,
          forgetAfter: undefined,
          archivedAt: undefined,
          deletedAt: undefined,
          validUntil: clearValidUntil ? undefined : base.validUntil,
        };
        await kv.set(KV.memories, restored.id, restored);
        await recordMemoryRevision(kv, restored.id, "restore", existing, restored, {
          actor: meta.actor,
          reason: meta.reason,
        });
        await safeAudit(kv, "memory_lifecycle", "mem::memory-restore", [restored.id], {
          action: "restore",
          reason: meta.reason,
        });
        await safeRecordAgentEvent(kv, {
          type: "memory_restored",
          timestamp: now,
          project: restored.project,
          agentId: restored.agentId,
          functionId: "mem::memory-restore",
          targetIds: [restored.id],
          memoryIds: [restored.id],
          metadata: {
            actor: meta.actor,
            reason: meta.reason,
            lifecycleState: restored.lifecycleState,
          },
        });
        await reindexMemory(restored);
        return { success: true, memory: restored };
      });
    },
  );

  sdk.registerFunction(
    "mem::memory-delete",
    async (data: MemoryDeleteInput) => {
      const request = normalizeDeleteRequest(data);
      if (!request.ok) return { success: false, error: request.error };
      if (request.selector && !request.memoryId) {
        return deleteBySourceSelector({
          kv,
          selector: request.selector,
          mode: request.mode,
          meta: request.meta,
          dryRun: request.dryRun,
        });
      }
      return withKeyedLock(`mem:memory:${request.memoryId}`, async () => {
        const existing = await kv.get<Memory>(KV.memories, request.memoryId!);
        if (!existing) return { success: false, error: "memory not found" };
        if (
          request.selector &&
          (!matchesSourceSelector(existing, request.selector) ||
            !matchesDeleteScope(existing, request.selector))
        ) {
          return {
            success: false,
            error: "memory does not match source selector",
          };
        }
        if (request.dryRun) {
          return {
            success: true,
            deleted: false,
            mode: request.mode,
            dryRun: true,
            wouldDelete: 1,
            target: summarizeDeleteTarget(existing),
          };
        }
        return deleteOneMemory({
          kv,
          existing,
          mode: request.mode,
          meta: request.meta,
          auditContext: request.selector
            ? { selector: request.selector, targetIds: [existing.id] }
            : undefined,
        });
      });
    },
  );

  sdk.registerFunction(
    "mem::today-in-memory",
    async (data?: DailyInboxInput) => {
      const projectError = inputStringError("project", data?.project);
      if (projectError) return { success: false, error: projectError };
      const agentError = inputStringError("agentId", data?.agentId);
      if (agentError) return { success: false, error: agentError };
      const sessionError = inputStringError("sessionId", data?.sessionId);
      if (sessionError) return { success: false, error: sessionError };
      const window = parseDateWindow(data);
      if (!window.ok) return { success: false, error: window.error };
      const limit = inputPositiveInt(data?.limit, 25, 200, "limit");
      if (limit.error) return { success: false, error: limit.error };
      const project = inputString(data?.project);
      const agentId = inputString(data?.agentId);
      const sessionId = inputString(data?.sessionId);
      const scope = { project, agentId, sessionId };
      const [observations, memories, stateValues, reviewQueue] = await Promise.all([
        scopedObservationRows(kv, window.value, scope),
        kv.list<Memory>(KV.memories).catch(() => []),
        kv.list<unknown>(KV.state).catch(() => []),
        buildReviewQueue(kv, { project, limit: limit.value ?? 25 }),
      ]);
      const reviewRows = reviewQueue.rows;
      const scopedMemories = memories
        .filter((memory) => memoryMatchesScope(memory, { project, agentId }))
        .filter(activeMemory);
      const newMemories = scopedMemories.filter((memory) =>
        timestampInWindow(memory.createdAt, window.value),
      );
      const newPreferences = newMemories.filter((memory) => memory.type === "preference");
      const failedCommands = observations.filter(isFailedCommand);
      const successfulFixes = [
        ...observations.filter(isSuccessfulFix).map(summarizeObservation),
        ...newMemories
          .filter((memory) => memory.type === "bug" || memory.type === "workflow")
          .filter((memory) => SUCCESS_FIX_TEXT.test(`${memory.title} ${memory.content}`))
          .map(summarizeMemory),
      ];
      const unresolvedClaims = [
        ...observations.filter(isUnresolvedObservation).map(summarizeObservation),
        ...reviewRows
          .filter((row) =>
            row.reasons.some((reason) =>
              [
                "missing_source_evidence",
                "low_confidence",
                "conflicting_relation",
                "explicit_review",
                "suspected_write_gate",
              ].includes(reason),
            ),
          )
          .map((row) => ({
            memory: summarizeMemory(row.memory),
            reasons: row.reasons,
            temporalStatus: row.temporalStatus,
            score: row.score,
          })),
      ];
      const proposedConsolidations = flattenProposalValues(stateValues)
        .filter((proposal) => proposal.status === "pending")
        .filter((proposal) => scopeMatchesProject(proposal.project, project))
        .filter((proposal) =>
          timestampInWindow(proposal.proposedAt, window.value) ||
          timestampInWindow(proposal.updatedAt, window.value),
        )
        .sort((a, b) =>
          (b.proposedAt ?? b.updatedAt ?? "").localeCompare(
            a.proposedAt ?? a.updatedAt ?? "",
          ),
        )
        .slice(0, limit.value ?? 25)
        .map(summarizeProposal);
      const sessionSummaries = Array.from(
        new Map(observations.map((row) => [row.session.id, row.session])).values(),
      )
        .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
        .map((session) => ({
          id: session.id,
          project: session.project,
          cwd: session.cwd,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          observationCount: observations.filter((row) => row.session.id === session.id).length,
          agentId: session.agentId,
        }));
      return {
        success: true,
        window: window.value,
        scope: { project, agentId, sessionId },
        counts: {
          sessions: sessionSummaries.length,
          observations: observations.length,
          newMemories: newMemories.length,
          newPreferences: newPreferences.length,
          failedCommands: failedCommands.length,
          successfulFixes: successfulFixes.length,
          unresolvedClaims: unresolvedClaims.length,
          proposedConsolidations: proposedConsolidations.length,
          reviewQueue: reviewQueue.total,
        },
        sessions: sessionSummaries.slice(0, limit.value),
        observations: observations.slice(0, limit.value).map(summarizeObservation),
        newMemories: newMemories.slice(0, limit.value).map(summarizeMemory),
        newPreferences: newPreferences.slice(0, limit.value).map(summarizeMemory),
        failedCommands: failedCommands.slice(0, limit.value).map(summarizeObservation),
        successfulFixes: successfulFixes.slice(0, limit.value),
        unresolvedClaims: unresolvedClaims.slice(0, limit.value),
        proposedConsolidations,
        reviewQueue: reviewRows.map((row) => ({
          memory: summarizeMemory(row.memory),
          reasons: row.reasons,
          temporalStatus: row.temporalStatus,
          score: row.score,
        })),
      };
    },
  );

  sdk.registerFunction(
    "mem::memory-unlinked-mentions",
    async (data?: UnlinkedMentionsInput) => {
      const projectError = inputStringError("project", data?.project);
      if (projectError) return { success: false, error: projectError };
      const agentError = inputStringError("agentId", data?.agentId);
      if (agentError) return { success: false, error: agentError };
      const sessionError = inputStringError("sessionId", data?.sessionId);
      if (sessionError) return { success: false, error: sessionError };
      const window = parseDateWindow(data);
      if (!window.ok) return { success: false, error: window.error };
      const limit = inputPositiveInt(data?.limit, 50, 500, "limit");
      if (limit.error) return { success: false, error: limit.error };
      const minMentions = inputPositiveInt(data?.minMentions, 1, 100, "minMentions");
      if (minMentions.error) return { success: false, error: minMentions.error };
      const project = inputString(data?.project);
      const agentId = inputString(data?.agentId);
      const sessionId = inputString(data?.sessionId);
      const observations = await scopedObservationRows(kv, window.value, {
        project,
        agentId,
        sessionId,
      });
      const memories = (await kv.list<Memory>(KV.memories).catch(() => []))
        .filter((memory) => memoryMatchesScope(memory, { project, agentId }))
        .filter(activeMemory);
      const grouped = new Map<string, {
        concept: string;
        project?: string;
        observations: ObservationRow[];
      }>();
      for (const row of observations) {
        for (const concept of row.observation.concepts) {
          const normalized = normalizeMention(concept);
          if (normalized.length < 2) continue;
          const key = `${row.session.project}::${normalized}`;
          const existing = grouped.get(key) ?? {
            concept: concept.trim(),
            project: row.session.project,
            observations: [],
          };
          existing.observations.push(row);
          grouped.set(key, existing);
        }
      }
      const suggestions = Array.from(grouped.values()).flatMap((group) => {
        const candidateMemories = memories
          .filter((memory) => memory.project === group.project)
          .filter((memory) => conceptInMemory(memory, group.concept));
        const linkedObservationIds = new Set(
          candidateMemories.flatMap((memory) => memory.sourceObservationIds ?? []),
        );
        const unlinkedRows = group.observations.filter(
          (row) => !linkedObservationIds.has(row.observation.id),
        );
        if (unlinkedRows.length < (minMentions.value ?? 1)) return [];
        return [{
          concept: group.concept,
          normalizedConcept: normalizeMention(group.concept),
          project: group.project,
          status: candidateMemories.length > 0
            ? "existing_memory_unlinked"
            : "missing_memory",
          mentionCount: unlinkedRows.length,
          candidateMemoryIds: candidateMemories.map((memory) => memory.id),
          unlinkedObservationIds: unlinkedRows.map((row) => row.observation.id),
          sessionIds: Array.from(new Set(unlinkedRows.map((row) => row.session.id))),
          files: Array.from(new Set(unlinkedRows.flatMap((row) => row.observation.files))),
          firstSeenAt: unlinkedRows
            .map((row) => row.observation.timestamp)
            .sort()[0],
          lastSeenAt: unlinkedRows
            .map((row) => row.observation.timestamp)
            .sort()
            .at(-1),
          evidence: unlinkedRows.slice(0, 5).map(summarizeObservation),
        }];
      });
      suggestions.sort((a, b) => {
        if (a.status !== b.status) return a.status.localeCompare(b.status);
        return b.mentionCount - a.mentionCount;
      });
      return {
        success: true,
        window: window.value,
        scope: { project, agentId, sessionId },
        suggestions: suggestions.slice(0, limit.value),
        total: suggestions.length,
      };
    },
  );

  sdk.registerFunction(
    "mem::memory-ledger",
    async (data?: {
      project?: string;
      state?: MemoryLifecycleState | "all";
      type?: Memory["type"];
      lane?: Memory["lane"];
      reviewState?: MemoryReviewState;
      includeSourceCards?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const limit = Math.max(1, Math.min(data?.limit ?? 100, 1000));
      const offset = Math.max(0, data?.offset ?? 0);
      let memories = await kv.list<Memory>(KV.memories).catch(() => []);
      if (data?.project) memories = memories.filter((m) => m.project === data.project);
      if (data?.type) memories = memories.filter((m) => m.type === data.type);
      if (data?.lane) {
        memories = memories.filter(
          (m) => (m.lane ?? defaultMemoryLane(m.type)) === data.lane,
        );
      }
      if (data?.reviewState) {
        memories = memories.filter(
          (m) => (m.reviewState ?? "unreviewed") === data.reviewState,
        );
      }
      if (data?.state && data.state !== "all") {
        memories = memories.filter((m) => normalizeLifecycleState(m) === data.state);
      } else if (!data?.state) {
        memories = memories.filter((m) => normalizeLifecycleState(m) === "active");
      }
      memories.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      const page = memories.slice(offset, offset + limit);
      const rows = await Promise.all(
        page.map(async (memory) => {
          const access = await getAccessLog(kv, memory.id);
          return {
            id: memory.id,
            title: memory.title,
            type: memory.type,
            lane: memory.lane ?? defaultMemoryLane(memory.type),
            lifecycleState: normalizeLifecycleState(memory),
            reviewState: memory.reviewState ?? "unreviewed",
            project: memory.project,
            branch: memory.branch,
            commit: memory.commit,
            ownerId: memory.ownerId,
            agentId: memory.agentId,
            confidence: memory.confidence,
            strength: memory.strength,
            redactionApplied: memory.redactionApplied === true,
            sensitivityLabels: memory.sensitivityLabels ?? [],
            sourceObservationCount: memory.sourceObservationIds?.length ?? 0,
            sessionCount: memory.sessionIds.length,
            lastUsed: access.lastAt || undefined,
            accessCount: access.count,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt,
            sourceCard: data?.includeSourceCards
              ? await buildSourceCard(kv, memory)
              : undefined,
          };
        }),
      );
      return { success: true, rows, total: memories.length, offset, limit };
    },
  );

  sdk.registerFunction(
    "mem::memory-review-queue",
    async (data?: { project?: string; limit?: number }) => {
      const limit = Math.max(1, Math.min(data?.limit ?? 50, 500));
      const result = await buildReviewQueue(kv, { project: data?.project, limit });
      return { success: true, queue: result.rows, total: result.total };
    },
  );
}

async function lifecycleStateChange(
  kv: StateKV,
  data: {
    memoryId: string;
    expiresAt?: string;
    reason?: string;
    actor?: string;
  },
  action: Extract<LifecycleAction, "expire" | "archive">,
  state: Extract<MemoryLifecycleState, "expired" | "archived">,
): Promise<{ success: boolean; error?: string; memory?: Memory }> {
  if (!data.memoryId || typeof data.memoryId !== "string") {
    return { success: false, error: "memoryId is required" };
  }
  return withKeyedLock(`mem:memory:${data.memoryId}`, async () => {
    const existing = await kv.get<Memory>(KV.memories, data.memoryId);
    if (!existing) return { success: false, error: "memory not found" };
    const meta = redactLifecycleMetadata(data);
    if (meta.error) return { success: false, error: meta.error };
    const now = new Date().toISOString();
    const updated: Memory = {
      ...existing,
      updatedAt: now,
      lifecycleState: state,
      isLatest: false,
      ...(state === "expired" && {
        forgetAfter: meta.expiresAt ?? now,
        validUntil: meta.expiresAt ?? now,
      }),
      ...(state === "archived" && { archivedAt: now }),
    };
    await kv.set(KV.memories, updated.id, updated);
    await recordMemoryRevision(kv, updated.id, action, existing, updated, {
      actor: meta.actor,
      reason: meta.reason,
    });
    await safeAudit(kv, "memory_lifecycle", `mem::memory-${action}`, [updated.id], {
      action,
      reason: meta.reason,
      state,
    });
    await safeRecordAgentEvent(kv, {
      type: action === "expire" ? "memory_expired" : "memory_archived",
      timestamp: now,
      project: updated.project,
      agentId: updated.agentId,
      functionId: `mem::memory-${action}`,
      targetIds: [updated.id],
      memoryIds: [updated.id],
      metadata: {
        actor: meta.actor,
        reason: meta.reason,
        lifecycleState: state,
        expiresAt: meta.expiresAt,
      },
    });
    await reindexMemory(updated);
    return { success: true, memory: updated };
  });
}
