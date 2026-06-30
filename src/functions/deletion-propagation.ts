import type { ISdk } from "iii-sdk";
import type {
  AgentEvent,
  GraphEdge,
  GraphNode,
  Memory,
  MemoryRelation,
  MemoryRevision,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import { safeAudit } from "./audit.js";
import {
  flushIndexSave,
  getSearchIndex,
  vectorIndexRemove,
} from "./search.js";

type PropagationMode = "review" | "tombstone";

type DeletionPropagationInput = {
  targetId?: unknown;
  memoryId?: unknown;
  sourceObservationId?: unknown;
  sourceHash?: unknown;
  sourceUri?: unknown;
  project?: unknown;
  agentId?: unknown;
  dryRun?: unknown;
  apply?: unknown;
  mode?: unknown;
  actor?: unknown;
  reason?: unknown;
};

type ImpactRef = {
  id: string;
  kind: string;
  reason: string;
  project?: string;
  agentId?: string;
};

type PropagationActionKind =
  | "mark_review"
  | "tombstone"
  | "delete_relation"
  | "mark_stale"
  | "not_enforced"
  | "audit";

type KeyedMemoryRelation = MemoryRelation & { id?: string };

type DeletionPropagationReport = {
  success: true;
  generatedAt: string;
  dryRun: boolean;
  mutationApplied: boolean;
  mode: PropagationMode;
  selector: {
    targetId?: string;
    memoryId?: string;
    sourceObservationId?: string;
    sourceHash?: string;
    sourceUri?: string;
  };
  scope: {
    project?: string;
    agentId?: string;
  };
  counts: {
    memories: number;
    sourceCards: number;
    relations: number;
    graphNodes: number;
    graphEdges: number;
    agentEvents: number;
    revisions: number;
  };
  impacted: {
    memories: ImpactRef[];
    sourceCards: ImpactRef[];
    relations: ImpactRef[];
    graphNodes: ImpactRef[];
    graphEdges: ImpactRef[];
    agentEvents: ImpactRef[];
    revisions: ImpactRef[];
  };
  actions: Array<{
    kind: PropagationActionKind;
    targetIds: string[];
    applied: boolean;
    reason?: string;
  }>;
  warnings: string[];
  blockers: string[];
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function modeOf(value: unknown): PropagationMode {
  return value === "tombstone" ? "tombstone" : "review";
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function matchesScope(
  value: { project?: string; agentId?: string },
  scope: { project?: string; agentId?: string },
): boolean {
  if (scope.project && value.project !== scope.project) return false;
  if (scope.agentId && value.agentId !== scope.agentId) return false;
  return true;
}

function matchesOptionalScope(
  value: { project?: string; agentId?: string },
  scope: { project?: string; agentId?: string },
): boolean {
  if (scope.project && value.project && value.project !== scope.project) return false;
  if (scope.agentId && value.agentId && value.agentId !== scope.agentId) return false;
  return true;
}

function memoryMatches(
  memory: Memory,
  selector: {
    targetId?: string;
    memoryId?: string;
    sourceObservationId?: string;
    sourceHash?: string;
    sourceUri?: string;
  },
): string[] {
  const reasons: string[] = [];
  if (selector.memoryId && memory.id === selector.memoryId) reasons.push("memory_id");
  if (selector.targetId && memory.id === selector.targetId) reasons.push("target_memory_id");
  if (
    selector.sourceObservationId &&
    (memory.sourceObservationIds ?? []).includes(selector.sourceObservationId)
  ) {
    reasons.push("source_observation_id");
  }
  if (selector.targetId && (memory.sourceObservationIds ?? []).includes(selector.targetId)) {
    reasons.push("target_source_observation_id");
  }
  if (selector.sourceHash && memory.sourceHash === selector.sourceHash) {
    reasons.push("source_hash");
  }
  if (selector.sourceUri && memory.sourceUri === selector.sourceUri) {
    reasons.push("source_uri");
  }
  return reasons;
}

function graphSourceIds(value: GraphNode | GraphEdge): string[] {
  return stringArray((value as { sourceObservationIds?: unknown }).sourceObservationIds);
}

function graphProject(value: GraphNode | GraphEdge): string | undefined {
  const props = "properties" in value ? value.properties : undefined;
  return typeof props?.project === "string" ? props.project : undefined;
}

function graphAgentId(value: GraphNode | GraphEdge): string | undefined {
  const props = "properties" in value ? value.properties : undefined;
  return typeof props?.agentId === "string" ? props.agentId : undefined;
}

function graphMatches(
  value: GraphNode | GraphEdge,
  selector: { targetId?: string; sourceObservationId?: string },
): string[] {
  const sourceIds = graphSourceIds(value);
  const reasons: string[] = [];
  if (selector.sourceObservationId && sourceIds.includes(selector.sourceObservationId)) {
    reasons.push("source_observation_id");
  }
  if (selector.targetId && sourceIds.includes(selector.targetId)) {
    reasons.push("target_source_observation_id");
  }
  return reasons;
}

function eventMatches(
  event: AgentEvent,
  selector: { targetId?: string; memoryId?: string; sourceObservationId?: string },
): string[] {
  const reasons: string[] = [];
  const targetIds = event.targetIds ?? [];
  if (selector.targetId && targetIds.includes(selector.targetId)) reasons.push("target_id");
  if (selector.memoryId && targetIds.includes(selector.memoryId)) reasons.push("target_memory_id");
  if (selector.memoryId && event.memoryIds?.includes(selector.memoryId)) reasons.push("memory_id");
  if (selector.targetId && event.memoryIds?.includes(selector.targetId)) reasons.push("target_memory_id");
  if (
    selector.sourceObservationId &&
    event.observationIds?.includes(selector.sourceObservationId)
  ) {
    reasons.push("source_observation_id");
  }
  if (selector.targetId && event.observationIds?.includes(selector.targetId)) {
    reasons.push("target_source_observation_id");
  }
  if (selector.targetId && event.artifactIds?.includes(selector.targetId)) {
    reasons.push("target_artifact_id");
  }
  return reasons;
}

function ref(
  id: string,
  kind: string,
  reasons: string[],
  scope?: { project?: string; agentId?: string },
): ImpactRef {
  return {
    id,
    kind,
    reason: reasons.sort().join(","),
    ...(scope?.project ? { project: scope.project } : {}),
    ...(scope?.agentId ? { agentId: scope.agentId } : {}),
  };
}

function relationKey(relation: KeyedMemoryRelation): string | undefined {
  return typeof relation.id === "string" && relation.id.trim()
    ? relation.id.trim()
    : undefined;
}

function relationRefId(relation: KeyedMemoryRelation): string {
  return relationKey(relation) ?? `${relation.sourceId}->${relation.targetId}`;
}

async function safeList<T>(kv: StateKV, scope: string): Promise<T[]> {
  return kv.list<T>(scope).catch(() => []);
}

function isUnregisteredFunctionError(err: unknown): boolean {
  return err instanceof Error && /^No function:/.test(err.message);
}

// Apply a real, index-aware tombstone to a single impacted memory.
//
// Prefer the canonical mem::memory-delete tombstone path so there is ONE
// audited, content-clearing, index-removing implementation. When that
// function is not registered (e.g. unit tests that wire only this module),
// fall back to an inline tombstone that mirrors deleteOneMemory in
// memory-lifecycle.ts: clear content/title/concepts/files, mark the row
// tombstoned + not-latest, and remove it from both the BM25 and vector
// indexes so "deleted" data is no longer retrievable.
async function tombstoneImpactedMemory(
  sdk: ISdk,
  kv: StateKV,
  memoryId: string,
  actor: string | undefined,
  reason: string | undefined,
): Promise<boolean> {
  try {
    const result = (await sdk.trigger({
      function_id: "mem::memory-delete",
      payload: {
        memoryId,
        mode: "tombstone",
        ...(actor ? { actor } : {}),
        ...(reason ? { reason } : {}),
      },
    })) as { success?: unknown; deleted?: unknown } | undefined;
    return Boolean(result && (result as { success?: unknown }).success === true);
  } catch (err) {
    if (!isUnregisteredFunctionError(err)) throw err;
  }
  const existing = await kv.get<Memory>(KV.memories, memoryId).catch(() => null);
  if (!existing) return false;
  const now = new Date().toISOString();
  const tombstone: Memory = {
    ...existing,
    updatedAt: now,
    deletedAt: existing.deletedAt ?? now,
    lifecycleState: "tombstoned",
    reviewState: "rejected",
    isLatest: false,
    title: `[deleted] ${existing.id}`,
    content: "",
    concepts: [],
    files: [],
  };
  await kv.set(KV.memories, tombstone.id, tombstone);
  getSearchIndex().remove(tombstone.id);
  vectorIndexRemove(tombstone.id);
  return true;
}

async function markGraphRowsStale(
  kv: StateKV,
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  graphNodeRefs: ImpactRef[],
  graphEdgeRefs: ImpactRef[],
  now: string,
): Promise<{ graphNodeIds: string[]; graphEdgeIds: string[] }> {
  const nodeIds = new Set(graphNodeRefs.map((item) => item.id));
  const edgeIds = new Set(graphEdgeRefs.map((item) => item.id));
  const graphNodeIds = (
    await Promise.all(
      graphNodes
        .filter((node) => nodeIds.has(node.id) && !node.stale)
        .map(async (node) => {
          const updated: GraphNode = { ...node, stale: true, updatedAt: now };
          await kv.set(KV.graphNodes, updated.id, updated);
          return updated.id;
        }),
    )
  ).sort();
  const graphEdgeIds = (
    await Promise.all(
      graphEdges
        .filter((edge) => edgeIds.has(edge.id) && !edge.stale)
        .map(async (edge) => {
          const updated: GraphEdge = { ...edge, stale: true };
          await kv.set(KV.graphEdges, updated.id, updated);
          return updated.id;
        }),
    )
  ).sort();
  return { graphNodeIds, graphEdgeIds };
}

function nonEnforcedWarnings(data: {
  keylessRelationCount: number;
  agentEventCount: number;
  revisionCount: number;
}): string[] {
  const warnings: string[] = [];
  if (data.keylessRelationCount > 0) {
    warnings.push(
      `memory_relation_not_enforced: legacy relation rows are report-only because rows do not carry stable kv ids (${data.keylessRelationCount})`,
    );
  }
  if (data.agentEventCount > 0) {
    warnings.push(
      `agent_event_not_enforced: agent events are immutable provenance and are report-only (${data.agentEventCount})`,
    );
  }
  if (data.revisionCount > 0) {
    warnings.push(
      `memory_revision_not_enforced: memory revisions are retained for audit and restore and are report-only (${data.revisionCount})`,
    );
  }
  return warnings;
}

export function registerDeletionPropagationFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::deletion-propagation-report",
    async (input: DeletionPropagationInput = {}): Promise<DeletionPropagationReport> => {
      const generatedAt = new Date().toISOString();
      const selector = {
        targetId: text(input.targetId),
        memoryId: text(input.memoryId),
        sourceObservationId: text(input.sourceObservationId),
        sourceHash: text(input.sourceHash),
        sourceUri: text(input.sourceUri),
      };
      const scope = {
        project: text(input.project),
        agentId: text(input.agentId),
      };
      const dryRun = input.dryRun !== false;
      const mode = modeOf(input.mode);
      const requestedApply = input.apply === true && !dryRun;
      const blockers: string[] = [];

      if (
        !selector.targetId &&
        !selector.memoryId &&
        !selector.sourceObservationId &&
        !selector.sourceHash &&
        !selector.sourceUri
      ) {
        blockers.push(
          "selector_required: provide memoryId, sourceObservationId, sourceHash, sourceUri, or targetId",
        );
      }
      const [memories, relations, graphNodes, graphEdges, agentEvents, revisions] =
        await Promise.all([
          safeList<Memory>(kv, KV.memories),
          safeList<KeyedMemoryRelation>(kv, KV.relations),
          safeList<GraphNode>(kv, KV.graphNodes),
          safeList<GraphEdge>(kv, KV.graphEdges),
          safeList<AgentEvent>(kv, KV.agentEvents),
          safeList<MemoryRevision>(kv, KV.memoryHistory),
        ]);

      const directMemoryMatches = memories
        .map((memory) => ({ memory, reasons: memoryMatches(memory, selector) }))
        .filter(({ memory, reasons }) => reasons.length > 0 && matchesScope(memory, scope));
      const directMemoryMap = new Map<
        string,
        { memory: Memory; reasons: string[] }
      >();
      for (const match of directMemoryMatches) {
        const existing = directMemoryMap.get(match.memory.id);
        directMemoryMap.set(match.memory.id, {
          memory: match.memory,
          reasons: existing ? [...existing.reasons, ...match.reasons] : match.reasons,
        });
      }
      const directMemories = [...directMemoryMap.values()];
      const directMemoryIds = new Set(directMemories.map(({ memory }) => memory.id));

      const impactedRelations = relations.filter(
        (relation) =>
          directMemoryIds.has(relation.sourceId) ||
          directMemoryIds.has(relation.targetId) ||
          (selector.targetId &&
            (relation.sourceId === selector.targetId || relation.targetId === selector.targetId)) ||
          (selector.memoryId &&
            (relation.sourceId === selector.memoryId || relation.targetId === selector.memoryId)),
      );
      const relationMemoryIds = new Set<string>();
      for (const relation of impactedRelations) {
        relationMemoryIds.add(relation.sourceId);
        relationMemoryIds.add(relation.targetId);
      }

      const relationMemories = memories
        .filter((memory) => relationMemoryIds.has(memory.id) && matchesScope(memory, scope))
        .map((memory) => ({ memory, reasons: ["memory_relation"] }));

      const impactedMemories = uniqueById([...directMemories, ...relationMemories].map(
        ({ memory, reasons }) => ({
          id: memory.id,
          kind: "memory",
          reason: reasons.sort().join(","),
          project: memory.project,
          agentId: memory.agentId,
        }),
      ));

      const impactedMemoryIds = new Set(impactedMemories.map((item) => item.id));
      const sourceCards = impactedMemories.filter((item) => {
        const memory = memories.find((candidate) => candidate.id === item.id);
        return Boolean(
          memory &&
            ((memory.sourceObservationIds ?? []).length > 0 ||
              memory.sourceHash ||
              memory.sourceUri ||
              memory.sourceType),
        );
      });

      const graphNodeRefs = uniqueById(
        graphNodes
          .map((node) => ({ node, reasons: graphMatches(node, selector) }))
          .filter(
            ({ node, reasons }) =>
              reasons.length > 0 &&
              matchesOptionalScope(
                { project: graphProject(node), agentId: graphAgentId(node) },
                scope,
              ),
          )
          .map(({ node, reasons }) =>
            ref(node.id, "graph_node", reasons, {
              project: graphProject(node),
              agentId: graphAgentId(node),
            }),
          ),
      );

      const graphEdgeRefs = uniqueById(
        graphEdges
          .map((edge) => ({ edge, reasons: graphMatches(edge, selector) }))
          .filter(
            ({ edge, reasons }) =>
              reasons.length > 0 &&
              matchesOptionalScope(
                { project: graphProject(edge), agentId: graphAgentId(edge) },
                scope,
              ),
          )
          .map(({ edge, reasons }) =>
            ref(edge.id, "graph_edge", reasons, {
              project: graphProject(edge),
              agentId: graphAgentId(edge),
            }),
          ),
      );

      const eventRefs = uniqueById(
        agentEvents
          .map((event) => ({ event, reasons: eventMatches(event, selector) }))
          .filter(({ event, reasons }) => reasons.length > 0 && matchesScope(event, scope))
          .map(({ event, reasons }) =>
            ref(event.id, "agent_event", reasons, {
              project: event.project,
              agentId: event.agentId,
            }),
          ),
      );

      const revisionRefs = uniqueById(
        revisions
          .filter((revision) => impactedMemoryIds.has(revision.memoryId))
          .map((revision) => ref(revision.id, "memory_revision", ["memory_history"])),
      );

      const relationRefs = impactedRelations.map((relation) =>
        ref(relationRefId(relation), "memory_relation", [relation.type]),
      );
      const enforceableRelations = impactedRelations.filter((relation) =>
        Boolean(relationKey(relation)),
      );
      const keylessRelationCount = impactedRelations.length - enforceableRelations.length;
      const warnings = nonEnforcedWarnings({
        keylessRelationCount,
        agentEventCount: eventRefs.length,
        revisionCount: revisionRefs.length,
      });
      if (requestedApply && blockers.length === 0 && warnings.length > 0) {
        blockers.push(...warnings.map((warning) => `apply_blocked_non_enforced: ${warning}`));
      }

      const apply = requestedApply && blockers.length === 0;
      const actions: DeletionPropagationReport["actions"] = [];
      let memoryMutationApplied = false;
      let graphMutationApplied = false;
      let relationMutationApplied = false;
      let appliedMemoryIds: string[] = [];
      let appliedGraphNodeIds: string[] = [];
      let appliedGraphEdgeIds: string[] = [];
      let appliedRelationIds: string[] = [];

      if (apply && impactedMemories.length > 0) {
        const now = generatedAt;
        let indexTouched = false;
        appliedMemoryIds = (
          await Promise.all(
            impactedMemories.map(async (item) => {
              if (mode === "tombstone") {
                const tombstoned = await tombstoneImpactedMemory(
                  sdk,
                  kv,
                  item.id,
                  text(input.actor),
                  text(input.reason),
                );
                if (tombstoned) indexTouched = true;
                return tombstoned ? item.id : undefined;
              }
              const existing = await kv.get<Memory>(KV.memories, item.id).catch(() => null);
              if (!existing) return undefined;
              // review mode is non-destructive (content is preserved for the
              // reviewer) but must still pull the row out of the live BM25 and
              // vector indexes so pending-deletion data is not retrievable.
              const updated: Memory = {
                ...existing,
                updatedAt: now,
                reviewState: "needs_review",
              };
              await kv.set(KV.memories, updated.id, updated);
              getSearchIndex().remove(updated.id);
              vectorIndexRemove(updated.id);
              indexTouched = true;
              return updated.id;
            }),
          )
        ).filter((id): id is string => typeof id === "string");
        memoryMutationApplied = appliedMemoryIds.length > 0;
        if (indexTouched) await flushIndexSave();
      }

      if (apply && (graphNodeRefs.length > 0 || graphEdgeRefs.length > 0)) {
        const applied = await markGraphRowsStale(
          kv,
          graphNodes,
          graphEdges,
          graphNodeRefs,
          graphEdgeRefs,
          generatedAt,
        );
        appliedGraphNodeIds = applied.graphNodeIds;
        appliedGraphEdgeIds = applied.graphEdgeIds;
        graphMutationApplied = appliedGraphNodeIds.length + appliedGraphEdgeIds.length > 0;
      }

      if (apply && enforceableRelations.length > 0) {
        appliedRelationIds = (
          await Promise.all(
            enforceableRelations.map(async (relation) => {
              const id = relationKey(relation);
              if (!id) return undefined;
              await kv.delete(KV.relations, id);
              return id;
            }),
          )
        ).filter((id): id is string => typeof id === "string");
        relationMutationApplied = appliedRelationIds.length > 0;
      }

      actions.push({
        kind: mode === "tombstone" ? "tombstone" : "mark_review",
        targetIds: impactedMemories.map((item) => item.id),
        applied: memoryMutationApplied,
      });

      const graphTargetIds = [...graphNodeRefs, ...graphEdgeRefs].map((item) => item.id);
      if (graphTargetIds.length > 0) {
        actions.push({
          kind: "mark_stale",
          targetIds: graphTargetIds,
          applied: graphMutationApplied,
          reason: "graph rows marked stale",
        });
      }

      if (relationRefs.length > 0) {
        actions.push({
          kind: "delete_relation",
          targetIds: relationRefs.map((item) => item.id),
          applied: relationMutationApplied,
          reason:
            keylessRelationCount > 0
              ? "only id-bearing relation rows were deleted"
              : "id-bearing relation rows deleted",
        });
      }

      if (keylessRelationCount > 0) {
        actions.push({
          kind: "not_enforced",
          targetIds: impactedRelations
            .filter((relation) => !relationKey(relation))
            .map(relationRefId),
          applied: false,
          reason: warnings.find((warning) => warning.startsWith("memory_relation_not_enforced")),
        });
      }
      if (eventRefs.length > 0) {
        actions.push({
          kind: "not_enforced",
          targetIds: eventRefs.map((item) => item.id),
          applied: false,
          reason: warnings.find((warning) => warning.startsWith("agent_event_not_enforced")),
        });
      }
      if (revisionRefs.length > 0) {
        actions.push({
          kind: "not_enforced",
          targetIds: revisionRefs.map((item) => item.id),
          applied: false,
          reason: warnings.find((warning) => warning.startsWith("memory_revision_not_enforced")),
        });
      }

      const mutationApplied =
        memoryMutationApplied || graphMutationApplied || relationMutationApplied;
      await safeAudit(
        kv,
        "memory_lifecycle",
        "mem::deletion-propagation-report",
        impactedMemories.map((item) => item.id),
        {
          action: "deletion_propagation_report",
          dryRun,
          apply,
          requestedApply,
          mutationApplied,
          mode,
          selector,
          scope,
          counts: {
            memories: impactedMemories.length,
            sourceCards: sourceCards.length,
            relations: impactedRelations.length,
            graphNodes: graphNodeRefs.length,
            graphEdges: graphEdgeRefs.length,
            agentEvents: eventRefs.length,
            revisions: revisionRefs.length,
          },
          warnings,
          blockers,
          enforced: {
            memories: appliedMemoryIds.length,
            graphNodes: appliedGraphNodeIds.length,
            graphEdges: appliedGraphEdgeIds.length,
            relations: appliedRelationIds.length,
          },
        },
      );

      actions.push({
        kind: "audit",
        targetIds: impactedMemories.map((item) => item.id),
        applied: true,
      });

      return {
        success: true,
        generatedAt,
        dryRun,
        mutationApplied,
        mode,
        selector,
        scope,
        counts: {
          memories: impactedMemories.length,
          sourceCards: sourceCards.length,
          relations: impactedRelations.length,
          graphNodes: graphNodeRefs.length,
          graphEdges: graphEdgeRefs.length,
          agentEvents: eventRefs.length,
          revisions: revisionRefs.length,
        },
        impacted: {
          memories: impactedMemories,
          sourceCards,
          relations: relationRefs,
          graphNodes: graphNodeRefs,
          graphEdges: graphEdgeRefs,
          agentEvents: eventRefs,
          revisions: revisionRefs,
        },
        actions,
        warnings,
        blockers,
      };
    },
  );
}
