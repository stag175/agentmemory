import { createHash } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { ExportData } from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { safeAudit } from "./audit.js";
import { scanPrivateData } from "./privacy.js";

type SyncMode = "local" | "remote";
type SyncDirection = "push" | "pull" | "both";
type SyncPeerStatus = "ready" | "blocked" | "disabled";
type SyncConflictPolicy = "block" | "merge";
type SyncSnapshotSource = Partial<ExportData> & Record<string, unknown>;
type SyncRunStatus =
  | "planned"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";
type SyncApplyStatus = "planned" | "applied" | "blocked";

type SyncScope =
  | "memories"
  | "actions"
  | "semantic"
  | "procedural"
  | "relations"
  | "graph:nodes"
  | "graph:edges";

interface SyncAuthPolicy {
  kind: "none" | "bearer" | "mtls" | "signed-request";
  tokenEnv?: string;
  secretRef?: string;
  certificateRef?: string;
  audience?: string;
}

interface SyncScopePolicy {
  allowedScopes: SyncScope[];
  direction: SyncDirection;
  workspaceIds: string[];
  maxItems?: number;
  remoteModeApproved: boolean;
}

interface SyncPeer {
  kind: "sync-peer";
  id: string;
  name: string;
  mode: SyncMode;
  endpoint: string;
  endpointHost: string;
  loopback: boolean;
  enabled: boolean;
  status: SyncPeerStatus;
  statusReasons: string[];
  authPolicy: SyncAuthPolicy;
  scopePolicy: SyncScopePolicy;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

interface SyncWorkspace {
  kind: "sync-workspace";
  id: string;
  name: string;
  workspaceRoot?: string;
  localOnly: boolean;
  enabled: boolean;
  allowedScopes: SyncScope[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

interface SyncPlanAction {
  actionId: string;
  peerId: string;
  workspaceId: string;
  mode: SyncMode;
  direction: SyncDirection;
  scopes: SyncScope[];
  dryRun: true;
  status: "ready" | "blocked";
  reasons: string[];
  evidence: Record<string, unknown>;
}

interface SyncPlan {
  id: string;
  dryRun: true;
  createdAt: string;
  direction: SyncDirection;
  requestedScopes: SyncScope[];
  actions: SyncPlanAction[];
  summary: {
    peers: number;
    workspaces: number;
    ready: number;
    blocked: number;
  };
  warnings: string[];
}

interface SyncRun {
  kind: "sync-run";
  id: string;
  planId?: string;
  peerId?: string;
  workspaceId?: string;
  mode: SyncMode;
  direction: SyncDirection;
  status: SyncRunStatus;
  dryRun: boolean;
  startedAt: string;
  endedAt?: string;
  itemCounts: Record<SyncScope, number>;
  errors: string[];
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface SyncSnapshotCandidate {
  scope: SyncScope;
  sourceId: string;
  digest: string;
  payload: Record<string, unknown>;
  sourceUpdatedAt?: string;
}

interface SyncSnapshotRecord extends SyncSnapshotCandidate {
  kind: "sync-snapshot";
  id: string;
  workspaceId: string;
  appliedAt: string;
  applyId: string;
  previousDigest?: string;
}

interface SyncConflict {
  scope: SyncScope;
  sourceId: string;
  snapshotId: string;
  existingDigest: string;
  incomingDigest: string;
  reason: "digest_mismatch";
}

interface SyncApplyRecord {
  kind: "sync-apply";
  id: string;
  planId?: string;
  peerId: string;
  workspaceId: string;
  mode: SyncMode;
  direction: SyncDirection;
  status: SyncApplyStatus;
  dryRun: boolean;
  approved: boolean;
  conflictPolicy: SyncConflictPolicy;
  scopes: SyncScope[];
  itemCounts: Record<SyncScope, number>;
  appliedCounts: Record<SyncScope, number>;
  unchangedCounts: Record<SyncScope, number>;
  conflictCount: number;
  conflicts: SyncConflict[];
  snapshotIds: string[];
  errors: string[];
  evidence: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:3111/";
const DEFAULT_SCOPES: SyncScope[] = [
  "memories",
  "actions",
  "semantic",
  "procedural",
  "relations",
];
const ALL_SCOPES: SyncScope[] = [
  "memories",
  "actions",
  "semantic",
  "procedural",
  "relations",
  "graph:nodes",
  "graph:edges",
];
const DIRECTIONS: SyncDirection[] = ["push", "pull", "both"];
const RUN_STATUSES: SyncRunStatus[] = [
  "planned",
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
];
const SECRET_FIELD_RE = /(?:token|secret|password|credential|authorization|api[_-]?key)/i;
const MAX_EVIDENCE_DEPTH = 4;
const MAX_EVIDENCE_ARRAY = 50;
const MAX_EVIDENCE_KEYS = 50;

const stateKey = {
  peer: (id: string) => `sync:peer:${id}`,
  workspace: (id: string) => `sync:workspace:${id}`,
  run: (id: string) => `sync:run:${id}`,
  apply: (id: string) => `sync:apply:${id}`,
  snapshot: (id: string) => `sync:snapshot:${id}`,
};

export function registerSyncControlPlaneFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::sync-peer-register", async (data: unknown) => {
    const parsed = normalizePeerInput(data);
    if (!parsed.ok) return { success: false, error: parsed.error };

    const now = new Date().toISOString();
    const existing = await findPeerByEndpoint(kv, parsed.endpoint.url);
    if (existing) {
      return { success: false, error: "peer already registered", peerId: existing.id };
    }

    const statusReasons = peerStatusReasons(parsed.mode, parsed.endpoint.loopback, parsed.enabled);
    const peer: SyncPeer = {
      kind: "sync-peer",
      id: generateId("syncpeer"),
      name: parsed.name,
      mode: parsed.mode,
      endpoint: parsed.endpoint.url,
      endpointHost: parsed.endpoint.host,
      loopback: parsed.endpoint.loopback,
      enabled: parsed.enabled,
      status: parsed.enabled && statusReasons.length === 0 ? "ready" : parsed.enabled ? "blocked" : "disabled",
      statusReasons,
      authPolicy: parsed.authPolicy,
      scopePolicy: parsed.scopePolicy,
      createdAt: now,
      updatedAt: now,
    };

    await kv.set(KV.state, stateKey.peer(peer.id), peer);
    await auditSync(kv, "mem::sync-peer-register", [peer.id], {
      action: "sync.peer.register",
      peer: peerEvidence(peer),
    });
    return { success: true, peer };
  });

  sdk.registerFunction("mem::sync-workspace-register", async (data: unknown) => {
    const parsed = normalizeWorkspaceInput(data);
    if (!parsed.ok) return { success: false, error: parsed.error };

    const now = new Date().toISOString();
    const workspace: SyncWorkspace = {
      kind: "sync-workspace",
      id: generateId("syncws"),
      name: parsed.name,
      workspaceRoot: parsed.workspaceRoot,
      localOnly: parsed.localOnly,
      enabled: parsed.enabled,
      allowedScopes: parsed.allowedScopes,
      labels: parsed.labels,
      createdAt: now,
      updatedAt: now,
    };

    await kv.set(KV.state, stateKey.workspace(workspace.id), workspace);
    await auditSync(kv, "mem::sync-workspace-register", [workspace.id], {
      action: "sync.workspace.register",
      workspace: workspaceEvidence(workspace),
    });
    return { success: true, workspace };
  });

  sdk.registerFunction("mem::sync-plan", async (data: unknown) => {
    const parsed = normalizePlanInput(data);
    if (!parsed.ok) return { success: false, error: parsed.error };

    const [peers, workspaces] = await Promise.all([
      loadPeers(kv, parsed.peerId),
      loadWorkspaces(kv, parsed.workspaceId),
    ]);
    if (parsed.peerId && peers.length === 0) {
      return { success: false, error: "peer not found" };
    }
    if (parsed.workspaceId && workspaces.length === 0) {
      return { success: false, error: "workspace not found" };
    }

    const createdAt = new Date().toISOString();
    const actions = peers.flatMap((peer) =>
      workspaces.map((workspace) =>
        buildPlanAction(peer, workspace, parsed.direction, parsed.scopes),
      ),
    );
    const plan: SyncPlan = {
      id: generateId("syncplan"),
      dryRun: true,
      createdAt,
      direction: parsed.direction,
      requestedScopes: parsed.scopes,
      actions,
      summary: {
        peers: peers.length,
        workspaces: workspaces.length,
        ready: actions.filter((action) => action.status === "ready").length,
        blocked: actions.filter((action) => action.status === "blocked").length,
      },
      warnings: parsed.dryRunWarning ? ["sync plans are dry-run only in this control-plane foundation"] : [],
    };

    await auditSync(kv, "mem::sync-plan", [plan.id], {
      action: "sync.plan",
      planId: plan.id,
      dryRun: true,
      direction: plan.direction,
      requestedScopes: plan.requestedScopes,
      summary: plan.summary,
      warnings: plan.warnings,
      actionEvidence: plan.actions.map((action) => action.evidence),
    });
    return { success: true, plan };
  });

  sdk.registerFunction("mem::sync-run-record", async (data: unknown) => {
    const parsed = await normalizeRunInput(kv, data);
    if (!parsed.ok) return { success: false, error: parsed.error };

    const now = new Date().toISOString();
    const run: SyncRun = {
      kind: "sync-run",
      id: generateId("syncrun"),
      planId: parsed.planId,
      peerId: parsed.peer?.id,
      workspaceId: parsed.workspace?.id,
      mode: parsed.peer?.mode ?? parsed.mode,
      direction: parsed.direction,
      status: parsed.status,
      dryRun: parsed.dryRun,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      itemCounts: parsed.itemCounts,
      errors: parsed.errors,
      evidence: parsed.evidence,
      createdAt: now,
      updatedAt: now,
    };

    await kv.set(KV.state, stateKey.run(run.id), run);
    if (parsed.peer) {
      await kv.set(KV.state, stateKey.peer(parsed.peer.id), {
        ...parsed.peer,
        lastRunAt: run.startedAt,
        status: run.status === "failed" || run.status === "blocked" ? "blocked" : parsed.peer.status,
        statusReasons:
          run.status === "failed" || run.status === "blocked"
            ? unique([...parsed.peer.statusReasons, `last run ${run.status}`])
            : parsed.peer.statusReasons,
        updatedAt: now,
      });
    }

    await auditSync(kv, "mem::sync-run-record", [run.id], {
      action: "sync.run.record",
      run: runEvidence(run),
    });
    return { success: true, run };
  });

  sdk.registerFunction("mem::sync-local-apply", async (data: unknown) => {
    const parsed = await normalizeLocalApplyInput(kv, data);
    if (!parsed.ok) return { success: false, error: parsed.error };

    const action = buildPlanAction(
      parsed.peer,
      parsed.workspace,
      parsed.direction,
      parsed.scopes,
    );
    if (action.status === "blocked") {
      return {
        success: false,
        error: "sync action is blocked",
        reasons: action.reasons,
        action,
      };
    }

    const candidates = buildSnapshotCandidates(parsed.source, parsed.scopes);
    if (!candidates.ok) return { success: false, error: candidates.error };
    if (
      parsed.peer.scopePolicy.maxItems !== undefined &&
      candidates.value.length > parsed.peer.scopePolicy.maxItems
    ) {
      return {
        success: false,
        error: `snapshot has ${candidates.value.length} items, exceeding peer scopePolicy.maxItems ${parsed.peer.scopePolicy.maxItems}`,
      };
    }

    const existing = await Promise.all(
      candidates.value.map(async (candidate) => {
        const snapshotId = snapshotIdFor(parsed.workspace.id, candidate.scope, candidate.sourceId);
        const record = await kv.get<SyncSnapshotRecord>(KV.state, stateKey.snapshot(snapshotId));
        return { candidate, snapshotId, record };
      }),
    );
    const conflicts: SyncConflict[] = existing
      .filter(({ record, candidate }) => record && record.digest !== candidate.digest)
      .map(({ candidate, snapshotId, record }) => ({
        scope: candidate.scope,
        sourceId: candidate.sourceId,
        snapshotId,
        existingDigest: record?.digest ?? "",
        incomingDigest: candidate.digest,
        reason: "digest_mismatch",
      }));
    const unchanged = existing.filter(
      ({ record, candidate }) => record?.digest === candidate.digest,
    );
    const blocked = conflicts.length > 0 && parsed.conflictPolicy === "block";
    const applyId = generateId("syncapply");
    const now = new Date().toISOString();
    const writes = blocked
      ? []
      : existing.filter(({ record, candidate }) => record?.digest !== candidate.digest);
    const record: SyncApplyRecord = {
      kind: "sync-apply",
      id: applyId,
      planId: parsed.planId,
      peerId: parsed.peer.id,
      workspaceId: parsed.workspace.id,
      mode: parsed.peer.mode,
      direction: parsed.direction,
      status: parsed.dryRun ? (blocked ? "blocked" : "planned") : blocked ? "blocked" : "applied",
      dryRun: parsed.dryRun,
      approved: parsed.approved,
      conflictPolicy: parsed.conflictPolicy,
      scopes: parsed.scopes,
      itemCounts: countCandidates(candidates.value),
      appliedCounts: parsed.dryRun || blocked ? emptyItemCounts() : countCandidates(writes.map((write) => write.candidate)),
      unchangedCounts: countCandidates(unchanged.map((entry) => entry.candidate)),
      conflictCount: conflicts.length,
      conflicts,
      snapshotIds: writes.map(({ snapshotId }) => snapshotId),
      errors: blocked ? ["snapshot conflicts detected"] : [],
      evidence: sanitizeEvidence({
        peer: peerEvidence(parsed.peer),
        workspace: workspaceEvidence(parsed.workspace),
        action: action.evidence,
        source: snapshotSourceEvidence(parsed.source),
      }),
      createdAt: now,
      updatedAt: now,
      appliedAt: parsed.dryRun || blocked ? undefined : now,
    };

    if (parsed.dryRun) {
      await auditSync(kv, "mem::sync-local-apply", [record.id], {
        action: "sync.local.apply.plan",
        apply: applyEvidence(record),
      });
      return { success: true, apply: record };
    }
    if (!parsed.approved) {
      return { success: false, error: "approved true is required to apply local sync snapshots" };
    }

    if (!blocked) {
      await Promise.all(
        writes.map(({ candidate, snapshotId, record: previous }) =>
          kv.set<SyncSnapshotRecord>(KV.state, stateKey.snapshot(snapshotId), {
            kind: "sync-snapshot",
            id: snapshotId,
            workspaceId: parsed.workspace.id,
            scope: candidate.scope,
            sourceId: candidate.sourceId,
            digest: candidate.digest,
            payload: candidate.payload,
            sourceUpdatedAt: candidate.sourceUpdatedAt,
            previousDigest: previous?.digest,
            appliedAt: now,
            applyId,
          }),
        ),
      );
    }

    await kv.set(KV.state, stateKey.apply(record.id), record);
    const run = await recordApplyRun(kv, parsed.peer, record, now);
    await auditSync(kv, "mem::sync-local-apply", [record.id, run.id], {
      action: blocked ? "sync.local.apply.blocked" : "sync.local.apply",
      apply: applyEvidence(record),
      run: runEvidence(run),
    });
    return { success: true, apply: record, run };
  });

  sdk.registerFunction("mem::sync-status", async (data: unknown) => {
    const input = asRecord(data);
    const peerId = optionalString(input?.peerId, "peerId");
    if (!peerId.ok) return { success: false, error: peerId.error };
    const workspaceId = optionalString(input?.workspaceId, "workspaceId");
    if (!workspaceId.ok) return { success: false, error: workspaceId.error };
    const limit = normalizeLimit(input?.limit);
    if (!limit.ok) return { success: false, error: limit.error };

    const [peers, workspaces, runs, applyRecords] = await Promise.all([
      loadPeers(kv, peerId.value),
      loadWorkspaces(kv, workspaceId.value),
      loadRuns(kv),
      loadApplyRecords(kv),
    ]);
    const filteredRuns = runs
      .filter((run) => !peerId.value || run.peerId === peerId.value)
      .filter((run) => !workspaceId.value || run.workspaceId === workspaceId.value)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit.value);
    const filteredApplyRecords = applyRecords
      .filter((apply) => !peerId.value || apply.peerId === peerId.value)
      .filter((apply) => !workspaceId.value || apply.workspaceId === workspaceId.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit.value);

    return {
      success: true,
      status: {
        peers,
        workspaces,
        runs: filteredRuns,
        applyRecords: filteredApplyRecords,
        summary: {
          peers: peers.length,
          workspaces: workspaces.length,
          runs: filteredRuns.length,
          applyRecords: filteredApplyRecords.length,
          readyPeers: peers.filter((peer) => peer.status === "ready").length,
          blockedPeers: peers.filter((peer) => peer.status === "blocked").length,
        },
      },
    };
  });
}

async function normalizeLocalApplyInput(
  kv: StateKV,
  raw: unknown,
): Promise<
  | {
      ok: true;
      planId?: string;
      peer: SyncPeer;
      workspace: SyncWorkspace;
      direction: SyncDirection;
      scopes: SyncScope[];
      dryRun: boolean;
      approved: boolean;
      conflictPolicy: SyncConflictPolicy;
      source: Record<string, unknown>;
    }
  | { ok: false; error: string }
> {
  const input = asRecord(raw);
  if (!input) return { ok: false, error: "payload required" };
  const planId = optionalString(input.planId, "planId");
  if (!planId.ok) return planId;
  const peerId = requiredString(input.peerId, "peerId");
  if (!peerId.ok) return peerId;
  const workspaceId = requiredString(input.workspaceId, "workspaceId");
  if (!workspaceId.ok) return workspaceId;
  const direction = normalizeDirection(input.direction, "pull");
  if (!direction.ok) return direction;
  if (direction.value === "push") {
    return { ok: false, error: "local apply supports pull or both directions only" };
  }
  const scopes = normalizeScopes(input.scopes, DEFAULT_SCOPES, {
    allowDefault: true,
    field: "scopes",
  });
  if (!scopes.ok) return scopes;
  const dryRun = optionalBoolean(input.dryRun, true);
  if (!dryRun.ok) return dryRun;
  const approved = optionalBoolean(input.approved, false);
  if (!approved.ok) return approved;
  const conflictPolicy = normalizeConflictPolicy(input.conflictPolicy);
  if (!conflictPolicy.ok) return conflictPolicy;
  const source = normalizeSnapshotSource(input.exportData ?? input.snapshot ?? input.source);
  if (!source.ok) return source;

  const [peer, workspace] = await Promise.all([
    kv.get<SyncPeer>(KV.state, stateKey.peer(peerId.value)),
    kv.get<SyncWorkspace>(KV.state, stateKey.workspace(workspaceId.value)),
  ]);
  if (!peer || peer.kind !== "sync-peer") return { ok: false, error: "peer not found" };
  if (!workspace || workspace.kind !== "sync-workspace") {
    return { ok: false, error: "workspace not found" };
  }
  if (peer.mode !== "local" || !peer.loopback) {
    return { ok: false, error: "local apply requires a loopback local peer" };
  }

  return {
    ok: true,
    planId: planId.value,
    peer,
    workspace,
    direction: direction.value,
    scopes: scopes.value,
    dryRun: dryRun.value,
    approved: approved.value,
    conflictPolicy: conflictPolicy.value,
    source: source.value,
  };
}

function normalizePeerInput(raw: unknown):
  | {
      ok: true;
      name: string;
      mode: SyncMode;
      endpoint: { url: string; host: string; loopback: boolean };
      enabled: boolean;
      authPolicy: SyncAuthPolicy;
      scopePolicy: SyncScopePolicy;
    }
  | { ok: false; error: string } {
  const input = asRecord(raw);
  if (!input) return { ok: false, error: "payload required" };

  const name = requiredString(input.name, "name");
  if (!name.ok) return name;
  const mode = normalizeMode(input.mode);
  if (!mode.ok) return mode;
  const endpoint = normalizeEndpoint(input.endpoint ?? DEFAULT_LOCAL_ENDPOINT);
  if (!endpoint.ok) return endpoint;
  const enabled = optionalBoolean(input.enabled, true);
  if (!enabled.ok) return enabled;

  if (mode.value === "local" && !endpoint.value.loopback) {
    return {
      ok: false,
      error: "remote endpoints require mode remote with explicit authPolicy and scopePolicy",
    };
  }
  if (mode.value === "remote" && endpoint.value.loopback) {
    return { ok: false, error: "remote mode requires a non-loopback endpoint" };
  }

  const authPolicy = normalizeAuthPolicy(input.authPolicy, mode.value);
  if (!authPolicy.ok) return authPolicy;
  const scopePolicy = normalizeScopePolicy(input.scopePolicy, mode.value);
  if (!scopePolicy.ok) return scopePolicy;

  return {
    ok: true,
    name: name.value,
    mode: mode.value,
    endpoint: endpoint.value,
    enabled: enabled.value,
    authPolicy: authPolicy.value,
    scopePolicy: scopePolicy.value,
  };
}

function normalizeWorkspaceInput(raw: unknown):
  | {
      ok: true;
      name: string;
      workspaceRoot?: string;
      localOnly: boolean;
      enabled: boolean;
      allowedScopes: SyncScope[];
      labels: string[];
    }
  | { ok: false; error: string } {
  const input = asRecord(raw);
  if (!input) return { ok: false, error: "payload required" };
  const root = optionalString(input.workspaceRoot ?? input.root ?? input.cwd, "workspaceRoot");
  if (!root.ok) return root;
  const name = optionalString(input.name, "name");
  if (!name.ok) return name;
  const localOnly = optionalBoolean(input.localOnly, true);
  if (!localOnly.ok) return localOnly;
  const enabled = optionalBoolean(input.enabled, true);
  if (!enabled.ok) return enabled;
  const scopes = normalizeScopes(input.allowedScopes ?? input.scopes, DEFAULT_SCOPES, {
    allowDefault: true,
    field: "allowedScopes",
  });
  if (!scopes.ok) return scopes;
  const labels = normalizeStringArray(input.labels, "labels");
  if (!labels.ok) return labels;
  if (localOnly.value === false && scopes.value.length === 0) {
    return { ok: false, error: "remote-capable workspaces require allowedScopes" };
  }

  return {
    ok: true,
    name: name.value ?? root.value ?? "local-workspace",
    workspaceRoot: root.value,
    localOnly: localOnly.value,
    enabled: enabled.value,
    allowedScopes: scopes.value,
    labels: labels.value,
  };
}

function normalizePlanInput(raw: unknown):
  | {
      ok: true;
      peerId?: string;
      workspaceId?: string;
      direction: SyncDirection;
      scopes: SyncScope[];
      dryRunWarning: boolean;
    }
  | { ok: false; error: string } {
  const input = asRecord(raw) ?? {};
  const peerId = optionalString(input.peerId, "peerId");
  if (!peerId.ok) return peerId;
  const workspaceId = optionalString(input.workspaceId, "workspaceId");
  if (!workspaceId.ok) return workspaceId;
  const direction = normalizeDirection(input.direction, "both");
  if (!direction.ok) return direction;
  const scopes = normalizeScopes(input.scopes, DEFAULT_SCOPES, {
    allowDefault: true,
    field: "scopes",
  });
  if (!scopes.ok) return scopes;
  return {
    ok: true,
    peerId: peerId.value,
    workspaceId: workspaceId.value,
    direction: direction.value,
    scopes: scopes.value,
    dryRunWarning: input.dryRun === false,
  };
}

async function normalizeRunInput(
  kv: StateKV,
  raw: unknown,
): Promise<
  | {
      ok: true;
      planId?: string;
      peer?: SyncPeer;
      workspace?: SyncWorkspace;
      mode: SyncMode;
      direction: SyncDirection;
      status: SyncRunStatus;
      dryRun: boolean;
      startedAt: string;
      endedAt?: string;
      itemCounts: Record<SyncScope, number>;
      errors: string[];
      evidence: Record<string, unknown>;
    }
  | { ok: false; error: string }
> {
  const input = asRecord(raw);
  if (!input) return { ok: false, error: "payload required" };
  const planId = optionalString(input.planId, "planId");
  if (!planId.ok) return planId;
  const peerId = optionalString(input.peerId, "peerId");
  if (!peerId.ok) return peerId;
  const workspaceId = optionalString(input.workspaceId, "workspaceId");
  if (!workspaceId.ok) return workspaceId;
  const mode = normalizeMode(input.mode);
  if (!mode.ok) return mode;
  const direction = normalizeDirection(input.direction, "both");
  if (!direction.ok) return direction;
  const status = normalizeRunStatus(input.status);
  if (!status.ok) return status;
  const dryRun = optionalBoolean(input.dryRun, true);
  if (!dryRun.ok) return dryRun;
  const startedAt = optionalTimestamp(input.startedAt, "startedAt", new Date().toISOString());
  if (!startedAt.ok) return startedAt;
  if (!startedAt.value) return { ok: false, error: "startedAt must be an ISO timestamp" };
  const endedAt = optionalTimestamp(input.endedAt, "endedAt");
  if (!endedAt.ok) return endedAt;
  const errors = normalizeStringArray(input.errors, "errors");
  if (!errors.ok) return errors;
  const itemCounts = normalizeItemCounts(input.itemCounts);
  if (!itemCounts.ok) return itemCounts;
  const peer = peerId.value ? await kv.get<SyncPeer>(KV.state, stateKey.peer(peerId.value)) : null;
  if (peerId.value && (!peer || peer.kind !== "sync-peer")) {
    return { ok: false, error: "peer not found" };
  }
  const workspace = workspaceId.value
    ? await kv.get<SyncWorkspace>(KV.state, stateKey.workspace(workspaceId.value))
    : null;
  if (workspaceId.value && (!workspace || workspace.kind !== "sync-workspace")) {
    return { ok: false, error: "workspace not found" };
  }

  return {
    ok: true,
    planId: planId.value,
    peer: peer ?? undefined,
    workspace: workspace ?? undefined,
    mode: mode.value,
    direction: direction.value,
    status: status.value,
    dryRun: dryRun.value,
    startedAt: startedAt.value,
    endedAt: endedAt.value,
    itemCounts: itemCounts.value,
    errors: errors.value,
    evidence: sanitizeEvidence(input.evidence),
  };
}

function buildPlanAction(
  peer: SyncPeer,
  workspace: SyncWorkspace,
  direction: SyncDirection,
  requestedScopes: SyncScope[],
): SyncPlanAction {
  const reasons: string[] = [];
  if (!peer.enabled || peer.status === "disabled") reasons.push("peer is disabled");
  if (!workspace.enabled) reasons.push("workspace is disabled");
  if (peer.status === "blocked") reasons.push(...peer.statusReasons);
  if (peer.mode === "remote" && workspace.localOnly) {
    reasons.push("workspace is local-only");
  }
  if (!directionAllowed(direction, peer.scopePolicy.direction)) {
    reasons.push(`direction ${direction} is outside peer scope policy`);
  }
  if (
    peer.scopePolicy.workspaceIds.length > 0 &&
    !peer.scopePolicy.workspaceIds.includes(workspace.id)
  ) {
    reasons.push("workspace is outside peer scope policy");
  }

  const scopes = intersectScopes(
    requestedScopes,
    peer.scopePolicy.allowedScopes,
    workspace.allowedScopes,
  );
  if (scopes.length === 0) reasons.push("no shared scopes available");

  return {
    actionId: generateId("syncact"),
    peerId: peer.id,
    workspaceId: workspace.id,
    mode: peer.mode,
    direction,
    scopes,
    dryRun: true,
    status: reasons.length > 0 ? "blocked" : "ready",
    reasons: unique(reasons),
    evidence: {
      peerId: peer.id,
      workspaceId: workspace.id,
      mode: peer.mode,
      loopback: peer.loopback,
      endpointHost: peer.endpointHost,
      direction,
      scopes,
      localOnly: workspace.localOnly,
    },
  };
}

async function loadPeers(kv: StateKV, peerId?: string): Promise<SyncPeer[]> {
  if (peerId) {
    const peer = await kv.get<SyncPeer>(KV.state, stateKey.peer(peerId));
    return peer?.kind === "sync-peer" ? [peer] : [];
  }
  const values = await kv.list<unknown>(KV.state);
  return values.filter(isSyncPeer);
}

async function loadWorkspaces(kv: StateKV, workspaceId?: string): Promise<SyncWorkspace[]> {
  if (workspaceId) {
    const workspace = await kv.get<SyncWorkspace>(KV.state, stateKey.workspace(workspaceId));
    return workspace?.kind === "sync-workspace" ? [workspace] : [];
  }
  const values = await kv.list<unknown>(KV.state);
  return values.filter(isSyncWorkspace);
}

async function loadRuns(kv: StateKV): Promise<SyncRun[]> {
  const values = await kv.list<unknown>(KV.state);
  return values.filter(isSyncRun);
}

async function loadApplyRecords(kv: StateKV): Promise<SyncApplyRecord[]> {
  const values = await kv.list<unknown>(KV.state);
  return values.filter(isSyncApplyRecord);
}

async function findPeerByEndpoint(kv: StateKV, endpoint: string): Promise<SyncPeer | null> {
  const peers = await loadPeers(kv);
  return peers.find((peer) => peer.endpoint === endpoint) ?? null;
}

function isSyncPeer(value: unknown): value is SyncPeer {
  return asRecord(value)?.kind === "sync-peer";
}

function isSyncWorkspace(value: unknown): value is SyncWorkspace {
  return asRecord(value)?.kind === "sync-workspace";
}

function isSyncRun(value: unknown): value is SyncRun {
  return asRecord(value)?.kind === "sync-run";
}

function isSyncApplyRecord(value: unknown): value is SyncApplyRecord {
  return asRecord(value)?.kind === "sync-apply";
}

function normalizeMode(value: unknown): { ok: true; value: SyncMode } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: "local" };
  if (value === "local" || value === "remote") return { ok: true, value };
  return { ok: false, error: "mode must be local or remote" };
}

function normalizeDirection(
  value: unknown,
  fallback: SyncDirection,
): { ok: true; value: SyncDirection } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: fallback };
  }
  if (DIRECTIONS.includes(value as SyncDirection)) {
    return { ok: true, value: value as SyncDirection };
  }
  return { ok: false, error: "direction must be push, pull, or both" };
}

function normalizeRunStatus(
  value: unknown,
): { ok: true; value: SyncRunStatus } | { ok: false; error: string } {
  if (RUN_STATUSES.includes(value as SyncRunStatus)) {
    return { ok: true, value: value as SyncRunStatus };
  }
  return { ok: false, error: "status must be a valid sync run status" };
}

function normalizeConflictPolicy(
  value: unknown,
): { ok: true; value: SyncConflictPolicy } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: "block" };
  }
  if (value === "block" || value === "merge") return { ok: true, value };
  return { ok: false, error: "conflictPolicy must be block or merge" };
}

function normalizeSnapshotSource(
  value: unknown,
): { ok: true; value: SyncSnapshotSource } | { ok: false; error: string } {
  const source = asRecord(value);
  if (!source) return { ok: false, error: "exportData, snapshot, or source is required" };
  if (source.version !== undefined && typeof source.version !== "string") {
    return { ok: false, error: "snapshot version must be a string when provided" };
  }
  if (
    source.exportedAt !== undefined &&
    (typeof source.exportedAt !== "string" || Number.isNaN(new Date(source.exportedAt).getTime()))
  ) {
    return { ok: false, error: "snapshot exportedAt must be an ISO timestamp when provided" };
  }
  return { ok: true, value: source as SyncSnapshotSource };
}

function normalizeEndpoint(
  value: unknown,
): { ok: true; value: { url: string; host: string; loopback: boolean } } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: false, error: "endpoint is required" };
  }
  if (typeof value !== "string") return { ok: false, error: "endpoint must be a string" };
  if (value.includes("\0")) return { ok: false, error: "endpoint must not contain NUL bytes" };
  const raw = value.trim();
  if (!raw) return { ok: false, error: "endpoint is required" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "endpoint must be a valid http(s) URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "endpoint must use http or https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "endpoint must not include credentials" };
  }
  if (scanPrivateData(parsed.pathname).redactionApplied) {
    return { ok: false, error: "endpoint path must not include secrets" };
  }
  parsed.hash = "";
  parsed.search = "";
  return {
    ok: true,
    value: {
      url: parsed.toString(),
      host: parsed.hostname,
      loopback: isLoopbackHost(parsed.hostname),
    },
  };
}

function normalizeAuthPolicy(
  value: unknown,
  mode: SyncMode,
): { ok: true; value: SyncAuthPolicy } | { ok: false; error: string } {
  const input = asRecord(value);
  if (mode === "local") {
    if (!input) return { ok: true, value: { kind: "none" } };
    if (input.kind !== undefined && input.kind !== "none") {
      return { ok: false, error: "local mode only accepts authPolicy kind none" };
    }
    return { ok: true, value: { kind: "none" } };
  }
  if (!input) return { ok: false, error: "remote mode requires authPolicy" };
  if (hasSecretField(input)) {
    return { ok: false, error: "authPolicy must reference credentials, not include raw secrets" };
  }
  if (
    input.kind !== "bearer" &&
    input.kind !== "mtls" &&
    input.kind !== "signed-request"
  ) {
    return { ok: false, error: "remote authPolicy kind must be bearer, mtls, or signed-request" };
  }
  const tokenEnv = optionalString(input.tokenEnv, "authPolicy.tokenEnv");
  if (!tokenEnv.ok) return tokenEnv;
  const secretRef = optionalString(input.secretRef, "authPolicy.secretRef");
  if (!secretRef.ok) return secretRef;
  const certificateRef = optionalString(input.certificateRef, "authPolicy.certificateRef");
  if (!certificateRef.ok) return certificateRef;
  const audience = optionalString(input.audience, "authPolicy.audience");
  if (!audience.ok) return audience;
  if ([tokenEnv.value, secretRef.value, certificateRef.value].some(hasRedactedSecret)) {
    return { ok: false, error: "remote authPolicy references must not include raw secrets" };
  }
  if (!tokenEnv.value && !secretRef.value && !certificateRef.value) {
    return { ok: false, error: "remote authPolicy requires tokenEnv, secretRef, or certificateRef" };
  }
  return {
    ok: true,
    value: {
      kind: input.kind,
      tokenEnv: tokenEnv.value,
      secretRef: secretRef.value,
      certificateRef: certificateRef.value,
      audience: audience.value,
    },
  };
}

function normalizeScopePolicy(
  value: unknown,
  mode: SyncMode,
): { ok: true; value: SyncScopePolicy } | { ok: false; error: string } {
  const input = asRecord(value);
  if (mode === "remote" && !input) {
    return { ok: false, error: "remote mode requires scopePolicy" };
  }
  const direction = normalizeDirection(input?.direction, "both");
  if (!direction.ok) return direction;
  const scopes = normalizeScopes(input?.allowedScopes ?? input?.scopes, DEFAULT_SCOPES, {
    allowDefault: mode === "local",
    field: "scopePolicy.allowedScopes",
  });
  if (!scopes.ok) return scopes;
  const workspaceIds = normalizeStringArray(input?.workspaceIds, "scopePolicy.workspaceIds");
  if (!workspaceIds.ok) return workspaceIds;
  const maxItems = optionalPositiveInteger(input?.maxItems, "scopePolicy.maxItems");
  if (!maxItems.ok) return maxItems;
  const approved = optionalBoolean(input?.remoteModeApproved, false);
  if (!approved.ok) return approved;
  if (mode === "remote" && !approved.value) {
    return { ok: false, error: "remote scopePolicy requires remoteModeApproved true" };
  }
  if (mode === "remote" && scopes.value.length === 0) {
    return { ok: false, error: "remote scopePolicy requires allowedScopes" };
  }
  return {
    ok: true,
    value: {
      allowedScopes: scopes.value,
      direction: direction.value,
      workspaceIds: workspaceIds.value,
      maxItems: maxItems.value,
      remoteModeApproved: approved.value,
    },
  };
}

function normalizeScopes(
  value: unknown,
  fallback: SyncScope[],
  options: { allowDefault: boolean; field: string },
): { ok: true; value: SyncScope[] } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    if (!options.allowDefault) {
      return { ok: false, error: `${options.field} is required` };
    }
    return { ok: true, value: [...fallback] };
  }
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!rawValues) return { ok: false, error: `${options.field} must be an array or comma-separated string` };
  const scopes: SyncScope[] = [];
  for (const raw of rawValues) {
    if (typeof raw !== "string") return { ok: false, error: `${options.field} must contain only strings` };
    const scope = raw.trim();
    if (!scope) continue;
    if (!ALL_SCOPES.includes(scope as SyncScope)) {
      return { ok: false, error: `${options.field} includes unsupported scope ${scope}` };
    }
    scopes.push(scope as SyncScope);
  }
  return { ok: true, value: unique(scopes) };
}

function normalizeItemCounts(
  value: unknown,
): { ok: true; value: Record<SyncScope, number> } | { ok: false; error: string } {
  const input = asRecord(value) ?? {};
  const counts = emptyItemCounts();
  for (const [key, raw] of Object.entries(input)) {
    if (!ALL_SCOPES.includes(key as SyncScope)) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return { ok: false, error: `itemCounts.${key} must be a non-negative integer` };
    }
    counts[key as SyncScope] = raw;
  }
  return { ok: true, value: counts };
}

function buildSnapshotCandidates(
  source: SyncSnapshotSource,
  scopes: SyncScope[],
): { ok: true; value: SyncSnapshotCandidate[] } | { ok: false; error: string } {
  const candidates: SyncSnapshotCandidate[] = [];
  const seen = new Map<string, string>();
  for (const scope of scopes) {
    const rows = snapshotRowsForScope(source, scope);
    if (!rows.ok) return rows;
    for (const [index, row] of rows.value.entries()) {
      const item = asRecord(row);
      if (!item) return { ok: false, error: `${scope}[${index}] must be an object` };
      const sourceId = snapshotSourceId(scope, item, index);
      if (!sourceId.ok) return sourceId;
      const payload = asRecord(sanitizeEvidenceValue(item, 0)) ?? {};
      const digest = digestValue({ scope, sourceId: sourceId.value, payload });
      const duplicateKey = `${scope}\0${sourceId.value}`;
      const previousDigest = seen.get(duplicateKey);
      if (previousDigest && previousDigest !== digest) {
        return { ok: false, error: `${scope}[${index}] conflicts with another ${sourceId.value} row` };
      }
      if (previousDigest) continue;
      seen.set(duplicateKey, digest);
      candidates.push({
        scope,
        sourceId: sourceId.value,
        payload,
        digest,
        sourceUpdatedAt: snapshotUpdatedAt(item),
      });
    }
  }
  return { ok: true, value: candidates };
}

function snapshotRowsForScope(
  source: SyncSnapshotSource,
  scope: SyncScope,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  const fields = snapshotFieldsForScope(scope);
  for (const field of fields) {
    const value = source[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      return { ok: false, error: `${field} must be an array for scope ${scope}` };
    }
    return { ok: true, value };
  }
  return { ok: true, value: [] };
}

function snapshotFieldsForScope(scope: SyncScope): string[] {
  switch (scope) {
    case "memories":
      return ["memories"];
    case "actions":
      return ["actions"];
    case "semantic":
      return ["semanticMemories", "semantic"];
    case "procedural":
      return ["proceduralMemories", "procedural"];
    case "relations":
      return ["relations"];
    case "graph:nodes":
      return ["graphNodes"];
    case "graph:edges":
      return ["graphEdges"];
  }
}

function snapshotSourceId(
  scope: SyncScope,
  item: Record<string, unknown>,
  index: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof item.id === "string" && item.id.trim()) {
    return { ok: true, value: item.id.trim() };
  }
  if (scope === "relations") {
    const sourceId = typeof item.sourceId === "string" ? item.sourceId.trim() : "";
    const targetId = typeof item.targetId === "string" ? item.targetId.trim() : "";
    const type = typeof item.type === "string" ? item.type.trim() : "";
    if (sourceId && targetId && type) {
      return { ok: true, value: `${type}:${sourceId}->${targetId}` };
    }
  }
  return { ok: false, error: `${scope}[${index}].id is required` };
}

function snapshotUpdatedAt(item: Record<string, unknown>): string | undefined {
  const value = item.updatedAt ?? item.createdAt;
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : undefined;
}

function normalizeLimit(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: 20 };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200) {
    return { ok: false, error: "limit must be an integer between 1 and 200" };
  }
  return { ok: true, value };
}

function requiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const parsed = optionalString(value, field);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: false, error: `${field} is required` };
  return { ok: true, value: parsed.value };
}

function optionalString(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  if (value.includes("\0")) return { ok: false, error: `${field} must not contain NUL bytes` };
  const redacted = scanPrivateData(value.trim()).redacted;
  return { ok: true, value: redacted || undefined };
}

function normalizeStringArray(
  value: unknown,
  field: string,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: [] };
  const rawValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (!rawValues) return { ok: false, error: `${field} must be an array or comma-separated string` };
  const values: string[] = [];
  for (const raw of rawValues) {
    const parsed = optionalString(raw, field);
    if (!parsed.ok) return parsed;
    if (parsed.value) values.push(parsed.value);
  }
  return { ok: true, value: unique(values) };
}

function optionalBoolean(
  value: unknown,
  fallback: boolean,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: fallback };
  if (typeof value === "boolean") return { ok: true, value };
  return { ok: false, error: "boolean value expected" };
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${field} must be a positive integer` };
  }
  return { ok: true, value };
}

function optionalTimestamp(
  value: unknown,
  field: string,
  fallback?: string,
): { ok: true; value: string } | { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return fallback ? { ok: true, value: fallback } : { ok: true, value: undefined };
  }
  const parsed = requiredString(value, field);
  if (!parsed.ok) return parsed;
  if (Number.isNaN(new Date(parsed.value).getTime())) {
    return { ok: false, error: `${field} must be an ISO timestamp` };
  }
  return { ok: true, value: parsed.value };
}

function sanitizeEvidence(value: unknown, depth = 0): Record<string, unknown> {
  const sanitized = sanitizeEvidenceValue(value, depth);
  return asRecord(sanitized) ?? {};
}

function sanitizeEvidenceValue(value: unknown, depth: number, key = ""): unknown {
  if (SECRET_FIELD_RE.test(key)) return "[REDACTED_SECRET]";
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_EVIDENCE_DEPTH) return "[TRUNCATED]";
    return value
      .slice(0, MAX_EVIDENCE_ARRAY)
      .map((item) => sanitizeEvidenceValue(item, depth + 1, key))
      .filter((item) => item !== undefined);
  }
  const record = asRecord(value);
  if (!record) return String(value);
  if (depth >= MAX_EVIDENCE_DEPTH) return "[TRUNCATED]";
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record).slice(0, MAX_EVIDENCE_KEYS)) {
    const sanitized = sanitizeEvidenceValue(entryValue, depth + 1, entryKey);
    if (sanitized !== undefined) result[entryKey] = sanitized;
  }
  return result;
}

function sanitizeString(value: string): string {
  const redacted = scanPrivateData(value).redacted;
  try {
    const parsed = new URL(redacted);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return redacted.length > 512 ? `${redacted.slice(0, 512)}...` : redacted;
  }
}

async function auditSync(
  kv: StateKV,
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown>,
): Promise<void> {
  await safeAudit(kv, "mesh_sync", functionId, targetIds, sanitizeEvidence(details));
}

function peerStatusReasons(mode: SyncMode, loopback: boolean, enabled: boolean): string[] {
  const reasons: string[] = [];
  if (!enabled) reasons.push("peer is disabled");
  if (mode === "local" && !loopback) reasons.push("local peers must use loopback endpoints");
  if (mode === "remote" && loopback) reasons.push("remote peers must use non-loopback endpoints");
  return reasons;
}

function directionAllowed(requested: SyncDirection, allowed: SyncDirection): boolean {
  if (allowed === "both") return true;
  if (requested === "both") return false;
  return requested === allowed;
}

function intersectScopes(...groups: SyncScope[][]): SyncScope[] {
  return ALL_SCOPES.filter((scope) => groups.every((group) => group.includes(scope)));
}

function hasSecretField(input: Record<string, unknown>): boolean {
  return Object.entries(input).some(([key, value]) => {
    if (SECRET_FIELD_RE.test(key) && key !== "tokenEnv" && key !== "secretRef") return true;
    const nested = asRecord(value);
    return nested ? hasSecretField(nested) : false;
  });
}

function hasRedactedSecret(value: string | undefined): boolean {
  return Boolean(value?.includes("[REDACTED"));
}

function peerEvidence(peer: SyncPeer): Record<string, unknown> {
  return {
    id: peer.id,
    mode: peer.mode,
    endpointHost: peer.endpointHost,
    loopback: peer.loopback,
    enabled: peer.enabled,
    status: peer.status,
    statusReasons: peer.statusReasons,
    authKind: peer.authPolicy.kind,
    scopes: peer.scopePolicy.allowedScopes,
    direction: peer.scopePolicy.direction,
    remoteModeApproved: peer.scopePolicy.remoteModeApproved,
  };
}

function workspaceEvidence(workspace: SyncWorkspace): Record<string, unknown> {
  return {
    id: workspace.id,
    localOnly: workspace.localOnly,
    enabled: workspace.enabled,
    scopes: workspace.allowedScopes,
    labels: workspace.labels,
  };
}

function runEvidence(run: SyncRun): Record<string, unknown> {
  return {
    id: run.id,
    planId: run.planId,
    peerId: run.peerId,
    workspaceId: run.workspaceId,
    mode: run.mode,
    direction: run.direction,
    status: run.status,
    dryRun: run.dryRun,
    itemCounts: run.itemCounts,
    errorCount: run.errors.length,
    evidence: run.evidence,
  };
}

function applyEvidence(apply: SyncApplyRecord): Record<string, unknown> {
  return {
    id: apply.id,
    planId: apply.planId,
    peerId: apply.peerId,
    workspaceId: apply.workspaceId,
    mode: apply.mode,
    direction: apply.direction,
    status: apply.status,
    dryRun: apply.dryRun,
    conflictPolicy: apply.conflictPolicy,
    itemCounts: apply.itemCounts,
    appliedCounts: apply.appliedCounts,
    unchangedCounts: apply.unchangedCounts,
    conflictCount: apply.conflictCount,
    snapshotIds: apply.snapshotIds,
    errorCount: apply.errors.length,
  };
}

function snapshotSourceEvidence(source: SyncSnapshotSource): Record<string, unknown> {
  return {
    version: typeof source.version === "string" ? source.version : undefined,
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : undefined,
    counts: Object.fromEntries(
      ALL_SCOPES.map((scope) => {
        const rows = snapshotRowsForScope(source, scope);
        return [scope, rows.ok ? rows.value.length : 0];
      }),
    ),
  };
}

async function recordApplyRun(
  kv: StateKV,
  peer: SyncPeer,
  apply: SyncApplyRecord,
  now: string,
): Promise<SyncRun> {
  const runStatus: SyncRunStatus = apply.status === "applied" ? "succeeded" : "blocked";
  const run: SyncRun = {
    kind: "sync-run",
    id: generateId("syncrun"),
    planId: apply.planId,
    peerId: apply.peerId,
    workspaceId: apply.workspaceId,
    mode: apply.mode,
    direction: apply.direction,
    status: runStatus,
    dryRun: false,
    startedAt: now,
    endedAt: now,
    itemCounts: apply.itemCounts,
    errors: apply.errors,
    evidence: sanitizeEvidence({
      applyId: apply.id,
      conflictPolicy: apply.conflictPolicy,
      conflictCount: apply.conflictCount,
      appliedCounts: apply.appliedCounts,
      unchangedCounts: apply.unchangedCounts,
    }),
    createdAt: now,
    updatedAt: now,
  };
  await kv.set(KV.state, stateKey.run(run.id), run);
  await kv.set(KV.state, stateKey.peer(peer.id), {
    ...peer,
    lastRunAt: now,
    status: peer.status,
    statusReasons: peer.statusReasons,
    updatedAt: now,
  });
  return run;
}

function emptyItemCounts(): Record<SyncScope, number> {
  return Object.fromEntries(ALL_SCOPES.map((scope) => [scope, 0])) as Record<SyncScope, number>;
}

function countCandidates(candidates: SyncSnapshotCandidate[]): Record<SyncScope, number> {
  const counts = emptyItemCounts();
  for (const candidate of candidates) {
    counts[candidate.scope] += 1;
  }
  return counts;
}

function snapshotIdFor(workspaceId: string, scope: SyncScope, sourceId: string): string {
  return `syncsnap_${digestString(`${workspaceId}|${scope}|${sourceId}`).slice(0, 24)}`;
}

function digestValue(value: unknown): string {
  return digestString(stableJson(value));
}

function digestString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableValue(entryValue)]),
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || normalized === "::1" || /^127\./.test(normalized);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
