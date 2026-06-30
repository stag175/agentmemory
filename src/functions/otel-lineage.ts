import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { AgentEvent } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId } from "../state/schema.js";
import { recordAudit } from "./audit.js";
import { scanPrivateData } from "./privacy.js";

export const OTEL_LINEAGE_STAGING_SCOPE = "mem:otel-lineage:staging";
export const OTEL_LINEAGE_SCHEMA = "agentmemory.otel-lineage";
export const OTEL_LINEAGE_SCHEMA_VERSION = 1;

const HASH_ALGORITHM = "sha256" as const;
const MAX_EXPORT_EVENTS = 10_000;
const MAX_IMPORT_SPANS = 1_000;
const MAX_IMPORT_PAYLOAD_BYTES = 1_000_000;
const MAX_SPAN_BYTES = 64_000;
const MAX_ATTRIBUTE_COUNT = 120;
const MAX_ATTRIBUTE_STRING_CHARS = 2_048;
const MAX_ATTRIBUTE_ARRAY_VALUES = 50;
const MAX_SPAN_NAME_CHARS = 256;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export type OtelLineageAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

export type OtelLineageSpanStatus = {
  code: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR";
  message?: string;
};

export type OtelLineageSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "SPAN_KIND_INTERNAL" | "SPAN_KIND_CLIENT";
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, OtelLineageAttributeValue>;
  status: OtelLineageSpanStatus;
};

export type OtelLineageStagedSpan = {
  id: string;
  importedAt: string;
  stagingScope: typeof OTEL_LINEAGE_STAGING_SCOPE;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  spanHash: string;
  sourceHash?: string;
  batchHash: string;
  nativeIds: {
    eventId?: string;
    nativeId?: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  provenance: {
    source: string;
    schema: typeof OTEL_LINEAGE_SCHEMA;
    schemaVersion: typeof OTEL_LINEAGE_SCHEMA_VERSION;
    hashAlgorithm: typeof HASH_ALGORITHM;
    sourceHash?: string;
    batchHash: string;
  };
  span: OtelLineageSpan;
};

export type OtelLineageExportInput = {
  events?: AgentEvent[];
  eventIds?: string[];
  project?: string;
  sessionId?: string;
  limit?: number;
};

export type OtelLineageExportResult = {
  success: true;
  schema: typeof OTEL_LINEAGE_SCHEMA;
  schemaVersion: typeof OTEL_LINEAGE_SCHEMA_VERSION;
  format: "otel-openinference";
  exportedAt: string;
  hashAlgorithm: typeof HASH_ALGORITHM;
  contentHash: string;
  spans: OtelLineageSpan[];
  total: number;
  skipped: Array<{ id?: string; reason: string }>;
};

export type OtelLineageImportInput = {
  spans?: unknown[];
  source?: string;
};

export type OtelLineageImportResult = {
  success: true;
  schema: typeof OTEL_LINEAGE_SCHEMA;
  schemaVersion: typeof OTEL_LINEAGE_SCHEMA_VERSION;
  format: "otel-openinference";
  importedAt: string;
  stagingScope: typeof OTEL_LINEAGE_STAGING_SCOPE;
  imported: number;
  batchHash: string;
  staged: OtelLineageStagedSpan[];
};

type OtelLineageFunctionError = {
  success: false;
  error: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableValue(entryValue)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hashValue(value: unknown): string {
  return createHash(HASH_ALGORITHM).update(stableJson(value)).digest("hex");
}

function hashHex(seed: string, length: 16 | 32): string {
  return createHash(HASH_ALGORITHM).update(seed).digest("hex").slice(0, length);
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value);
}

function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!TRACE_ID_RE.test(normalized) || isAllZeroHex(normalized)) return undefined;
  return normalized;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!SPAN_ID_RE.test(normalized) || isAllZeroHex(normalized)) return undefined;
  return normalized;
}

function traceIdForEvent(event: AgentEvent): string {
  return (
    normalizeTraceId(event.traceId) ??
    hashHex(
      `trace:${event.traceId ?? event.correlationId ?? event.runId ?? event.sessionId ?? event.id}`,
      32,
    )
  );
}

function spanIdForEvent(event: AgentEvent): string {
  return normalizeSpanId(event.nativeId) ?? hashHex(`span:${event.id}`, 16);
}

function unixNanoFromIso(timestamp: string): string {
  const millis = new Date(timestamp).getTime();
  if (Number.isNaN(millis)) return String(BigInt(Date.now()) * 1_000_000n);
  return String(BigInt(millis) * 1_000_000n);
}

function openInferenceSpanKind(event: AgentEvent): "TOOL" | "AGENT" {
  return event.type === "tool_requested" ||
    event.type === "tool_completed" ||
    event.type === "tool_failed"
    ? "TOOL"
    : "AGENT";
}

function spanStatus(event: AgentEvent): OtelLineageSpanStatus {
  if (event.status === "ok") return { code: "STATUS_CODE_OK" };
  if (event.status === "error") return { code: "STATUS_CODE_ERROR" };
  return { code: "STATUS_CODE_UNSET" };
}

function safeString(value: string, maxChars = MAX_ATTRIBUTE_STRING_CHARS): string {
  return scanPrivateData(value).redacted.slice(0, maxChars);
}

const MAX_NESTED_SANITIZE_DEPTH = 6;

function stripRawPayloadSubtrees(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    if (depth >= MAX_NESTED_SANITIZE_DEPTH) return "[truncated]";
    return value
      .slice(0, MAX_ATTRIBUTE_ARRAY_VALUES)
      .map((item) => stripRawPayloadSubtrees(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_NESTED_SANITIZE_DEPTH) return "[truncated]";
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (isRawPayloadKey(key)) continue;
      result[key] = stripRawPayloadSubtrees(entryValue, depth + 1);
    }
    return result;
  }
  return value;
}

function cleanExportAttributeValue(
  value: unknown,
): OtelLineageAttributeValue | undefined {
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ATTRIBUTE_ARRAY_VALUES);
    if (items.every((item) => typeof item === "string")) {
      return items.map((item) => safeString(item as string));
    }
    if (items.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return items as number[];
    }
    if (items.every((item) => typeof item === "boolean")) return items as boolean[];
    return safeString(stableJson(stripRawPayloadSubtrees(items)));
  }
  if (value && typeof value === "object") {
    return safeString(stableJson(stripRawPayloadSubtrees(value)));
  }
  return undefined;
}

function setExportAttribute(
  attributes: Record<string, OtelLineageAttributeValue>,
  key: string,
  value: unknown,
): void {
  const cleaned = cleanExportAttributeValue(value);
  if (cleaned !== undefined) attributes[key] = cleaned;
}

function safeAttributeKey(key: string): string {
  return safeString(key, 80).replace(/[^A-Za-z0-9_.-]/g, "_") || "field";
}

function isRawPayloadKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (
    lower.includes("input_tokens") ||
    lower.includes("output_tokens") ||
    lower.includes("total_tokens") ||
    lower.includes("token_count")
  ) {
    return false;
  }
  const segments = lower.split(/[._:-]/).filter(Boolean);
  if (
    segments.some((segment) =>
      [
        "payload",
        "raw",
        "body",
        "content",
        "message",
        "messages",
        "prompt",
        "completion",
        "transcript",
        "attachment",
        "attachments",
      ].includes(segment),
    )
  ) {
    return true;
  }
  return [
    "input.value",
    "output.value",
    "llm.input_messages",
    "llm.output_messages",
    "tool.parameters",
    "tool.output",
    "tool.result",
  ].some((needle) => lower.includes(needle));
}

function appendExportMetadata(
  attributes: Record<string, OtelLineageAttributeValue>,
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  let included = 0;
  let omitted = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (included >= MAX_ATTRIBUTE_COUNT) {
      omitted++;
      continue;
    }
    if (isRawPayloadKey(key)) {
      omitted++;
      continue;
    }
    const before = Object.keys(attributes).length;
    setExportAttribute(attributes, `agentmemory.metadata.${safeAttributeKey(key)}`, value);
    if (Object.keys(attributes).length > before) included++;
  }
  if (omitted > 0) {
    setExportAttribute(attributes, "agentmemory.metadata.omitted_count", omitted);
  }
}

function eventAttributes(
  event: AgentEvent,
  exportedAt: string,
): Record<string, OtelLineageAttributeValue> {
  const eventHash = hashValue(event);
  const attributes: Record<string, OtelLineageAttributeValue> = {};
  setExportAttribute(attributes, "openinference.span.kind", openInferenceSpanKind(event));
  setExportAttribute(attributes, "agentmemory.event.id", event.id);
  setExportAttribute(attributes, "agentmemory.event.type", event.type);
  setExportAttribute(attributes, "agentmemory.event.hash", eventHash);
  setExportAttribute(attributes, "agentmemory.project", event.project);
  setExportAttribute(attributes, "agentmemory.cwd", event.cwd);
  setExportAttribute(attributes, "agentmemory.agent.id", event.agentId);
  setExportAttribute(attributes, "agentmemory.framework", event.framework);
  setExportAttribute(attributes, "agentmemory.native.id", event.nativeId);
  setExportAttribute(attributes, "agentmemory.run.id", event.runId);
  setExportAttribute(attributes, "agentmemory.team.id", event.teamId);
  setExportAttribute(attributes, "agentmemory.task.id", event.taskId);
  setExportAttribute(attributes, "agentmemory.tool_call.id", event.toolCallId);
  setExportAttribute(attributes, "agentmemory.function.id", event.functionId);
  setExportAttribute(attributes, "agentmemory.from_agent.id", event.fromAgentId);
  setExportAttribute(attributes, "agentmemory.to_agent.id", event.toAgentId);
  setExportAttribute(attributes, "agentmemory.parent_event.id", event.parentEventId);
  setExportAttribute(attributes, "agentmemory.correlation.id", event.correlationId);
  setExportAttribute(attributes, "agentmemory.status", event.status);
  setExportAttribute(attributes, "agentmemory.target.ids", event.targetIds);
  setExportAttribute(attributes, "agentmemory.observation.ids", event.observationIds);
  setExportAttribute(attributes, "agentmemory.memory.ids", event.memoryIds);
  setExportAttribute(attributes, "agentmemory.signal.ids", event.signalIds);
  setExportAttribute(attributes, "agentmemory.action.ids", event.actionIds);
  setExportAttribute(attributes, "agentmemory.artifact.ids", event.artifactIds);
  setExportAttribute(attributes, "agentmemory.commit.shas", event.commitShas);
  setExportAttribute(attributes, "agentmemory.eval.id", event.evalId);
  setExportAttribute(attributes, "agentmemory.checkpoint.id", event.checkpointId);
  setExportAttribute(attributes, "agentmemory.provenance.source", "agentmemory.agent_event");
  setExportAttribute(attributes, "agentmemory.provenance.schema", OTEL_LINEAGE_SCHEMA);
  setExportAttribute(attributes, "agentmemory.provenance.schema_version", OTEL_LINEAGE_SCHEMA_VERSION);
  setExportAttribute(attributes, "agentmemory.provenance.hash_algorithm", HASH_ALGORITHM);
  setExportAttribute(attributes, "agentmemory.provenance.exported_at", exportedAt);
  setExportAttribute(attributes, "session.id", event.sessionId);
  setExportAttribute(attributes, "gen_ai.operation.name", event.functionId ?? event.type);
  setExportAttribute(attributes, "gen_ai.usage.input_tokens", event.usage?.inputTokens);
  setExportAttribute(attributes, "gen_ai.usage.output_tokens", event.usage?.outputTokens);
  setExportAttribute(attributes, "gen_ai.usage.total_tokens", event.usage?.totalTokens);
  setExportAttribute(attributes, "llm.token_count.prompt", event.usage?.inputTokens);
  setExportAttribute(attributes, "llm.token_count.completion", event.usage?.outputTokens);
  setExportAttribute(attributes, "llm.token_count.total", event.usage?.totalTokens);
  setExportAttribute(attributes, "agentmemory.cost.amount", event.cost?.amount);
  setExportAttribute(attributes, "agentmemory.cost.currency", event.cost?.currency);
  appendExportMetadata(attributes, event.metadata);
  return attributes;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["timestamp"] === "string" &&
    typeof value["type"] === "string" &&
    Array.isArray(value["targetIds"]) &&
    (value["targetIds"] as unknown[]).every((item) => typeof item === "string")
  );
}

function matchesExportFilter(event: AgentEvent, input: OtelLineageExportInput): boolean {
  if (input.eventIds && !input.eventIds.includes(event.id)) return false;
  if (input.project && event.project !== input.project) return false;
  if (input.sessionId && event.sessionId !== input.sessionId) return false;
  return true;
}

export function agentEventsToOtelLineageSpans(
  events: AgentEvent[],
  exportedAt = new Date().toISOString(),
): { spans: OtelLineageSpan[]; skipped: Array<{ id?: string; reason: string }> } {
  const spanIdsByEventId = new Map(
    events.filter(isAgentEvent).map((event) => [event.id, spanIdForEvent(event)]),
  );
  const spans: OtelLineageSpan[] = [];
  const skipped: Array<{ id?: string; reason: string }> = [];

  for (const event of events) {
    if (!isAgentEvent(event)) {
      skipped.push({ reason: "invalid_agent_event" });
      continue;
    }
    if (jsonSize(event) > MAX_SPAN_BYTES) {
      skipped.push({ id: event.id, reason: "agent_event_too_large" });
      continue;
    }
    const spanId = spanIdForEvent(event);
    const parentSpanId = event.parentEventId
      ? spanIdsByEventId.get(event.parentEventId) ?? hashHex(`span:${event.parentEventId}`, 16)
      : undefined;
    const time = unixNanoFromIso(event.timestamp);
    spans.push({
      traceId: traceIdForEvent(event),
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: safeString(event.functionId ?? `agentmemory.${event.type}`, MAX_SPAN_NAME_CHARS),
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: time,
      endTimeUnixNano: time,
      attributes: eventAttributes(event, exportedAt),
      status: spanStatus(event),
    });
  }

  return { spans, skipped };
}

export async function exportOtelLineage(
  kv: StateKV,
  input: OtelLineageExportInput = {},
): Promise<OtelLineageExportResult> {
  const limit = Math.max(1, Math.min(input.limit ?? MAX_EXPORT_EVENTS, MAX_EXPORT_EVENTS));
  const rawEvents = input.events ?? (await kv.list<AgentEvent>(KV.agentEvents).catch(() => []));
  const events = rawEvents.filter((event) => matchesExportFilter(event, input)).slice(0, limit);
  const exportedAt = new Date().toISOString();
  const converted = agentEventsToOtelLineageSpans(events, exportedAt);
  const contentHash = hashValue(converted.spans);
  const targetIds = converted.spans
    .map((span) => span.attributes["agentmemory.event.id"])
    .filter((id): id is string => typeof id === "string");

  await recordAudit(kv, "export", "mem::otel-lineage-export", targetIds, {
    schema: OTEL_LINEAGE_SCHEMA,
    schemaVersion: OTEL_LINEAGE_SCHEMA_VERSION,
    format: "otel-openinference",
    count: converted.spans.length,
    skipped: converted.skipped.length,
    contentHash,
    hashAlgorithm: HASH_ALGORITHM,
  });

  return {
    success: true,
    schema: OTEL_LINEAGE_SCHEMA,
    schemaVersion: OTEL_LINEAGE_SCHEMA_VERSION,
    format: "otel-openinference",
    exportedAt,
    hashAlgorithm: HASH_ALGORITHM,
    contentHash,
    spans: converted.spans,
    total: converted.spans.length,
    skipped: converted.skipped,
  };
}

function getField(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}

function rejectRawOrSecretString(value: string, field: string): string {
  if (value.length > MAX_ATTRIBUTE_STRING_CHARS) {
    throw new Error(`${field} exceeds ${MAX_ATTRIBUTE_STRING_CHARS} characters`);
  }
  const scan = scanPrivateData(value);
  if (scan.redactionApplied) {
    throw new Error(`${field} contains private data`);
  }
  return value;
}

function normalizeOtlpAttributeValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("stringValue" in value) return value["stringValue"];
  if ("intValue" in value) return Number(value["intValue"]);
  if ("doubleValue" in value) return Number(value["doubleValue"]);
  if ("boolValue" in value) return value["boolValue"];
  if (isRecord(value["arrayValue"])) {
    const values = value["arrayValue"]["values"];
    return Array.isArray(values) ? values.map((item) => normalizeOtlpAttributeValue(item)) : [];
  }
  return value;
}

function normalizeAttributeInput(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (isRecord(input)) return input;
  if (Array.isArray(input)) {
    const attributes: Record<string, unknown> = {};
    for (const item of input) {
      if (!isRecord(item) || typeof item["key"] !== "string") {
        throw new Error("span attributes must be a record or OTLP key/value array");
      }
      attributes[item["key"]] = normalizeOtlpAttributeValue(item["value"]);
    }
    return attributes;
  }
  throw new Error("span attributes must be a record or OTLP key/value array");
}

function cleanImportAttributeValue(
  key: string,
  value: unknown,
): OtelLineageAttributeValue | undefined {
  if (isRawPayloadKey(key)) {
    throw new Error(`span attribute ${key} appears to contain raw payload data`);
  }
  if (typeof value === "string") return rejectRawOrSecretString(value, `span attribute ${key}`);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`span attribute ${key} must be finite`);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ATTRIBUTE_ARRAY_VALUES) {
      throw new Error(`span attribute ${key} has too many values`);
    }
    if (value.every((item) => typeof item === "string")) {
      return value.map((item) =>
        rejectRawOrSecretString(item as string, `span attribute ${key}`),
      );
    }
    if (value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return value as number[];
    }
    if (value.every((item) => typeof item === "boolean")) return value as boolean[];
  }
  if (value === undefined || value === null) return undefined;
  throw new Error(`span attribute ${key} must be a primitive OTEL attribute`);
}

function cleanImportAttributes(input: unknown): Record<string, OtelLineageAttributeValue> {
  const raw = normalizeAttributeInput(input);
  const entries = Object.entries(raw);
  if (entries.length > MAX_ATTRIBUTE_COUNT) {
    throw new Error(`span has more than ${MAX_ATTRIBUTE_COUNT} attributes`);
  }
  const attributes: Record<string, OtelLineageAttributeValue> = {};
  for (const [key, value] of entries) {
    const safeKey = safeAttributeKey(key);
    const cleaned = cleanImportAttributeValue(safeKey, value);
    if (cleaned !== undefined) attributes[safeKey] = cleaned;
  }
  return attributes;
}

function normalizeStatus(input: unknown): OtelLineageSpanStatus {
  if (typeof input === "string") {
    if (
      input === "STATUS_CODE_UNSET" ||
      input === "STATUS_CODE_OK" ||
      input === "STATUS_CODE_ERROR"
    ) {
      return { code: input };
    }
    throw new Error("span status code is invalid");
  }
  if (input === undefined) return { code: "STATUS_CODE_UNSET" };
  if (!isRecord(input)) throw new Error("span status must be an object");
  const code = input["code"];
  if (
    code !== "STATUS_CODE_UNSET" &&
    code !== "STATUS_CODE_OK" &&
    code !== "STATUS_CODE_ERROR"
  ) {
    throw new Error("span status code is invalid");
  }
  const message = input["message"];
  return {
    code,
    ...(typeof message === "string"
      ? { message: rejectRawOrSecretString(message, "span status message") }
      : {}),
  };
}

function normalizeUnixNano(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${field} must be a string, number, or bigint`);
  }
  const normalized = String(value);
  if (!/^[0-9]+$/.test(normalized)) throw new Error(`${field} must be unix nanoseconds`);
  return normalized;
}

function stringAttribute(
  attributes: Record<string, OtelLineageAttributeValue>,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeIncomingSpan(
  value: unknown,
  index: number,
  importedAt: string,
  batchHash: string,
  source: string,
): OtelLineageStagedSpan {
  if (!isRecord(value)) throw new Error(`span ${index} must be an object`);
  if (jsonSize(value) > MAX_SPAN_BYTES) throw new Error(`span ${index} is too large`);

  const allowedFields = new Set([
    "traceId",
    "trace_id",
    "spanId",
    "span_id",
    "parentSpanId",
    "parent_span_id",
    "name",
    "kind",
    "startTimeUnixNano",
    "start_time_unix_nano",
    "endTimeUnixNano",
    "end_time_unix_nano",
    "attributes",
    "status",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedFields.has(key)) throw new Error(`span ${index} has unsupported field ${key}`);
  }

  const traceId = normalizeTraceId(getField(value, "traceId", "trace_id"));
  if (!traceId) throw new Error(`span ${index} has invalid traceId`);
  const spanId = normalizeSpanId(getField(value, "spanId", "span_id"));
  if (!spanId) throw new Error(`span ${index} has invalid spanId`);
  const parentSpanId = normalizeSpanId(getField(value, "parentSpanId", "parent_span_id"));
  const nameValue = value["name"];
  if (typeof nameValue !== "string" || nameValue.trim().length === 0) {
    throw new Error(`span ${index} name is required`);
  }
  const name = rejectRawOrSecretString(nameValue.trim(), `span ${index} name`).slice(
    0,
    MAX_SPAN_NAME_CHARS,
  );
  const kind = value["kind"];
  if (
    kind !== undefined &&
    kind !== "SPAN_KIND_INTERNAL" &&
    kind !== "SPAN_KIND_CLIENT"
  ) {
    throw new Error(`span ${index} kind is invalid`);
  }

  const attributes = cleanImportAttributes(value["attributes"]);
  const nowNano = String(BigInt(new Date(importedAt).getTime()) * 1_000_000n);
  const span: OtelLineageSpan = {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: kind === "SPAN_KIND_CLIENT" ? kind : "SPAN_KIND_INTERNAL",
    startTimeUnixNano: normalizeUnixNano(
      getField(value, "startTimeUnixNano", "start_time_unix_nano"),
      nowNano,
      `span ${index} startTimeUnixNano`,
    ),
    endTimeUnixNano: normalizeUnixNano(
      getField(value, "endTimeUnixNano", "end_time_unix_nano"),
      nowNano,
      `span ${index} endTimeUnixNano`,
    ),
    attributes,
    status: normalizeStatus(value["status"]),
  };
  const spanHash = hashValue(span);
  const sourceHash = stringAttribute(attributes, "agentmemory.event.hash");
  if (sourceHash !== undefined && !SHA256_HEX_RE.test(sourceHash)) {
    throw new Error(`span ${index} agentmemory.event.hash must be sha256 hex`);
  }

  return {
    id: fingerprintId("otel", `${traceId}:${spanId}:${spanHash}`),
    importedAt,
    stagingScope: OTEL_LINEAGE_STAGING_SCOPE,
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    spanHash,
    ...(sourceHash ? { sourceHash } : {}),
    batchHash,
    nativeIds: {
      eventId: stringAttribute(attributes, "agentmemory.event.id"),
      nativeId: stringAttribute(attributes, "agentmemory.native.id"),
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
    },
    provenance: {
      source,
      schema: OTEL_LINEAGE_SCHEMA,
      schemaVersion: OTEL_LINEAGE_SCHEMA_VERSION,
      hashAlgorithm: HASH_ALGORITHM,
      ...(sourceHash ? { sourceHash } : {}),
      batchHash,
    },
    span,
  };
}

function normalizeImportSource(source: unknown): string {
  if (source === undefined) return "otel-lineage-import";
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("source must be a non-empty string");
  }
  return rejectRawOrSecretString(source.trim(), "source");
}

function normalizeImportSpans(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (isRecord(input) && Array.isArray(input["spans"])) return input["spans"];
  throw new Error("spans must be an array");
}

export async function importOtelLineage(
  kv: StateKV,
  input: OtelLineageImportInput | unknown[],
): Promise<OtelLineageImportResult> {
  if (jsonSize(input) > MAX_IMPORT_PAYLOAD_BYTES) {
    throw new Error(`otel lineage import payload exceeds ${MAX_IMPORT_PAYLOAD_BYTES} bytes`);
  }
  const spans = normalizeImportSpans(input);
  if (spans.length > MAX_IMPORT_SPANS) {
    throw new Error(`cannot import more than ${MAX_IMPORT_SPANS} spans`);
  }
  const source = isRecord(input)
    ? normalizeImportSource(input["source"])
    : "otel-lineage-import";
  const importedAt = new Date().toISOString();
  const batchHash = hashValue(spans);
  const staged = spans.map((span, index) =>
    sanitizeIncomingSpan(span, index, importedAt, batchHash, source),
  );

  await Promise.all(
    staged.map((record) => kv.set(OTEL_LINEAGE_STAGING_SCOPE, record.id, record)),
  );
  await recordAudit(kv, "import", "mem::otel-lineage-import", staged.map((span) => span.id), {
    schema: OTEL_LINEAGE_SCHEMA,
    schemaVersion: OTEL_LINEAGE_SCHEMA_VERSION,
    format: "otel-openinference",
    count: staged.length,
    stagingScope: OTEL_LINEAGE_STAGING_SCOPE,
    batchHash,
    hashAlgorithm: HASH_ALGORITHM,
    source,
  });

  return {
    success: true,
    schema: OTEL_LINEAGE_SCHEMA,
    schemaVersion: OTEL_LINEAGE_SCHEMA_VERSION,
    format: "otel-openinference",
    importedAt,
    stagingScope: OTEL_LINEAGE_STAGING_SCOPE,
    imported: staged.length,
    batchHash,
    staged,
  };
}

export function registerOtelLineageFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::otel-lineage-export",
    async (
      data?: OtelLineageExportInput,
    ): Promise<OtelLineageExportResult | OtelLineageFunctionError> => {
      try {
        return await exportOtelLineage(kv, data ?? {});
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  sdk.registerFunction(
    "mem::otel-lineage-import",
    async (
      data: OtelLineageImportInput | unknown[],
    ): Promise<OtelLineageImportResult | OtelLineageFunctionError> => {
      try {
        return await importOtelLineage(kv, data);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
