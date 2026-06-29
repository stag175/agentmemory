import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { AgentEvent, AgentEventType } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  redactOptionalString,
  redactStringArray,
  scanPrivateData,
  summarizePrivacyScans,
  type PrivacyScanSummary,
} from "./privacy.js";
import { logger } from "../logger.js";
import { getAutomaticCaptureControl } from "../config.js";

const AGENT_EVENT_TYPES: AgentEventType[] = [
  "session_started",
  "session_ended",
  "observation_recorded",
  "memory_written",
  "memory_superseded",
  "memory_updated",
  "memory_expired",
  "memory_archived",
  "memory_restored",
  "memory_tombstoned",
  "memory_deleted",
  "memory_forgotten",
  "signal_sent",
  "signal_read",
  "handoff_sent",
  "tool_requested",
  "tool_completed",
  "tool_failed",
  "handoff_accepted",
  "handoff_rejected",
  "handoff_completed",
  "checkpoint_created",
  "checkpoint_resolved",
  "eval_recorded",
  "custom",
];

const AGENT_EVENT_TYPE_SET = new Set<AgentEventType>(AGENT_EVENT_TYPES);
const MAX_ARRAY_VALUES = 100;
const MAX_METADATA_CHARS = 12_000;
const MAX_OTEL_ATTRIBUTE_STRING_CHARS = 2_048;
const MAX_OTEL_ATTRIBUTE_ARRAY_VALUES = 50;
const MAX_OTEL_METADATA_ATTRIBUTES = 50;
const AUTOMATIC_HOOK_TYPES = new Set([
  "notification",
  "post_tool_failure",
  "post_tool_use",
  "prompt_submit",
  "session_end",
  "session_start",
  "stop",
  "subagent_start",
  "subagent_stop",
  "task_completed",
]);
const AUTOMATIC_HOOK_MARKER_VALUES = new Set(["automatic_hook", "hook"]);
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;
const SPAN_ID_RE = /^[0-9a-f]{16}$/i;
const AGENT_EVENT_INDEX_FIELDS = [
  "type",
  "sessionId",
  "project",
  "agentId",
  "fromAgentId",
  "toAgentId",
  "functionId",
  "targetId",
  "observationId",
  "memoryId",
  "signalId",
  "correlationId",
  "parentEventId",
] as const;

type AgentEventIndexField = (typeof AGENT_EVENT_INDEX_FIELDS)[number];

type AgentEventIndexEntry = {
  eventIds: string[];
  updatedAt: string;
};

export type AgentEventExportFormat = "otel";

export type OtelAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

export type AgentEventOtelSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: string;
  end: string;
  attributes: Record<string, OtelAttributeValue>;
};

export type AgentEventInput = {
  id?: string;
  preserveId?: boolean;
  type: AgentEventType;
  timestamp?: string;
  sessionId?: string;
  project?: string;
  cwd?: string;
  agentId?: string;
  framework?: string;
  nativeId?: string;
  traceId?: string;
  runId?: string;
  teamId?: string;
  taskId?: string;
  toolCallId?: string;
  functionId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  handoffFrom?: string;
  handoffTo?: string;
  parentEventId?: string;
  correlationId?: string;
  status?: AgentEvent["status"];
  targetIds?: string[];
  observationIds?: string[];
  memoryIds?: string[];
  signalIds?: string[];
  actionIds?: string[];
  artifactIds?: string[];
  commitShas?: string[];
  evalId?: string;
  checkpointId?: string;
  usage?: AgentEvent["usage"];
  cost?: AgentEvent["cost"];
  metadata?: Record<string, unknown>;
};

export type AgentEventListFilter = {
  format?: AgentEventExportFormat;
  type?: AgentEventType;
  sessionId?: string;
  project?: string;
  agentId?: string;
  fromAgentId?: string;
  toAgentId?: string;
  functionId?: string;
  targetId?: string;
  observationId?: string;
  memoryId?: string;
  signalId?: string;
  correlationId?: string;
  parentEventId?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
};

function metadataHookType(metadata: AgentEventInput["metadata"]): string | undefined {
  const hookType = metadata?.hookType;
  return typeof hookType === "string" && hookType.trim().length > 0
    ? hookType.trim()
    : undefined;
}

function metadataString(
  metadata: AgentEventInput["metadata"],
  field: string,
): string | undefined {
  const value = metadata?.[field];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function hasAutomaticHookMarker(metadata: AgentEventInput["metadata"]): boolean {
  const marker =
    metadataString(metadata, "captureSource") ??
    metadataString(metadata, "origin") ??
    metadataString(metadata, "source");
  return marker !== undefined && AUTOMATIC_HOOK_MARKER_VALUES.has(marker);
}

function isLegacyAutomaticHookEvent(
  input: AgentEventInput,
  hookType: string,
): boolean {
  if (hookType === "post_tool_use") {
    return (
      input.type === "tool_completed" &&
      input.status === "ok" &&
      typeof input.functionId === "string" &&
      input.functionId.startsWith("tool:")
    );
  }
  if (hookType === "post_tool_failure") {
    return (
      input.type === "tool_failed" &&
      input.status === "error" &&
      typeof input.functionId === "string" &&
      input.functionId.startsWith("tool:")
    );
  }
  if (hookType === "stop") {
    return (
      input.type === "custom" &&
      input.status === "ok" &&
      input.functionId === "plugin::stop"
    );
  }
  if (hookType === "subagent_start") {
    return (
      input.type === "custom" &&
      input.status === "pending" &&
      input.functionId === "plugin::subagent_start"
    );
  }
  return false;
}

function isAutomaticHookAgentEvent(input: AgentEventInput): boolean {
  const hookType = metadataHookType(input.metadata);
  if (!hookType || !AUTOMATIC_HOOK_TYPES.has(hookType)) return false;
  return (
    hasAutomaticHookMarker(input.metadata) ||
    isLegacyAutomaticHookEvent(input, hookType)
  );
}

export function getAutomaticAgentEventCaptureSkip(
  input: AgentEventInput,
): { reason?: string; source?: string } | undefined {
  if (input.preserveId === true) return undefined;
  if (!isAutomaticHookAgentEvent(input)) return undefined;
  const control = getAutomaticCaptureControl();
  if (control.enabled) return undefined;
  return { reason: control.reason, source: control.source };
}

function indexKey(field: AgentEventIndexField, value: string): string {
  return `${field}:${encodeURIComponent(value)}`;
}

function normalizeIndexEntry(value: unknown): AgentEventIndexEntry {
  if (Array.isArray(value)) {
    return {
      eventIds: [...new Set(value.filter((id): id is string => typeof id === "string"))],
      updatedAt: new Date(0).toISOString(),
    };
  }
  if (!value || typeof value !== "object") {
    return { eventIds: [], updatedAt: new Date(0).toISOString() };
  }
  const candidate = value as { eventIds?: unknown; updatedAt?: unknown };
  return {
    eventIds: Array.isArray(candidate.eventIds)
      ? [
          ...new Set(
            candidate.eventIds.filter((id): id is string => typeof id === "string"),
          ),
        ]
      : [],
    updatedAt:
      typeof candidate.updatedAt === "string"
        ? candidate.updatedAt
        : new Date(0).toISOString(),
  };
}

function eventIndexValues(event: AgentEvent, field: AgentEventIndexField): string[] {
  switch (field) {
    case "type":
      return [event.type];
    case "sessionId":
      return event.sessionId ? [event.sessionId] : [];
    case "project":
      return event.project ? [event.project] : [];
    case "agentId":
      return event.agentId ? [event.agentId] : [];
    case "fromAgentId":
      return event.fromAgentId ? [event.fromAgentId] : [];
    case "toAgentId":
      return event.toAgentId ? [event.toAgentId] : [];
    case "functionId":
      return event.functionId ? [event.functionId] : [];
    case "targetId":
      return event.targetIds ?? [];
    case "observationId":
      return event.observationIds ?? [];
    case "memoryId":
      return event.memoryIds ?? [];
    case "signalId":
      return event.signalIds ?? [];
    case "correlationId":
      return event.correlationId ? [event.correlationId] : [];
    case "parentEventId":
      return event.parentEventId ? [event.parentEventId] : [];
  }
}

function filterIndexValue(
  filter: AgentEventListFilter,
  field: AgentEventIndexField,
): string | undefined {
  switch (field) {
    case "type":
      return filter.type;
    case "sessionId":
      return filter.sessionId;
    case "project":
      return filter.project;
    case "agentId":
      return filter.agentId;
    case "fromAgentId":
      return filter.fromAgentId;
    case "toAgentId":
      return filter.toAgentId;
    case "functionId":
      return filter.functionId;
    case "targetId":
      return filter.targetId;
    case "observationId":
      return filter.observationId;
    case "memoryId":
      return filter.memoryId;
    case "signalId":
      return filter.signalId;
    case "correlationId":
      return filter.correlationId;
    case "parentEventId":
      return filter.parentEventId;
  }
}

function indexedFilterLookups(
  filter: AgentEventListFilter,
): Array<{ field: AgentEventIndexField; key: string }> {
  return AGENT_EVENT_INDEX_FIELDS.flatMap((field) => {
    const value = filterIndexValue(filter, field);
    return value ? [{ field, key: indexKey(field, value) }] : [];
  });
}

async function indexAgentEvent(kv: StateKV, event: AgentEvent): Promise<void> {
  const updatedAt = new Date().toISOString();
  const pairs = AGENT_EVENT_INDEX_FIELDS.flatMap((field) =>
    eventIndexValues(event, field).map((value) => ({
      field,
      key: indexKey(field, value),
    })),
  );
  const uniquePairs = [
    ...new Map(pairs.map((pair) => [`${pair.field}\0${pair.key}`, pair])).values(),
  ];

  await Promise.all(
    uniquePairs.map(({ key }) =>
      withKeyedLock(`mem:agent-events:index:${key}`, async () => {
        const existing = normalizeIndexEntry(
          await kv.get<AgentEventIndexEntry | string[]>(KV.agentEventIndexes, key),
        );
        if (existing.eventIds.includes(event.id)) return;
        await kv.set<AgentEventIndexEntry>(KV.agentEventIndexes, key, {
          eventIds: [...existing.eventIds, event.id],
          updatedAt,
        });
      }),
    ),
  );
}

function isEventType(value: unknown): value is AgentEventType {
  return typeof value === "string" && AGENT_EVENT_TYPE_SET.has(value as AgentEventType);
}

function safeTimestamp(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(new Date(value).getTime())) {
    return value;
  }
  return new Date().toISOString();
}

function cleanString(value: unknown): { value?: string; scan: PrivacyScanSummary } {
  const redacted = redactOptionalString(value);
  const trimmed = redacted.value?.trim();
  return {
    value: trimmed ? trimmed.slice(0, 512) : undefined,
    scan: redacted.scan,
  };
}

function cleanStringArray(
  values: unknown,
): { values: string[]; scan: PrivacyScanSummary } {
  const raw = Array.isArray(values) ? values.slice(0, MAX_ARRAY_VALUES) : undefined;
  const redacted = redactStringArray(raw);
  return {
    values: redacted.values
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => value.slice(0, 512)),
    scan: redacted.scan,
  };
}

function cleanMetadata(
  metadata: unknown,
): { metadata?: Record<string, unknown>; scan: PrivacyScanSummary } {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      scan: summarizePrivacyScans(),
    };
  }
  try {
    const json = JSON.stringify(metadata);
    if (!json) return { scan: summarizePrivacyScans() };
    const bounded =
      json.length > MAX_METADATA_CHARS
        ? JSON.stringify({
            truncated: true,
            preview: json.slice(0, MAX_METADATA_CHARS),
          })
        : json;
    const scan = scanPrivateData(bounded);
    const parsed = JSON.parse(scan.redacted) as Record<string, unknown>;
    return { metadata: parsed, scan };
  } catch {
    const scan = scanPrivateData(String(metadata));
    return {
      metadata: {
        unparsed: scan.redacted.slice(0, MAX_METADATA_CHARS),
      },
      scan,
    };
  }
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanStatus(value: unknown): AgentEvent["status"] {
  return value === "ok" || value === "error" || value === "pending"
    ? value
    : undefined;
}

function cleanUsage(value: AgentEvent["usage"]): AgentEvent["usage"] {
  if (!value || typeof value !== "object") return undefined;
  const usage = {
    inputTokens: cleanNumber(value.inputTokens),
    outputTokens: cleanNumber(value.outputTokens),
    totalTokens: cleanNumber(value.totalTokens),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : undefined;
}

function cleanCost(value: AgentEvent["cost"]): AgentEvent["cost"] {
  if (!value || typeof value !== "object") return undefined;
  const amount = cleanNumber(value.amount);
  const currency = cleanString(value.currency).value;
  if (amount === undefined && !currency) return undefined;
  return { amount, currency };
}

function hashHex(seed: string, length: 16 | 32): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value);
}

function normalizeTraceId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !TRACE_ID_RE.test(normalized) || isAllZeroHex(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeSpanId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !SPAN_ID_RE.test(normalized) || isAllZeroHex(normalized)) {
    return undefined;
  }
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

function spanIdForSeed(seed: string): string {
  return normalizeSpanId(seed) ?? hashHex(`span:${seed}`, 16);
}

function spanIdForEvent(event: AgentEvent): string {
  return normalizeSpanId(event.nativeId) ?? spanIdForSeed(event.id);
}

function redactAttributeString(value: string): string {
  return scanPrivateData(value).redacted.slice(0, MAX_OTEL_ATTRIBUTE_STRING_CHARS);
}

function stringifyAttributeObject(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json ? redactAttributeString(json) : undefined;
  } catch {
    return redactAttributeString(String(value));
  }
}

function cleanAttributeValue(value: unknown): OtelAttributeValue | undefined {
  if (typeof value === "string") return redactAttributeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_OTEL_ATTRIBUTE_ARRAY_VALUES);
    if (items.every((item) => typeof item === "string")) {
      return items.map((item) => redactAttributeString(item as string));
    }
    if (items.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return items as number[];
    }
    if (items.every((item) => typeof item === "boolean")) {
      return items as boolean[];
    }
    return stringifyAttributeObject(items);
  }
  if (value && typeof value === "object") return stringifyAttributeObject(value);
  return undefined;
}

function setAttribute(
  attributes: Record<string, OtelAttributeValue>,
  key: string,
  value: unknown,
): void {
  const cleaned = cleanAttributeValue(value);
  if (cleaned !== undefined) attributes[key] = cleaned;
}

function metadataAttributeKey(key: string): string {
  const normalized = redactAttributeString(key)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  return normalized || "field";
}

function openInferenceSpanKind(event: AgentEvent): string {
  if (
    event.type === "tool_requested" ||
    event.type === "tool_completed" ||
    event.type === "tool_failed"
  ) {
    return "TOOL";
  }
  return "AGENT";
}

function agentEventSpanName(event: AgentEvent): string {
  return event.functionId ?? `agentmemory.${event.type}`;
}

function appendMetadataAttributes(
  attributes: Record<string, OtelAttributeValue>,
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata) return;
  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= MAX_OTEL_METADATA_ATTRIBUTES) {
      setAttribute(attributes, "agentmemory.metadata.truncated", true);
      return;
    }
    setAttribute(attributes, `agentmemory.metadata.${metadataAttributeKey(key)}`, value);
    count++;
  }
}

function agentEventAttributes(event: AgentEvent): Record<string, OtelAttributeValue> {
  const attributes: Record<string, OtelAttributeValue> = {};
  setAttribute(attributes, "openinference.span.kind", openInferenceSpanKind(event));
  setAttribute(attributes, "agentmemory.event.id", event.id);
  setAttribute(attributes, "agentmemory.event.type", event.type);
  setAttribute(attributes, "agentmemory.project", event.project);
  setAttribute(attributes, "agentmemory.cwd", event.cwd);
  setAttribute(attributes, "agentmemory.agent.id", event.agentId);
  setAttribute(attributes, "agentmemory.framework", event.framework);
  setAttribute(attributes, "agentmemory.native.id", event.nativeId);
  setAttribute(attributes, "agentmemory.run.id", event.runId);
  setAttribute(attributes, "agentmemory.team.id", event.teamId);
  setAttribute(attributes, "agentmemory.task.id", event.taskId);
  setAttribute(attributes, "agentmemory.tool_call.id", event.toolCallId);
  setAttribute(attributes, "agentmemory.function.id", event.functionId);
  setAttribute(attributes, "agentmemory.from_agent.id", event.fromAgentId);
  setAttribute(attributes, "agentmemory.to_agent.id", event.toAgentId);
  setAttribute(attributes, "agentmemory.handoff.from", event.handoffFrom);
  setAttribute(attributes, "agentmemory.handoff.to", event.handoffTo);
  setAttribute(attributes, "agentmemory.parent_event.id", event.parentEventId);
  setAttribute(attributes, "agentmemory.correlation.id", event.correlationId);
  setAttribute(attributes, "agentmemory.status", event.status);
  setAttribute(attributes, "agentmemory.target.ids", event.targetIds);
  setAttribute(attributes, "agentmemory.observation.ids", event.observationIds);
  setAttribute(attributes, "agentmemory.memory.ids", event.memoryIds);
  setAttribute(attributes, "agentmemory.signal.ids", event.signalIds);
  setAttribute(attributes, "agentmemory.action.ids", event.actionIds);
  setAttribute(attributes, "agentmemory.artifact.ids", event.artifactIds);
  setAttribute(attributes, "agentmemory.commit.shas", event.commitShas);
  setAttribute(attributes, "agentmemory.eval.id", event.evalId);
  setAttribute(attributes, "agentmemory.checkpoint.id", event.checkpointId);
  setAttribute(attributes, "agentmemory.redaction.applied", event.redactionApplied);
  setAttribute(attributes, "agentmemory.sensitivity.labels", event.sensitivityLabels);
  setAttribute(attributes, "session.id", event.sessionId);
  setAttribute(attributes, "gen_ai.operation.name", event.functionId ?? event.type);
  setAttribute(attributes, "gen_ai.usage.input_tokens", event.usage?.inputTokens);
  setAttribute(attributes, "gen_ai.usage.output_tokens", event.usage?.outputTokens);
  setAttribute(attributes, "gen_ai.usage.total_tokens", event.usage?.totalTokens);
  setAttribute(attributes, "llm.token_count.prompt", event.usage?.inputTokens);
  setAttribute(attributes, "llm.token_count.completion", event.usage?.outputTokens);
  setAttribute(attributes, "llm.token_count.total", event.usage?.totalTokens);
  setAttribute(attributes, "agentmemory.cost.amount", event.cost?.amount);
  setAttribute(attributes, "agentmemory.cost.currency", event.cost?.currency);
  appendMetadataAttributes(attributes, event.metadata);
  return attributes;
}

export function agentEventsToOtelSpans(events: AgentEvent[]): AgentEventOtelSpan[] {
  return events.map((event) => {
    const parentSpanId = event.parentEventId
      ? spanIdForSeed(event.parentEventId)
      : undefined;
    return {
      traceId: traceIdForEvent(event),
      spanId: spanIdForEvent(event),
      ...(parentSpanId ? { parentSpanId } : {}),
      name: agentEventSpanName(event),
      start: event.timestamp,
      end: event.timestamp,
      attributes: agentEventAttributes(event),
    };
  });
}

function compactEvent(event: AgentEvent): AgentEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([key, value]) => {
      if (key === "targetIds") return true;
      if (value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    }),
  ) as AgentEvent;
}

async function assertAppendOnlyAgentEvent(
  kv: StateKV,
  eventId: string,
): Promise<void> {
  const existing = await kv.get<AgentEvent>(KV.agentEvents, eventId).catch(() => null);
  if (existing) {
    throw new Error(`agent event id already exists: ${eventId}`);
  }
}

export async function recordAgentEvent(
  kv: StateKV,
  input: AgentEventInput,
): Promise<AgentEvent> {
  if (!isEventType(input.type)) {
    throw new Error(`invalid agent event type: ${String(input.type)}`);
  }

  const strings = {
    id: cleanString(input.id),
    sessionId: cleanString(input.sessionId),
    project: cleanString(input.project),
    cwd: cleanString(input.cwd),
    agentId: cleanString(input.agentId),
    framework: cleanString(input.framework),
    nativeId: cleanString(input.nativeId),
    traceId: cleanString(input.traceId),
    runId: cleanString(input.runId),
    teamId: cleanString(input.teamId),
    taskId: cleanString(input.taskId),
    toolCallId: cleanString(input.toolCallId),
    functionId: cleanString(input.functionId),
    fromAgentId: cleanString(input.fromAgentId),
    toAgentId: cleanString(input.toAgentId),
    handoffFrom: cleanString(input.handoffFrom),
    handoffTo: cleanString(input.handoffTo),
    parentEventId: cleanString(input.parentEventId),
    correlationId: cleanString(input.correlationId),
    evalId: cleanString(input.evalId),
    checkpointId: cleanString(input.checkpointId),
  };

  const arrays = {
    targetIds: cleanStringArray(input.targetIds),
    observationIds: cleanStringArray(input.observationIds),
    memoryIds: cleanStringArray(input.memoryIds),
    signalIds: cleanStringArray(input.signalIds),
    actionIds: cleanStringArray(input.actionIds),
    artifactIds: cleanStringArray(input.artifactIds),
    commitShas: cleanStringArray(input.commitShas),
  };

  const metadata = cleanMetadata(input.metadata);
  const privacy = summarizePrivacyScans(
    ...Object.values(strings).map((field) => field.scan),
    ...Object.values(arrays).map((field) => field.scan),
    metadata.scan,
  );

  const eventId = input.preserveId && strings.id.value ? strings.id.value : generateId("agevt");
  const existingEvent = await kv.get<AgentEvent>(KV.agentEvents, eventId).catch(() => null);
  if (existingEvent) {
    throw new Error(`agent event id already exists: ${eventId}`);
  }

  const event: AgentEvent = compactEvent({
    id: eventId,
    timestamp: safeTimestamp(input.timestamp),
    type: input.type,
    sessionId: strings.sessionId.value,
    project: strings.project.value,
    cwd: strings.cwd.value,
    agentId: strings.agentId.value,
    framework: strings.framework.value,
    nativeId: strings.nativeId.value,
    traceId: strings.traceId.value,
    runId: strings.runId.value,
    teamId: strings.teamId.value,
    taskId: strings.taskId.value,
    toolCallId: strings.toolCallId.value,
    functionId: strings.functionId.value,
    fromAgentId: strings.fromAgentId.value,
    toAgentId: strings.toAgentId.value,
    handoffFrom: strings.handoffFrom.value,
    handoffTo: strings.handoffTo.value,
    parentEventId: strings.parentEventId.value,
    correlationId: strings.correlationId.value,
    status: cleanStatus(input.status),
    targetIds: arrays.targetIds.values,
    observationIds: arrays.observationIds.values,
    memoryIds: arrays.memoryIds.values,
    signalIds: arrays.signalIds.values,
    actionIds: arrays.actionIds.values,
    artifactIds: arrays.artifactIds.values,
    commitShas: arrays.commitShas.values,
    evalId: strings.evalId.value,
    checkpointId: strings.checkpointId.value,
    usage: cleanUsage(input.usage),
    cost: cleanCost(input.cost),
    metadata: metadata.metadata,
    redactionApplied: privacy.redactionApplied || undefined,
    sensitivityLabels: privacy.labels.length > 0 ? privacy.labels : undefined,
  });

  await withKeyedLock(`mem:agent-events:event:${event.id}`, async () => {
    await assertAppendOnlyAgentEvent(kv, event.id);
    await kv.set(KV.agentEvents, event.id, event);
    await indexAgentEvent(kv, event);
  });
  return event;
}

export async function safeRecordAgentEvent(
  kv: StateKV,
  input: AgentEventInput,
): Promise<void> {
  try {
    await recordAgentEvent(kv, input);
  } catch (err) {
    try {
      logger.warn("agent event write failed", {
        type: input.type,
        functionId: input.functionId,
        targetIds: input.targetIds ?? [],
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function listAgentEvents(
  kv: StateKV,
  filter: AgentEventListFilter = {},
): Promise<{
  events: AgentEvent[];
  total: number;
  offset: number;
  limit: number;
}> {
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 1000));
  const offset = Math.max(0, filter.offset ?? 0);
  const from = filter.dateFrom ? new Date(filter.dateFrom).getTime() : undefined;
  const to = filter.dateTo ? new Date(filter.dateTo).getTime() : undefined;

  let events = await preselectAgentEvents(kv, filter);
  if (filter.type) events = events.filter((event) => event.type === filter.type);
  if (filter.sessionId) events = events.filter((event) => event.sessionId === filter.sessionId);
  if (filter.project) events = events.filter((event) => event.project === filter.project);
  if (filter.agentId) events = events.filter((event) => event.agentId === filter.agentId);
  if (filter.fromAgentId) {
    events = events.filter((event) => event.fromAgentId === filter.fromAgentId);
  }
  if (filter.toAgentId) events = events.filter((event) => event.toAgentId === filter.toAgentId);
  if (filter.functionId) events = events.filter((event) => event.functionId === filter.functionId);
  if (filter.correlationId) {
    events = events.filter((event) => event.correlationId === filter.correlationId);
  }
  if (filter.parentEventId) {
    events = events.filter((event) => event.parentEventId === filter.parentEventId);
  }
  if (filter.targetId) {
    events = events.filter((event) => (event.targetIds ?? []).includes(filter.targetId!));
  }
  if (filter.observationId) {
    events = events.filter((event) => event.observationIds?.includes(filter.observationId!) === true);
  }
  if (filter.memoryId) {
    events = events.filter((event) => event.memoryIds?.includes(filter.memoryId!) === true);
  }
  if (filter.signalId) {
    events = events.filter((event) => event.signalIds?.includes(filter.signalId!) === true);
  }
  if (from !== undefined && !Number.isNaN(from)) {
    events = events.filter((event) => new Date(event.timestamp).getTime() >= from);
  }
  if (to !== undefined && !Number.isNaN(to)) {
    events = events.filter((event) => new Date(event.timestamp).getTime() <= to);
  }

  events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return {
    events: events.slice(offset, offset + limit),
    total: events.length,
    offset,
    limit,
  };
}

async function preselectAgentEvents(
  kv: StateKV,
  filter: AgentEventListFilter,
): Promise<AgentEvent[]> {
  const lookups = indexedFilterLookups(filter);
  if (lookups.length === 0) {
    return kv.list<AgentEvent>(KV.agentEvents).catch(() => []);
  }

  const rows = await Promise.all(
    lookups.map(async ({ field, key }) => ({
      field,
      key,
      eventIds: normalizeIndexEntry(
        await kv.get<AgentEventIndexEntry | string[]>(KV.agentEventIndexes, key).catch(() => null),
      ).eventIds,
    })),
  );
  const narrowest = rows
    .filter((row) => row.eventIds.length > 0)
    .sort((a, b) => a.eventIds.length - b.eventIds.length)[0];

  if (!narrowest) return [];

  const events = await Promise.all(
    narrowest.eventIds.map((id) =>
      kv.get<AgentEvent>(KV.agentEvents, id).catch(() => null),
    ),
  );
  return events.filter((event): event is AgentEvent => event !== null);
}

export function registerAgentEventFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::agent-event-record", async (data: AgentEventInput) => {
    if (!data || typeof data !== "object") {
      return { success: false, error: "agent event payload is required" };
    }
    if (!isEventType(data.type)) {
      return { success: false, error: "valid event type is required" };
    }
    const skip = getAutomaticAgentEventCaptureSkip(data);
    if (skip) {
      return {
        success: true,
        skipped: true,
        reason: skip.reason,
        source: skip.source,
      };
    }
    try {
      const event = await recordAgentEvent(kv, data);
      return { success: true, event };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  sdk.registerFunction("mem::agent-event-list", async (data?: AgentEventListFilter) => {
    if (data?.type && !isEventType(data.type)) {
      return { success: false, error: "invalid event type" };
    }
    if (data?.format !== undefined && data.format !== "otel") {
      return { success: false, error: "format must be one of: otel" };
    }
    const result = await listAgentEvents(kv, data ?? {});
    if (data?.format === "otel") {
      return {
        success: true,
        format: "otel",
        spans: agentEventsToOtelSpans(result.events),
        total: result.total,
        offset: result.offset,
        limit: result.limit,
      };
    }
    return { success: true, ...result };
  });
}
