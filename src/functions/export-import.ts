import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ProjectProfile,
  ExportData,
  GraphNode,
  GraphEdge,
  SemanticMemory,
  ProceduralMemory,
  Action,
  ActionEdge,
  Routine,
  Signal,
  Checkpoint,
  Sentinel,
  Sketch,
  Crystal,
  Facet,
  Lesson,
  Insight,
  AccessLogExport,
  MemoryRevision,
  AgentEvent,
  AgentEventType,
  ExportVersion,
} from "../types.js";
import { normalizeAccessLog } from "./access-tracker.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  defaultMemoryLane,
  normalizeMemoryLane,
  normalizeMemoryPrivacyScope,
  normalizeMemoryReviewState,
} from "../state/memory-utils.js";
import { VERSION } from "../version.js";
import { recordAudit } from "./audit.js";
import {
  recordAgentEvent,
  AGENT_EVENT_TYPES,
  type AgentEventInput,
} from "./agent-events.js";
import {
  encryptLocalJsonPayload,
  type LocalJsonEncryptionEnvelope,
} from "../security/encryption.js";
import { encryptionPolicyFromEnv } from "../security/encryption-policy.js";
import { keySourceFromEncryptionKeyRef } from "../state/encryption-runtime.js";
import {
  redactOptionalString,
  redactStringArray,
  scanPrivateData,
  summarizePrivacyScans,
  type PrivacyScanResult,
  type PrivacyScanSummary,
} from "./privacy.js";
import { evaluateWriteGate, type WriteGateDecision } from "./write-gate.js";
import { logger } from "../logger.js";

const EXPORT_SCHEMA = "agentmemory.export" as const;
const EXPORT_SCHEMA_VERSION = 1 as const;
const ENCRYPTED_EXPORT_SCHEMA = "agentmemory.export.encrypted" as const;
const ENCRYPTED_EXPORT_SCHEMA_VERSION = 1 as const;
const HASH_ALGORITHM = "sha256" as const;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

type ExportRequest = {
  maxSessions?: number;
  offset?: number;
  encrypt?: boolean;
  encryptionKeyRef?: string;
};

type EncryptedExportArtifact = {
  schema: typeof ENCRYPTED_EXPORT_SCHEMA;
  schemaVersion: typeof ENCRYPTED_EXPORT_SCHEMA_VERSION;
  encryptedAt: string;
  keyRef: string;
  envelope: LocalJsonEncryptionEnvelope;
};

const SUPPORTED_EXPORT_VERSIONS = [
  "0.3.0",
  "0.4.0",
  "0.5.0",
  "0.6.0",
  "0.6.1",
  "0.7.0",
  "0.7.2",
  "0.7.3",
  "0.7.4",
  "0.7.5",
  "0.7.6",
  "0.7.7",
  "0.7.9",
  "0.8.0",
  "0.8.1",
  "0.8.2",
  "0.8.3",
  "0.8.4",
  "0.8.5",
  "0.8.6",
  "0.8.7",
  "0.8.8",
  "0.8.9",
  "0.8.10",
  "0.8.11",
  "0.8.12",
  "0.8.13",
  "0.9.0",
  "0.9.1",
  "0.9.2",
  "0.9.3",
  "0.9.4",
  "0.9.5",
  "0.9.6",
  "0.9.7",
  "0.9.8",
  "0.9.9",
  "0.9.10",
  "0.9.11",
  "0.9.12",
  "0.9.13",
  "0.9.14",
  "0.9.15",
  "0.9.16",
  "0.9.17",
  "0.9.18",
  "0.9.19",
  "0.9.20",
  "0.9.21",
  "0.9.22",
  "0.9.23",
  "0.9.24",
  "0.9.25",
  "0.9.26",
  "0.9.27",
] as const satisfies readonly ExportVersion[];
const SUPPORTED_EXPORT_VERSION_SET: ReadonlySet<string> = new Set(
  SUPPORTED_EXPORT_VERSIONS,
);

const MAX_SESSIONS = 10_000;
const MAX_MEMORIES = 50_000;
const MAX_SUMMARIES = 10_000;
const MAX_OBS_BUCKETS = 10_000;
const MAX_OBS_PER_SESSION = 5_000;
const MAX_TOTAL_OBSERVATIONS = 500_000;

const OPTIONAL_ARRAY_LIMITS = {
  profiles: 10_000,
  graphNodes: 250_000,
  graphEdges: 500_000,
  semanticMemories: 100_000,
  proceduralMemories: 100_000,
  actions: 200_000,
  actionEdges: 500_000,
  routines: 50_000,
  signals: 100_000,
  checkpoints: 50_000,
  sentinels: 100_000,
  sketches: 100_000,
  crystals: 100_000,
  facets: 100_000,
  lessons: 100_000,
  insights: 100_000,
  accessLogs: 50_000,
  memoryHistory: 100_000,
  agentEvents: 200_000,
} as const;

const CORE_EXPORT_SECTIONS = [
  "sessions",
  "observations",
  "memories",
  "summaries",
] as const;

const OPTIONAL_EXPORT_SECTIONS = Object.keys(
  OPTIONAL_ARRAY_LIMITS,
) as OptionalArraySection[];

const EXPORT_SECTION_NAMES = [
  ...CORE_EXPORT_SECTIONS,
  ...OPTIONAL_EXPORT_SECTIONS,
] as const;

const AGENT_EVENT_TYPE_SET = new Set<AgentEventType>(AGENT_EVENT_TYPES);
const MEMORY_TYPES = new Set<Memory["type"]>([
  "pattern",
  "preference",
  "architecture",
  "bug",
  "workflow",
  "fact",
]);
const MEMORY_LIFECYCLE_STATES = new Set<NonNullable<Memory["lifecycleState"]>>([
  "active",
  "quarantined",
  "archived",
  "expired",
  "tombstoned",
  "deleted",
  "superseded",
]);
const AGENT_EVENT_ARRAY_FIELDS = [
  "targetIds",
  "observationIds",
  "memoryIds",
  "signalIds",
  "actionIds",
  "artifactIds",
  "commitShas",
  "sensitivityLabels",
] as const;

const AGENT_EVENT_STRING_FIELDS = [
  "sessionId",
  "project",
  "cwd",
  "agentId",
  "framework",
  "nativeId",
  "traceId",
  "runId",
  "teamId",
  "taskId",
  "toolCallId",
  "functionId",
  "fromAgentId",
  "toAgentId",
  "handoffFrom",
  "handoffTo",
  "parentEventId",
  "correlationId",
  "evalId",
  "checkpointId",
] as const;

const MEMORY_REVISION_ACTIONS = new Set<MemoryRevision["action"]>([
  "create",
  "update",
  "supersede",
  "expire",
  "archive",
  "restore",
  "tombstone",
  "delete",
]);

const MAX_QUARANTINE_DETAILS = 100;

type ImportStrategy = "merge" | "replace" | "skip";
type OptionalArraySection = keyof typeof OPTIONAL_ARRAY_LIMITS;
type CoreExportSection = (typeof CORE_EXPORT_SECTIONS)[number];
type ExportSectionName = CoreExportSection | OptionalArraySection;
type ExportSections = Record<ExportSectionName, unknown>;

type QuarantineEntry = {
  section: string;
  reason: string;
  id?: string;
  index?: number;
  count?: number;
};

type QuarantineReport = {
  count: number;
  entries: QuarantineEntry[];
  truncated: boolean;
};

type IntegrityReport = {
  checked: boolean;
  ok: boolean;
  mismatches: QuarantineEntry[];
};

type ImportValidation = {
  sourceCounts: Record<string, number>;
  counts: Record<string, number>;
  sections: ExportSections;
  optionalSections: Record<OptionalArraySection, unknown[]>;
  agentEvents: AgentEvent[];
  totalObservations: number;
  quarantine: QuarantineReport;
  integrity: IntegrityReport;
};

type ImportedMemoryWithGate = Memory & { writeGate?: WriteGateDecision };

type ImportStats = {
  sessions: number;
  observations: number;
  memories: number;
  summaries: number;
  accessLogs: number;
  memoryHistory: number;
  agentEvents: number;
  profiles: number;
  graphNodes: number;
  graphEdges: number;
  semanticMemories: number;
  proceduralMemories: number;
  actions: number;
  actionEdges: number;
  routines: number;
  signals: number;
  checkpoints: number;
  sentinels: number;
  sketches: number;
  crystals: number;
  facets: number;
  lessons: number;
  insights: number;
  skipped: number;
  quarantined: number;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableValue(entryValue)]),
    );
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hashSection(value: unknown): string {
  return createHash(HASH_ALGORITHM).update(stableJson(value)).digest("hex");
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function encryptedExportRequest(
  data: ExportRequest | undefined,
  env: Record<string, string | undefined> = process.env,
): { requested: false } | { requested: true; keyRef: string } {
  const policy = encryptionPolicyFromEnv(env);
  const requested = data?.encrypt === true || policy.backups?.enabled === true;
  if (!requested) return { requested: false };
  const keyRef =
    optionalText(data?.encryptionKeyRef) ??
    policy.backups?.keyRef ??
    policy.database?.keyRef ??
    policy.embeddings?.keyRef ??
    policy.transcripts?.keyRef;
  if (!keyRef) {
    throw new Error(
      "backup export encryption requested but no backup encryption key reference is configured",
    );
  }
  return { requested: true, keyRef };
}

function encryptExportData(
  exportData: ExportData,
  keyRef: string,
  env: Record<string, string | undefined> = process.env,
): EncryptedExportArtifact {
  return {
    schema: ENCRYPTED_EXPORT_SCHEMA,
    schemaVersion: ENCRYPTED_EXPORT_SCHEMA_VERSION,
    encryptedAt: exportData.exportedAt,
    keyRef,
    envelope: encryptLocalJsonPayload(
      exportData,
      keySourceFromEncryptionKeyRef(keyRef, env),
      { keyRef },
    ),
  };
}

function countSection(section: ExportSectionName, value: unknown): number {
  if (section === "observations") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, bucket) => sum + (Array.isArray(bucket) ? bucket.length : 0),
      0,
    );
  }
  return Array.isArray(value) ? value.length : 0;
}

function buildSectionCounts(sections: ExportSections): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const section of EXPORT_SECTION_NAMES) {
    counts[section] = countSection(section, sections[section]);
  }
  const observations = sections.observations;
  counts.observationBuckets =
    observations && typeof observations === "object" && !Array.isArray(observations)
      ? Object.keys(observations).length
      : 0;
  return counts;
}

function buildSectionHashes(sections: ExportSections): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const section of EXPORT_SECTION_NAMES) {
    hashes[section] = hashSection(sections[section]);
  }
  return hashes;
}

function buildExportManifest(
  version: ExportData["version"],
  exportedAt: string,
  sections: ExportSections,
): NonNullable<ExportData["manifest"]> {
  return {
    schema: EXPORT_SCHEMA,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    version,
    createdAt: exportedAt,
    exportedAt,
    counts: buildSectionCounts(sections),
    hashAlgorithm: HASH_ALGORITHM,
    hashes: buildSectionHashes(sections),
  };
}

function createQuarantineReport(): QuarantineReport {
  return { count: 0, entries: [], truncated: false };
}

function addQuarantine(
  report: QuarantineReport,
  entry: QuarantineEntry,
  count = entry.count ?? 1,
): void {
  report.count += count;
  if (report.entries.length < MAX_QUARANTINE_DETAILS) {
    report.entries.push({ ...entry, count });
    return;
  }
  report.truncated = true;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRequiredId(
  value: unknown,
  section: string,
  index: number,
  field = "id",
): string | undefined {
  if (!isRecord(value)) {
    return `${section}[${index}] must be an object; received ${describeValue(value)}`;
  }
  if (!isNonEmptyString(value[field])) {
    return `${section}[${index}].${field} must be a non-empty string`;
  }
  return undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalidStringArrayField(
  candidate: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = candidate[field];
    if (value !== undefined && !isStringArray(value)) {
      return field;
    }
  }
  return undefined;
}

function invalidOptionalStringField(
  candidate: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== "string") {
      return field;
    }
  }
  return undefined;
}

function readOptionalArray(
  importData: ExportData,
  section: OptionalArraySection,
): { value: unknown[] } | { error: string } {
  const value = (importData as unknown as Record<string, unknown>)[section];
  if (value === undefined) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return {
      error: `${section} must be an array when provided; received ${describeValue(value)}`,
    };
  }
  const max = OPTIONAL_ARRAY_LIMITS[section];
  if (value.length > max) {
    return {
      error: `${section} has ${value.length} items, exceeding max ${max}`,
    };
  }
  return { value };
}

function isOptionalSection(section: ExportSectionName): section is OptionalArraySection {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_ARRAY_LIMITS, section);
}

function getSectionValue(
  importData: ExportData,
  optionalSections: Record<OptionalArraySection, unknown[]>,
  section: ExportSectionName,
): unknown {
  if (isOptionalSection(section)) {
    return optionalSections[section];
  }
  return importData[section];
}

function validateManifest(
  importData: ExportData,
  optionalSections: Record<OptionalArraySection, unknown[]>,
  quarantine: QuarantineReport,
): { integrity: IntegrityReport; error?: string } {
  const manifest = importData.manifest;
  if (manifest === undefined) {
    return {
      integrity: { checked: false, ok: true, mismatches: [] },
    };
  }
  if (!isRecord(manifest)) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: `manifest must be an object when provided; received ${describeValue(manifest)}`,
    };
  }
  if (
    manifest.schema !== EXPORT_SCHEMA ||
    manifest.schemaVersion !== EXPORT_SCHEMA_VERSION
  ) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: `Unsupported export manifest schema: ${String(
        manifest.schema,
      )}@${String(manifest.schemaVersion)}`,
    };
  }
  if (manifest.version !== importData.version) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: "manifest version does not match exportData version",
    };
  }
  if (manifest.hashAlgorithm !== HASH_ALGORITHM) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: `Unsupported manifest hash algorithm: ${String(
        manifest.hashAlgorithm,
      )}`,
    };
  }
  if (!isRecord(manifest.counts)) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: "manifest.counts must be an object",
    };
  }
  if (!isRecord(manifest.hashes)) {
    return {
      integrity: { checked: true, ok: false, mismatches: [] },
      error: "manifest.hashes must be an object",
    };
  }

  const mismatches: QuarantineEntry[] = [];
  const quarantinedSections = new Set<OptionalArraySection>();
  const expectedObservationBuckets = manifest.counts.observationBuckets;
  const actualObservationBuckets =
    isRecord(importData.observations) ? Object.keys(importData.observations).length : 0;
  if (
    typeof expectedObservationBuckets !== "number" ||
    !Number.isInteger(expectedObservationBuckets) ||
    expectedObservationBuckets < 0
  ) {
    return {
      integrity: { checked: true, ok: false, mismatches },
      error: "manifest.counts.observationBuckets must be a non-negative integer",
    };
  }
  if (expectedObservationBuckets !== actualObservationBuckets) {
    return {
      integrity: {
        checked: true,
        ok: false,
        mismatches: [
          {
            section: "observationBuckets",
            reason: "manifest_count_mismatch",
            count: Math.max(expectedObservationBuckets, actualObservationBuckets),
          },
        ],
      },
      error: "Export manifest integrity check failed for observationBuckets: manifest_count_mismatch",
    };
  }
  for (const section of EXPORT_SECTION_NAMES) {
    const value = getSectionValue(importData, optionalSections, section);
    const expectedCount = manifest.counts[section];
    const expectedHash = manifest.hashes[section];
    if (
      typeof expectedCount !== "number" ||
      !Number.isInteger(expectedCount) ||
      expectedCount < 0
    ) {
      return {
        integrity: { checked: true, ok: false, mismatches },
        error: `manifest.counts.${section} must be a non-negative integer`,
      };
    }
    if (typeof expectedHash !== "string" || !SHA256_HEX_RE.test(expectedHash)) {
      return {
        integrity: { checked: true, ok: false, mismatches },
        error: `manifest.hashes.${section} must be a sha256 hex digest`,
      };
    }

    const actualCount = countSection(section, value);
    const actualHash = hashSection(value);
    if (actualCount !== expectedCount || actualHash !== expectedHash) {
      const reason =
        actualCount !== expectedCount
          ? "manifest_count_mismatch"
          : "manifest_hash_mismatch";
      const affectedCount = Math.max(actualCount, expectedCount);
      const mismatch = { section, reason, count: affectedCount };
      mismatches.push(mismatch);
      if (!isOptionalSection(section)) {
        return {
          integrity: { checked: true, ok: false, mismatches },
          error: `Export manifest integrity check failed for ${section}: ${reason}`,
        };
      }
      quarantinedSections.add(section);
      addQuarantine(quarantine, mismatch, affectedCount);
    }
  }

  for (const section of quarantinedSections) {
    optionalSections[section] = [];
  }

  return {
    integrity: {
      checked: true,
      ok: mismatches.length === 0,
      mismatches,
    },
  };
}

const OPTIONAL_SECTION_ID_FIELDS: Partial<Record<OptionalArraySection, string>> = {
  profiles: "project",
  graphNodes: "id",
  graphEdges: "id",
  semanticMemories: "id",
  proceduralMemories: "id",
  actions: "id",
  actionEdges: "id",
  routines: "id",
  signals: "id",
  checkpoints: "id",
  sentinels: "id",
  sketches: "id",
  crystals: "id",
  facets: "id",
  lessons: "id",
  insights: "id",
};

const OPTIONAL_SECTIONS_WITH_DEDICATED_IMPORT_VALIDATION: ReadonlySet<OptionalArraySection> =
  new Set(["accessLogs", "memoryHistory", "agentEvents"]);

function validateOptionalImportRows(
  optionalSections: Record<OptionalArraySection, unknown[]>,
): string | undefined {
  for (const [section, idField] of Object.entries(OPTIONAL_SECTION_ID_FIELDS) as Array<
    [OptionalArraySection, string]
  >) {
    const rows = optionalSections[section];
    for (const [index, row] of rows.entries()) {
      const error = validateRequiredId(row, section, index, idField);
      if (error) return error;
    }
  }
  return undefined;
}

function sanitizedOptionalImportRows(
  optionalSections: Record<OptionalArraySection, unknown[]>,
  quarantine: QuarantineReport,
): Record<OptionalArraySection, unknown[]> {
  const sanitized = {} as Record<OptionalArraySection, unknown[]>;
  for (const section of OPTIONAL_EXPORT_SECTIONS) {
    if (OPTIONAL_SECTIONS_WITH_DEDICATED_IMPORT_VALIDATION.has(section)) {
      sanitized[section] = optionalSections[section];
      continue;
    }
    sanitized[section] = optionalSections[section].map((row, index) => {
      const redacted = redactUnknownValue(row);
      if (redacted.scan.redactionApplied) {
        const idField = OPTIONAL_SECTION_ID_FIELDS[section];
        const id =
          idField && isRecord(row) && typeof row[idField] === "string"
            ? row[idField]
            : undefined;
        addQuarantine(quarantine, {
          section,
          id,
          index,
          reason: "optional_row_redacted_or_sensitive",
        });
      }
      return redacted.value;
    });
  }
  return sanitized;
}

function isAgentEventType(value: unknown): value is AgentEventType {
  return typeof value === "string" && AGENT_EVENT_TYPE_SET.has(value as AgentEventType);
}

function hasValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validateAgentEvents(
  events: unknown[],
  quarantine: QuarantineReport,
): AgentEvent[] {
  const valid: AgentEvent[] = [];
  const seenIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (!isRecord(event)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        index,
        reason: "agent_event_must_be_object",
      });
      continue;
    }
    const candidate = event as Partial<AgentEvent> & Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        index,
        reason: "agent_event_missing_id",
      });
      continue;
    }
    if (seenIds.has(id)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_duplicate_id",
      });
      continue;
    }
    if (!isAgentEventType(candidate.type)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_invalid_type",
      });
      continue;
    }
    const invalidStringField = invalidOptionalStringField(
      candidate,
      AGENT_EVENT_STRING_FIELDS,
    );
    if (invalidStringField) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: `agent_event_${invalidStringField}_must_be_string`,
      });
      continue;
    }
    if (!hasValidTimestamp(candidate.timestamp)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_invalid_timestamp",
      });
      continue;
    }
    if (!isStringArray(candidate.targetIds)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_targetIds_must_be_string_array",
      });
      continue;
    }
    const invalidArrayField = invalidStringArrayField(
      candidate,
      AGENT_EVENT_ARRAY_FIELDS,
    );
    if (invalidArrayField) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: `agent_event_${invalidArrayField}_must_be_string_array`,
      });
      continue;
    }
    if (
      candidate.status !== undefined &&
      candidate.status !== "ok" &&
      candidate.status !== "error" &&
      candidate.status !== "pending"
    ) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_invalid_status",
      });
      continue;
    }
    if (
      candidate.usage !== undefined &&
      (!isRecord(candidate.usage) ||
        Object.values(candidate.usage).some(
          (value) =>
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value)),
        ))
    ) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_usage_must_be_numeric",
      });
      continue;
    }
    if (
      candidate.cost !== undefined &&
      (!isRecord(candidate.cost) ||
        (candidate.cost.amount !== undefined &&
          (typeof candidate.cost.amount !== "number" ||
            !Number.isFinite(candidate.cost.amount))) ||
        (candidate.cost.currency !== undefined &&
          typeof candidate.cost.currency !== "string"))
    ) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_cost_invalid",
      });
      continue;
    }
    if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_metadata_must_be_object",
      });
      continue;
    }
    if (
      candidate.redactionApplied === true ||
      (Array.isArray(candidate.sensitivityLabels) &&
        candidate.sensitivityLabels.length > 0)
    ) {
      addQuarantine(quarantine, {
        section: "agentEvents",
        id,
        index,
        reason: "agent_event_redacted_or_sensitive",
      });
      continue;
    }
    seenIds.add(id);
    valid.push({ ...candidate, id } as AgentEvent);
  }
  return valid;
}

function agentEventIndexKey(field: string, value: string): string {
  return `${field}:${encodeURIComponent(value)}`;
}

function agentEventIndexKeys(event: AgentEvent): string[] {
  const pairs: Array<[string, string]> = [
    ["type", event.type],
    ...(event.sessionId ? [["sessionId", event.sessionId] as [string, string]] : []),
    ...(event.project ? [["project", event.project] as [string, string]] : []),
    ...(event.agentId ? [["agentId", event.agentId] as [string, string]] : []),
    ...(event.fromAgentId ? [["fromAgentId", event.fromAgentId] as [string, string]] : []),
    ...(event.toAgentId ? [["toAgentId", event.toAgentId] as [string, string]] : []),
    ...(event.functionId ? [["functionId", event.functionId] as [string, string]] : []),
    ...(event.targetIds ?? []).map((id) => ["targetId", id] as [string, string]),
    ...(event.observationIds ?? []).map((id) => ["observationId", id] as [string, string]),
    ...(event.memoryIds ?? []).map((id) => ["memoryId", id] as [string, string]),
    ...(event.signalIds ?? []).map((id) => ["signalId", id] as [string, string]),
    ...(event.correlationId
      ? [["correlationId", event.correlationId] as [string, string]]
      : []),
    ...(event.parentEventId
      ? [["parentEventId", event.parentEventId] as [string, string]]
      : []),
  ];
  return [
    ...new Set(
      pairs
        .filter(([, value]) => value.length > 0)
        .map(([field, value]) => agentEventIndexKey(field, value)),
    ),
  ];
}

function validateCoreImportRows(importData: ExportData): string | undefined {
  for (const [index, session] of importData.sessions.entries()) {
    const error = validateRequiredId(session, "sessions", index);
    if (error) return error;
  }
  for (const [index, memory] of importData.memories.entries()) {
    const error = validateRequiredId(memory, "memories", index);
    if (error) return error;
    if (
      isRecord(memory) &&
      memory.sessionIds !== undefined &&
      !isStringArray(memory.sessionIds)
    ) {
      return `memories[${index}].sessionIds must be an array of strings when provided`;
    }
  }
  for (const [index, summary] of importData.summaries.entries()) {
    const error = validateRequiredId(summary, "summaries", index, "sessionId");
    if (error) return error;
  }
  for (const [sessionId, observations] of Object.entries(importData.observations)) {
    for (const [index, observation] of observations.entries()) {
      const section = `observations.${sessionId}`;
      const error = validateRequiredId(observation, section, index);
      if (error) return error;
      if (!isRecord(observation) || !isNonEmptyString(observation.sessionId)) {
        return `${section}[${index}].sessionId must be a non-empty string`;
      }
      if (observation.sessionId !== sessionId) {
        return `${section}[${index}].sessionId must match its observation bucket`;
      }
    }
  }
  return undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string")),
  );
}

function normalizeMemoryType(value: unknown): Memory["type"] {
  return typeof value === "string" && MEMORY_TYPES.has(value as Memory["type"])
    ? (value as Memory["type"])
    : "fact";
}

function normalizeMemoryLifecycleState(
  value: unknown,
): Memory["lifecycleState"] | undefined {
  return typeof value === "string" &&
    MEMORY_LIFECYCLE_STATES.has(value as NonNullable<Memory["lifecycleState"]>)
    ? (value as Memory["lifecycleState"])
    : undefined;
}

function redactStringField(
  record: Record<string, unknown>,
  field: string,
  scans: Array<PrivacyScanSummary | PrivacyScanResult>,
): void {
  if (record[field] === undefined) return;
  const redacted = redactOptionalString(record[field]);
  scans.push(redacted.scan);
  if (redacted.value !== undefined) {
    record[field] = redacted.value;
  }
}

function redactStringArrayField(
  record: Record<string, unknown>,
  field: string,
  scans: Array<PrivacyScanSummary | PrivacyScanResult>,
): void {
  if (record[field] === undefined) return;
  const redacted = redactStringArray(Array.isArray(record[field]) ? record[field] : []);
  scans.push(redacted.scan);
  record[field] = redacted.values;
}

function redactUnknownValue(
  value: unknown,
): { value: unknown; scan: PrivacyScanSummary | PrivacyScanResult } {
  if (typeof value === "string") {
    const scan = scanPrivateData(value);
    return { value: scan.redacted, scan };
  }
  if (Array.isArray(value)) {
    const values = value.map((item) => redactUnknownValue(item));
    return {
      value: values.map((item) => item.value),
      scan: summarizePrivacyScans(...values.map((item) => item.scan)),
    };
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, item]) => {
      const redacted = redactUnknownValue(item);
      return [key, redacted] as const;
    });
    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      scan: summarizePrivacyScans(...entries.map(([, item]) => item.scan)),
    };
  }
  return { value, scan: summarizePrivacyScans() };
}

function redactUnknownField(
  record: Record<string, unknown>,
  field: string,
  scans: Array<PrivacyScanSummary | PrivacyScanResult>,
): void {
  if (record[field] === undefined) return;
  const redacted = redactUnknownValue(record[field]);
  scans.push(redacted.scan);
  record[field] = redacted.value;
}

function sanitizedObservation(
  observation: CompressedObservation,
  sessionId: string,
  index: number,
  quarantine: QuarantineReport,
): CompressedObservation {
  const row = { ...(observation as unknown as Record<string, unknown>) };
  const scans: Array<PrivacyScanSummary | PrivacyScanResult> = [];
  for (const field of ["title", "subtitle", "narrative", "imageDescription"]) {
    redactStringField(row, field, scans);
  }
  for (const field of ["facts", "concepts", "files"]) {
    redactStringArrayField(row, field, scans);
  }
  for (const field of ["raw", "toolInput", "toolOutput", "userPrompt", "assistantResponse"]) {
    redactUnknownField(row, field, scans);
  }
  const privacy = summarizePrivacyScans(...scans);
  if (privacy.redactionApplied) {
    addQuarantine(quarantine, {
      section: `observations.${sessionId}`,
      id: observation.id,
      index,
      reason: "observation_redacted_or_sensitive",
    });
  }
  return row as unknown as CompressedObservation;
}

function sanitizedMemory(
  memory: Memory,
  index: number,
  quarantine: QuarantineReport,
): ImportedMemoryWithGate {
  const row = { ...(memory as unknown as Record<string, unknown>) };
  const scans: Array<PrivacyScanSummary | PrivacyScanResult> = [];
  for (const field of [
    "title",
    "content",
    "ownerId",
    "branch",
    "commit",
    "sourceHash",
    "sourceType",
    "sourceUri",
    "agentId",
    "project",
    "lane",
    "lifecycleState",
    "reviewState",
    "privacyScope",
  ]) {
    redactStringField(row, field, scans);
  }
  for (const field of ["concepts", "files", "sourceObservationIds"]) {
    redactStringArrayField(row, field, scans);
  }
  if (!Array.isArray(row.sessionIds)) row.sessionIds = [];

  const gated = row as unknown as ImportedMemoryWithGate;
  const memoryType = normalizeMemoryType(gated.type);
  gated.type = memoryType;
  gated.concepts = Array.isArray(gated.concepts) ? gated.concepts : [];
  gated.files = Array.isArray(gated.files) ? gated.files : [];
  gated.sourceObservationIds = Array.isArray(gated.sourceObservationIds)
    ? gated.sourceObservationIds
    : [];
  gated.lane = normalizeMemoryLane(gated.lane) ?? defaultMemoryLane(memoryType);
  const lifecycleState = normalizeMemoryLifecycleState(gated.lifecycleState);
  if (lifecycleState) {
    gated.lifecycleState = lifecycleState;
  } else {
    delete gated.lifecycleState;
  }
  const reviewState = normalizeMemoryReviewState(gated.reviewState);
  if (reviewState) {
    gated.reviewState = reviewState;
  } else {
    delete gated.reviewState;
  }
  const privacyScope = normalizeMemoryPrivacyScope(gated.privacyScope);
  if (privacyScope) {
    gated.privacyScope = privacyScope;
  } else {
    delete gated.privacyScope;
  }

  const existingLabels = Array.isArray(memory.sensitivityLabels)
    ? memory.sensitivityLabels.filter((label): label is string => typeof label === "string")
    : [];
  const privacy = summarizePrivacyScans(...scans);
  const sensitive = privacy.redactionApplied || memory.redactionApplied === true || existingLabels.length > 0;
  const labels = uniqueStrings([...privacy.labels, ...existingLabels]);
  const sensitivityLabels =
    labels.length > 0 ? labels : sensitive ? ["imported_sensitive"] : [];
  gated.writeGate = {
    ...evaluateWriteGate({
      content: typeof gated.content === "string" ? gated.content : "",
      type: gated.type,
      concepts: gated.concepts,
      files: gated.files,
      sourceObservationIds: gated.sourceObservationIds,
      project: gated.project,
      lane: gated.lane,
      privacyScope: gated.privacyScope,
      ownerId: gated.ownerId,
      branch: gated.branch,
      commit: gated.commit,
      sourceHash: gated.sourceHash,
      sourceType: gated.sourceType,
      sourceUri: gated.sourceUri,
      agentId: gated.agentId,
      existingMemories: [],
      privacySummary: {
        redactionApplied: sensitive || privacy.redactionApplied,
        labels: sensitivityLabels,
        matchCount: privacy.matchCount,
      },
    }),
    mode: "review",
  };
  if (sensitive) {
    gated.lifecycleState = "quarantined";
    gated.reviewState = "needs_review";
    gated.privacyScope = privacyScope ?? "user";
    gated.redactionApplied = true;
    gated.sensitivityLabels = sensitivityLabels;
    addQuarantine(quarantine, {
      section: "memories",
      id: memory.id,
      index,
      reason: "memory_redacted_or_sensitive",
    });
  } else {
    gated.lifecycleState = gated.lifecycleState ?? "active";
    gated.reviewState =
      gated.writeGate.reviewState === "needs_review"
        ? "needs_review"
        : gated.reviewState ?? "unreviewed";
    delete gated.redactionApplied;
    delete gated.sensitivityLabels;
  }
  return row as unknown as ImportedMemoryWithGate;
}

function sanitizeCoreImportSections(
  importData: ExportData,
  quarantine: QuarantineReport,
): Pick<ExportSections, "sessions" | "observations" | "memories" | "summaries"> {
  const observations: ExportData["observations"] = {};
  for (const [sessionId, bucket] of Object.entries(importData.observations)) {
    observations[sessionId] = bucket.map((observation, index) =>
      sanitizedObservation(observation, sessionId, index, quarantine),
    );
  }
  const memories = importData.memories.map((memory, index) =>
    sanitizedMemory(memory, index, quarantine),
  );
  return {
    sessions: importData.sessions,
    observations,
    memories,
    summaries: importData.summaries,
  };
}

function validateAccessLogs(
  logs: unknown[],
  importedMemoryIds: ReadonlySet<string>,
  quarantine: QuarantineReport,
): AccessLogExport[] {
  const valid: AccessLogExport[] = [];
  for (const [index, raw] of logs.entries()) {
    const log = normalizeAccessLog(raw);
    if (!log.memoryId) {
      addQuarantine(quarantine, {
        section: "accessLogs",
        index,
        reason: "access_log_missing_memory_id",
      });
      continue;
    }
    if (!importedMemoryIds.has(log.memoryId)) {
      addQuarantine(quarantine, {
        section: "accessLogs",
        id: log.memoryId,
        index,
        reason: "access_log_missing_imported_memory",
      });
      continue;
    }
    valid.push(log);
  }
  return valid;
}

function validateMemoryHistory(
  revisions: unknown[],
  importedMemoryIds: ReadonlySet<string>,
  quarantine: QuarantineReport,
): MemoryRevision[] {
  const valid: MemoryRevision[] = [];
  for (const [index, revision] of revisions.entries()) {
    if (!isRecord(revision)) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        index,
        reason: "memory_history_must_be_object",
      });
      continue;
    }
    const id = typeof revision.id === "string" ? revision.id.trim() : "";
    const memoryId =
      typeof revision.memoryId === "string" ? revision.memoryId.trim() : "";
    if (!id) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        index,
        reason: "memory_history_missing_id",
      });
      continue;
    }
    if (!memoryId) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        id,
        index,
        reason: "memory_history_missing_memory_id",
      });
      continue;
    }
    if (!importedMemoryIds.has(memoryId)) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        id,
        index,
        reason: "memory_history_missing_imported_memory",
      });
      continue;
    }
    if (!MEMORY_REVISION_ACTIONS.has(revision.action as MemoryRevision["action"])) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        id,
        index,
        reason: "memory_history_invalid_action",
      });
      continue;
    }
    if (!hasValidTimestamp(revision.createdAt)) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        id,
        index,
        reason: "memory_history_invalid_created_at",
      });
      continue;
    }
    const row = { ...revision, id, memoryId } as Record<string, unknown>;
    const scans: Array<PrivacyScanSummary | PrivacyScanResult> = [];
    redactStringField(row, "actor", scans);
    redactStringField(row, "reason", scans);
    redactUnknownField(row, "prior", scans);
    redactUnknownField(row, "next", scans);
    const privacy = summarizePrivacyScans(...scans);
    if (privacy.redactionApplied) {
      addQuarantine(quarantine, {
        section: "memoryHistory",
        id,
        index,
        reason: "memory_history_redacted_or_sensitive",
      });
    }
    valid.push(row as unknown as MemoryRevision);
  }
  return valid;
}

function validateImportData(
  importData: ExportData,
): { success: true; validation: ImportValidation } | { success: false; error: string } {
  if (!Array.isArray(importData.sessions)) {
    return {
      success: false,
      error: `sessions must be an array; received ${describeValue(importData.sessions)}`,
    };
  }
  if (!Array.isArray(importData.memories)) {
    return {
      success: false,
      error: `memories must be an array; received ${describeValue(importData.memories)}`,
    };
  }
  if (!Array.isArray(importData.summaries)) {
    return {
      success: false,
      error: `summaries must be an array; received ${describeValue(importData.summaries)}`,
    };
  }
  if (
    typeof importData.observations !== "object" ||
    importData.observations === null ||
    Array.isArray(importData.observations)
  ) {
    return {
      success: false,
      error: `observations must be an object keyed by session id; received ${describeValue(
        importData.observations,
      )}`,
    };
  }

  if (importData.sessions.length > MAX_SESSIONS) {
    return {
      success: false,
      error: `sessions has ${importData.sessions.length} items, exceeding max ${MAX_SESSIONS}`,
    };
  }
  if (importData.memories.length > MAX_MEMORIES) {
    return {
      success: false,
      error: `memories has ${importData.memories.length} items, exceeding max ${MAX_MEMORIES}`,
    };
  }
  if (importData.summaries.length > MAX_SUMMARIES) {
    return {
      success: false,
      error: `summaries has ${importData.summaries.length} items, exceeding max ${MAX_SUMMARIES}`,
    };
  }

  const obsBuckets = Object.keys(importData.observations);
  if (obsBuckets.length > MAX_OBS_BUCKETS) {
    return {
      success: false,
      error: `observations has ${obsBuckets.length} buckets, exceeding max ${MAX_OBS_BUCKETS}`,
    };
  }

  let totalObservations = 0;
  for (const [sessionId, obs] of Object.entries(importData.observations)) {
    if (!Array.isArray(obs)) {
      return {
        success: false,
        error: `observations.${sessionId} must be an array; received ${describeValue(obs)}`,
      };
    }
    if (obs.length > MAX_OBS_PER_SESSION) {
      return {
        success: false,
        error: `observations.${sessionId} has ${obs.length} items, exceeding max ${MAX_OBS_PER_SESSION}`,
      };
    }
    totalObservations += obs.length;
  }
  if (totalObservations > MAX_TOTAL_OBSERVATIONS) {
    return {
      success: false,
      error: `observations has ${totalObservations} total items, exceeding max ${MAX_TOTAL_OBSERVATIONS}`,
    };
  }
  const coreError = validateCoreImportRows(importData);
  if (coreError) {
    return { success: false, error: coreError };
  }

  const optionalSections = {} as Record<OptionalArraySection, unknown[]>;
  for (const section of OPTIONAL_EXPORT_SECTIONS) {
    const result = readOptionalArray(importData, section);
    if ("error" in result) {
      return { success: false, error: result.error };
    }
    optionalSections[section] = result.value;
  }
  const optionalRowError = validateOptionalImportRows(optionalSections);
  if (optionalRowError) {
    return { success: false, error: optionalRowError };
  }
  const sourceSections: ExportSections = {
    sessions: importData.sessions,
    observations: importData.observations,
    memories: importData.memories,
    summaries: importData.summaries,
    profiles: optionalSections.profiles,
    graphNodes: optionalSections.graphNodes,
    graphEdges: optionalSections.graphEdges,
    semanticMemories: optionalSections.semanticMemories,
    proceduralMemories: optionalSections.proceduralMemories,
    actions: optionalSections.actions,
    actionEdges: optionalSections.actionEdges,
    routines: optionalSections.routines,
    signals: optionalSections.signals,
    checkpoints: optionalSections.checkpoints,
    sentinels: optionalSections.sentinels,
    sketches: optionalSections.sketches,
    crystals: optionalSections.crystals,
    facets: optionalSections.facets,
    lessons: optionalSections.lessons,
    insights: optionalSections.insights,
    accessLogs: optionalSections.accessLogs,
    memoryHistory: optionalSections.memoryHistory,
    agentEvents: optionalSections.agentEvents,
  };
  const sourceCounts = buildSectionCounts(sourceSections);

  const quarantine = createQuarantineReport();
  const manifestResult = validateManifest(importData, optionalSections, quarantine);
  if (manifestResult.error) {
    return { success: false, error: manifestResult.error };
  }
  const coreSections = sanitizeCoreImportSections(importData, quarantine);
  const sanitizedOptionalSections = sanitizedOptionalImportRows(
    optionalSections,
    quarantine,
  );

  const importedMemoryIds = new Set(
    (coreSections.memories as Memory[]).map((memory) => memory.id),
  );
  const accessLogs = validateAccessLogs(
    sanitizedOptionalSections.accessLogs,
    importedMemoryIds,
    quarantine,
  );
  sanitizedOptionalSections.accessLogs = accessLogs;
  const memoryHistory = validateMemoryHistory(
    sanitizedOptionalSections.memoryHistory,
    importedMemoryIds,
    quarantine,
  );
  sanitizedOptionalSections.memoryHistory = memoryHistory;
  const agentEvents = validateAgentEvents(
    sanitizedOptionalSections.agentEvents,
    quarantine,
  );
  sanitizedOptionalSections.agentEvents = agentEvents;

  const sections: ExportSections = {
    sessions: coreSections.sessions,
    observations: coreSections.observations,
    memories: coreSections.memories,
    summaries: coreSections.summaries,
    profiles: sanitizedOptionalSections.profiles,
    graphNodes: sanitizedOptionalSections.graphNodes,
    graphEdges: sanitizedOptionalSections.graphEdges,
    semanticMemories: sanitizedOptionalSections.semanticMemories,
    proceduralMemories: sanitizedOptionalSections.proceduralMemories,
    actions: sanitizedOptionalSections.actions,
    actionEdges: sanitizedOptionalSections.actionEdges,
    routines: sanitizedOptionalSections.routines,
    signals: sanitizedOptionalSections.signals,
    checkpoints: sanitizedOptionalSections.checkpoints,
    sentinels: sanitizedOptionalSections.sentinels,
    sketches: sanitizedOptionalSections.sketches,
    crystals: sanitizedOptionalSections.crystals,
    facets: sanitizedOptionalSections.facets,
    lessons: sanitizedOptionalSections.lessons,
    insights: sanitizedOptionalSections.insights,
    accessLogs,
    memoryHistory,
    agentEvents,
  };

  return {
    success: true,
    validation: {
      sourceCounts,
      counts: buildSectionCounts(sections),
      sections,
      optionalSections: sanitizedOptionalSections,
      agentEvents,
      totalObservations,
      quarantine,
      integrity: manifestResult.integrity,
    },
  };
}

function buildImportPlan(
  strategy: ImportStrategy,
  validation: ImportValidation,
): Record<string, unknown> {
  return {
    strategy,
    replaceExisting: strategy === "replace",
    sourceCounts: validation.sourceCounts,
    counts: validation.counts,
    quarantined: validation.quarantine.count,
    wouldImport: {
      sessions: validation.counts.sessions,
      observations: validation.counts.observations,
      memories: validation.counts.memories,
      summaries: validation.counts.summaries,
      profiles: validation.counts.profiles,
      graphNodes: validation.counts.graphNodes,
      graphEdges: validation.counts.graphEdges,
      semanticMemories: validation.counts.semanticMemories,
      proceduralMemories: validation.counts.proceduralMemories,
      actions: validation.counts.actions,
      actionEdges: validation.counts.actionEdges,
      routines: validation.counts.routines,
      signals: validation.counts.signals,
      checkpoints: validation.counts.checkpoints,
      sentinels: validation.counts.sentinels,
      sketches: validation.counts.sketches,
      crystals: validation.counts.crystals,
      facets: validation.counts.facets,
      lessons: validation.counts.lessons,
      insights: validation.counts.insights,
      accessLogs: validation.counts.accessLogs,
      memoryHistory: validation.counts.memoryHistory,
      agentEvents: validation.agentEvents.length,
    },
    quarantine: validation.quarantine,
    integrity: validation.integrity,
  };
}

type ReplaceSnapshot = {
  sessions: Session[];
  observations: Map<string, CompressedObservation[]>;
  memories: Memory[];
  summaries: SessionSummary[];
  actions: Action[];
  actionEdges: ActionEdge[];
  routines: Routine[];
  signals: Signal[];
  checkpoints: Checkpoint[];
  sentinels: Sentinel[];
  sketches: Sketch[];
  crystals: Crystal[];
  facets: Facet[];
  lessons: Lesson[];
  insights: Insight[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  semantic: SemanticMemory[];
  procedural: ProceduralMemory[];
  profiles: ProjectProfile[];
  accessLog: AccessLogExport[];
  memoryHistory: MemoryRevision[];
  agentEvents: AgentEvent[];
};

// Observation buckets live in per-session KV scopes (mem:obs:<id>) with no
// registry of bucket names. Enumerate the candidate session-id universe from
// every listable source keyed by sessionId — the sessions list AND the
// summaries list — so an orphaned bucket whose session record was already
// removed (but whose summary or bucket survives) is still cleared on replace.
function observationBucketSessionIds(
  sessions: Session[],
  summaries: SessionSummary[],
): string[] {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session?.id) ids.add(session.id);
  }
  for (const summary of summaries) {
    if (summary?.sessionId) ids.add(summary.sessionId);
  }
  return [...ids];
}

async function snapshotExistingState(
  kv: StateKV,
  sessions: Session[],
  summaries: SessionSummary[],
): Promise<ReplaceSnapshot> {
  const observations = new Map<string, CompressedObservation[]>();
  for (const sessionId of observationBucketSessionIds(sessions, summaries)) {
    const bucket = await kv
      .list<CompressedObservation>(KV.observations(sessionId))
      .catch(() => []);
    if (bucket.length > 0) observations.set(sessionId, bucket);
  }
  return {
    sessions,
    observations,
    memories: await kv.list<Memory>(KV.memories).catch(() => []),
    summaries,
    actions: await kv.list<Action>(KV.actions).catch(() => []),
    actionEdges: await kv.list<ActionEdge>(KV.actionEdges).catch(() => []),
    routines: await kv.list<Routine>(KV.routines).catch(() => []),
    signals: await kv.list<Signal>(KV.signals).catch(() => []),
    checkpoints: await kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
    sentinels: await kv.list<Sentinel>(KV.sentinels).catch(() => []),
    sketches: await kv.list<Sketch>(KV.sketches).catch(() => []),
    crystals: await kv.list<Crystal>(KV.crystals).catch(() => []),
    facets: await kv.list<Facet>(KV.facets).catch(() => []),
    lessons: await kv.list<Lesson>(KV.lessons).catch(() => []),
    insights: await kv.list<Insight>(KV.insights).catch(() => []),
    graphNodes: await kv.list<GraphNode>(KV.graphNodes).catch(() => []),
    graphEdges: await kv.list<GraphEdge>(KV.graphEdges).catch(() => []),
    semantic: await kv.list<SemanticMemory>(KV.semantic).catch(() => []),
    procedural: await kv.list<ProceduralMemory>(KV.procedural).catch(() => []),
    profiles: await kv.list<ProjectProfile>(KV.profiles).catch(() => []),
    accessLog: await kv.list<AccessLogExport>(KV.accessLog).catch(() => []),
    memoryHistory: await kv
      .list<MemoryRevision>(KV.memoryHistory)
      .catch(() => []),
    agentEvents: await kv.list<AgentEvent>(KV.agentEvents).catch(() => []),
  };
}

async function deleteSnapshotState(
  kv: StateKV,
  snapshot: ReplaceSnapshot,
): Promise<void> {
  for (const session of snapshot.sessions) {
    await kv.delete(KV.sessions, session.id);
  }
  for (const [sessionId, bucket] of snapshot.observations) {
    for (const obs of bucket) {
      await kv.delete(KV.observations(sessionId), obs.id);
    }
  }
  for (const memory of snapshot.memories) {
    await kv.delete(KV.memories, memory.id);
  }
  for (const summary of snapshot.summaries) {
    await kv.delete(KV.summaries, summary.sessionId);
  }
  for (const action of snapshot.actions) await kv.delete(KV.actions, action.id);
  for (const edge of snapshot.actionEdges) {
    await kv.delete(KV.actionEdges, edge.id);
  }
  for (const routine of snapshot.routines) {
    await kv.delete(KV.routines, routine.id);
  }
  for (const signal of snapshot.signals) await kv.delete(KV.signals, signal.id);
  for (const checkpoint of snapshot.checkpoints) {
    await kv.delete(KV.checkpoints, checkpoint.id);
  }
  for (const sentinel of snapshot.sentinels) {
    await kv.delete(KV.sentinels, sentinel.id);
  }
  for (const sketch of snapshot.sketches) await kv.delete(KV.sketches, sketch.id);
  for (const crystal of snapshot.crystals) {
    await kv.delete(KV.crystals, crystal.id);
  }
  for (const facet of snapshot.facets) await kv.delete(KV.facets, facet.id);
  for (const lesson of snapshot.lessons) await kv.delete(KV.lessons, lesson.id);
  for (const insight of snapshot.insights) {
    await kv.delete(KV.insights, insight.id);
  }
  for (const node of snapshot.graphNodes) await kv.delete(KV.graphNodes, node.id);
  for (const edge of snapshot.graphEdges) {
    await kv.delete(KV.graphEdges, edge.id);
  }
  for (const sem of snapshot.semantic) await kv.delete(KV.semantic, sem.id);
  for (const proc of snapshot.procedural) {
    await kv.delete(KV.procedural, proc.id);
  }
  for (const profile of snapshot.profiles) {
    await kv.delete(KV.profiles, profile.project);
  }
  for (const log of snapshot.accessLog) {
    await kv.delete(KV.accessLog, log.memoryId);
  }
  for (const revision of snapshot.memoryHistory) {
    await kv.delete(KV.memoryHistory, revision.id);
  }
  for (const event of snapshot.agentEvents) {
    await kv.delete(KV.agentEvents, event.id);
    await Promise.all(
      agentEventIndexKeys(event).map((key) =>
        kv.delete(KV.agentEventIndexes, key).catch(() => undefined),
      ),
    );
  }
}

async function restoreSnapshotState(
  kv: StateKV,
  snapshot: ReplaceSnapshot,
): Promise<void> {
  for (const session of snapshot.sessions) {
    await kv.set(KV.sessions, session.id, session);
  }
  for (const [sessionId, bucket] of snapshot.observations) {
    for (const obs of bucket) {
      await kv.set(KV.observations(sessionId), obs.id, obs);
    }
  }
  for (const memory of snapshot.memories) {
    await kv.set(KV.memories, memory.id, memory);
  }
  for (const summary of snapshot.summaries) {
    await kv.set(KV.summaries, summary.sessionId, summary);
  }
  for (const action of snapshot.actions) {
    await kv.set(KV.actions, action.id, action);
  }
  for (const edge of snapshot.actionEdges) {
    await kv.set(KV.actionEdges, edge.id, edge);
  }
  for (const routine of snapshot.routines) {
    await kv.set(KV.routines, routine.id, routine);
  }
  for (const signal of snapshot.signals) {
    await kv.set(KV.signals, signal.id, signal);
  }
  for (const checkpoint of snapshot.checkpoints) {
    await kv.set(KV.checkpoints, checkpoint.id, checkpoint);
  }
  for (const sentinel of snapshot.sentinels) {
    await kv.set(KV.sentinels, sentinel.id, sentinel);
  }
  for (const sketch of snapshot.sketches) {
    await kv.set(KV.sketches, sketch.id, sketch);
  }
  for (const crystal of snapshot.crystals) {
    await kv.set(KV.crystals, crystal.id, crystal);
  }
  for (const facet of snapshot.facets) {
    await kv.set(KV.facets, facet.id, facet);
  }
  for (const lesson of snapshot.lessons) {
    await kv.set(KV.lessons, lesson.id, lesson);
  }
  for (const insight of snapshot.insights) {
    await kv.set(KV.insights, insight.id, insight);
  }
  for (const node of snapshot.graphNodes) {
    await kv.set(KV.graphNodes, node.id, node);
  }
  for (const edge of snapshot.graphEdges) {
    await kv.set(KV.graphEdges, edge.id, edge);
  }
  for (const sem of snapshot.semantic) {
    await kv.set(KV.semantic, sem.id, sem);
  }
  for (const proc of snapshot.procedural) {
    await kv.set(KV.procedural, proc.id, proc);
  }
  for (const profile of snapshot.profiles) {
    await kv.set(KV.profiles, profile.project, profile);
  }
  for (const log of snapshot.accessLog) {
    await kv.set(KV.accessLog, log.memoryId, log);
  }
  for (const revision of snapshot.memoryHistory) {
    await kv.set(KV.memoryHistory, revision.id, revision);
  }
  for (const event of snapshot.agentEvents) {
    await kv.set(KV.agentEvents, event.id, event);
    for (const key of agentEventIndexKeys(event)) {
      const existing = await kv
        .get<{ eventIds?: string[] }>(KV.agentEventIndexes, key)
        .catch(() => null);
      const eventIds = new Set<string>(existing?.eventIds ?? []);
      eventIds.add(event.id);
      await kv
        .set(KV.agentEventIndexes, key, {
          eventIds: [...eventIds],
          updatedAt: event.timestamp,
        })
        .catch(() => undefined);
    }
  }
}

export function registerExportImportFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::export",
    async (data?: ExportRequest) => {
      const rawMax = Number(data?.maxSessions);
      const maxSessions = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(Math.floor(rawMax), 1000) : undefined;
      const rawOffset = Number(data?.offset);
      const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

      const allSessions = await kv.list<Session>(KV.sessions);
      const paginatedSessions = maxSessions !== undefined
        ? allSessions.slice(offset, offset + maxSessions)
        : allSessions;
      const memories = await kv.list<Memory>(KV.memories);
      const summaries = await kv.list<SessionSummary>(KV.summaries);

      const observations: Record<string, CompressedObservation[]> = {};
      const obsResults = await Promise.all(
        paginatedSessions.map((session) =>
          kv
            .list<CompressedObservation>(KV.observations(session.id))
            .catch(() => [] as CompressedObservation[])
            .then((obs) => ({ sessionId: session.id, obs })),
        ),
      );
      for (const { sessionId, obs } of obsResults) {
        if (obs.length > 0) {
          observations[sessionId] = obs;
        }
      }

      const profiles: ProjectProfile[] = [];
      const uniqueProjects = [...new Set(paginatedSessions.map((s) => s.project))];
      const profileResults = await Promise.all(
        uniqueProjects.map((project) =>
          kv.get<ProjectProfile>(KV.profiles, project).catch(() => null),
        ),
      );
      for (const profile of profileResults) {
        if (profile) profiles.push(profile);
      }

      const [
        graphNodes,
        graphEdges,
        semanticMemories,
        proceduralMemories,
        actions,
        actionEdges,
        sentinels,
        sketches,
        crystals,
        facets,
        lessons,
        insights,
        routines,
        signals,
        checkpoints,
        accessLogs,
        memoryHistory,
        agentEvents,
      ] = await Promise.all([
        kv.list<GraphNode>(KV.graphNodes).catch(() => []),
        kv.list<GraphEdge>(KV.graphEdges).catch(() => []),
        kv.list<SemanticMemory>(KV.semantic).catch(() => []),
        kv.list<ProceduralMemory>(KV.procedural).catch(() => []),
        kv.list<Action>(KV.actions).catch(() => []),
        kv.list<ActionEdge>(KV.actionEdges).catch(() => []),
        kv.list<Sentinel>(KV.sentinels).catch(() => []),
        kv.list<Sketch>(KV.sketches).catch(() => []),
        kv.list<Crystal>(KV.crystals).catch(() => []),
        kv.list<Facet>(KV.facets).catch(() => []),
        kv.list<Lesson>(KV.lessons).catch(() => []),
        kv.list<Insight>(KV.insights).catch(() => []),
        kv.list<Routine>(KV.routines).catch(() => []),
        kv.list<Signal>(KV.signals).catch(() => []),
        kv.list<Checkpoint>(KV.checkpoints).catch(() => []),
        kv.list<AccessLogExport>(KV.accessLog).catch(() => []),
        kv.list<MemoryRevision>(KV.memoryHistory).catch(() => []),
        kv.list<AgentEvent>(KV.agentEvents).catch(() => []),
      ]);

      const exportedAt = new Date().toISOString();
      const exportSections: ExportSections = {
        sessions: paginatedSessions,
        observations,
        memories,
        summaries,
        profiles,
        graphNodes,
        graphEdges,
        semanticMemories,
        proceduralMemories,
        actions,
        actionEdges,
        routines,
        signals,
        checkpoints,
        sentinels,
        sketches,
        crystals,
        facets,
        lessons,
        insights,
        accessLogs,
        memoryHistory,
        agentEvents,
      };

      const exportData: ExportData = {
        version: VERSION,
        exportedAt,
        manifest: buildExportManifest(VERSION, exportedAt, exportSections),
        sessions: paginatedSessions,
        observations,
        memories,
        summaries,
        profiles: profiles.length > 0 ? profiles : undefined,
        graphNodes: graphNodes.length > 0 ? graphNodes : undefined,
        graphEdges: graphEdges.length > 0 ? graphEdges : undefined,
        semanticMemories:
          semanticMemories.length > 0 ? semanticMemories : undefined,
        proceduralMemories:
          proceduralMemories.length > 0 ? proceduralMemories : undefined,
        actions: actions.length > 0 ? actions : undefined,
        actionEdges: actionEdges.length > 0 ? actionEdges : undefined,
        sentinels: sentinels.length > 0 ? sentinels : undefined,
        sketches: sketches.length > 0 ? sketches : undefined,
        crystals: crystals.length > 0 ? crystals : undefined,
        facets: facets.length > 0 ? facets : undefined,
        lessons: lessons.length > 0 ? lessons : undefined,
        insights: insights.length > 0 ? insights : undefined,
        routines: routines.length > 0 ? routines : undefined,
        signals: signals.length > 0 ? signals : undefined,
        checkpoints: checkpoints.length > 0 ? checkpoints : undefined,
        accessLogs: accessLogs.length > 0 ? accessLogs : undefined,
        memoryHistory: memoryHistory.length > 0 ? memoryHistory : undefined,
        agentEvents: agentEvents.length > 0 ? agentEvents : undefined,
      };

      if (maxSessions !== undefined) {
        exportData.pagination = {
          offset,
          limit: maxSessions,
          total: allSessions.length,
          hasMore: offset + maxSessions < allSessions.length,
        };
      }

      const totalObs = Object.values(observations).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      logger.info("Export complete", {
        sessions: paginatedSessions.length,
        totalSessions: allSessions.length,
        observations: totalObs,
        memories: memories.length,
        summaries: summaries.length,
      });

      const encryption = encryptedExportRequest(data);
      if (encryption.requested) {
        return encryptExportData(exportData, encryption.keyRef);
      }

      return exportData;
    },
  );

  sdk.registerFunction("mem::import", 
    async (data: {
      exportData: ExportData;
      strategy?: ImportStrategy;
      dryRun?: boolean;
    }) => {
      if (
        !data?.exportData ||
        typeof data.exportData !== "object" ||
        typeof (data.exportData as { version?: unknown }).version !== "string"
      ) {
        return { success: false, error: "exportData with string version is required" };
      }
      const strategy = data.strategy || "merge";
      if (!["merge", "replace", "skip"].includes(strategy)) {
        return {
          success: false,
          error: `Unsupported import strategy: ${String(strategy)}`,
        };
      }
      const dryRun = data.dryRun === true;
      const importData = data.exportData;

      if (!SUPPORTED_EXPORT_VERSION_SET.has(importData.version)) {
        return {
          success: false,
          error: `Unsupported export version: ${importData.version}`,
        };
      }

      const validationResult = validateImportData(importData);
      if (!validationResult.success) {
        return { success: false, error: validationResult.error };
      }
      const validation = validationResult.validation;
      const importPlan = buildImportPlan(strategy, validation);
      if (dryRun) {
        logger.info("Import dry run complete", {
          strategy,
          counts: validation.counts,
          quarantined: validation.quarantine.count,
        });
        return {
          success: true,
          dryRun: true,
          strategy,
          plan: importPlan,
          skipped: validation.quarantine.count,
          quarantined: validation.quarantine.count,
          quarantine: validation.quarantine,
          integrity: validation.integrity,
        };
      }

      const stats: ImportStats = {
        sessions: 0,
        observations: 0,
        memories: 0,
        summaries: 0,
        accessLogs: 0,
        memoryHistory: 0,
        agentEvents: 0,
        profiles: 0,
        graphNodes: 0,
        graphEdges: 0,
        semanticMemories: 0,
        proceduralMemories: 0,
        actions: 0,
        actionEdges: 0,
        routines: 0,
        signals: 0,
        checkpoints: 0,
        sentinels: 0,
        sketches: 0,
        crystals: 0,
        facets: 0,
        lessons: 0,
        insights: 0,
        skipped: 0,
        quarantined: validation.quarantine.count,
      };
      const optionalSections = validation.optionalSections;
      const coreSections = validation.sections;

      if (strategy === "replace") {
        // Snapshot everything before the destructive delete so a mid-replace
        // failure can roll back rather than leave the store partially wiped.
        // Observation buckets are enumerated independently of the sessions
        // list (see observationBucketSessionIds) so orphaned buckets clear.
        const existingSessions = await kv.list<Session>(KV.sessions);
        const existingSummaries = await kv.list<SessionSummary>(KV.summaries);
        const snapshot = await snapshotExistingState(
          kv,
          existingSessions,
          existingSummaries,
        );

        // Record the destructive intent BEFORE deleting anything: if the
        // delete pass throws and rollback also fails, the audit log still
        // attests that a replace was attempted and what it would remove.
        const replacedCounts = {
          sessions: snapshot.sessions.length,
          observations: [...snapshot.observations.values()].reduce(
            (sum, bucket) => sum + bucket.length,
            0,
          ),
          memories: snapshot.memories.length,
          summaries: snapshot.summaries.length,
          agentEvents: snapshot.agentEvents.length,
        };
        await recordAudit(kv, "import", "mem::import", [], {
          strategy,
          phase: "replace-pre-delete",
          replacedCounts,
        });

        try {
          await deleteSnapshotState(kv, snapshot);
        } catch (error) {
          try {
            await restoreSnapshotState(kv, snapshot);
          } catch (restoreError) {
            logger.error("Replace rollback failed after delete error", {
              deleteError:
                error instanceof Error ? error.message : String(error),
              restoreError:
                restoreError instanceof Error
                  ? restoreError.message
                  : String(restoreError),
            });
            throw restoreError;
          }
          logger.error("Replace delete failed; existing data restored", {
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false,
            strategy,
            error: `replace import aborted and existing data was restored: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }

      for (const session of coreSections.sessions as Session[]) {
        if (strategy === "skip") {
          const existing = await kv
            .get<Session>(KV.sessions, session.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        await kv.set(KV.sessions, session.id, session);
        stats.sessions++;
      }

      for (const [sessionId, obs] of Object.entries(
        coreSections.observations as ExportData["observations"],
      )) {
        for (const o of obs) {
          if (strategy === "skip") {
            const existing = await kv
              .get<CompressedObservation>(KV.observations(sessionId), o.id)
              .catch(() => null);
            if (existing) {
              stats.skipped++;
              continue;
            }
          }
          await kv.set(KV.observations(sessionId), o.id, o);
          stats.observations++;
        }
      }

      for (const memory of coreSections.memories as Memory[]) {
        if (strategy === "skip") {
          const existing = await kv
            .get<Memory>(KV.memories, memory.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        // Older exports + hand-edited dumps can omit this field.
        if (!Array.isArray(memory.sessionIds)) {
          memory.sessionIds = [];
        }
        await kv.set(KV.memories, memory.id, memory);
        stats.memories++;
      }

      for (const summary of coreSections.summaries as SessionSummary[]) {
        if (strategy === "skip") {
          const existing = await kv
            .get<SessionSummary>(KV.summaries, summary.sessionId)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        await kv.set(KV.summaries, summary.sessionId, summary);
        stats.summaries++;
      }

      const importedMemoryIds = new Set<string>(
        (coreSections.memories as Memory[]).map((memory) => memory.id),
      );

      for (const node of optionalSections.graphNodes as GraphNode[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.graphNodes, node.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.graphNodes, node.id, node);
        stats.graphNodes++;
      }
      for (const edge of optionalSections.graphEdges as GraphEdge[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.graphEdges, edge.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.graphEdges, edge.id, edge);
        stats.graphEdges++;
      }
      for (const sem of optionalSections.semanticMemories as SemanticMemory[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.semantic, sem.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.semantic, sem.id, sem);
        stats.semanticMemories++;
      }
      for (const proc of optionalSections.proceduralMemories as ProceduralMemory[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.procedural, proc.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.procedural, proc.id, proc);
        stats.proceduralMemories++;
      }
      for (const profile of optionalSections.profiles as ProjectProfile[]) {
        if (strategy === "skip") {
          const existing = await kv
            .get<ProjectProfile>(KV.profiles, profile.project)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        await kv.set(KV.profiles, profile.project, profile);
        stats.profiles++;
      }

      for (const action of optionalSections.actions as Action[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.actions, action.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.actions, action.id, action);
        stats.actions++;
      }
      for (const edge of optionalSections.actionEdges as ActionEdge[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.actionEdges, edge.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.actionEdges, edge.id, edge);
        stats.actionEdges++;
      }
      for (const routine of optionalSections.routines as Routine[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.routines, routine.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.routines, routine.id, routine);
        stats.routines++;
      }
      for (const signal of optionalSections.signals as Signal[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.signals, signal.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.signals, signal.id, signal);
        stats.signals++;
      }
      for (const checkpoint of optionalSections.checkpoints as Checkpoint[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.checkpoints, checkpoint.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.checkpoints, checkpoint.id, checkpoint);
        stats.checkpoints++;
      }
      for (const sentinel of optionalSections.sentinels as Sentinel[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.sentinels, sentinel.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.sentinels, sentinel.id, sentinel);
        stats.sentinels++;
      }
      for (const sketch of optionalSections.sketches as Sketch[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.sketches, sketch.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.sketches, sketch.id, sketch);
        stats.sketches++;
      }
      for (const crystal of optionalSections.crystals as Crystal[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.crystals, crystal.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.crystals, crystal.id, crystal);
        stats.crystals++;
      }
      for (const facet of optionalSections.facets as Facet[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.facets, facet.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.facets, facet.id, facet);
        stats.facets++;
      }
      for (const lesson of optionalSections.lessons as Lesson[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.lessons, lesson.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.lessons, lesson.id, lesson);
        stats.lessons++;
      }
      for (const insight of optionalSections.insights as Insight[]) {
        if (strategy === "skip") {
          const existing = await kv.get(KV.insights, insight.id).catch(() => null);
          if (existing) { stats.skipped++; continue; }
        }
        await kv.set(KV.insights, insight.id, insight);
        stats.insights++;
      }
      for (const raw of optionalSections.accessLogs as AccessLogExport[]) {
        const log = normalizeAccessLog(raw);
        if (!log.memoryId || !importedMemoryIds.has(log.memoryId)) continue;
        if (strategy === "skip") {
          const existing = await kv
            .get(KV.accessLog, log.memoryId)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        await kv.set(KV.accessLog, log.memoryId, log);
        stats.accessLogs++;
      }
      for (const revision of optionalSections.memoryHistory as MemoryRevision[]) {
        if (!revision?.id || !revision.memoryId) continue;
        if (!importedMemoryIds.has(revision.memoryId)) continue;
        if (strategy === "skip") {
          const existing = await kv
            .get(KV.memoryHistory, revision.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        await kv.set(KV.memoryHistory, revision.id, revision);
        stats.memoryHistory++;
      }
      for (const event of validation.agentEvents) {
        if (strategy === "skip") {
          const existing = await kv
            .get(KV.agentEvents, event.id)
            .catch(() => null);
          if (existing) {
            stats.skipped++;
            continue;
          }
        }
        try {
          await recordAgentEvent(kv, { ...(event as AgentEventInput), preserveId: true });
          stats.agentEvents++;
        } catch {
          stats.skipped++;
        }
      }

      logger.info("Import complete", { strategy, ...stats });
      await recordAudit(kv, "import", "mem::import", [], {
        strategy,
        stats,
      });
      return {
        success: true,
        dryRun: false,
        strategy,
        ...stats,
        plan: importPlan,
        quarantine: validation.quarantine,
        integrity: validation.integrity,
      };
    },
  );
}
