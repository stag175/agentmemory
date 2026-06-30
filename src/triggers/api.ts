import { TriggerAction, type ISdk, type ApiRequest } from "iii-sdk";
import type { Session, CompressedObservation, HookPayload, CommitLink, SessionSummary, SearchMode, RetrievalMode, ComplianceEvidenceInput } from "../types.js";
import type { AgentEventInput, AgentEventListFilter } from "../functions/agent-events.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { getLatestHealth } from "../health/monitor.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import type { ResilientProvider } from "../providers/resilient.js";
import { VERSION } from "../version.js";
import { timingSafeCompare } from "../auth.js";
import { isSlotsEnabled, isReflectEnabled } from "../functions/slots.js";
import { renderViewerDocument } from "../viewer/document.js";
import { getBoundViewerPort, getViewerSkipped } from "../viewer/server.js";
import { MAX_FILES_UPPER_BOUND } from "../functions/replay.js";
import { logger } from "../logger.js";
import { safeRecordAgentEvent } from "../functions/agent-events.js";
import { registerRulesResolverFunction } from "../functions/rules-resolver.js";
import {
  isGraphExtractionEnabled,
  isConsolidationEnabled,
  isAutoCompressEnabled,
  isContextInjectionEnabled,
  detectEmbeddingProvider,
  detectLlmProviderKind,
  getAgentId,
  getAutomaticCaptureControl,
  isAgentScopeIsolated,
} from "../config.js";

type Response = {
  status_code: number;
  headers?: Record<string, string>;
  body: unknown;
};

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

function checkAuth(
  req: ApiRequest,
  secret: string | undefined,
): Response | null {
  if (!secret) return null;
  const auth = req.headers?.["authorization"] || req.headers?.["Authorization"];
  if (
    typeof auth !== "string" ||
    !timingSafeCompare(auth, `Bearer ${secret}`)
  ) {
    return { status_code: 401, body: { error: "unauthorized" } };
  }
  return null;
}

function requireConfiguredSecret(
  secret: string | undefined,
  feature: string,
): Response | null {
  if (secret) return null;
  return {
    status_code: 503,
    body: { error: `${feature} requires AGENTMEMORY_SECRET` },
  };
}

function flagDisabledResponse(opts: {
  error: string;
  flag: string;
  enableHow: string;
  docsHref: string;
}): Response {
  return {
    status_code: 503,
    body: opts,
  };
}

function graphDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Knowledge graph not enabled",
    flag: "GRAPH_EXTRACTION_ENABLED",
    enableHow: "Set GRAPH_EXTRACTION_ENABLED=true and restart. Requires an LLM provider key.",
    docsHref: "https://github.com/rohitg00/agentmemory#knowledge-graph",
  });
}

function consolidationDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Consolidation pipeline not enabled",
    flag: "CONSOLIDATION_ENABLED",
    enableHow: "Set CONSOLIDATION_ENABLED=true and restart. Requires an LLM provider key.",
    docsHref: "https://github.com/rohitg00/agentmemory#consolidation",
  });
}

function slotsDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Memory slots not enabled",
    flag: "AGENTMEMORY_SLOTS",
    enableHow: "Set AGENTMEMORY_SLOTS=true (in ~/.agentmemory/.env or the shell) and restart.",
    docsHref: "https://github.com/rohitg00/agentmemory#memory-slots",
  });
}

function reflectDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Slot reflection not enabled",
    flag: "AGENTMEMORY_REFLECT",
    enableHow: "Set AGENTMEMORY_REFLECT=true (in ~/.agentmemory/.env or the shell) and restart. Requires AGENTMEMORY_SLOTS=true.",
    docsHref: "https://github.com/rohitg00/agentmemory#memory-slots",
  });
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalPositiveInt(value: unknown): number | undefined | null {
  const parsed = parseOptionalFiniteNumber(value);
  if (parsed === undefined || parsed === null) return parsed;
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  }
  return null;
}

function isAutomaticHookRequest(body: Record<string, unknown>): boolean {
  const marker =
    asNonEmptyString(body.captureSource) ??
    asNonEmptyString(body.origin) ??
    asNonEmptyString(body.source);
  return marker === "automatic_hook" || marker === "hook";
}

function automaticCaptureSkipResponse(
  body: Record<string, unknown>,
): Response | undefined {
  if (!isAutomaticHookRequest(body)) return undefined;
  const control = getAutomaticCaptureControl();
  if (control.enabled) return undefined;
  return {
    status_code: 200,
    body: {
      success: true,
      skipped: true,
      reason: control.reason,
      source: control.source,
    },
  };
}

const SEARCH_MODES = new Set<SearchMode>(["fast", "balanced", "deep"]);
const RETRIEVAL_MODES = new Set<RetrievalMode>([
  "basic",
  "local_graph",
  "global_community",
  "drift",
  "as_of",
]);

function parseOptionalSearchMode(value: unknown): SearchMode | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return SEARCH_MODES.has(normalized as SearchMode)
    ? (normalized as SearchMode)
    : null;
}

function parseOptionalRetrievalMode(value: unknown): RetrievalMode | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return RETRIEVAL_MODES.has(normalized as RetrievalMode)
    ? (normalized as RetrievalMode)
    : null;
}

const AGENT_EVENT_STRING_FIELDS = [
  "timestamp",
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

const AGENT_EVENT_ARRAY_FIELDS = [
  "targetIds",
  "observationIds",
  "memoryIds",
  "signalIds",
  "actionIds",
  "artifactIds",
  "commitShas",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickOptionalString(
  body: Record<string, unknown>,
  field: string,
): { value?: string; error?: string } {
  if (body[field] === undefined) return {};
  const value = asNonEmptyString(body[field]);
  if (!value) return { error: `${String(field)} must be a non-empty string` };
  return { value };
}

function pickStringArray(
  body: Record<string, unknown>,
  field: keyof AgentEventInput,
): { value?: string[]; error?: string } {
  const raw = body[field];
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    return { error: `${String(field)} must be an array of strings` };
  }
  return { value: raw };
}

function pickFiniteNumber(
  body: Record<string, unknown>,
  field: string,
): { value?: number; error?: string } {
  const raw = body[field];
  if (raw === undefined) return {};
  const value = parseOptionalFiniteNumber(raw);
  if (value === undefined || value === null) {
    return { error: `${field} must be a finite number` };
  }
  return { value };
}

function pickAgentEventUsage(
  value: unknown,
): { value?: AgentEventInput["usage"]; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) return { error: "usage must be an object" };
  const inputTokens = pickFiniteNumber(value, "inputTokens");
  if (inputTokens.error) return { error: `usage.${inputTokens.error}` };
  const outputTokens = pickFiniteNumber(value, "outputTokens");
  if (outputTokens.error) return { error: `usage.${outputTokens.error}` };
  const totalTokens = pickFiniteNumber(value, "totalTokens");
  if (totalTokens.error) return { error: `usage.${totalTokens.error}` };
  const usage: NonNullable<AgentEventInput["usage"]> = {};
  if (inputTokens.value !== undefined) usage.inputTokens = inputTokens.value;
  if (outputTokens.value !== undefined) usage.outputTokens = outputTokens.value;
  if (totalTokens.value !== undefined) usage.totalTokens = totalTokens.value;
  return Object.keys(usage).length > 0 ? { value: usage } : {};
}

function pickAgentEventCost(
  value: unknown,
): { value?: AgentEventInput["cost"]; error?: string } {
  if (value === undefined) return {};
  if (!isRecord(value)) return { error: "cost must be an object" };
  const amount = pickFiniteNumber(value, "amount");
  if (amount.error) return { error: `cost.${amount.error}` };
  const currency = pickOptionalString(value, "currency");
  if (currency.error) return { error: `cost.${currency.error}` };
  const cost: NonNullable<AgentEventInput["cost"]> = {};
  if (amount.value !== undefined) cost.amount = amount.value;
  if (currency.value !== undefined) cost.currency = currency.value;
  return Object.keys(cost).length > 0 ? { value: cost } : {};
}

function buildAgentEventInput(
  body: Record<string, unknown>,
): { input?: AgentEventInput; error?: string } {
  const type = asNonEmptyString(body.type);
  if (!type) return { error: "type is required" };

  const input: AgentEventInput = { type: type as AgentEventInput["type"] };
  for (const field of AGENT_EVENT_STRING_FIELDS) {
    const picked = pickOptionalString(body, field);
    if (picked.error) return { error: picked.error };
    if (picked.value !== undefined) {
      (input as Record<string, unknown>)[field] = picked.value;
    }
  }

  const status = pickOptionalString(body, "status");
  if (status.error) return { error: status.error };
  if (status.value !== undefined) {
    if (!["ok", "error", "pending"].includes(status.value)) {
      return { error: "status must be one of: ok, error, pending" };
    }
    input.status = status.value as AgentEventInput["status"];
  }

  for (const field of AGENT_EVENT_ARRAY_FIELDS) {
    const picked = pickStringArray(body, field);
    if (picked.error) return { error: picked.error };
    if (picked.value !== undefined) {
      (input as Record<string, unknown>)[field] = picked.value;
    }
  }

  const usage = pickAgentEventUsage(body.usage);
  if (usage.error) return { error: usage.error };
  if (usage.value !== undefined) input.usage = usage.value;

  const cost = pickAgentEventCost(body.cost);
  if (cost.error) return { error: cost.error };
  if (cost.value !== undefined) input.cost = cost.value;

  if (body.metadata !== undefined) {
    if (!isRecord(body.metadata)) return { error: "metadata must be an object" };
    input.metadata = body.metadata;
  }

  return { input };
}

const RULES_RESOLVE_FIELDS = [
  "workspaceRoot",
  "root",
  "cwd",
  "instructionGlobs",
  "ignoreDirectories",
  "maxDepth",
  "maxBytes",
  "maxFileBytes",
  "includeContent",
] as const;
// Authorization-bearing fields are deliberately EXCLUDED from this whitelist
// (no permissions/roles/roleGrants/teamPolicy/auth/access/actor/requestContext,
// and actorId is NOT trusted as authz). The principal is resolved server-side
// from the authenticated operator credential — see resolveMemoryProposalPrincipal
// — so a request body can never self-grant. Only proposal-content / lookup
// fields belong here.
const MEMORY_PROPOSAL_FIELDS = [
  "teamId",
  "proposalId",
  "project",
  "action",
  "status",
  "title",
  "reason",
  "change",
  "provenance",
  "targetMemoryId",
  "limit",
  "offset",
  "requestedBy",
] as const;
const SYNC_CONTROL_PLANE_FIELDS = [
  "peerId",
  "workspaceId",
  "name",
  "mode",
  "endpoint",
  "enabled",
  "authPolicy",
  "scopePolicy",
  "workspaceRoot",
  "localOnly",
  "allowedScopes",
  "labels",
  "direction",
  "scopes",
  "dryRun",
  "planId",
  "status",
  "startedAt",
  "endedAt",
  "itemCounts",
  "errors",
  "evidence",
  "approved",
  "conflictPolicy",
  "exportData",
  "snapshot",
  "source",
  "limit",
  "offset",
] as const;
// Sync recovery (item 6): set-status only toggles a peer's enabled flag and
// recovers a peer an untrusted run marked blocked. Only peerId + enabled are
// accepted from the body.
const SYNC_PEER_SET_STATUS_FIELDS = ["peerId", "enabled"] as const;
// Audit-chain REST exposure (item 3). Pagination + filter fields shared by both
// the read (mem::audit-chain) and verify (mem::audit-chain-verify) endpoints.
const AUDIT_CHAIN_FIELDS = [
  "offset",
  "limit",
  "includeLinks",
  "operation",
  "functionId",
  "dateFrom",
  "dateTo",
] as const;
// verify adds the integrity-proof anchors on top of the pagination/filter set.
const AUDIT_CHAIN_VERIFY_FIELDS = [
  "expectedHeadHash",
  "expectedCount",
  "expectedFirstEntryId",
  "expectedLastEntryId",
  "chain",
  "allowUnanchored",
  ...AUDIT_CHAIN_FIELDS,
] as const;
const OTEL_LINEAGE_EXPORT_FIELDS = [
  "events",
  "eventIds",
  "project",
  "sessionId",
  "limit",
] as const;
const OTEL_LINEAGE_IMPORT_FIELDS = ["spans", "source"] as const;
const DELETION_PROPAGATION_FIELDS = [
  "targetId",
  "memoryId",
  "sourceObservationId",
  "sourceHash",
  "sourceUri",
  "project",
  "agentId",
  "dryRun",
  "apply",
  "mode",
  "actor",
  "reason",
] as const;
const HANDOFF_UPDATE_FIELDS = [
  "signalId",
  "agentId",
  "status",
  "reason",
  "metadata",
] as const;
const IMPORT_STRATEGIES = new Set(["merge", "replace", "skip"]);

function pickRulesResolvePayload(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of RULES_RESOLVE_FIELDS) {
    if (source[field] !== undefined) payload[field] = source[field];
  }
  return payload;
}

function pickFields(
  source: Record<string, unknown>,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (source[field] !== undefined) payload[field] = source[field];
  }
  return payload;
}

function validateWhitelistedField(field: string, value: unknown): string | undefined {
  const stringFields = new Set([
    "action",
    "actor",
    "agentId",
    "conflictPolicy",
    "dateFrom",
    "dateTo",
    "direction",
    "expectedFirstEntryId",
    "expectedHeadHash",
    "expectedLastEntryId",
    "functionId",
    "memoryId",
    "mode",
    "operation",
    "peerId",
    "project",
    "proposalId",
    "reason",
    "reviewer",
    "signalId",
    "source",
    "sourceHash",
    "sourceObservationId",
    "sourceUri",
    "status",
    "targetId",
    "workspaceId",
  ]);
  const stringArrayFields = new Set(["eventIds", "permissions", "scopes"]);
  const booleanFields = new Set([
    "allowUnanchored",
    "apply",
    "approved",
    "dryRun",
    "enabled",
    "includeLinks",
  ]);
  const arrayFields = new Set(["chain"]);
  const integerFields = new Set(["expectedCount", "offset"]);
  const objectFields = new Set(["change", "exportData", "metadata", "snapshot"]);
  if (stringFields.has(field) && typeof value !== "string") {
    return `${field} must be a string`;
  }
  if (
    stringArrayFields.has(field) &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  ) {
    return `${field} must be an array of strings`;
  }
  if (booleanFields.has(field) && typeof value !== "boolean") {
    return `${field} must be a boolean`;
  }
  if (objectFields.has(field) && !isRecord(value)) {
    return `${field} must be an object`;
  }
  if (arrayFields.has(field) && !Array.isArray(value)) {
    return `${field} must be an array`;
  }
  if (integerFields.has(field) && !Number.isInteger(value)) {
    return `${field} must be an integer`;
  }
  if (field === "limit" && !Number.isInteger(value)) {
    return "limit must be an integer";
  }
  if (field === "spans" && !Array.isArray(value)) {
    return "spans must be an array";
  }
  return undefined;
}

function validateWhitelistedPayload(
  payload: Record<string, unknown>,
): string | undefined {
  for (const [field, value] of Object.entries(payload)) {
    const error = validateWhitelistedField(field, value);
    if (error) return error;
  }
  return undefined;
}

async function callWhitelistedFunction(
  sdk: ISdk,
  req: ApiRequest,
  functionId: string,
  allowedFields: readonly string[],
): Promise<Response> {
  if (req.body !== undefined && !isRecord(req.body)) {
    return { status_code: 400, body: { error: "body must be an object" } };
  }
  const payload = pickFields((req.body ?? {}) as Record<string, unknown>, allowedFields);
  const validationError = validateWhitelistedPayload(payload);
  if (validationError) {
    return { status_code: 400, body: { error: validationError } };
  }
  const result = await sdk.trigger({ function_id: functionId, payload });
  return { status_code: 200, body: result };
}

function isRulesResolveInvalidInput(
  result: unknown,
): result is {
  success: false;
  code: "invalid_input" | "forbidden_root";
  error: string;
} {
  return (
    isRecord(result) &&
    result.success === false &&
    (result.code === "invalid_input" || result.code === "forbidden_root") &&
    typeof result.error === "string"
  );
}

// The trusted operator permission set. A request that passes checkAuth is a
// trusted operator on this single-shared-secret deployment, so it is granted
// the full operator scope. Permissions are NEVER read from the request body.
const MEMORY_PROPOSAL_OPERATOR_PERMISSIONS = Object.freeze([
  "project:read",
  "project:write",
  "governance:delete",
]);

// Resolve the effective principal SERVER-SIDE for memory-proposal triggers.
// - permissions: the fixed trusted-operator set above (never from the body).
// - actorId: an IDENTITY LABEL ONLY, used for audit stamping + separation of
//   duties. Read from the x-actor-id header, falling back to body.actorId, then
//   "operator". It carries no authorization weight.
// - teamPolicy.allowSelfApproval: opt-in via AGENTMEMORY_ALLOW_SELF_APPROVAL
//   (secure default false so self-approval is blocked).
function resolveMemoryProposalPrincipal(req: ApiRequest): {
  actorId: string;
  permissions: string[];
  teamPolicy: { allowSelfApproval: boolean };
} {
  const headers = (req.headers || {}) as Record<
    string,
    string | string[] | undefined
  >;
  const rawHeaderActor = headers["x-actor-id"] ?? headers["X-Actor-Id"];
  const headerActor = Array.isArray(rawHeaderActor)
    ? rawHeaderActor[0]
    : rawHeaderActor;
  const body = isRecord(req.body) ? req.body : {};
  const actorId =
    asNonEmptyString(headerActor) ??
    asNonEmptyString(body.actorId) ??
    "operator";
  const allowSelfApproval =
    process.env.AGENTMEMORY_ALLOW_SELF_APPROVAL === "true";
  return {
    actorId,
    permissions: [...MEMORY_PROPOSAL_OPERATOR_PERMISSIONS],
    teamPolicy: { allowSelfApproval },
  };
}

// Whitelisted memory-proposal handler: strips request-body authorization,
// resolves the principal server-side, and attaches it as data.principal.
async function callMemoryProposalFunction(
  sdk: ISdk,
  req: ApiRequest,
  functionId: string,
): Promise<Response> {
  if (req.body !== undefined && !isRecord(req.body)) {
    return { status_code: 400, body: { error: "body must be an object" } };
  }
  const payload = pickFields(
    (req.body ?? {}) as Record<string, unknown>,
    MEMORY_PROPOSAL_FIELDS,
  );
  const validationError = validateWhitelistedPayload(payload);
  if (validationError) {
    return { status_code: 400, body: { error: validationError } };
  }
  payload.principal = resolveMemoryProposalPrincipal(req);
  const result = await sdk.trigger({ function_id: functionId, payload });
  return { status_code: 200, body: result };
}

export function registerApiTriggers(
  sdk: ISdk,
  kv: StateKV,
  secret?: string,
  metricsStore?: MetricsStore,
  provider?: ResilientProvider | { circuitState?: unknown },
): void {
  sdk.registerFunction(
    "middleware::api-auth",
    async (input: {
      request?: { headers?: Record<string, string | undefined> };
    }) => {
      if (!secret) return { action: "continue" };
      const headers = input?.request?.headers || {};
      const auth = headers["authorization"] || headers["Authorization"];
      if (
        typeof auth !== "string" ||
        !timingSafeCompare(auth, `Bearer ${secret}`)
      ) {
        return {
          action: "respond",
          response: { status_code: 401, body: { error: "unauthorized" } },
        };
      }
      return { action: "continue" };
    },
  );

  // item 4 (NETWORK trust model): constrain the public REST/MCP rules-resolve
  // surface to the server's configured project root(s). config.ts has no
  // project-root setting, so default to [process.cwd()]. allowCallerOptions
  // stays FALSE (the resolver default), so caller-supplied instructionGlobs and
  // includeContent are stripped — the public surface never widens the scan or
  // returns raw rule content. A workspaceRoot outside these roots yields
  // result.code === 'forbidden_root', mapped to HTTP 400 below.
  const rulesResolveAllowedRoots = [process.cwd()];
  registerRulesResolverFunction(sdk, { allowedRoots: rulesResolveAllowedRoots });

  sdk.registerFunction("api::liveness",
    async (): Promise<Response> => ({
      status_code: 200,
      body: { status: "ok", service: "agentmemory", viewerPort: getBoundViewerPort(), viewerSkipped: getViewerSkipped() },
    }),
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::liveness",
    config: { api_path: "/agentmemory/livez", http_method: "GET" },
  });

  sdk.registerFunction("api::config-flags",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const providerKind = detectLlmProviderKind();
      const embeddingProvider = detectEmbeddingProvider() ? "embeddings" : "none";
      const flags = [
        {
          key: "GRAPH_EXTRACTION_ENABLED",
          label: "Knowledge graph extraction",
          enabled: isGraphExtractionEnabled(),
          default: false,
          affects: ["Graph", "Dashboard"],
          needsLlm: true,
          description: "Extracts entities and relations from observations into a knowledge graph.",
          enableHow: "Set GRAPH_EXTRACTION_ENABLED=true and provide an LLM key, then restart.",
          docsHref: "https://github.com/rohitg00/agentmemory#knowledge-graph",
        },
        {
          key: "CONSOLIDATION_ENABLED",
          label: "Memory consolidation",
          enabled: isConsolidationEnabled(),
          default: false,
          affects: ["Dashboard", "Memories", "Crystals"],
          needsLlm: true,
          description: "Periodically summarizes sessions into semantic facts + procedures.",
          enableHow: "Set CONSOLIDATION_ENABLED=true and provide an LLM key, then restart.",
          docsHref: "https://github.com/rohitg00/agentmemory#consolidation",
        },
        {
          key: "AGENTMEMORY_AUTO_COMPRESS",
          label: "LLM-powered observation compression",
          enabled: isAutoCompressEnabled(),
          default: false,
          affects: ["Memories", "Timeline"],
          needsLlm: true,
          description: "Every observation is compressed by the LLM for richer summaries (costs tokens). OFF uses zero-LLM synthetic compression.",
          enableHow: "Set AGENTMEMORY_AUTO_COMPRESS=true and provide an LLM key.",
          docsHref: "https://github.com/rohitg00/agentmemory/issues/138",
        },
        {
          key: "AGENTMEMORY_INJECT_CONTEXT",
          label: "In-conversation context injection",
          enabled: isContextInjectionEnabled(),
          default: false,
          affects: ["Hooks"],
          needsLlm: false,
          description: "Hooks write recalled context into Claude Code's conversation. OFF captures in the background without injecting.",
          enableHow: "Set AGENTMEMORY_INJECT_CONTEXT=true and restart.",
          docsHref: "https://github.com/rohitg00/agentmemory/issues/143",
        },
      ];
      return {
        status_code: 200,
        body: {
          version: VERSION,
          provider: providerKind,
          embeddingProvider,
          flags,
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::config-flags",
    config: {
      api_path: "/agentmemory/config/flags",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::health", 
    async (): Promise<Response> => {
      const health = await getLatestHealth(kv);
      const functionMetrics = metricsStore ? await metricsStore.getAll() : [];
      const circuitBreaker =
        provider && "circuitState" in provider ? provider.circuitState : null;

      const status = health?.status || "healthy";
      const statusCode = status === "critical" ? 503 : 200;

      return {
        status_code: statusCode,
        body: {
          status,
          service: "agentmemory",
          version: VERSION,
          health: health || null,
          functionMetrics,
          circuitBreaker,
          viewerPort: getBoundViewerPort(),
          viewerSkipped: getViewerSkipped(),
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::health",
    config: {
      api_path: "/agentmemory/health",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::observe",
    async (req: ApiRequest<HookPayload>): Promise<Response> => {
      const body = (req.body ?? {}) as unknown as Record<string, unknown>;
      const hookType = asNonEmptyString(body.hookType);
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      const cwd = asNonEmptyString(body.cwd);
      const timestamp = asNonEmptyString(body.timestamp);
      if (!hookType || !sessionId || !project || !cwd || !timestamp) {
        return {
          status_code: 400,
          body: {
            error:
              "hookType, sessionId, project, cwd, and timestamp are required strings",
          },
        };
      }
      const payload: HookPayload = {
        hookType: hookType as HookPayload["hookType"],
        sessionId,
        project,
        cwd,
        timestamp,
        data: body.data,
      };
      const result = await sdk.trigger({ function_id: "mem::observe", payload });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::observe",
    config: {
      api_path: "/agentmemory/observe",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::context",
    async (
      req: ApiRequest<{
        sessionId: string;
        project: string;
        budget?: number;
        tokenBudget?: number;
        explain?: boolean;
        includeReport?: boolean;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      if (!sessionId || !project) {
        return {
          status_code: 400,
          body: { error: "sessionId and project are required strings" },
        };
      }
      const budget = parseOptionalPositiveInt(body.budget);
      if (budget === null) {
        return {
          status_code: 400,
          body: { error: "budget must be a positive integer" },
        };
      }
      const tokenBudget = parseOptionalPositiveInt(body.tokenBudget);
      if (tokenBudget === null) {
        return {
          status_code: 400,
          body: { error: "tokenBudget must be a positive integer" },
        };
      }
      const explain = parseOptionalBoolean(body.explain);
      if (explain === null) {
        return { status_code: 400, body: { error: "explain must be a boolean" } };
      }
      const includeReport = parseOptionalBoolean(body.includeReport);
      if (includeReport === null) {
        return { status_code: 400, body: { error: "includeReport must be a boolean" } };
      }
      const payload: {
        sessionId: string;
        project: string;
        budget?: number;
        tokenBudget?: number;
        explain?: boolean;
        includeReport?: boolean;
      } = {
        sessionId,
        project,
      };
      if (budget !== undefined) {
        payload.budget = budget;
        if (tokenBudget === undefined) payload.tokenBudget = budget;
      }
      if (tokenBudget !== undefined) {
        payload.tokenBudget = tokenBudget;
        if (budget === undefined) payload.budget = tokenBudget;
      }
      if (explain !== undefined) payload.explain = explain;
      if (includeReport !== undefined) payload.includeReport = includeReport;
      const result = await sdk.trigger({ function_id: "mem::context", payload });
      return { status_code: 200, body: result };
    },
  );

  sdk.registerTrigger({
    type: "http",
    function_id: "api::context",
    config: {
      api_path: "/agentmemory/context",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::search",
    async (
      req: ApiRequest<{
        query: string;
        limit?: number;
        project?: string;
        cwd?: string;
        format?: string;
        token_budget?: number;
        agentId?: string;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const queryAgentId =
        typeof (req as { query_params?: Record<string, string> })
          .query_params?.["agentId"] === "string"
          ? (req as { query_params: Record<string, string> })
              .query_params["agentId"]
          : undefined;
      if (typeof body.query !== "string" || !body.query.trim()) {
        return { status_code: 400, body: { error: "query is required and must be a non-empty string" } };
      }
      if (
        body.limit !== undefined &&
        (!Number.isInteger(body.limit) || (body.limit as number) < 1)
      ) {
        return { status_code: 400, body: { error: "limit must be a positive integer" } };
      }
      if (body.project !== undefined && typeof body.project !== "string") {
        return { status_code: 400, body: { error: "project must be a string" } };
      }
      if (body.cwd !== undefined && typeof body.cwd !== "string") {
        return { status_code: 400, body: { error: "cwd must be a string" } };
      }
      if (
        body.format !== undefined &&
        (typeof body.format !== "string" ||
          !["full", "compact", "narrative"].includes(body.format.trim().toLowerCase()))
      ) {
        return {
          status_code: 400,
          body: { error: "format must be one of: full, compact, narrative" },
        };
      }
      if (
        body.token_budget !== undefined &&
        (!Number.isInteger(body.token_budget) || (body.token_budget as number) < 1)
      ) {
        return {
          status_code: 400,
          body: { error: "token_budget must be a positive integer" },
        };
      }
      // #817: propagate agentId so the upstream isolation filter
      // applies. Honors body.agentId (POST body), ?agentId=... query
      // param, or implicit fallback to the worker's AGENT_ID when
      // AGENTMEMORY_AGENT_SCOPE=isolated.
      const bodyAgentId =
        typeof body.agentId === "string" && body.agentId.trim().length > 0
          ? (body.agentId as string).trim()
          : undefined;
      const payload = {
        query: body.query.trim(),
        limit: body.limit as number | undefined,
        project: body.project as string | undefined,
        cwd: body.cwd as string | undefined,
        format:
          typeof body.format === "string"
            ? body.format.trim().toLowerCase()
            : undefined,
        token_budget: body.token_budget as number | undefined,
        agentId: bodyAgentId ?? queryAgentId,
      };
      const result = await sdk.trigger({ function_id: "mem::search", payload: payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::search",
    config: {
      api_path: "/agentmemory/search",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::compress-file", 
    async (req: ApiRequest<{ filePath: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const filePath = asNonEmptyString(body.filePath);
      if (!filePath) {
        return {
          status_code: 400,
          body: { error: "filePath is required and must be a non-empty string" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::compress-file",
        payload: { filePath },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::compress-file",
    config: { api_path: "/agentmemory/compress-file", http_method: "POST" },
  });

  sdk.registerFunction("api::replay::load",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessionId = asNonEmptyString(req.query_params?.["sessionId"]);
      if (!sessionId) {
        return { status_code: 400, body: { error: "sessionId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::replay::load",
        payload: { sessionId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::load",
    config: { api_path: "/agentmemory/replay/load", http_method: "GET" },
  });

  sdk.registerFunction("api::replay::sessions",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessions = await kv.list<Session>(KV.sessions);
      sessions.sort((a, b) =>
        (b.startedAt || "").localeCompare(a.startedAt || ""),
      );
      return { status_code: 200, body: { success: true, sessions } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::sessions",
    config: { api_path: "/agentmemory/replay/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::replay::import",
    async (
      req: ApiRequest<{ path?: string; maxFiles?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload: { path?: string; maxFiles?: number } = {};
      if (body.path !== undefined) {
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          return {
            status_code: 400,
            body: { error: "path must be a non-empty string" },
          };
        }
        payload.path = body.path.trim();
      }
      if (body.maxFiles !== undefined) {
        const n = body.maxFiles as number;
        if (
          !Number.isInteger(n) ||
          n < 1 ||
          n > MAX_FILES_UPPER_BOUND
        ) {
          return {
            status_code: 400,
            body: {
              error: `maxFiles must be an integer between 1 and ${MAX_FILES_UPPER_BOUND}`,
            },
          };
        }
        payload.maxFiles = n;
      }
      const result = await sdk.trigger({
        function_id: "mem::replay::import-jsonl",
        payload,
      });
      return { status_code: 202, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::import",
    config: { api_path: "/agentmemory/replay/import-jsonl", http_method: "POST" },
  });

  sdk.registerFunction("api::session::start",
    async (
      req: ApiRequest<{ sessionId: string; project: string; cwd: string }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const automaticSkip = automaticCaptureSkipResponse(body);
      if (automaticSkip) return automaticSkip;
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      const cwd = asNonEmptyString(body.cwd);
      if (!sessionId || !project || !cwd) {
        return {
          status_code: 400,
          body: {
            error: "sessionId, project, and cwd are required non-empty strings",
          },
        };
      }
      const title = typeof body.title === "string" ? body.title.trim() : undefined;
      // allow session/start to override AGENT_ID from request body
      // (multi-agent runtimes that route many roles through one server
      // process). Falls back to the AGENT_ID env on the server.
      const requestAgentId =
        typeof body.agentId === "string" && body.agentId.trim().length > 0
          ? body.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: sessionId,
        project,
        cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(title ? { summary: title.slice(0, 200) } : {}),
        ...(title ? { firstPrompt: title.slice(0, 200) } : {}),
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, sessionId, session);
      await safeRecordAgentEvent(kv, {
        type: "session_started",
        timestamp: session.startedAt,
        sessionId,
        project,
        cwd,
        agentId,
        functionId: "api::session::start",
        targetIds: [sessionId],
        metadata: { title },
      });
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string },
        { context: string }
      >({ function_id: "mem::context", payload: { sessionId, project } });
      return {
        status_code: 200,
        body: { session, context: contextResult.context },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::start",
    config: {
      api_path: "/agentmemory/session/start",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::end",
    async (req: ApiRequest<{ sessionId: string }>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const automaticSkip = automaticCaptureSkipResponse(body);
      if (automaticSkip) return automaticSkip;
      const sessionId = asNonEmptyString(body.sessionId);
      if (!sessionId) {
        return {
          status_code: 400,
          body: { error: "sessionId is required and must be a non-empty string" },
        };
      }
      const existingSession = await kv.get<Session>(KV.sessions, sessionId).catch(() => null);
      const endedAt = new Date().toISOString();
      await kv.update(KV.sessions, sessionId, [
        { type: "set", path: "endedAt", value: endedAt },
        { type: "set", path: "status", value: "completed" },
      ]);
      await safeRecordAgentEvent(kv, {
        type: "session_ended",
        timestamp: endedAt,
        sessionId,
        project: existingSession?.project,
        cwd: existingSession?.cwd,
        agentId: existingSession?.agentId,
        functionId: "api::session::end",
        targetIds: [sessionId],
        commitShas: existingSession?.commitShas,
        metadata: { observationCount: existingSession?.observationCount ?? 0 },
      });
      // Fan out session-stopped lifecycle (non-blocking).
      try {
        sdk.trigger({
          function_id: "event::session::stopped",
          payload: { sessionId },
          action: TriggerAction.Void(),
        });
      } catch (err) {
        logger.warn("event::session::stopped trigger failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { status_code: 200, body: { success: true } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::end",
    config: {
      api_path: "/agentmemory/session/end",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::summarize", 
    async (req: ApiRequest<{ sessionId: string }>): Promise<Response> => {
      const sessionId = asNonEmptyString((req.body as Record<string, unknown>)?.sessionId);
      if (!sessionId) {
        return { status_code: 400, body: { error: "sessionId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::summarize",
        payload: { sessionId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::summarize",
    config: {
      api_path: "/agentmemory/summarize",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::commit",
    async (req: ApiRequest): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sha = asNonEmptyString(body.sha);
      if (!sha) {
        return {
          status_code: 400,
          body: { error: "sha is required and must be a non-empty string" },
        };
      }
      const sessionId = asNonEmptyString(body.sessionId) ?? undefined;
      const branch = asNonEmptyString(body.branch) ?? undefined;
      const repo = asNonEmptyString(body.repo) ?? undefined;
      const message = asNonEmptyString(body.message) ?? undefined;
      const author = asNonEmptyString(body.author) ?? undefined;
      const authoredAt = asNonEmptyString(body.authoredAt) ?? undefined;
      const files = Array.isArray(body.files)
        ? (body.files as unknown[]).filter(
            (f): f is string => typeof f === "string" && f.length > 0,
          )
        : undefined;

      const link = await withKeyedLock(`commit:${sha}`, async () => {
        const existing = await kv.get<CommitLink>(KV.commits, sha);
        const sessionSet = new Set<string>(existing?.sessionIds ?? []);
        if (sessionId) sessionSet.add(sessionId);
        const merged: CommitLink = {
          sha,
          shortSha: existing?.shortSha ?? sha.slice(0, 7),
          branch: branch ?? existing?.branch,
          repo: repo ?? existing?.repo,
          message: message ?? existing?.message,
          author: author ?? existing?.author,
          authoredAt: authoredAt ?? existing?.authoredAt,
          files: files ?? existing?.files,
          sessionIds: Array.from(sessionSet),
          linkedAt: existing?.linkedAt ?? new Date().toISOString(),
        };
        await kv.set(KV.commits, sha, merged);
        return merged;
      });

      if (sessionId) {
        await withKeyedLock(`session:${sessionId}`, async () => {
          const session = await kv.get<Session>(KV.sessions, sessionId);
          if (!session) return;
          const shaSet = new Set<string>(session.commitShas ?? []);
          shaSet.add(sha);
          session.commitShas = Array.from(shaSet);
          await kv.set(KV.sessions, sessionId, session);
        });
      }

      return { status_code: 200, body: { commit: link } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::commit",
    config: {
      api_path: "/agentmemory/session/commit",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::by-commit",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sha = asNonEmptyString(req.query_params?.["sha"]);
      if (!sha) {
        return {
          status_code: 400,
          body: { error: "sha is required and must be a non-empty string" },
        };
      }
      const link = await kv.get<CommitLink>(KV.commits, sha);
      if (!link) {
        return {
          status_code: 404,
          body: { error: "no sessions linked to this commit" },
        };
      }
      const fetched = await Promise.all(
        (link.sessionIds ?? []).map((sid) => kv.get<Session>(KV.sessions, sid)),
      );
      const sessions = fetched.filter((s): s is Session => s !== null);
      return { status_code: 200, body: { commit: link, sessions } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::by-commit",
    config: {
      api_path: "/agentmemory/session/by-commit",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::commits",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const branch = asNonEmptyString(req.query_params?.["branch"]);
      const repo = asNonEmptyString(req.query_params?.["repo"]);
      const rawLimit = parseOptionalInt(req.query_params?.["limit"]);
      const limit = Math.max(1, Math.min(500, rawLimit ?? 100));
      const all = await kv.list<CommitLink>(KV.commits);
      const filtered = all
        .filter((c) => !branch || c.branch === branch)
        .filter((c) => !repo || c.repo === repo)
        .sort((a, b) => ((a.linkedAt ?? "") < (b.linkedAt ?? "") ? 1 : -1))
        .slice(0, limit);
      return { status_code: 200, body: { commits: filtered } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::commits",
    config: {
      api_path: "/agentmemory/commits",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::sessions",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessions = await kv.list<Session>(KV.sessions);
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ??
          (isAgentScopeIsolated() ? getAgentId() : undefined);
      const filtered = filterAgentId
        ? sessions.filter((s) => s.agentId === filterAgentId)
        : sessions;
      const summaries = await Promise.all(
        filtered.map((s) =>
          kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
        ),
      );
      const withSummary = filtered.map((s, i) =>
        summaries[i] ? { ...s, summary: summaries[i] } : s,
      );
      return { status_code: 200, body: { sessions: withSummary } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::sessions",
    config: { api_path: "/agentmemory/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::observations",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessionId = asNonEmptyString(req.query_params?.["sessionId"]);
      if (!sessionId)
        return { status_code: 400, body: { error: "sessionId required" } };
      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ??
          (isAgentScopeIsolated() ? getAgentId() : undefined);
      const filtered = filterAgentId
        ? observations.filter((o) => o.agentId === filterAgentId)
        : observations;
      return { status_code: 200, body: { observations: filtered } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::observations",
    config: { api_path: "/agentmemory/observations", http_method: "GET" },
  });

  sdk.registerFunction("api::file-context", 
    async (
      req: ApiRequest<{ sessionId: string; files: string[] }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::file-context", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::file-context",
    config: { api_path: "/agentmemory/file-context", http_method: "POST" },
  });

  sdk.registerFunction("api::enrich",
    async (
      req: ApiRequest<{
        sessionId: string;
        files: string[];
        terms?: string[];
        toolName?: string;
        project?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.sessionId ||
        typeof req.body.sessionId !== "string" ||
        !Array.isArray(req.body?.files) ||
        req.body.files.length === 0 ||
        !req.body.files.every((f: unknown) => typeof f === "string")
      ) {
        return {
          status_code: 400,
          body: {
            error: "sessionId (string) and files (string[]) are required",
          },
        };
      }
      if (
        req.body.terms !== undefined &&
        (!Array.isArray(req.body.terms) ||
          !req.body.terms.every((t: unknown) => typeof t === "string"))
      ) {
        return {
          status_code: 400,
          body: { error: "terms must be an array of strings" },
        };
      }
      if (
        req.body.project !== undefined &&
        (typeof req.body.project !== "string" || !req.body.project.trim())
      ) {
        return {
          status_code: 400,
          body: { error: "project must be a non-empty string" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::enrich",
        payload: {
          sessionId: req.body.sessionId,
          files: req.body.files,
          ...(req.body.terms !== undefined && { terms: req.body.terms }),
          ...(req.body.toolName !== undefined && { toolName: req.body.toolName }),
          ...(req.body.project !== undefined && { project: req.body.project }),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::enrich",
    config: { api_path: "/agentmemory/enrich", http_method: "POST" },
  });

  sdk.registerFunction("api::remember",
    async (
      req: ApiRequest<{
        content: string;
        type?: string;
        concepts?: string[];
        files?: string[];
        ttlDays?: number;
        sourceObservationIds?: string[];
        project?: string;
        lane?: string;
        confidence?: number;
        privacyScope?: string;
        ownerId?: string;
        branch?: string;
        commit?: string;
        sourceHash?: string;
        sourceType?: string;
        sourceUri?: string;
        reviewState?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.content ||
        typeof req.body.content !== "string" ||
        !req.body.content.trim()
      ) {
        return { status_code: 400, body: { error: "content is required" } };
      }
      if (
        req.body.project !== undefined &&
        (typeof req.body.project !== "string" || !req.body.project.trim())
      ) {
        return { status_code: 400, body: { error: "project must be a non-empty string" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: req.body.content,
          ...(req.body.type !== undefined && { type: req.body.type }),
          ...(req.body.concepts !== undefined && { concepts: req.body.concepts }),
          ...(req.body.files !== undefined && { files: req.body.files }),
          ...(req.body.ttlDays !== undefined && { ttlDays: req.body.ttlDays }),
          ...(req.body.sourceObservationIds !== undefined && { sourceObservationIds: req.body.sourceObservationIds }),
          ...(req.body.project !== undefined && { project: req.body.project }),
          ...(req.body.lane !== undefined && { lane: req.body.lane }),
          ...(req.body.confidence !== undefined && { confidence: req.body.confidence }),
          ...(req.body.privacyScope !== undefined && { privacyScope: req.body.privacyScope }),
          ...(req.body.ownerId !== undefined && { ownerId: req.body.ownerId }),
          ...(req.body.branch !== undefined && { branch: req.body.branch }),
          ...(req.body.commit !== undefined && { commit: req.body.commit }),
          ...(req.body.sourceHash !== undefined && { sourceHash: req.body.sourceHash }),
          ...(req.body.sourceType !== undefined && { sourceType: req.body.sourceType }),
          ...(req.body.sourceUri !== undefined && { sourceUri: req.body.sourceUri }),
          ...(req.body.reviewState !== undefined && { reviewState: req.body.reviewState }),
        },
      });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::remember",
    config: { api_path: "/agentmemory/remember", http_method: "POST" },
  });

  sdk.registerFunction("api::forget", 
    async (
      req: ApiRequest<{
        sessionId?: string;
        observationIds?: string[];
        memoryId?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sessionId && !req.body?.memoryId) {
        return {
          status_code: 400,
          body: { error: "sessionId or memoryId is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::forget", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::forget",
    config: { api_path: "/agentmemory/forget", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-create",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (
        !body.content ||
        typeof body.content !== "string" ||
        !body.content.trim()
      ) {
        return { status_code: 400, body: { error: "content is required" } };
      }
      if (
        body.project !== undefined &&
        (typeof body.project !== "string" || !body.project.trim())
      ) {
        return { status_code: 400, body: { error: "project must be a non-empty string" } };
      }
      if (
        body.requireGatePass !== undefined &&
        typeof body.requireGatePass !== "boolean"
      ) {
        return { status_code: 400, body: { error: "requireGatePass must be a boolean" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-create",
        payload: {
          content: body.content,
          ...(body.type !== undefined && { type: body.type }),
          ...(body.concepts !== undefined && { concepts: body.concepts }),
          ...(body.files !== undefined && { files: body.files }),
          ...(body.ttlDays !== undefined && { ttlDays: body.ttlDays }),
          ...(body.sourceObservationIds !== undefined && { sourceObservationIds: body.sourceObservationIds }),
          ...(body.agentId !== undefined && { agentId: body.agentId }),
          ...(body.project !== undefined && { project: body.project }),
          ...(body.lane !== undefined && { lane: body.lane }),
          ...(body.confidence !== undefined && { confidence: body.confidence }),
          ...(body.privacyScope !== undefined && { privacyScope: body.privacyScope }),
          ...(body.ownerId !== undefined && { ownerId: body.ownerId }),
          ...(body.branch !== undefined && { branch: body.branch }),
          ...(body.commit !== undefined && { commit: body.commit }),
          ...(body.sourceHash !== undefined && { sourceHash: body.sourceHash }),
          ...(body.sourceType !== undefined && { sourceType: body.sourceType }),
          ...(body.sourceUri !== undefined && { sourceUri: body.sourceUri }),
          ...(body.reviewState !== undefined && { reviewState: body.reviewState }),
          ...(body.requireGatePass !== undefined && { requireGatePass: body.requireGatePass }),
          ...(body.writeGate !== undefined && { writeGate: body.writeGate }),
        },
      });
      const statusCode =
        isRecord(result) && result.success === false ? 400 : 201;
      return { status_code: statusCode, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-create",
    config: { api_path: "/agentmemory/memory/create", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-inspect",
    async (req: ApiRequest<{ memoryId?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const memoryId =
        asNonEmptyString(req.body?.memoryId) ??
        asNonEmptyString(req.query_params?.["memoryId"]);
      if (!memoryId) return { status_code: 400, body: { error: "memoryId is required" } };
      const result = await sdk.trigger({
        function_id: "mem::memory-inspect",
        payload: { memoryId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-inspect",
    config: { api_path: "/agentmemory/memory/inspect", http_method: "POST" },
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-inspect",
    config: { api_path: "/agentmemory/memory/inspect", http_method: "GET" },
  });

  sdk.registerFunction("api::memory-history",
    async (req: ApiRequest<{ memoryId?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const memoryId =
        asNonEmptyString(req.body?.memoryId) ??
        asNonEmptyString(req.query_params?.["memoryId"]);
      if (!memoryId) return { status_code: 400, body: { error: "memoryId is required" } };
      const result = await sdk.trigger({
        function_id: "mem::memory-history",
        payload: { memoryId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-history",
    config: { api_path: "/agentmemory/memory/history", http_method: "GET" },
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-history",
    config: { api_path: "/agentmemory/memory/history", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-update",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!asNonEmptyString(body.memoryId)) {
        return { status_code: 400, body: { error: "memoryId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-update",
        payload: {
          memoryId: body.memoryId,
          content: body.content,
          title: body.title,
          concepts: body.concepts,
          files: body.files,
          strength: body.strength,
          confidence: body.confidence,
          lane: body.lane,
          reviewState: body.reviewState,
          privacyScope: body.privacyScope,
          validFrom: body.validFrom,
          validUntil: body.validUntil,
          reason: body.reason,
          actor: body.actor,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-update",
    config: { api_path: "/agentmemory/memory/update", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-expire",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!asNonEmptyString(body.memoryId)) {
        return { status_code: 400, body: { error: "memoryId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-expire",
        payload: {
          memoryId: body.memoryId,
          expiresAt: body.expiresAt,
          reason: body.reason,
          actor: body.actor,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-expire",
    config: { api_path: "/agentmemory/memory/expire", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-archive",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!asNonEmptyString(body.memoryId)) {
        return { status_code: 400, body: { error: "memoryId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-archive",
        payload: {
          memoryId: body.memoryId,
          reason: body.reason,
          actor: body.actor,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-archive",
    config: { api_path: "/agentmemory/memory/archive", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-restore",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!asNonEmptyString(body.memoryId)) {
        return { status_code: 400, body: { error: "memoryId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-restore",
        payload: {
          memoryId: body.memoryId,
          reason: body.reason,
          actor: body.actor,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-restore",
    config: { api_path: "/agentmemory/memory/restore", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-delete",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const optionalString = (field: string): string | Response | undefined => {
        if (body[field] === undefined || body[field] === null) return undefined;
        const value = asNonEmptyString(body[field]);
        if (!value) {
          return {
            status_code: 400,
            body: { error: `${field} must be a non-empty string` },
          };
        }
        return value;
      };
      const memoryId = optionalString("memoryId");
      if (typeof memoryId === "object") return memoryId;
      const sourceObservationId = optionalString("sourceObservationId");
      if (typeof sourceObservationId === "object") return sourceObservationId;
      const sourceHash = optionalString("sourceHash");
      if (typeof sourceHash === "object") return sourceHash;
      const sourceUri = optionalString("sourceUri");
      if (typeof sourceUri === "object") return sourceUri;
      const project = optionalString("project");
      if (typeof project === "object") return project;
      const agentId = optionalString("agentId");
      if (typeof agentId === "object") return agentId;
      if (!memoryId && !sourceObservationId && !sourceHash && !sourceUri) {
        return {
          status_code: 400,
          body: { error: "memoryId or source selector is required" },
        };
      }
      if (
        body.dryRun !== undefined &&
        body.dryRun !== null &&
        typeof body.dryRun !== "boolean"
      ) {
        return { status_code: 400, body: { error: "dryRun must be a boolean" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-delete",
        payload: {
          memoryId,
          sourceObservationId,
          sourceHash,
          sourceUri,
          project,
          agentId,
          mode: body.mode,
          reason: body.reason,
          actor: body.actor,
          dryRun: body.dryRun,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-delete",
    config: { api_path: "/agentmemory/memory/delete", http_method: "POST" },
  });

  sdk.registerFunction("api::memory-ledger",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const params = req.query_params ?? {};
      const limit = parseOptionalPositiveInt(params.limit);
      if (limit === null) return { status_code: 400, body: { error: "invalid numeric parameter: limit" } };
      const offset = parseOptionalInt(params.offset);
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        return { status_code: 400, body: { error: "invalid numeric parameter: offset" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::memory-ledger",
        payload: {
          project: params.project,
          state: params.state,
          type: params.type,
          lane: params.lane,
          reviewState: params.reviewState,
          includeSourceCards: params.includeSourceCards === "true",
          limit,
          offset,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-ledger",
    config: { api_path: "/agentmemory/memory-ledger", http_method: "GET" },
  });

  sdk.registerFunction("api::memory-review-queue",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const params = req.query_params ?? {};
      const limit = parseOptionalPositiveInt(params.limit);
      if (limit === null) return { status_code: 400, body: { error: "invalid numeric parameter: limit" } };
      const result = await sdk.trigger({
        function_id: "mem::memory-review-queue",
        payload: { project: params.project, limit },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-review-queue",
    config: { api_path: "/agentmemory/memory-review-queue", http_method: "GET" },
  });

  sdk.registerFunction("api::today-in-memory",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const params = req.query_params ?? {};
      const limit = parseOptionalPositiveInt(params.limit);
      if (limit === null) return { status_code: 400, body: { error: "invalid numeric parameter: limit" } };
      const result = await sdk.trigger({
        function_id: "mem::today-in-memory",
        payload: {
          project: params.project,
          agentId: params.agentId,
          sessionId: params.sessionId,
          date: params.date,
          since: params.since,
          until: params.until,
          limit,
        },
      });
      const statusCode =
        isRecord(result) && result.success === false ? 400 : 200;
      return { status_code: statusCode, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::today-in-memory",
    config: { api_path: "/agentmemory/memory/today", http_method: "GET" },
  });

  sdk.registerFunction("api::memory-unlinked-mentions",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const params = req.query_params ?? {};
      const limit = parseOptionalPositiveInt(params.limit);
      if (limit === null) return { status_code: 400, body: { error: "invalid numeric parameter: limit" } };
      const minMentions = parseOptionalPositiveInt(params.minMentions);
      if (minMentions === null) return { status_code: 400, body: { error: "invalid numeric parameter: minMentions" } };
      const result = await sdk.trigger({
        function_id: "mem::memory-unlinked-mentions",
        payload: {
          project: params.project,
          agentId: params.agentId,
          sessionId: params.sessionId,
          date: params.date,
          since: params.since,
          until: params.until,
          limit,
          minMentions,
        },
      });
      const statusCode =
        isRecord(result) && result.success === false ? 400 : 200;
      return { status_code: statusCode, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-unlinked-mentions",
    config: { api_path: "/agentmemory/memory/unlinked-mentions", http_method: "GET" },
  });

  sdk.registerFunction("api::agent-event-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const params = req.query_params ?? {};
      const limit = parseOptionalPositiveInt(params.limit);
      if (limit === null) return { status_code: 400, body: { error: "invalid numeric parameter: limit" } };
      const offset = parseOptionalInt(params.offset);
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
        return { status_code: 400, body: { error: "invalid numeric parameter: offset" } };
      }
      const qp = (key: string): string | undefined =>
        asNonEmptyString(params[key]) ?? undefined;
      const format = qp("format")?.toLowerCase();
      if (format !== undefined && format !== "otel") {
        return { status_code: 400, body: { error: "format must be one of: otel" } };
      }
      const payload: AgentEventListFilter = {
        format: format as AgentEventListFilter["format"],
        type: qp("type") as AgentEventListFilter["type"],
        sessionId: qp("sessionId"),
        project: qp("project"),
        agentId: qp("agentId"),
        fromAgentId: qp("fromAgentId"),
        toAgentId: qp("toAgentId"),
        functionId: qp("functionId"),
        targetId: qp("targetId"),
        observationId: qp("observationId"),
        memoryId: qp("memoryId"),
        signalId: qp("signalId"),
        correlationId: qp("correlationId"),
        parentEventId: qp("parentEventId"),
        dateFrom: qp("dateFrom"),
        dateTo: qp("dateTo"),
        limit,
        offset,
      };
      const result = await sdk.trigger({ function_id: "mem::agent-event-list", payload });
      const success = (result as { success?: boolean }).success !== false;
      return { status_code: success ? 200 : 400, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::agent-event-list",
    config: { api_path: "/agentmemory/agent-events", http_method: "GET" },
  });

  sdk.registerFunction("api::agent-event-record",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const built = buildAgentEventInput(body);
      if (built.error || !built.input) {
        return { status_code: 400, body: { error: built.error ?? "invalid agent event payload" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::agent-event-record",
        payload: built.input,
      });
      const success = (result as { success?: boolean }).success !== false;
      const skipped = (result as { skipped?: boolean }).skipped === true;
      return { status_code: success ? (skipped ? 200 : 201) : 400, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::agent-event-record",
    config: { api_path: "/agentmemory/agent-events", http_method: "POST" },
  });

  sdk.registerFunction("api::consolidate", 
    async (
      req: ApiRequest<{ project?: string; minObservations?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::consolidate", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::consolidate",
    config: { api_path: "/agentmemory/consolidate", http_method: "POST" },
  });

  sdk.registerFunction("api::patterns", 
    async (req: ApiRequest<{ project?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::patterns", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::patterns",
    config: { api_path: "/agentmemory/patterns", http_method: "POST" },
  });

  sdk.registerFunction("api::generate-rules", 
    async (req: ApiRequest<{ project?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::generate-rules", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::generate-rules",
    config: { api_path: "/agentmemory/generate-rules", http_method: "POST" },
  });

  sdk.registerFunction("api::rules-resolve",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (req.body !== undefined && !isRecord(req.body)) {
        return { status_code: 400, body: { error: "body must be an object" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::rules-resolve",
        payload: pickRulesResolvePayload((req.body ?? {}) as Record<string, unknown>),
      });
      if (isRulesResolveInvalidInput(result)) {
        return { status_code: 400, body: result };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::rules-resolve",
    config: {
      api_path: "/agentmemory/rules/resolve",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::rules-resolve-get",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({
        function_id: "mem::rules-resolve",
        payload: pickRulesResolvePayload(req.query_params ?? {}),
      });
      if (isRulesResolveInvalidInput(result)) {
        return { status_code: 400, body: result };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::rules-resolve-get",
    config: {
      api_path: "/agentmemory/rules/resolve",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // Audit-chain REST exposure (item 3). GET reads the tamper-evident chain;
  // query params arrive as strings, so the read endpoint whitelists fields and
  // forwards them to mem::audit-chain, which coerces + bounds them itself.
  sdk.registerFunction("api::audit-chain",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const payload = pickFields(
        req.query_params ?? {},
        AUDIT_CHAIN_FIELDS,
      );
      const result = await sdk.trigger({
        function_id: "mem::audit-chain",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::audit-chain",
    config: {
      api_path: "/agentmemory/audit/chain",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  // POST verify accepts a JSON body, so it can validate whitelisted field types
  // before forwarding to mem::audit-chain-verify (which performs the full
  // integrity proof).
  sdk.registerFunction("api::audit-chain-verify",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      return callWhitelistedFunction(
        sdk,
        req,
        "mem::audit-chain-verify",
        AUDIT_CHAIN_VERIFY_FIELDS,
      );
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::audit-chain-verify",
    config: {
      api_path: "/agentmemory/audit/chain/verify",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::compliance-soc2-evidence",
    async (req: ApiRequest<ComplianceEvidenceInput>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = req.body ?? {};
      if (
        body.includeRuleContent !== undefined &&
        typeof body.includeRuleContent !== "boolean"
      ) {
        return {
          status_code: 400,
          body: { error: "includeRuleContent must be a boolean" },
        };
      }
      const payload: ComplianceEvidenceInput = {};
      if (typeof body.project === "string") payload.project = body.project;
      if (typeof body.workspaceRoot === "string") {
        payload.workspaceRoot = body.workspaceRoot;
      }
      if (body.teamPolicy !== undefined) payload.teamPolicy = body.teamPolicy;
      if (body.releaseGateEvidence !== undefined) {
        payload.releaseGateEvidence = body.releaseGateEvidence;
      }
      if (body.includeRuleContent !== undefined) {
        payload.includeRuleContent = body.includeRuleContent;
      }
      const result = await sdk.trigger({
        function_id: "mem::compliance-evidence",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::compliance-soc2-evidence",
    config: {
      api_path: "/agentmemory/compliance/soc2-evidence",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  const whitelistedPost = (
    apiFunctionId: string,
    path: string,
    memoryFunctionId: string,
    allowedFields: readonly string[],
  ) => {
    sdk.registerFunction(apiFunctionId,
      async (req: ApiRequest): Promise<Response> => {
        const authErr = checkAuth(req, secret);
        if (authErr) return authErr;
        return callWhitelistedFunction(sdk, req, memoryFunctionId, allowedFields);
      },
    );
    sdk.registerTrigger({
      type: "http",
      function_id: apiFunctionId,
      config: {
        api_path: path,
        http_method: "POST",
        middleware_function_ids: ["middleware::api-auth"],
      },
    });
  };

  // Memory-proposal routes resolve the principal server-side (item 2) and must
  // NOT use the generic whitelisted handler, which would pass the body through
  // without an injected principal. Each handler strips body authz, whitelists
  // proposal-content fields, and attaches data.principal.
  const memoryProposalRoutes = [
    {
      apiFunctionId: "api::memory-proposal-create",
      api_path: "/agentmemory/memory-proposals/create",
      memoryFunctionId: "mem::memory-proposal-create",
    },
    {
      apiFunctionId: "api::memory-proposal-list",
      api_path: "/agentmemory/memory-proposals/list",
      memoryFunctionId: "mem::memory-proposal-list",
    },
    {
      apiFunctionId: "api::memory-proposal-approve",
      api_path: "/agentmemory/memory-proposals/approve",
      memoryFunctionId: "mem::memory-proposal-approve",
    },
    {
      apiFunctionId: "api::memory-proposal-reject",
      api_path: "/agentmemory/memory-proposals/reject",
      memoryFunctionId: "mem::memory-proposal-reject",
    },
    {
      apiFunctionId: "api::memory-proposal-apply",
      api_path: "/agentmemory/memory-proposals/apply",
      memoryFunctionId: "mem::memory-proposal-apply",
    },
  ] as const;
  for (const route of memoryProposalRoutes) {
    const memoryFunctionId = route.memoryFunctionId;
    sdk.registerFunction(route.apiFunctionId,
      async (req: ApiRequest): Promise<Response> => {
        const authErr = checkAuth(req, secret);
        if (authErr) return authErr;
        return callMemoryProposalFunction(sdk, req, memoryFunctionId);
      },
    );
    sdk.registerTrigger({
      type: "http",
      function_id: route.apiFunctionId,
      config: {
        api_path: route.api_path,
        http_method: "POST",
        middleware_function_ids: ["middleware::api-auth"],
      },
    });
  }

  const roadmapRoutes = [
    {
      apiFunctionId: "api::sync-peer-register",
      api_path: "/agentmemory/sync/peers/register",
      memoryFunctionId: "mem::sync-peer-register",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::sync-peer-set-status",
      api_path: "/agentmemory/sync/peer/set-status",
      memoryFunctionId: "mem::sync-peer-set-status",
      allowedFields: SYNC_PEER_SET_STATUS_FIELDS,
    },
    {
      apiFunctionId: "api::sync-workspace-register",
      api_path: "/agentmemory/sync/workspaces/register",
      memoryFunctionId: "mem::sync-workspace-register",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::sync-plan",
      api_path: "/agentmemory/sync/plan",
      memoryFunctionId: "mem::sync-plan",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::sync-run-record",
      api_path: "/agentmemory/sync/runs/record",
      memoryFunctionId: "mem::sync-run-record",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::sync-local-apply",
      api_path: "/agentmemory/sync/local/apply",
      memoryFunctionId: "mem::sync-local-apply",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::sync-status",
      api_path: "/agentmemory/sync/status",
      memoryFunctionId: "mem::sync-status",
      allowedFields: SYNC_CONTROL_PLANE_FIELDS,
    },
    {
      apiFunctionId: "api::otel-lineage-export",
      api_path: "/agentmemory/lineage/otel/export",
      memoryFunctionId: "mem::otel-lineage-export",
      allowedFields: OTEL_LINEAGE_EXPORT_FIELDS,
    },
    {
      apiFunctionId: "api::otel-lineage-import",
      api_path: "/agentmemory/lineage/otel/import",
      memoryFunctionId: "mem::otel-lineage-import",
      allowedFields: OTEL_LINEAGE_IMPORT_FIELDS,
    },
    {
      apiFunctionId: "api::deletion-propagation-report",
      api_path: "/agentmemory/governance/deletion-propagation",
      memoryFunctionId: "mem::deletion-propagation-report",
      allowedFields: DELETION_PROPAGATION_FIELDS,
    },
  ] as const;
  for (const route of roadmapRoutes) {
    whitelistedPost(
      route.apiFunctionId,
      route.api_path,
      route.memoryFunctionId,
      route.allowedFields,
    );
  }

  sdk.registerFunction("api::migrate",
    async (
      req: ApiRequest<{ dbPath?: string; step?: string; dryRun?: boolean }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const hasStep =
        typeof req.body?.step === "string" && req.body.step.trim().length > 0;
      const hasDbPath =
        typeof req.body?.dbPath === "string" && req.body.dbPath.trim().length > 0;
      if (!hasStep && !hasDbPath) {
        return {
          status_code: 400,
          body: { error: "Either step (string) or dbPath (string) is required" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::migrate",
        payload: {
          ...(req.body.step !== undefined && { step: req.body.step }),
          ...(req.body.dbPath !== undefined && { dbPath: req.body.dbPath }),
          ...(req.body.dryRun !== undefined && { dryRun: req.body.dryRun }),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::migrate",
    config: { api_path: "/agentmemory/migrate", http_method: "POST" },
  });

  sdk.registerFunction("api::evict", 
    async (req: ApiRequest<{ dryRun?: boolean }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const dryRun =
        req.query_params?.["dryRun"] === "true" || req.body?.dryRun === true;
      const result = await sdk.trigger({ function_id: "mem::evict", payload: { dryRun } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::evict",
    config: { api_path: "/agentmemory/evict", http_method: "POST" },
  });

  sdk.registerFunction("api::smart-search",
    async (
      req: ApiRequest<{
        query?: string;
        expandIds?: Array<string | { obsId: string; sessionId: string }>;
        limit?: number;
        project?: string;
        includeLessons?: boolean;
        explain?: boolean;
        searchMode?: string;
        retrievalMode?: string;
        includeReport?: boolean;
        tokenBudget?: number;
        token_budget?: number;
        budget?: number;
        files?: string[] | string;
        file?: string;
        filePath?: string;
        cwd?: string;
        branch?: string;
        commit?: string;
        memoryTier?: string;
        privacyScope?: string;
        asOf?: string;
        validAt?: string;
        agentId?: string;
        sessionId?: string;
        source?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.query &&
        (!req.body?.expandIds || req.body.expandIds.length === 0)
      ) {
        return {
          status_code: 400,
          body: { error: "query or expandIds is required" },
        };
      }
      // #771: route the X-Agentmemory-Source header into the payload so
      // the followup-rate diagnostic can skip viewer-originated calls.
      // Body wins if both are set (advanced callers explicitly override).
      const headers = (req.headers || {}) as Record<string, string | string[] | undefined>;
      const sourceHeader = headers["x-agentmemory-source"] ?? headers["X-Agentmemory-Source"];
      const sourceFromHeader = Array.isArray(sourceHeader) ? sourceHeader[0] : sourceHeader;
      const searchMode = parseOptionalSearchMode(req.body?.searchMode);
      if (searchMode === null) {
        return {
          status_code: 400,
          body: { error: "searchMode must be one of: fast, balanced, deep" },
        };
      }
      const retrievalMode = parseOptionalRetrievalMode(req.body?.retrievalMode);
      if (retrievalMode === null) {
        return {
          status_code: 400,
          body: {
            error: "retrievalMode must be one of: basic, local_graph, global_community, drift, as_of",
          },
        };
      }
      const explain = parseOptionalBoolean(req.body?.explain);
      if (explain === null) {
        return { status_code: 400, body: { error: "explain must be a boolean" } };
      }
      const includeReport = parseOptionalBoolean(req.body?.includeReport);
      if (includeReport === null) {
        return { status_code: 400, body: { error: "includeReport must be a boolean" } };
      }
      const tokenBudget = parseOptionalPositiveInt(req.body?.tokenBudget);
      if (tokenBudget === null) {
        return {
          status_code: 400,
          body: { error: "tokenBudget must be a positive integer" },
        };
      }
      const tokenBudgetSnake = parseOptionalPositiveInt(req.body?.token_budget);
      if (tokenBudgetSnake === null) {
        return {
          status_code: 400,
          body: { error: "token_budget must be a positive integer" },
        };
      }
      const budget = parseOptionalPositiveInt(req.body?.budget);
      if (budget === null) {
        return {
          status_code: 400,
          body: { error: "budget must be a positive integer" },
        };
      }
      const effectiveTokenBudget = tokenBudget ?? tokenBudgetSnake ?? budget;
      // Whitelist payload fields explicitly — REST endpoints never pass
      // the raw request body through to sdk.trigger (AGENTS.md security
      // section). Drops unknown fields so a misbehaving client can't
      // inject downstream-only options.
      const payload = {
        query: req.body?.query,
        expandIds: req.body?.expandIds,
        limit: req.body?.limit,
        project: req.body?.project,
        includeLessons: req.body?.includeLessons,
        explain,
        searchMode,
        retrievalMode,
        includeReport,
        tokenBudget: effectiveTokenBudget,
        files: req.body?.files,
        file: req.body?.file,
        filePath: req.body?.filePath,
        cwd: req.body?.cwd,
        branch: req.body?.branch,
        commit: req.body?.commit,
        memoryTier: req.body?.memoryTier,
        privacyScope: req.body?.privacyScope,
        asOf: req.body?.asOf,
        validAt: req.body?.validAt,
        agentId: req.body?.agentId,
        sessionId: req.body?.sessionId,
        source: req.body?.source ?? sourceFromHeader,
      };
      const result = await sdk.trigger({ function_id: "mem::smart-search", payload });
      // item 18: the full mem::smart-search response is returned as-is, so any
      // optional top-level response.warnings is forwarded additively without
      // needing to be re-listed here.
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::smart-search",
    config: { api_path: "/agentmemory/smart-search", http_method: "POST" },
  });

  sdk.registerFunction("api::search-explain",
    async (
      req: ApiRequest<{
        query?: string;
        limit?: number;
        project?: string;
        cwd?: string;
        includeLessons?: boolean;
        explain?: boolean;
        searchMode?: string;
        retrievalMode?: string;
        includeReport?: boolean;
        tokenBudget?: number;
        token_budget?: number;
        budget?: number;
        files?: string[] | string;
        file?: string;
        filePath?: string;
        branch?: string;
        commit?: string;
        memoryTier?: string;
        privacyScope?: string;
        asOf?: string;
        validAt?: string;
        agentId?: string;
        sessionId?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.query || typeof req.body.query !== "string") {
        return {
          status_code: 400,
          body: { error: "query is required" },
        };
      }
      const searchMode = parseOptionalSearchMode(req.body.searchMode);
      if (searchMode === null) {
        return {
          status_code: 400,
          body: { error: "searchMode must be one of: fast, balanced, deep" },
        };
      }
      const retrievalMode = parseOptionalRetrievalMode(req.body.retrievalMode);
      if (retrievalMode === null) {
        return {
          status_code: 400,
          body: {
            error: "retrievalMode must be one of: basic, local_graph, global_community, drift, as_of",
          },
        };
      }
      const explain = parseOptionalBoolean(req.body.explain);
      if (explain === null) {
        return { status_code: 400, body: { error: "explain must be a boolean" } };
      }
      const includeReport = parseOptionalBoolean(req.body.includeReport);
      if (includeReport === null) {
        return { status_code: 400, body: { error: "includeReport must be a boolean" } };
      }
      const tokenBudget = parseOptionalPositiveInt(req.body.tokenBudget);
      if (tokenBudget === null) {
        return {
          status_code: 400,
          body: { error: "tokenBudget must be a positive integer" },
        };
      }
      const tokenBudgetSnake = parseOptionalPositiveInt(req.body.token_budget);
      if (tokenBudgetSnake === null) {
        return {
          status_code: 400,
          body: { error: "token_budget must be a positive integer" },
        };
      }
      const budget = parseOptionalPositiveInt(req.body.budget);
      if (budget === null) {
        return {
          status_code: 400,
          body: { error: "budget must be a positive integer" },
        };
      }
      const effectiveTokenBudget = tokenBudget ?? tokenBudgetSnake ?? budget;
      const result = await sdk.trigger({
        function_id: "mem::smart-search",
        payload: {
          query: req.body.query,
          limit: req.body.limit,
          project: req.body.project,
          includeLessons: req.body.includeLessons,
          searchMode,
          retrievalMode,
          includeReport,
          tokenBudget: effectiveTokenBudget,
          files: req.body.files,
          file: req.body.file,
          filePath: req.body.filePath,
          cwd: req.body.cwd,
          branch: req.body.branch,
          commit: req.body.commit,
          memoryTier: req.body.memoryTier,
          privacyScope: req.body.privacyScope,
          asOf: req.body.asOf,
          validAt: req.body.validAt,
          agentId: req.body.agentId,
          sessionId: req.body.sessionId,
          explain: true,
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::search-explain",
    config: { api_path: "/agentmemory/search/explain", http_method: "POST" },
  });

  // #771: read-back endpoint for the followup-rate diagnostic. Returns
  // a directional signal — overcounts on legitimate query refinement —
  // so help text + the CLI status line carry the same caveat.
  sdk.registerFunction("api::diagnostic-followup",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({
        function_id: "mem::diagnostic::followup-stats",
        payload: {},
      });
      return {
        status_code: 200,
        body: {
          ...(result as Record<string, unknown>),
          caveat:
            "Directional signal: overcounts on legitimate query refinement. " +
            "Tune via AGENTMEMORY_FOLLOWUP_WINDOW_SECONDS.",
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::diagnostic-followup",
    config: {
      api_path: "/agentmemory/diagnostics/followup",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::timeline", 
    async (
      req: ApiRequest<{
        anchor: string;
        project?: string;
        before?: number;
        after?: number;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.anchor) {
        return { status_code: 400, body: { error: "anchor is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::timeline", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::timeline",
    config: { api_path: "/agentmemory/timeline", http_method: "POST" },
  });

  sdk.registerFunction("api::profile", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const project = req.query_params["project"] as string;
      if (!project) {
        return {
          status_code: 400,
          body: { error: "project query param is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::profile", payload: { project } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::profile",
    config: { api_path: "/agentmemory/profile", http_method: "GET" },
  });

  sdk.registerFunction("api::export",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      // mem::export already supports maxSessions/offset internally,
      // but the HTTP endpoint hardcoded an empty payload — so /export on a
      // real corpus (40 sessions × 34K observations × 8K memories) hit the
      // iii engine invocation timeout and `agentmemory status` reported 0.
      // Pass through the query-string pagination so callers can chunk.
      const rawMax = req.query_params?.["maxSessions"];
      const rawOffset = req.query_params?.["offset"];
      const payload: { maxSessions?: number; offset?: number } = {};
      if (typeof rawMax === "string") {
        const n = Number(rawMax);
        if (Number.isInteger(n) && n > 0) payload.maxSessions = n;
      }
      if (typeof rawOffset === "string") {
        const n = Number(rawOffset);
        if (Number.isInteger(n) && n >= 0) payload.offset = n;
      }
      const result = await sdk.trigger({
        function_id: "mem::export",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::export",
    config: { api_path: "/agentmemory/export", http_method: "GET" },
  });

  sdk.registerFunction("api::import", 
    async (
      req: ApiRequest<{
        exportData: unknown;
        strategy?: "merge" | "replace" | "skip";
        dryRun?: boolean;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
      if (!body.exportData) {
        return { status_code: 400, body: { error: "exportData is required" } };
      }
      if (
        body.strategy !== undefined &&
        (typeof body.strategy !== "string" || !IMPORT_STRATEGIES.has(body.strategy))
      ) {
        return {
          status_code: 400,
          body: { error: "strategy must be one of: merge, replace, skip" },
        };
      }
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
        return { status_code: 400, body: { error: "dryRun must be a boolean" } };
      }
      const payload: {
        exportData: unknown;
        strategy?: "merge" | "replace" | "skip";
        dryRun?: boolean;
      } = {
        exportData: body.exportData,
      };
      if (body.strategy !== undefined) {
        payload.strategy = body.strategy as "merge" | "replace" | "skip";
      }
      if (body.dryRun !== undefined) {
        payload.dryRun = body.dryRun;
      }
      const result = await sdk.trigger({ function_id: "mem::import", payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::import",
    config: { api_path: "/agentmemory/import", http_method: "POST" },
  });

  sdk.registerFunction("api::relations", 
    async (
      req: ApiRequest<{ sourceId: string; targetId: string; type: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sourceId || !req.body?.targetId || !req.body?.type) {
        return {
          status_code: 400,
          body: { error: "sourceId, targetId, and type are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::relate", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::relations",
    config: { api_path: "/agentmemory/relations", http_method: "POST" },
  });

  sdk.registerFunction("api::evolve", 
    async (
      req: ApiRequest<{
        memoryId: string;
        newContent: string;
        newTitle?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.memoryId || !req.body?.newContent) {
        return {
          status_code: 400,
          body: { error: "memoryId and newContent are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::evolve", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::evolve",
    config: { api_path: "/agentmemory/evolve", http_method: "POST" },
  });

  sdk.registerFunction("api::auto-forget", 
    async (req: ApiRequest<{ dryRun?: boolean }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const dryRun =
        req.query_params?.["dryRun"] === "true" || req.body?.dryRun === true;
      const result = await sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::auto-forget",
    config: { api_path: "/agentmemory/auto-forget", http_method: "POST" },
  });

  sdk.registerFunction("api::claude-bridge-read", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::claude-bridge-read", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Claude bridge not enabled" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::claude-bridge-read",
    config: { api_path: "/agentmemory/claude-bridge/read", http_method: "GET" },
  });

  sdk.registerFunction("api::claude-bridge-sync", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::claude-bridge-sync", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Claude bridge not enabled" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::claude-bridge-sync",
    config: {
      api_path: "/agentmemory/claude-bridge/sync",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::graph-query",
    async (
      req: ApiRequest<{
        startNodeId?: string;
        nodeType?: string;
        maxDepth?: number;
        query?: string;
        limit?: number;
        offset?: number;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      // Whitelist payload fields explicitly; AGENTS.md security rule:
      // REST endpoints never pass raw req.body through to sdk.trigger.
      const payload = {
        startNodeId: req.body?.startNodeId,
        nodeType: req.body?.nodeType,
        maxDepth: req.body?.maxDepth,
        query: req.body?.query,
        limit: req.body?.limit,
        offset: req.body?.offset,
      };
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-query", payload });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-query",
    config: { api_path: "/agentmemory/graph/query", http_method: "POST" },
  });

  sdk.registerFunction("api::graph-stats", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-stats", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-stats",
    config: { api_path: "/agentmemory/graph/stats", http_method: "GET" },
  });

  // #814: explicit snapshot rebuild endpoint. Pays the full graph
  // enumeration once and persists a top-degree subgraph + aggregate
  // counts so subsequent /graph/query and /graph/stats calls skip the
  // unbounded kv.list. Operator-grade endpoint exposed for the viewer
  // banner action and CLI repair.
  sdk.registerFunction("api::graph-snapshot-rebuild",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({
          function_id: "mem::graph-snapshot-rebuild",
          payload: {},
        });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-snapshot-rebuild",
    config: { api_path: "/agentmemory/graph/snapshot-rebuild", http_method: "POST" },
  });

  // #814 v2: clean-restart endpoint for legacy corpora too large for
  // safe rebuild. Wipes graph state without touching observations, so
  // recall + history stay intact while the graph rebuilds incrementally
  // from new extracts (or a one-shot /graph/build replay).
  sdk.registerFunction("api::graph-reset",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({
          function_id: "mem::graph-reset",
          payload: {},
        });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-reset",
    config: { api_path: "/agentmemory/graph/reset", http_method: "POST" },
  });

  sdk.registerFunction("api::graph-extract",
    async (req: ApiRequest<{ observations: unknown[] }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !Array.isArray(req.body?.observations) ||
        req.body.observations.length === 0
      ) {
        return {
          status_code: 400,
          body: { error: "observations array is required" },
        };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-extract", payload: req.body });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-extract",
    config: { api_path: "/agentmemory/graph/extract", http_method: "POST" },
  });

  // Backfill the knowledge graph from existing compressed observations.
  // Viewer calls this when the graph is empty (#666). Iterates every
  // session, collects observations that have a `title` (compressed only),
  // and feeds them through `mem::graph-extract` in batches.
  sdk.registerFunction("api::graph-build",
    async (req: ApiRequest<{ batchSize?: number }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const batchSize = Math.max(
        1,
        Math.min(100, Number((req.body as { batchSize?: number })?.batchSize) || 25),
      );
      try {
        const sessions = await kv.list<Session>(KV.sessions);
        let totalNodes = 0;
        let totalEdges = 0;
        let batchesRun = 0;
        for (const session of sessions) {
          const sid = session?.id;
          if (typeof sid !== "string" || sid.length === 0) continue;
          const observations = await kv.list<CompressedObservation>(KV.observations(sid));
          const compressed = observations.filter((o) => o && typeof o.title === "string" && o.title.length > 0);
          if (compressed.length === 0) continue;
          for (let i = 0; i < compressed.length; i += batchSize) {
            const batch = compressed.slice(i, i + batchSize);
            try {
              const result = (await sdk.trigger({
                function_id: "mem::graph-extract",
                payload: { observations: batch },
              })) as { success?: boolean; nodesAdded?: number; edgesAdded?: number };
              if (result?.success) {
                totalNodes += Number(result.nodesAdded) || 0;
                totalEdges += Number(result.edgesAdded) || 0;
              }
              batchesRun++;
            } catch (err) {
              logger.warn("graph-build batch failed", {
                sessionId: sid,
                batchIndex: Math.floor(i / batchSize),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        return {
          status_code: 200,
          body: {
            success: true,
            sessions: sessions.length,
            batches: batchesRun,
            nodes: totalNodes,
            edges: totalEdges,
          },
        };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-build",
    config: { api_path: "/agentmemory/graph/build", http_method: "POST" },
  });

  sdk.registerFunction("api::consolidate-pipeline",
    async (req: ApiRequest<{ tier?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: req.body || {},
         });
        return { status_code: 200, body: result };
      } catch {
        return consolidationDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::consolidate-pipeline",
    config: {
      api_path: "/agentmemory/consolidate-pipeline",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::team-share", 
    async (
      req: ApiRequest<{ itemId: string; itemType: string; project?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.itemId || !req.body?.itemType) {
        return {
          status_code: 400,
          body: { error: "itemId and itemType are required" },
        };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::team-share", payload: req.body });
        return { status_code: 201, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-share",
    config: { api_path: "/agentmemory/team/share", http_method: "POST" },
  });

  sdk.registerFunction("api::team-feed", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
        const limit = parsedLimit ?? 20;
        const result = await sdk.trigger({ function_id: "mem::team-feed", payload: { limit } });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-feed",
    config: { api_path: "/agentmemory/team/feed", http_method: "GET" },
  });

  sdk.registerFunction("api::team-profile", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::team-profile", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-profile",
    config: { api_path: "/agentmemory/team/profile", http_method: "GET" },
  });

  sdk.registerFunction("api::audit",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const entries = await sdk.trigger({ function_id: "mem::audit-query", payload: {
        operation: req.query_params?.["operation"],
        limit: parsedLimit ?? 50,
      } });
      return { status_code: 200, body: { entries, success: true } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::audit",
    config: { api_path: "/agentmemory/audit", http_method: "GET" },
  });

  sdk.registerFunction("api::governance-delete", 
    async (
      req: ApiRequest<{ memoryIds: string[]; reason?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.memoryIds || !Array.isArray(req.body.memoryIds)) {
        return {
          status_code: 400,
          body: { error: "memoryIds array is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::governance-delete", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::governance-delete",
    config: {
      api_path: "/agentmemory/governance/memories",
      http_method: "DELETE",
    },
  });

  sdk.registerFunction("api::governance-bulk", 
    async (
      req: ApiRequest<{
        type?: string[];
        dateFrom?: string;
        dateTo?: string;
        qualityBelow?: number;
        dryRun?: boolean;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::governance-bulk", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::governance-bulk",
    config: {
      api_path: "/agentmemory/governance/bulk-delete",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::snapshots", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-list", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshots",
    config: { api_path: "/agentmemory/snapshots", http_method: "GET" },
  });

  sdk.registerFunction("api::snapshot-create", 
    async (req: ApiRequest<{ message?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-create", payload: req.body || {},
         });
        return { status_code: 201, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshot-create",
    config: { api_path: "/agentmemory/snapshot/create", http_method: "POST" },
  });

  sdk.registerFunction("api::snapshot-restore", 
    async (req: ApiRequest<{ commitHash: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.commitHash) {
        return { status_code: 400, body: { error: "commitHash is required" } };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-restore", payload: req.body });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshot-restore",
    config: { api_path: "/agentmemory/snapshot/restore", http_method: "POST" },
  });

  sdk.registerFunction("api::memories",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const memories = await kv.list<import("../types.js").Memory>(KV.memories);
      const latest = req.query_params?.["latest"] === "true";
      // agentId filter. Request param wins, env AGENT_ID (when
      // scope=isolated) is the fallback. Shared mode keeps the tag but
      // does not restrict the list endpoint. Pass agentId=* to opt out
      // of the env scope entirely. includeOrphans=true surfaces
      // pre-AGENT_ID memories whose agentId is undefined.
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const includeOrphans =
        req.query_params?.["includeOrphans"] === "true";
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ?? (isAgentScopeIsolated() ? getAgentId() : undefined);
      let filtered = latest ? memories.filter((m) => m.isLatest) : memories;
      if (filterAgentId) {
        filtered = filtered.filter(
          (m) =>
            m.agentId === filterAgentId ||
            (includeOrphans && m.agentId === undefined),
        );
      }

      // viewer + `agentmemory status` were hitting this endpoint to
      // count memories. On a real corpus (8K+ memories) the unbounded
      // response either timed out at the iii engine boundary ("Invocation
      // stopped") or arrived too large for the viewer to render — so the
      // UI showed 0 memories despite a healthy store. Two opt-in modes:
      //   ?count=true       — totals only, no payload
      //   ?limit=N&offset=M — page slice (default unlimited for back-compat)
      if (req.query_params?.["count"] === "true") {
        // Match the SAME scope that the list path applies — returning
        // unfiltered totals here would leak cross-agent counts to a
        // caller that's blocked from the underlying rows.
        return {
          status_code: 200,
          body: {
            total: filtered.length,
            latestCount: filtered.filter((m) => m.isLatest).length,
          },
        };
      }

      const rawLimit = req.query_params?.["limit"];
      const rawOffset = req.query_params?.["offset"];
      const parsedLimit =
        typeof rawLimit === "string" ? Number(rawLimit) : Number.NaN;
      const parsedOffset =
        typeof rawOffset === "string" ? Number(rawOffset) : Number.NaN;
      const limit =
        Number.isInteger(parsedLimit) && parsedLimit > 0
          ? Math.min(parsedLimit, 5000)
          : undefined;
      const offset =
        Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
      const sliced =
        limit !== undefined ? filtered.slice(offset, offset + limit) : filtered;

      return {
        status_code: 200,
        body: {
          memories: sliced,
          total: filtered.length,
          offset,
          limit: limit ?? null,
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memories",
    config: { api_path: "/agentmemory/memories", http_method: "GET" },
  });

  sdk.registerFunction("api::memory-by-id",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const id = req.path_params?.["id"];
      if (!id || typeof id !== "string") {
        return { status_code: 400, body: { error: "id path parameter is required" } };
      }
      const memory = await kv.get<import("../types.js").Memory>(KV.memories, id);
      if (!memory) {
        return { status_code: 404, body: { error: `memory not found: ${id}` } };
      }
      return { status_code: 200, body: { memory } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-by-id",
    config: { api_path: "/agentmemory/memories/:id", http_method: "GET" },
  });

  sdk.registerFunction("api::semantic-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const semantic = await kv.list<import("../types.js").SemanticMemory>(KV.semantic);
      return { status_code: 200, body: { semantic } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::semantic-list",
    config: { api_path: "/agentmemory/semantic", http_method: "GET" },
  });

  sdk.registerFunction("api::procedural-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const procedural = await kv.list<import("../types.js").ProceduralMemory>(KV.procedural);
      return { status_code: 200, body: { procedural } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::procedural-list",
    config: { api_path: "/agentmemory/procedural", http_method: "GET" },
  });

  sdk.registerFunction("api::relations-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const relations = await kv.list<import("../types.js").MemoryRelation>(KV.relations);
      return { status_code: 200, body: { relations } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::relations-list",
    config: { api_path: "/agentmemory/relations", http_method: "GET" },
  });

  sdk.registerFunction("api::vision-search",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const queryText = asNonEmptyString(body["queryText"]);
      const queryImageRef = asNonEmptyString(body["queryImageRef"]);
      const queryImageBase64 = asNonEmptyString(body["queryImageBase64"]);
      const sessionId = asNonEmptyString(body["sessionId"]);
      if (!queryText && !queryImageRef && !queryImageBase64) {
        return {
          status_code: 400,
          body: { error: "queryText, queryImageRef, or queryImageBase64 required" },
        };
      }
      const topKParsed = parseOptionalPositiveInt(body["topK"]);
      if (topKParsed === null) {
        return { status_code: 400, body: { error: "topK must be a positive integer" } };
      }
      const payload: Record<string, unknown> = {};
      if (queryText) payload["queryText"] = queryText;
      if (queryImageRef) payload["queryImageRef"] = queryImageRef;
      if (queryImageBase64) payload["queryImageBase64"] = queryImageBase64;
      if (sessionId) payload["sessionId"] = sessionId;
      if (topKParsed !== undefined) payload["topK"] = Math.min(50, topKParsed);
      const result = await sdk.trigger({ function_id: "mem::vision-search", payload });
      const resp = result as { success?: boolean; error?: string };
      if (resp?.success === false) {
        return { status_code: resp.error?.includes("disabled") ? 503 : 400, body: resp };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::vision-search",
    config: { api_path: "/agentmemory/vision-search", http_method: "POST" },
  });

  sdk.registerFunction("api::vision-embed",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const imageRef = asNonEmptyString(body["imageRef"]);
      const sessionId = asNonEmptyString(body["sessionId"]);
      const observationId = asNonEmptyString(body["observationId"]);
      if (!imageRef) {
        return { status_code: 400, body: { error: "imageRef is required" } };
      }
      const payload: Record<string, unknown> = { imageRef };
      if (sessionId) payload["sessionId"] = sessionId;
      if (observationId) payload["observationId"] = observationId;
      const result = await sdk.trigger({ function_id: "mem::vision-embed", payload });
      const resp = result as { success?: boolean; error?: string };
      if (resp?.success === false) {
        return { status_code: resp.error?.includes("disabled") ? 503 : 400, body: resp };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::vision-embed",
    config: { api_path: "/agentmemory/vision-embed", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-list", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const result = await sdk.trigger({ function_id: "mem::slot-list", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-list",
    config: { api_path: "/agentmemory/slots", http_method: "GET" },
  });

  sdk.registerFunction("api::slot-get", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const label = asNonEmptyString(req.query_params?.["label"]);
    if (!label) return { status_code: 400, body: { error: "label query param required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-get", payload: { label } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("not found") ? 404 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-get",
    config: { api_path: "/agentmemory/slot", http_method: "GET" },
  });

  sdk.registerFunction("api::slot-create", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    if (!label) return { status_code: 400, body: { error: "label required" } };
    // Reject malformed inputs instead of silently dropping them.
    if (body["content"] !== undefined && typeof body["content"] !== "string") {
      return { status_code: 400, body: { error: "content must be a string" } };
    }
    if (body["description"] !== undefined && typeof body["description"] !== "string") {
      return { status_code: 400, body: { error: "description must be a string" } };
    }
    if (body["pinned"] !== undefined && typeof body["pinned"] !== "boolean") {
      return { status_code: 400, body: { error: "pinned must be a boolean" } };
    }
    if (
      body["scope"] !== undefined &&
      body["scope"] !== "project" &&
      body["scope"] !== "global"
    ) {
      return { status_code: 400, body: { error: "scope must be 'project' or 'global'" } };
    }
    const sizeLimit = parseOptionalPositiveInt(body["sizeLimit"]);
    if (sizeLimit === null) {
      return { status_code: 400, body: { error: "sizeLimit must be a positive integer" } };
    }
    if (sizeLimit !== undefined && sizeLimit > 20000) {
      return { status_code: 400, body: { error: "sizeLimit must be <= 20000" } };
    }
    const payload: Record<string, unknown> = { label };
    if (typeof body["content"] === "string") payload["content"] = body["content"];
    if (typeof body["description"] === "string") payload["description"] = body["description"];
    if (sizeLimit !== undefined) payload["sizeLimit"] = sizeLimit;
    if (typeof body["pinned"] === "boolean") payload["pinned"] = body["pinned"];
    if (body["scope"] === "project" || body["scope"] === "global") payload["scope"] = body["scope"];
    const result = await sdk.trigger({ function_id: "mem::slot-create", payload });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("exists") ? 409 : 400, body: resp };
    }
    return { status_code: 201, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-create",
    config: { api_path: "/agentmemory/slot", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-append", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    const text = typeof body["text"] === "string" ? body["text"] : null;
    if (!label || !text) return { status_code: 400, body: { error: "label and text required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-append", payload: { label, text } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      const notFound = resp.error?.includes("not found");
      const overLimit = resp.error?.includes("exceed");
      return { status_code: notFound ? 404 : overLimit ? 413 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-append",
    config: { api_path: "/agentmemory/slot/append", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-replace", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    const content = body["content"];
    if (!label || typeof content !== "string") {
      return { status_code: 400, body: { error: "label and content (string) required" } };
    }
    const result = await sdk.trigger({ function_id: "mem::slot-replace", payload: { label, content } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      const notFound = resp.error?.includes("not found");
      const overLimit = resp.error?.includes("exceed");
      return { status_code: notFound ? 404 : overLimit ? 413 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-replace",
    config: { api_path: "/agentmemory/slot/replace", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-delete", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const label = asNonEmptyString(req.query_params?.["label"]);
    if (!label) return { status_code: 400, body: { error: "label query param required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-delete", payload: { label } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("not found") ? 404 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-delete",
    config: { api_path: "/agentmemory/slot", http_method: "DELETE" },
  });

  sdk.registerFunction("api::slot-reflect", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    if (!isReflectEnabled()) return reflectDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = asNonEmptyString(body["sessionId"]);
    if (!sessionId) return { status_code: 400, body: { error: "sessionId required" } };
    const maxObservations = parseOptionalPositiveInt(body["maxObservations"]);
    if (maxObservations === null) return { status_code: 400, body: { error: "maxObservations must be a positive integer" } };
    const payload: Record<string, unknown> = { sessionId };
    if (maxObservations !== undefined) payload["maxObservations"] = maxObservations;
    const result = await sdk.trigger({ function_id: "mem::slot-reflect", payload });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-reflect",
    config: { api_path: "/agentmemory/slot/reflect", http_method: "POST" },
  });

  sdk.registerFunction("api::action-create",
    async (
      req: ApiRequest<{
        title: string;
        description?: string;
        priority?: number;
        createdBy?: string;
        project?: string;
        tags?: string[];
        parentId?: string;
        edges?: Array<{ type: string; targetActionId: string }>;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.title) {
        return { status_code: 400, body: { error: "title is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-create",
    config: { api_path: "/agentmemory/actions", http_method: "POST" },
  });

  sdk.registerFunction("api::action-update", 
    async (
      req: ApiRequest<{
        actionId: string;
        status?: string;
        title?: string;
        description?: string;
        priority?: number;
        result?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId) {
        return { status_code: 400, body: { error: "actionId is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-update", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-update",
    config: { api_path: "/agentmemory/actions/update", http_method: "POST" },
  });

  sdk.registerFunction("api::action-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::action-list", payload: {
        status: req.query_params?.["status"],
        project: req.query_params?.["project"],
        parentId: req.query_params?.["parentId"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-list",
    config: { api_path: "/agentmemory/actions", http_method: "GET" },
  });

  sdk.registerFunction("api::action-get", 
    async (req: ApiRequest<{ actionId: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const actionId = req.query_params?.["actionId"] as string;
      if (!actionId) {
        return { status_code: 400, body: { error: "actionId required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-get", payload: { actionId } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-get",
    config: { api_path: "/agentmemory/actions/get", http_method: "GET" },
  });

  sdk.registerFunction("api::action-edge", 
    async (
      req: ApiRequest<{
        sourceActionId: string;
        targetActionId: string;
        type: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sourceActionId || !req.body?.targetActionId || !req.body?.type) {
        return { status_code: 400, body: { error: "sourceActionId, targetActionId, and type are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-edge-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-edge",
    config: { api_path: "/agentmemory/actions/edges", http_method: "POST" },
  });

  sdk.registerFunction("api::frontier", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const result = await sdk.trigger({ function_id: "mem::frontier", payload: {
        project: req.query_params?.["project"],
        agentId: req.query_params?.["agentId"],
        limit: parsedLimit,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::frontier",
    config: { api_path: "/agentmemory/frontier", http_method: "GET" },
  });

  sdk.registerFunction("api::next", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::next", payload: {
        project: req.query_params?.["project"],
        agentId: req.query_params?.["agentId"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::next",
    config: { api_path: "/agentmemory/next", http_method: "GET" },
  });

  sdk.registerFunction("api::lease-acquire", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; ttlMs?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-acquire", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-acquire",
    config: { api_path: "/agentmemory/leases/acquire", http_method: "POST" },
  });

  sdk.registerFunction("api::lease-release", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; result?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-release", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-release",
    config: { api_path: "/agentmemory/leases/release", http_method: "POST" },
  });

  sdk.registerFunction("api::lease-renew", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; ttlMs?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-renew", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-renew",
    config: { api_path: "/agentmemory/leases/renew", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-create",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!asNonEmptyString(body.name) || !Array.isArray(body.steps)) {
        return {
          status_code: 400,
          body: { error: "name and steps are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-create",
    config: { api_path: "/agentmemory/routines", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::routine-list", payload: {
        frozen: req.query_params?.["frozen"] === "true" ? true : undefined,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-list",
    config: { api_path: "/agentmemory/routines", http_method: "GET" },
  });

  sdk.registerFunction("api::routine-run", 
    async (
      req: ApiRequest<{ routineId: string; project?: string; initiatedBy?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.routineId) {
        return { status_code: 400, body: { error: "routineId is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-run", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-run",
    config: { api_path: "/agentmemory/routines/run", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-status", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const runId = req.query_params?.["runId"] as string;
      if (!runId) {
        return { status_code: 400, body: { error: "runId query param required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-status", payload: { runId } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-status",
    config: { api_path: "/agentmemory/routines/status", http_method: "GET" },
  });

  sdk.registerFunction("api::signal-send", 
    async (
      req: ApiRequest<{
        from: string;
        to?: string;
        content: string;
        type?: string;
        replyTo?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.from || !req.body?.content) {
        return { status_code: 400, body: { error: "from and content are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::signal-send", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::signal-send",
    config: { api_path: "/agentmemory/signals/send", http_method: "POST" },
  });

  sdk.registerFunction("api::signal-read", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const agentId = req.query_params?.["agentId"] as string;
      if (!agentId) {
        return { status_code: 400, body: { error: "agentId query param required" } };
      }
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const result = await sdk.trigger({ function_id: "mem::signal-read", payload: {
        agentId,
        unreadOnly: req.query_params?.["unreadOnly"] === "true",
        threadId: req.query_params?.["threadId"],
        limit: parsedLimit,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::signal-read",
    config: { api_path: "/agentmemory/signals", http_method: "GET" },
  });

  sdk.registerFunction(
    "api::handoff-update",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const response = await callWhitelistedFunction(
        sdk,
        req,
        "mem::handoff-update",
        HANDOFF_UPDATE_FIELDS,
      );
      if (response.status_code !== 200) return response;
      const success = isRecord(response.body) && response.body.success === true;
      return { status_code: success ? 200 : 400, body: response.body };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::handoff-update",
    config: { api_path: "/agentmemory/handoffs/status", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-create", 
    async (
      req: ApiRequest<{
        name: string;
        description?: string;
        type?: string;
        linkedActionIds?: string[];
        expiresInMs?: number;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.name) {
        return { status_code: 400, body: { error: "name is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::checkpoint-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-create",
    config: { api_path: "/agentmemory/checkpoints", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-resolve", 
    async (
      req: ApiRequest<{
        checkpointId: string;
        status: string;
        resolvedBy?: string;
        result?: unknown;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.checkpointId || !req.body?.status) {
        return { status_code: 400, body: { error: "checkpointId and status are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::checkpoint-resolve", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-resolve",
    config: { api_path: "/agentmemory/checkpoints/resolve", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::checkpoint-list", payload: {
        status: req.query_params?.["status"],
        type: req.query_params?.["type"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-list",
    config: { api_path: "/agentmemory/checkpoints", http_method: "GET" },
  });

  sdk.registerFunction("api::mesh-register", 
    async (
      req: ApiRequest<{ url: string; name: string; sharedScopes?: string[] }>,
    ): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.url || !req.body?.name) {
        return { status_code: 400, body: { error: "url and name are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::mesh-register", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-register",
    config: { api_path: "/agentmemory/mesh/peers", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-list", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-list", payload: {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-list",
    config: { api_path: "/agentmemory/mesh/peers", http_method: "GET" },
  });

  sdk.registerFunction("api::mesh-sync", 
    async (
      req: ApiRequest<{ peerId?: string; direction?: string }>,
    ): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-sync", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-sync",
    config: { api_path: "/agentmemory/mesh/sync", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-receive", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-receive", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-receive",
    config: { api_path: "/agentmemory/mesh/receive", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-export", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const since = req.query_params?.["since"] as string;
      if (since) {
        const parsed = new Date(since).getTime();
        if (Number.isNaN(parsed)) {
          return { status_code: 400, body: { error: "Invalid 'since' date format" } };
        }
      }
      const project = req.query_params?.["project"] as string | undefined;
      const sinceTime = since ? new Date(since).getTime() : 0;
      const df = <T>(items: T[], field: "updatedAt" | "createdAt") =>
        items.filter((i) => new Date((i as Record<string, unknown>)[field] as string).getTime() > sinceTime);
      const memories = await kv.list<import("../types.js").Memory>(KV.memories);
      let actions = await kv.list<import("../types.js").Action>(KV.actions);
      if (project) {
        actions = actions.filter((a) => a.project === project);
      }
      const body: Record<string, unknown> = {
        memories: df(memories, "updatedAt"),
        actions: df(actions, "updatedAt"),
      };
      if (!project) {
        const semantic = await kv.list<import("../types.js").SemanticMemory>(KV.semantic);
        const procedural = await kv.list<import("../types.js").ProceduralMemory>(KV.procedural);
        const relations = await kv.list<import("../types.js").MemoryRelation>(KV.relations);
        const graphNodes = await kv.list<import("../types.js").GraphNode>(KV.graphNodes);
        const graphEdges = await kv.list<import("../types.js").GraphEdge>(KV.graphEdges);
        body.semantic = df(semantic, "updatedAt");
        body.procedural = df(procedural, "updatedAt");
        body.relations = df(relations, "createdAt");
        body.graphNodes = graphNodes.filter(
          (n) => new Date(n.updatedAt || n.createdAt).getTime() > sinceTime,
        );
        body.graphEdges = df(graphEdges, "createdAt");
      }
      return { status_code: 200, body };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-export",
    config: { api_path: "/agentmemory/mesh/export", http_method: "GET" },
  });

  sdk.registerFunction("api::flow-compress", 
    async (
      req: ApiRequest<{
        runId?: string;
        actionIds?: string[];
        project?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::flow-compress", payload: req.body || {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Flow compression requires a provider" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::flow-compress",
    config: { api_path: "/agentmemory/flow/compress", http_method: "POST" },
  });

  sdk.registerFunction("api::branch-detect", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::detect-worktree", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-detect",
    config: { api_path: "/agentmemory/branch/detect", http_method: "GET" },
  });

  sdk.registerFunction("api::branch-worktrees", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::list-worktrees", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-worktrees",
    config: { api_path: "/agentmemory/branch/worktrees", http_method: "GET" },
  });

  sdk.registerFunction("api::branch-sessions", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::branch-sessions", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-sessions",
    config: { api_path: "/agentmemory/branch/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::viewer", 
    async (req: ApiRequest): Promise<Response> => {
      const denied = checkAuth(req, secret);
      if (denied) return denied;
      const rendered = renderViewerDocument();
      if (rendered.found) {
        return {
          status_code: 200,
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": rendered.csp,
          },
          body: rendered.html,
        };
      }
      return {
        status_code: 404,
        headers: {
          "Content-Type": "text/html",
        },
        body: "<!DOCTYPE html><html><body><h1>agentmemory</h1><p>viewer not found</p></body></html>",
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::viewer",
    config: { api_path: "/agentmemory/viewer", http_method: "GET" },
  });

  sdk.registerFunction("api::sentinel-create",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.name) return { status_code: 400, body: { error: "name is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-create", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-create", config: { api_path: "/agentmemory/sentinels", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-trigger",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sentinelId) return { status_code: 400, body: { error: "sentinelId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-trigger", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-trigger", config: { api_path: "/agentmemory/sentinels/trigger", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-check",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const result = await sdk.trigger({ function_id: "mem::sentinel-check", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-check", config: { api_path: "/agentmemory/sentinels/check", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-cancel",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sentinelId) return { status_code: 400, body: { error: "sentinelId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-cancel", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-cancel", config: { api_path: "/agentmemory/sentinels/cancel", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::sentinel-list", payload: { status: params.status, type: params.type } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-list", config: { api_path: "/agentmemory/sentinels", http_method: "GET" } });

  sdk.registerFunction("api::sketch-create",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.title) return { status_code: 400, body: { error: "title is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-create", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-create", config: { api_path: "/agentmemory/sketches", http_method: "POST" } });

  sdk.registerFunction("api::sketch-add",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId || !body?.title) return { status_code: 400, body: { error: "sketchId and title are required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-add", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-add", config: { api_path: "/agentmemory/sketches/add", http_method: "POST" } });

  sdk.registerFunction("api::sketch-promote",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId) return { status_code: 400, body: { error: "sketchId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-promote", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-promote", config: { api_path: "/agentmemory/sketches/promote", http_method: "POST" } });

  sdk.registerFunction("api::sketch-discard",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId) return { status_code: 400, body: { error: "sketchId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-discard", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-discard", config: { api_path: "/agentmemory/sketches/discard", http_method: "POST" } });

  sdk.registerFunction("api::sketch-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::sketch-list", payload: { status: params.status, project: params.project } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-list", config: { api_path: "/agentmemory/sketches", http_method: "GET" } });

  sdk.registerFunction("api::sketch-gc",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const result = await sdk.trigger({ function_id: "mem::sketch-gc", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-gc", config: { api_path: "/agentmemory/sketches/gc", http_method: "POST" } });

  sdk.registerFunction("api::crystallize",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.actionIds) return { status_code: 400, body: { error: "actionIds is required" } };
    const result = await sdk.trigger({ function_id: "mem::crystallize", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::crystallize", config: { api_path: "/agentmemory/crystals/create", http_method: "POST" } });

  sdk.registerFunction("api::crystal-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::crystal-list", payload: { project: params.project, sessionId: params.sessionId, limit } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::crystal-list", config: { api_path: "/agentmemory/crystals", http_method: "GET" } });

  sdk.registerFunction("api::auto-crystallize",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::auto-crystallize", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::auto-crystallize", config: { api_path: "/agentmemory/crystals/auto", http_method: "POST" } });

  sdk.registerFunction("api::diagnose",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::diagnose", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::diagnose", config: { api_path: "/agentmemory/diagnostics", http_method: "POST" } });

  sdk.registerFunction("api::heal",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::heal", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::heal", config: { api_path: "/agentmemory/diagnostics/heal", http_method: "POST" } });

  sdk.registerFunction("api::facet-tag",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.targetId || !body?.dimension || !body?.value) return { status_code: 400, body: { error: "targetId, dimension, and value are required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-tag", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-tag", config: { api_path: "/agentmemory/facets", http_method: "POST" } });

  sdk.registerFunction("api::facet-untag",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.targetId || !body?.dimension) return { status_code: 400, body: { error: "targetId and dimension are required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-untag", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-untag", config: { api_path: "/agentmemory/facets/remove", http_method: "POST" } });

  sdk.registerFunction("api::facet-query",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::facet-query", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-query", config: { api_path: "/agentmemory/facets/query", http_method: "POST" } });

  sdk.registerFunction("api::facet-get",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    if (!params.targetId) return { status_code: 400, body: { error: "targetId query param is required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-get", payload: { targetId: params.targetId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-get", config: { api_path: "/agentmemory/facets", http_method: "GET" } });

  sdk.registerFunction("api::facet-stats",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::facet-stats", payload: { targetType: params.targetType } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-stats", config: { api_path: "/agentmemory/facets/stats", http_method: "GET" } });

  sdk.registerFunction("api::verify",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.id || typeof body.id !== "string") return { status_code: 400, body: { error: "id is required" } };
    const result = await sdk.trigger({ function_id: "mem::verify", payload: { id: body.id } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::verify", config: { api_path: "/agentmemory/verify", http_method: "POST" } });

  sdk.registerFunction("api::cascade-update",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.supersededMemoryId || typeof body.supersededMemoryId !== "string") {
      return { status_code: 400, body: { error: "supersededMemoryId is required" } };
    }
    const result = await sdk.trigger({ function_id: "mem::cascade-update", payload: { supersededMemoryId: body.supersededMemoryId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::cascade-update", config: { api_path: "/agentmemory/cascade-update", http_method: "POST" } });

  sdk.registerFunction("api::lesson-save",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.content || typeof body.content !== "string") return { status_code: 400, body: { error: "content is required" } };
    const tags = typeof body.tags === "string" ? (body.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean) : Array.isArray(body.tags) ? body.tags : [];
    const result = (await sdk.trigger({
      function_id: "mem::lesson-save",
      payload: {
        content: body.content,
        context: body.context || "",
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        project: typeof body.project === "string" ? body.project : undefined,
        tags,
        source: "manual",
      },
    })) as { action?: string };
    const statusCode = result?.action === "created" ? 201 : 200;
    return { status_code: statusCode, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-save", config: { api_path: "/agentmemory/lessons", http_method: "POST" } });

  sdk.registerFunction("api::lesson-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const minConfidence = parseOptionalFiniteNumber(params.minConfidence);
    if (minConfidence === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: minConfidence" },
      };
    }
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::lesson-list", payload: {
      project: params.project,
      source: params.source,
      minConfidence,
      limit,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-list", config: { api_path: "/agentmemory/lessons", http_method: "GET" } });

  sdk.registerFunction("api::lesson-search",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.query || typeof body.query !== "string") return { status_code: 400, body: { error: "query is required" } };
    const result = await sdk.trigger({ function_id: "mem::lesson-recall", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-search", config: { api_path: "/agentmemory/lessons/search", http_method: "POST" } });

  sdk.registerFunction("api::lesson-strengthen",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.lessonId || typeof body.lessonId !== "string") return { status_code: 400, body: { error: "lessonId is required" } };
    const result = await sdk.trigger({ function_id: "mem::lesson-strengthen", payload: { lessonId: body.lessonId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-strengthen", config: { api_path: "/agentmemory/lessons/strengthen", http_method: "POST" } });

  sdk.registerFunction("api::obsidian-export", async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = (req.body as Record<string, unknown>) || {};
    const vaultDir = asNonEmptyString(body.vaultDir);
    if (!vaultDir) {
      return {
        status_code: 400,
        body: { error: "vaultDir must be a non-empty string" },
      };
    }
    const types = typeof body.types === "string" ? body.types.split(",").map((t: string) => t.trim()).filter(Boolean) : undefined;
    const result = await sdk.trigger({ function_id: "mem::obsidian-export", payload: { vaultDir, types } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::obsidian-export", config: { api_path: "/agentmemory/obsidian/export", http_method: "POST" } });

  sdk.registerFunction("api::reflect",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = (req.body as Record<string, unknown>) || {};
    const result = await sdk.trigger({ function_id: "mem::reflect", payload: {
      project: typeof body.project === "string" ? body.project : undefined,
      maxClusters: typeof body.maxClusters === "number" ? body.maxClusters : undefined,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::reflect", config: { api_path: "/agentmemory/reflect", http_method: "POST" } });

  sdk.registerFunction("api::insight-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const minConfidence = parseOptionalFiniteNumber(params.minConfidence);
    if (minConfidence === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: minConfidence" },
      };
    }
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::insight-list", payload: {
      project: params.project,
      minConfidence,
      limit,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::insight-list", config: { api_path: "/agentmemory/insights", http_method: "GET" } });

  sdk.registerFunction("api::insight-search",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.query || typeof body.query !== "string") return { status_code: 400, body: { error: "query is required" } };
    const result = await sdk.trigger({ function_id: "mem::insight-search", payload: {
      query: body.query,
      project: typeof body.project === "string" ? body.project : undefined,
      minConfidence: typeof body.minConfidence === "number" ? body.minConfidence : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::insight-search", config: { api_path: "/agentmemory/insights/search", http_method: "POST" } });
}
