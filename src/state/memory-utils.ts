import type {
  CompressedObservation,
  Memory,
  MemoryLane,
  MemoryPrivacyScope,
  MemoryReviewState,
} from "../types.js";

const MEMORY_LANES = new Set<MemoryLane>([
  "episode",
  "semantic_fact",
  "procedure",
  "reflection",
  "artifact_index",
]);

const MEMORY_REVIEW_STATES = new Set<MemoryReviewState>([
  "unreviewed",
  "reviewed",
  "needs_review",
  "trusted",
  "rejected",
]);

const MEMORY_PRIVACY_SCOPES = new Set<MemoryPrivacyScope>([
  "user",
  "project",
  "team",
  "agent",
  "temporary",
]);

export type TemporalValidityFilter = {
  source: "asOf" | "validAt";
  validAt: string;
  validAtMs: number;
};

export type TemporalValidityNormalization =
  | { filter?: TemporalValidityFilter; error?: undefined }
  | { filter?: undefined; error: string };

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function optionalTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function memoryExpiresAt(memory: Memory): string | undefined {
  const expiresAt = optionalTimestamp((memory as { expiresAt?: unknown }).expiresAt);
  return expiresAt ?? optionalTimestamp(memory.forgetAfter);
}

export function normalizeTemporalValidityFilter(input: {
  asOf?: unknown;
  validAt?: unknown;
}): TemporalValidityNormalization {
  if (
    input.validAt !== undefined &&
    input.validAt !== null &&
    typeof input.validAt !== "string"
  ) {
    return { error: "validAt must be an ISO timestamp" };
  }
  if (
    input.asOf !== undefined &&
    input.asOf !== null &&
    typeof input.asOf !== "string"
  ) {
    return { error: "asOf must be an ISO timestamp" };
  }
  const validAtRaw = optionalTimestamp(input.validAt);
  const asOfRaw = optionalTimestamp(input.asOf);
  const source = validAtRaw ? "validAt" : asOfRaw ? "asOf" : undefined;
  const value = validAtRaw ?? asOfRaw;
  if (!source || !value) return {};
  const validAtMs = timestampMs(value);
  if (validAtMs === undefined) {
    return { error: `${source} must be an ISO timestamp` };
  }
  return {
    filter: {
      source,
      validAt: value,
      validAtMs,
    },
  };
}

export function temporalValidityHardFilter(
  filter?: TemporalValidityFilter,
): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  return {
    source: filter.source,
    validAt: filter.validAt,
  };
}

export function normalizeMemoryLane(value: unknown): MemoryLane | undefined {
  return typeof value === "string" && MEMORY_LANES.has(value as MemoryLane)
    ? (value as MemoryLane)
    : undefined;
}

export function normalizeMemoryReviewState(
  value: unknown,
): MemoryReviewState | undefined {
  return typeof value === "string" &&
    MEMORY_REVIEW_STATES.has(value as MemoryReviewState)
    ? (value as MemoryReviewState)
    : undefined;
}

export function normalizeMemoryPrivacyScope(
  value: unknown,
): MemoryPrivacyScope | undefined {
  return typeof value === "string" &&
    MEMORY_PRIVACY_SCOPES.has(value as MemoryPrivacyScope)
    ? (value as MemoryPrivacyScope)
    : undefined;
}

export function defaultMemoryLane(memoryType: Memory["type"]): MemoryLane {
  switch (memoryType) {
    case "workflow":
      return "procedure";
    case "fact":
    case "architecture":
    case "preference":
      return "semantic_fact";
    case "bug":
    case "pattern":
      return "episode";
    default:
      return "episode";
  }
}

export function isMemorySearchable(memory: Memory): boolean {
  if (memory.isLatest === false) return false;
  const state = memory.lifecycleState ?? "active";
  if (
    state === "quarantined" ||
    state === "archived" ||
    state === "expired" ||
    state === "tombstoned" ||
    state === "deleted" ||
    state === "superseded"
  ) {
    return false;
  }
  if (memory.forgetAfter) {
    const expires = timestampMs(memory.forgetAfter);
    if (expires !== undefined && expires <= Date.now()) return false;
  }
  return true;
}

export function isMemoryTemporallyCompatible(
  memory: Memory,
  filter?: TemporalValidityFilter,
): boolean {
  if (!filter) return true;
  const validFrom = optionalTimestamp(memory.validFrom);
  const validFromMs = timestampMs(validFrom);
  if (validFrom && validFromMs === undefined) return false;
  if (validFromMs !== undefined && validFromMs > filter.validAtMs) return false;

  const validUntil = optionalTimestamp(memory.validUntil);
  const validUntilMs = timestampMs(validUntil);
  if (validUntil && validUntilMs === undefined) return false;
  if (validUntilMs !== undefined && validUntilMs <= filter.validAtMs) {
    return false;
  }

  const expiresAt = memoryExpiresAt(memory);
  const expiresAtMs = timestampMs(expiresAt);
  if (expiresAt && expiresAtMs === undefined) return false;
  if (expiresAtMs !== undefined && expiresAtMs <= filter.validAtMs) {
    return false;
  }

  return true;
}

// Wraps a Memory record in the CompressedObservation shape that
// SearchIndex / VectorIndex / enrichment paths consume. Memories share
// the same searchable fields as observations (title + content +
// concepts + files); type is normalized to "decision" so memories stay
// distinguishable in result metadata without colliding with observation
// enums (file_read, command_run, …). The synthetic sessionId
// ("memory" or memory.sessionIds[0]) is what enrich-side fallbacks key
// off of when looking up the source record in KV.memories.
export function memoryToObservation(memory: Memory): CompressedObservation {
  return {
    id: memory.id,
    sessionId: memory.sessionIds?.[0] ?? "memory",
    timestamp: memory.createdAt,
    type: "decision",
    title: memory.title,
    facts: [memory.content],
    narrative: memory.content,
    concepts: memory.concepts,
    files: memory.files,
    importance: memory.strength,
    confidence: memory.confidence,
    agentId: memory.agentId,
  };
}
