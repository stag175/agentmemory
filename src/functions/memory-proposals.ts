import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { recordAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

type ProposalAction = "create" | "update" | "expire" | "archive" | "restore" | "delete";
type ProposalStatus = "pending" | "approved" | "rejected" | "applied";
type Permission = "project:read" | "project:write" | "governance:delete";

export type TeamPolicy = {
  allowSelfApproval?: boolean;
};

// The effective principal is resolved by the trusted caller (the REST/MCP
// integration layer) from the authenticated credential. The proposal
// functions NEVER derive authorization from the request body — they only
// trust the principal handed to them.
export type Principal = {
  actorId: string;
  permissions: string[];
  teamPolicy?: TeamPolicy;
};

type MemoryProposalApplication = {
  appliedAt: string;
  appliedBy?: string;
  functionId: string;
  targetIds: string[];
  result: Record<string, unknown>;
};

export type MemoryProposal = {
  id: string;
  teamId: string;
  project: string;
  action: ProposalAction;
  status: ProposalStatus;
  title?: string;
  reason?: string;
  targetMemoryId?: string;
  requiredPermissions: Permission[];
  change: Record<string, unknown>;
  provenance: Record<string, unknown>;
  proposedBy?: string;
  proposedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewReason?: string;
  application?: MemoryProposalApplication;
  createdAt: string;
  updatedAt: string;
};

type ProposalResult =
  | { success: true; proposal: MemoryProposal; result?: unknown }
  | { success: false; error: string; proposal?: MemoryProposal; result?: unknown };

const PROPOSALS_KEY_PREFIX = "team-memory-proposals:";

const ACTIONS = new Set<ProposalAction>([
  "create",
  "update",
  "expire",
  "archive",
  "restore",
  "delete",
]);

const STATUSES = new Set<ProposalStatus>([
  "pending",
  "approved",
  "rejected",
  "applied",
]);

const CREATE_FIELDS = new Set([
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
]);

const UPDATE_FIELDS = new Set([
  "memoryId",
  "content",
  "title",
  "concepts",
  "files",
  "strength",
  "confidence",
  "lane",
  "reviewState",
  "privacyScope",
  "validFrom",
  "validUntil",
]);

const LIFECYCLE_FIELDS = new Set([
  "memoryId",
  "expiresAt",
]);

const DELETE_FIELDS = new Set([
  "memoryId",
  "mode",
  "sourceObservationId",
  "sourceHash",
  "sourceUri",
  "project",
  "agentId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

// Authorization is granted exclusively by the resolved principal. A
// body-supplied wildcard ("*") is never honored: the integration layer must
// expand effective permissions into concrete grants before resolving the
// principal, so a literal "*" reaching here can only be forged input.
function hasPermission(principal: Principal, required: Permission): boolean {
  const [domain] = required.split(":");
  return (
    principal.permissions.includes(required) ||
    principal.permissions.includes(`${domain}:*`)
  );
}

function requirePermissions(
  principal: Principal,
  required: Permission[],
): { ok: true } | { ok: false; error: string } {
  const missing = required.filter((permission) => !hasPermission(principal, permission));
  if (missing.length > 0) {
    return { ok: false, error: `missing permissions: ${missing.join(", ")}` };
  }
  return { ok: true };
}

// Strip any forged "*" before the principal is used so the wildcard cannot
// satisfy a permission check regardless of where it was injected.
function normalizePrincipal(principal: Principal): Principal {
  const permissions = principal.permissions.filter(
    (permission) => typeof permission === "string" && permission.trim() && permission.trim() !== "*",
  );
  return {
    actorId: principal.actorId,
    permissions: [...new Set(permissions.map((permission) => permission.trim()))],
    teamPolicy: principal.teamPolicy,
  };
}

function readPrincipalFromInput(input: Record<string, unknown>): Principal | undefined {
  const raw = input.principal;
  if (!isRecord(raw)) return undefined;
  const actorId = nonEmptyString(raw.actorId);
  if (!actorId) return undefined;
  const teamPolicy = isRecord(raw.teamPolicy)
    ? { allowSelfApproval: raw.teamPolicy.allowSelfApproval === true }
    : undefined;
  return {
    actorId,
    permissions: stringArray(raw.permissions),
    teamPolicy,
  };
}

function proposalKey(teamId: string): string {
  return `${PROPOSALS_KEY_PREFIX}${teamId}`;
}

async function loadProposals(kv: StateKV, teamId: string): Promise<MemoryProposal[]> {
  const rows = await kv.get<MemoryProposal[]>(KV.state, proposalKey(teamId));
  return Array.isArray(rows) ? rows : [];
}

async function saveProposals(
  kv: StateKV,
  teamId: string,
  proposals: MemoryProposal[],
): Promise<void> {
  await kv.set(KV.state, proposalKey(teamId), proposals);
}

function normalizeTeamId(input: Record<string, unknown>): string {
  return nonEmptyString(input.teamId) ?? "local";
}

function normalizeAction(value: unknown): ProposalAction | undefined {
  const action = nonEmptyString(value) as ProposalAction | undefined;
  return action && ACTIONS.has(action) ? action : undefined;
}

function requiredForAction(action: ProposalAction): Permission[] {
  if (action === "delete") return ["project:write", "governance:delete"];
  return ["project:write"];
}

function allowedFields(action: ProposalAction): Set<string> {
  if (action === "create") return CREATE_FIELDS;
  if (action === "update") return UPDATE_FIELDS;
  if (action === "delete") return DELETE_FIELDS;
  return LIFECYCLE_FIELDS;
}

function validateChange(
  action: ProposalAction,
  change: unknown,
): { ok: true; change: Record<string, unknown>; targetMemoryId?: string } | { ok: false; error: string } {
  if (!isRecord(change)) return { ok: false, error: "change is required" };
  const allowed = allowedFields(action);
  for (const key of Object.keys(change)) {
    if (!allowed.has(key)) return { ok: false, error: `unsupported change field: ${key}` };
  }
  if (action === "create") {
    const content = nonEmptyString(change.content);
    if (!content) return { ok: false, error: "change.content is required" };
    return { ok: true, change: { ...change, content } };
  }

  const targetMemoryId = nonEmptyString(change.memoryId);
  if (action === "delete") {
    const hasSourceSelector =
      nonEmptyString(change.sourceObservationId) ||
      nonEmptyString(change.sourceHash) ||
      nonEmptyString(change.sourceUri);
    if (!targetMemoryId && !hasSourceSelector) {
      return {
        ok: false,
        error: "change.memoryId or a source selector is required",
      };
    }
    const mode = change.mode;
    if (mode !== undefined && mode !== "tombstone" && mode !== "hard") {
      return { ok: false, error: "change.mode must be tombstone or hard" };
    }
    return { ok: true, change: { ...change }, targetMemoryId };
  }

  if (!targetMemoryId) return { ok: false, error: "change.memoryId is required" };
  return { ok: true, change: { ...change }, targetMemoryId };
}

function applyFunctionId(action: ProposalAction): string {
  if (action === "create") return "mem::memory-create";
  return `mem::memory-${action}`;
}

function pickPayload(
  proposal: MemoryProposal,
  actorId: string | undefined,
  reason: string | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const source = proposal.change;
  for (const field of allowedFields(proposal.action)) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      payload[field] = source[field];
    }
  }
  if (proposal.action === "create") {
    if (!payload.project) payload.project = proposal.project;
    return payload;
  }
  if (proposal.targetMemoryId && !payload.memoryId) {
    payload.memoryId = proposal.targetMemoryId;
  }
  payload.reason = reason ?? proposal.reason ?? `approved proposal ${proposal.id}`;
  if (actorId) payload.actor = actorId;
  if (proposal.action === "delete") {
    payload.dryRun = false;
    if (!payload.project) payload.project = proposal.project;
  }
  return payload;
}

function resultRecord(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { value: result };
}

function isSuccessfulResult(result: unknown): boolean {
  return isRecord(result) && result.success === true;
}

function resultError(result: unknown): string {
  if (isRecord(result) && typeof result.error === "string") return result.error;
  return "proposal apply failed";
}

function appliedTargetIds(result: unknown, proposal: MemoryProposal): string[] {
  const ids = new Set<string>();
  if (proposal.targetMemoryId) ids.add(proposal.targetMemoryId);
  if (isRecord(result)) {
    if (isRecord(result.memory)) {
      const id = nonEmptyString(result.memory.id);
      if (id) ids.add(id);
    }
    if (typeof result.memoryId === "string") ids.add(result.memoryId);
    if (Array.isArray(result.deletedIds)) {
      for (const id of stringArray(result.deletedIds)) ids.add(id);
    }
    if (isRecord(result.propagation)) {
      for (const id of stringArray(result.propagation.deletedIds)) ids.add(id);
      for (const id of stringArray(result.propagation.targetIds)) ids.add(id);
    }
  }
  return [...ids];
}

function auditTargetIds(proposal: MemoryProposal): string[] {
  return proposal.targetMemoryId ? [proposal.id, proposal.targetMemoryId] : [proposal.id];
}

async function auditProposal(
  kv: StateKV,
  functionId: string,
  proposal: MemoryProposal,
  actorId: string | undefined,
  details: Record<string, unknown>,
): Promise<void> {
  await recordAudit(kv, "memory_lifecycle", functionId, auditTargetIds(proposal), {
    proposalId: proposal.id,
    teamId: proposal.teamId,
    project: proposal.project,
    action: proposal.action,
    status: proposal.status,
    requiredPermissions: proposal.requiredPermissions,
    ...details,
  }, undefined, actorId);
}

function proposalSummaryResult(proposal: MemoryProposal): {
  success: true;
  proposal: MemoryProposal;
} {
  return { success: true, proposal };
}

// ---------------------------------------------------------------------------
// Core operations. Each takes the effective principal EXPLICITLY from the
// trusted caller. Authorization is never read from the input payload.
// ---------------------------------------------------------------------------

export async function createMemoryProposal(
  kv: StateKV,
  rawPrincipal: Principal,
  input: Record<string, unknown>,
): Promise<ProposalResult> {
  const principal = normalizePrincipal(rawPrincipal);
  const accessCheck = requirePermissions(principal, ["project:write"]);
  if (!accessCheck.ok) return { success: false, error: accessCheck.error };

  const action = normalizeAction(input.action);
  if (!action) return { success: false, error: "action is required" };

  const change = validateChange(action, input.change);
  if (!change.ok) return { success: false, error: change.error };

  const project =
    nonEmptyString(input.project) ??
    (typeof change.change.project === "string" ? nonEmptyString(change.change.project) : undefined);
  if (!project) return { success: false, error: "project is required" };

  const teamId = normalizeTeamId(input);
  const now = new Date().toISOString();
  const proposal: MemoryProposal = {
    id: generateId("mpr"),
    teamId,
    project,
    action,
    status: "pending",
    title: nonEmptyString(input.title),
    reason: nonEmptyString(input.reason),
    targetMemoryId: change.targetMemoryId,
    requiredPermissions: requiredForAction(action),
    change: change.change,
    provenance: isRecord(input.provenance) ? { ...input.provenance } : {},
    proposedBy: principal.actorId,
    proposedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
    const proposals = await loadProposals(kv, teamId);
    proposals.push(proposal);
    await saveProposals(kv, teamId, proposals);
  });
  await auditProposal(kv, "mem::memory-proposal-create", proposal, principal.actorId, {
    proposedBy: principal.actorId,
    userId: principal.actorId,
    provenance: proposal.provenance,
  });
  return proposalSummaryResult(proposal);
}

export async function listMemoryProposals(
  kv: StateKV,
  rawPrincipal: Principal,
  input: Record<string, unknown>,
): Promise<
  | { success: true; proposals: MemoryProposal[]; total: number; offset: number; limit: number }
  | { success: false; error: string }
> {
  const principal = normalizePrincipal(rawPrincipal);
  const accessCheck = requirePermissions(principal, ["project:read"]);
  if (!accessCheck.ok) return { success: false, error: accessCheck.error };

  const teamId = normalizeTeamId(input);
  const project = nonEmptyString(input.project);
  const action = input.action === undefined ? undefined : normalizeAction(input.action);
  if (input.action !== undefined && !action) {
    return { success: false, error: "action is invalid" };
  }
  const status = input.status === undefined
    ? undefined
    : (nonEmptyString(input.status) as ProposalStatus | undefined);
  if (input.status !== undefined && (!status || !STATUSES.has(status))) {
    return { success: false, error: "status is invalid" };
  }
  const targetMemoryId = nonEmptyString(input.targetMemoryId);
  const limit = Math.max(
    1,
    Math.min(typeof input.limit === "number" ? input.limit : 50, 200),
  );
  const offset = Math.max(0, typeof input.offset === "number" ? input.offset : 0);

  let proposals = await loadProposals(kv, teamId);
  if (project) proposals = proposals.filter((proposal) => proposal.project === project);
  if (action) proposals = proposals.filter((proposal) => proposal.action === action);
  if (status) proposals = proposals.filter((proposal) => proposal.status === status);
  if (targetMemoryId) {
    proposals = proposals.filter((proposal) => proposal.targetMemoryId === targetMemoryId);
  }
  proposals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    success: true,
    proposals: proposals.slice(offset, offset + limit),
    total: proposals.length,
    offset,
    limit,
  };
}

export async function approveMemoryProposal(
  kv: StateKV,
  rawPrincipal: Principal,
  input: Record<string, unknown>,
): Promise<ProposalResult> {
  const principal = normalizePrincipal(rawPrincipal);
  const teamId = normalizeTeamId(input);
  const proposalId = nonEmptyString(input.proposalId);
  if (!proposalId) return { success: false, error: "proposalId is required" };

  return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
    const proposals = await loadProposals(kv, teamId);
    const proposal = proposals.find((row) => row.id === proposalId);
    if (!proposal) return { success: false, error: "proposal not found" };
    const accessCheck = requirePermissions(principal, proposal.requiredPermissions);
    if (!accessCheck.ok) return { success: false, error: accessCheck.error };
    if (proposal.status !== "pending") {
      return { success: false, error: `proposal is ${proposal.status}` };
    }
    const allowSelfApproval = principal.teamPolicy?.allowSelfApproval === true;
    if (proposal.proposedBy && principal.actorId === proposal.proposedBy && !allowSelfApproval) {
      return {
        success: false,
        error: "self-approval is not permitted: proposer cannot approve their own proposal",
      };
    }
    const now = new Date().toISOString();
    proposal.status = "approved";
    proposal.reviewedBy = principal.actorId;
    proposal.reviewedAt = now;
    proposal.reviewReason = nonEmptyString(input.reason);
    proposal.updatedAt = now;
    await saveProposals(kv, teamId, proposals);
    await auditProposal(kv, "mem::memory-proposal-approve", proposal, principal.actorId, {
      reviewedBy: proposal.reviewedBy,
      userId: principal.actorId,
      reviewReason: proposal.reviewReason,
    });
    return proposalSummaryResult(proposal);
  });
}

export async function rejectMemoryProposal(
  kv: StateKV,
  rawPrincipal: Principal,
  input: Record<string, unknown>,
): Promise<ProposalResult> {
  const principal = normalizePrincipal(rawPrincipal);
  const teamId = normalizeTeamId(input);
  const proposalId = nonEmptyString(input.proposalId);
  if (!proposalId) return { success: false, error: "proposalId is required" };

  return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
    const proposals = await loadProposals(kv, teamId);
    const proposal = proposals.find((row) => row.id === proposalId);
    if (!proposal) return { success: false, error: "proposal not found" };
    // Reject requires the same governance as the proposal it vetoes so a
    // non-governance actor cannot veto a governance-gated delete.
    const accessCheck = requirePermissions(principal, proposal.requiredPermissions);
    if (!accessCheck.ok) return { success: false, error: accessCheck.error };
    if (proposal.status !== "pending") {
      return { success: false, error: `proposal is ${proposal.status}` };
    }
    const now = new Date().toISOString();
    proposal.status = "rejected";
    proposal.reviewedBy = principal.actorId;
    proposal.reviewedAt = now;
    proposal.reviewReason = nonEmptyString(input.reason);
    proposal.updatedAt = now;
    await saveProposals(kv, teamId, proposals);
    await auditProposal(kv, "mem::memory-proposal-reject", proposal, principal.actorId, {
      reviewedBy: proposal.reviewedBy,
      userId: principal.actorId,
      reviewReason: proposal.reviewReason,
    });
    return proposalSummaryResult(proposal);
  });
}

export async function applyMemoryProposal(
  sdk: ISdk,
  kv: StateKV,
  rawPrincipal: Principal,
  input: Record<string, unknown>,
): Promise<ProposalResult> {
  const principal = normalizePrincipal(rawPrincipal);
  const teamId = normalizeTeamId(input);
  const proposalId = nonEmptyString(input.proposalId);
  if (!proposalId) return { success: false, error: "proposalId is required" };

  return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
    const proposals = await loadProposals(kv, teamId);
    const proposal = proposals.find((row) => row.id === proposalId);
    if (!proposal) return { success: false, error: "proposal not found" };
    const accessCheck = requirePermissions(principal, proposal.requiredPermissions);
    if (!accessCheck.ok) return { success: false, error: accessCheck.error };
    if (proposal.status !== "approved") {
      return { success: false, error: `proposal is ${proposal.status}` };
    }

    const functionId = applyFunctionId(proposal.action);
    const payload = pickPayload(
      proposal,
      principal.actorId,
      nonEmptyString(input.reason),
    );
    let result: unknown;
    try {
      result = await sdk.trigger({ function_id: functionId, payload });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await auditProposal(kv, "mem::memory-proposal-apply", proposal, principal.actorId, {
        applyFunctionId: functionId,
        applyStatus: "error",
        error: message,
      });
      return { success: false, error: message, proposal };
    }

    if (!isSuccessfulResult(result)) {
      await auditProposal(kv, "mem::memory-proposal-apply", proposal, principal.actorId, {
        applyFunctionId: functionId,
        applyStatus: "rejected",
        result: resultRecord(result),
      });
      return {
        success: false,
        error: resultError(result),
        proposal,
        result,
      };
    }

    const now = new Date().toISOString();
    const targetIds = appliedTargetIds(result, proposal);
    proposal.status = "applied";
    proposal.application = {
      appliedAt: now,
      appliedBy: principal.actorId,
      functionId,
      targetIds,
      result: resultRecord(result),
    };
    proposal.updatedAt = now;
    await saveProposals(kv, teamId, proposals);
    await auditProposal(kv, "mem::memory-proposal-apply", proposal, principal.actorId, {
      applyFunctionId: functionId,
      applyStatus: "applied",
      appliedBy: principal.actorId,
      userId: principal.actorId,
      appliedTargetIds: targetIds,
    });
    return { success: true, proposal, result };
  });
}

// The integration layer (src/triggers/api.ts, src/mcp/*) MUST resolve the
// principal from the authenticated credential and attach it as
// data.principal. These handlers refuse to fall back to body-derived
// authorization: a request with no resolved principal is unauthorized.
function principalError(): { success: false; error: string } {
  return { success: false, error: "unauthorized: missing resolved principal" };
}

export function registerMemoryProposalFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::memory-proposal-create", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const principal = readPrincipalFromInput(data);
    if (!principal) return principalError();
    return createMemoryProposal(kv, principal, data);
  });

  sdk.registerFunction("mem::memory-proposal-list", async (data?: unknown) => {
    const input = isRecord(data) ? data : {};
    const principal = readPrincipalFromInput(input);
    if (!principal) return principalError();
    return listMemoryProposals(kv, principal, input);
  });

  sdk.registerFunction("mem::memory-proposal-approve", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const principal = readPrincipalFromInput(data);
    if (!principal) return principalError();
    return approveMemoryProposal(kv, principal, data);
  });

  sdk.registerFunction("mem::memory-proposal-reject", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const principal = readPrincipalFromInput(data);
    if (!principal) return principalError();
    return rejectMemoryProposal(kv, principal, data);
  });

  sdk.registerFunction("mem::memory-proposal-apply", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const principal = readPrincipalFromInput(data);
    if (!principal) return principalError();
    return applyMemoryProposal(sdk, kv, principal, data);
  });
}
