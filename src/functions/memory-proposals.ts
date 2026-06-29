import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { recordAudit } from "./audit.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

type ProposalAction = "create" | "update" | "expire" | "archive" | "restore" | "delete";
type ProposalStatus = "pending" | "approved" | "rejected" | "applied";
type Permission = "project:read" | "project:write" | "governance:delete";

type RoleGrant = {
  name: string;
  permissions: string[];
};

type RequestAccess = {
  actorId?: string;
  permissions: string[];
  roles: string[];
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function roleNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (isRecord(item)) {
          return nonEmptyString(item.name) ?? nonEmptyString(item.role);
        }
        return undefined;
      })
      .filter((item): item is string => Boolean(item));
  }
  if (!isRecord(value)) return [];
  return Object.keys(value).filter(Boolean);
}

function roleGrants(value: unknown): RoleGrant[] {
  const grants: RoleGrant[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const name = nonEmptyString(item.name) ?? nonEmptyString(item.role);
      const permissions = stringArray(item.permissions);
      if (name && permissions.length > 0) grants.push({ name, permissions });
    }
    return grants;
  }
  if (!isRecord(value)) return grants;
  for (const [name, role] of Object.entries(value)) {
    if (Array.isArray(role)) {
      const permissions = stringArray(role);
      if (permissions.length > 0) grants.push({ name, permissions });
    } else if (isRecord(role)) {
      const permissions = stringArray(role.permissions);
      if (permissions.length > 0) grants.push({ name, permissions });
    }
  }
  return grants;
}

function requestRecords(input: Record<string, unknown>): Record<string, unknown>[] {
  return [
    input,
    input.auth,
    input.access,
    input.actor,
    input.requestContext,
    input.request,
  ].filter(isRecord);
}

function resolveAccess(input: Record<string, unknown>): RequestAccess {
  const permissions: string[] = [];
  const names: string[] = [];
  const grantPool: RoleGrant[] = [];
  let actorId: string | undefined =
    nonEmptyString(input.actorId) ??
    nonEmptyString(input.requestedBy) ??
    (typeof input.actor === "string" ? nonEmptyString(input.actor) : undefined);

  for (const record of requestRecords(input)) {
    actorId =
      actorId ??
      nonEmptyString(record.actorId) ??
      nonEmptyString(record.userId) ??
      nonEmptyString(record.id);
    permissions.push(...stringArray(record.permissions));
    names.push(...roleNames(record.roles));
    const directGrants = roleGrants(record.roles);
    grantPool.push(...directGrants, ...roleGrants(record.roleGrants));
    for (const grant of directGrants) permissions.push(...grant.permissions);
    if (isRecord(record.teamPolicy)) {
      grantPool.push(...roleGrants(record.teamPolicy.roles));
    }
  }

  const roleSet = new Set(names);
  for (const grant of grantPool) {
    if (roleSet.has(grant.name)) permissions.push(...grant.permissions);
  }

  return {
    actorId,
    permissions: unique(permissions),
    roles: unique(names),
  };
}

function hasPermission(access: RequestAccess, required: Permission): boolean {
  const [domain] = required.split(":");
  return (
    access.permissions.includes("*") ||
    access.permissions.includes(required) ||
    access.permissions.includes(`${domain}:*`)
  );
}

function requirePermissions(
  input: Record<string, unknown>,
  required: Permission[],
): { ok: true; access: RequestAccess } | { ok: false; access: RequestAccess; error: string } {
  const access = resolveAccess(input);
  const missing = required.filter((permission) => !hasPermission(access, permission));
  if (missing.length > 0) {
    return {
      ok: false,
      access,
      error: `missing permissions: ${missing.join(", ")}`,
    };
  }
  return { ok: true, access };
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
  return (
    nonEmptyString(input.teamId) ??
    (isRecord(input.teamPolicy) ? nonEmptyString(input.teamPolicy.teamId) : undefined) ??
    "local"
  );
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

export function registerMemoryProposalFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::memory-proposal-create", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const accessCheck = requirePermissions(data, ["project:write"]);
    if (!accessCheck.ok) return { success: false, error: accessCheck.error };

    const action = normalizeAction(data.action);
    if (!action) return { success: false, error: "action is required" };

    const change = validateChange(action, data.change);
    if (!change.ok) return { success: false, error: change.error };

    const project =
      nonEmptyString(data.project) ??
      (typeof change.change.project === "string" ? nonEmptyString(change.change.project) : undefined);
    if (!project) return { success: false, error: "project is required" };

    const teamId = normalizeTeamId(data);
    const now = new Date().toISOString();
    const proposal: MemoryProposal = {
      id: generateId("mpr"),
      teamId,
      project,
      action,
      status: "pending",
      title: nonEmptyString(data.title),
      reason: nonEmptyString(data.reason),
      targetMemoryId: change.targetMemoryId,
      requiredPermissions: requiredForAction(action),
      change: change.change,
      provenance: isRecord(data.provenance) ? { ...data.provenance } : {},
      proposedBy: accessCheck.access.actorId,
      proposedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    await withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
      const proposals = await loadProposals(kv, teamId);
      proposals.push(proposal);
      await saveProposals(kv, teamId, proposals);
    });
    await auditProposal(kv, "mem::memory-proposal-create", proposal, accessCheck.access.actorId, {
      proposedBy: accessCheck.access.actorId,
      provenance: proposal.provenance,
    });
    return proposalSummaryResult(proposal);
  });

  sdk.registerFunction("mem::memory-proposal-list", async (data?: unknown) => {
    const input = isRecord(data) ? data : {};
    const accessCheck = requirePermissions(input, ["project:read"]);
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
  });

  sdk.registerFunction("mem::memory-proposal-approve", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const teamId = normalizeTeamId(data);
    const proposalId = nonEmptyString(data.proposalId);
    if (!proposalId) return { success: false, error: "proposalId is required" };

    return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
      const proposals = await loadProposals(kv, teamId);
      const proposal = proposals.find((row) => row.id === proposalId);
      if (!proposal) return { success: false, error: "proposal not found" };
      const required = proposal.requiredPermissions;
      const accessCheck = requirePermissions(data, required);
      if (!accessCheck.ok) return { success: false, error: accessCheck.error };
      if (proposal.status !== "pending") {
        return { success: false, error: `proposal is ${proposal.status}` };
      }
      const now = new Date().toISOString();
      proposal.status = "approved";
      proposal.reviewedBy = accessCheck.access.actorId;
      proposal.reviewedAt = now;
      proposal.reviewReason = nonEmptyString(data.reason);
      proposal.updatedAt = now;
      await saveProposals(kv, teamId, proposals);
      await auditProposal(kv, "mem::memory-proposal-approve", proposal, accessCheck.access.actorId, {
        reviewedBy: proposal.reviewedBy,
        reviewReason: proposal.reviewReason,
      });
      return proposalSummaryResult(proposal);
    });
  });

  sdk.registerFunction("mem::memory-proposal-reject", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const accessCheck = requirePermissions(data, ["project:write"]);
    if (!accessCheck.ok) return { success: false, error: accessCheck.error };
    const teamId = normalizeTeamId(data);
    const proposalId = nonEmptyString(data.proposalId);
    if (!proposalId) return { success: false, error: "proposalId is required" };

    return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
      const proposals = await loadProposals(kv, teamId);
      const proposal = proposals.find((row) => row.id === proposalId);
      if (!proposal) return { success: false, error: "proposal not found" };
      if (proposal.status !== "pending") {
        return { success: false, error: `proposal is ${proposal.status}` };
      }
      const now = new Date().toISOString();
      proposal.status = "rejected";
      proposal.reviewedBy = accessCheck.access.actorId;
      proposal.reviewedAt = now;
      proposal.reviewReason = nonEmptyString(data.reason);
      proposal.updatedAt = now;
      await saveProposals(kv, teamId, proposals);
      await auditProposal(kv, "mem::memory-proposal-reject", proposal, accessCheck.access.actorId, {
        reviewedBy: proposal.reviewedBy,
        reviewReason: proposal.reviewReason,
      });
      return proposalSummaryResult(proposal);
    });
  });

  sdk.registerFunction("mem::memory-proposal-apply", async (data: unknown) => {
    if (!isRecord(data)) return { success: false, error: "payload required" };
    const teamId = normalizeTeamId(data);
    const proposalId = nonEmptyString(data.proposalId);
    if (!proposalId) return { success: false, error: "proposalId is required" };

    return withKeyedLock(`mem:memory-proposals:${teamId}`, async () => {
      const proposals = await loadProposals(kv, teamId);
      const proposal = proposals.find((row) => row.id === proposalId);
      if (!proposal) return { success: false, error: "proposal not found" };
      const accessCheck = requirePermissions(data, proposal.requiredPermissions);
      if (!accessCheck.ok) return { success: false, error: accessCheck.error };
      if (proposal.status !== "approved") {
        return { success: false, error: `proposal is ${proposal.status}` };
      }

      const functionId = applyFunctionId(proposal.action);
      const payload = pickPayload(
        proposal,
        accessCheck.access.actorId,
        nonEmptyString(data.reason),
      );
      let result: unknown;
      try {
        result = await sdk.trigger({ function_id: functionId, payload });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await auditProposal(kv, "mem::memory-proposal-apply", proposal, accessCheck.access.actorId, {
          applyFunctionId: functionId,
          applyStatus: "error",
          error: message,
        });
        return { success: false, error: message, proposal };
      }

      if (!isSuccessfulResult(result)) {
        await auditProposal(kv, "mem::memory-proposal-apply", proposal, accessCheck.access.actorId, {
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
        appliedBy: accessCheck.access.actorId,
        functionId,
        targetIds,
        result: resultRecord(result),
      };
      proposal.updatedAt = now;
      await saveProposals(kv, teamId, proposals);
      await auditProposal(kv, "mem::memory-proposal-apply", proposal, accessCheck.access.actorId, {
        applyFunctionId: functionId,
        applyStatus: "applied",
        appliedBy: accessCheck.access.actorId,
        appliedTargetIds: targetIds,
      });
      return { success: true, proposal, result };
    });
  });
}
