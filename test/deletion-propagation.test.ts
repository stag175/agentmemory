import { describe, expect, it, beforeEach } from "vitest";

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerDeletionPropagationFunction } from "../src/functions/deletion-propagation.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { isMemorySearchable, memoryToObservation } from "../src/state/memory-utils.js";
import type {
  AgentEvent,
  AuditEntry,
  GraphEdge,
  GraphNode,
  Memory,
  MemoryRevision,
} from "../src/types.js";

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: "mem_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    type: "fact",
    lane: "semantic_fact",
    lifecycleState: "active",
    reviewState: "reviewed",
    title: "Memory",
    content: "Sensitive raw content must not appear in propagation reports.",
    concepts: ["billing"],
    files: ["src/billing.ts"],
    sessionIds: ["ses_1"],
    strength: 1,
    confidence: 0.9,
    version: 1,
    sourceObservationIds: ["obs_source"],
    isLatest: true,
    sourceHash: "hash_source",
    sourceUri: "file:///repo/source.md",
    project: "billing",
    agentId: "architect",
    ...overrides,
  };
}

describe("deletion propagation report", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    setIndexPersistence(null);
    registerDeletionPropagationFunction(sdk as never, kv as never);
  });

  it("reports impacted derivatives without exposing memory content", async () => {
    await kv.set("mem:memories", "mem_1", memory({ id: "mem_1" }));
    await kv.set(
      "mem:memories",
      "mem_2",
      memory({
        id: "mem_2",
        title: "Derived",
        sourceObservationIds: [],
        sourceHash: undefined,
        sourceUri: undefined,
      }),
    );
    await kv.set("mem:relations", "rel_1", {
      type: "derives",
      sourceId: "mem_1",
      targetId: "mem_2",
      createdAt: "2026-06-01T00:10:00.000Z",
      confidence: 0.8,
    });
    await kv.set<GraphNode>("mem:graph:nodes", "node_1", {
      id: "node_1",
      type: "concept",
      name: "billing",
      properties: { project: "billing" },
      sourceObservationIds: ["obs_source"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await kv.set<GraphEdge>("mem:graph:edges", "edge_1", {
      id: "edge_1",
      type: "related_to",
      sourceNodeId: "node_1",
      targetNodeId: "node_2",
      weight: 1,
      sourceObservationIds: ["obs_source"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await kv.set<AgentEvent>("mem:agent-events", "evt_1", {
      id: "evt_1",
      timestamp: "2026-06-01T00:11:00.000Z",
      type: "memory_written",
      project: "billing",
      agentId: "architect",
      targetIds: ["mem_1"],
      memoryIds: ["mem_1"],
      observationIds: ["obs_source"],
    });
    await kv.set<MemoryRevision>("mem:memory-history", "rev_1", {
      id: "rev_1",
      memoryId: "mem_1",
      action: "create",
      createdAt: "2026-06-01T00:00:00.000Z",
    });

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      sourceObservationId: "obs_source",
      project: "billing",
      agentId: "architect",
    })) as {
      counts: Record<string, number>;
      impacted: { memories: Array<{ id: string }>; graphNodes: unknown[]; agentEvents: unknown[] };
      dryRun: boolean;
      mutationApplied: boolean;
      actions: Array<{ kind: string; applied: boolean }>;
      warnings: string[];
      blockers: string[];
    };

    expect(report.dryRun).toBe(true);
    expect(report.mutationApplied).toBe(false);
    expect(report.counts.memories).toBe(2);
    expect(report.counts.sourceCards).toBe(1);
    expect(report.counts.relations).toBe(1);
    expect(report.counts.graphNodes).toBe(1);
    expect(report.counts.graphEdges).toBe(1);
    expect(report.counts.agentEvents).toBe(1);
    expect(report.counts.revisions).toBe(1);
    expect(report.impacted.memories.map((item) => item.id).sort()).toEqual([
      "mem_1",
      "mem_2",
    ]);
    expect(report.warnings).toEqual([
      "memory_relation_not_enforced: legacy relation rows are report-only because rows do not carry stable kv ids (1)",
      "agent_event_not_enforced: agent events are immutable provenance and are report-only (1)",
      "memory_revision_not_enforced: memory revisions are retained for audit and restore and are report-only (1)",
    ]);
    expect(report.blockers).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("Sensitive raw content");
    expect(report.actions.find((action) => action.kind === "mark_review")?.applied).toBe(false);
  });

  it("marks impacted memories for review when explicitly applied", async () => {
    await kv.set("mem:memories", "mem_1", memory({ id: "mem_1" }));

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      memoryId: "mem_1",
      dryRun: false,
      apply: true,
      mode: "review",
      reason: "source deletion request",
    })) as { mutationApplied: boolean; counts: { memories: number } };

    const updated = await kv.get<Memory>("mem:memories", "mem_1");
    const audit = await kv.list<AuditEntry>("mem:audit");

    expect(report.mutationApplied).toBe(true);
    expect(report.counts.memories).toBe(1);
    expect(updated?.reviewState).toBe("needs_review");
    expect(updated?.lifecycleState).toBe("active");
    expect(audit.at(-1)?.functionId).toBe("mem::deletion-propagation-report");
    expect(audit.at(-1)?.operation).toBe("memory_lifecycle");
  });

  it("tombstone apply clears content and removes the memory from the search index", async () => {
    const stored = memory({ id: "mem_1" });
    await kv.set("mem:memories", "mem_1", stored);
    getSearchIndex().add(memoryToObservation(stored));
    expect(getSearchIndex().has("mem_1")).toBe(true);

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      targetId: "mem_1",
      dryRun: false,
      apply: true,
      mode: "tombstone",
    })) as { mutationApplied: boolean };

    const updated = await kv.get<Memory>("mem:memories", "mem_1");
    // (a) stored content is emptied after apply.
    expect(updated?.content).toBe("");
    expect(updated?.title).toBe("[deleted] mem_1");
    expect(updated?.concepts).toEqual([]);
    expect(updated?.files).toEqual([]);
    expect(updated?.lifecycleState).toBe("tombstoned");
    expect(updated?.isLatest).toBe(false);
    expect(updated?.deletedAt).toBeTruthy();
    // (b) the search index no longer returns the tombstoned id.
    expect(getSearchIndex().has("mem_1")).toBe(false);
    expect(
      getSearchIndex()
        .search("billing")
        .some((hit) => hit.obsId === "mem_1"),
    ).toBe(false);
    expect(report.mutationApplied).toBe(true);
  });

  it("review apply preserves content for the reviewer but pulls the row out of search", async () => {
    const stored = memory({ id: "mem_1" });
    await kv.set("mem:memories", "mem_1", stored);
    getSearchIndex().add(memoryToObservation(stored));
    expect(getSearchIndex().has("mem_1")).toBe(true);

    await sdk.trigger("mem::deletion-propagation-report", {
      memoryId: "mem_1",
      dryRun: false,
      apply: true,
      mode: "review",
    });

    const updated = await kv.get<Memory>("mem:memories", "mem_1");
    expect(updated?.reviewState).toBe("needs_review");
    expect(updated?.lifecycleState).toBe("active");
    // Content is preserved so the reviewer can still inspect it.
    expect(updated?.content).toContain("Sensitive raw content");
    // But pending-deletion data must not stay retrievable.
    expect(getSearchIndex().has("mem_1")).toBe(false);
    expect(isMemorySearchable(updated as Memory)).toBe(false);
  });

  it("default mode (no mode) is not a silent no-op and removes the row from search", async () => {
    const stored = memory({ id: "mem_1" });
    await kv.set("mem:memories", "mem_1", stored);
    getSearchIndex().add(memoryToObservation(stored));
    expect(getSearchIndex().has("mem_1")).toBe(true);

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      memoryId: "mem_1",
      dryRun: false,
      apply: true,
    })) as { mutationApplied: boolean; counts: { memories: number } };

    const updated = await kv.get<Memory>("mem:memories", "mem_1");
    // (c) default mode performs a real mutation, not a no-op.
    expect(report.mutationApplied).toBe(true);
    expect(report.counts.memories).toBe(1);
    expect(updated?.reviewState).toBe("needs_review");
    expect(getSearchIndex().has("mem_1")).toBe(false);
    expect(isMemorySearchable(updated as Memory)).toBe(false);
  });

  it("marks graph rows stale when apply can enforce every impacted row type", async () => {
    await kv.set<GraphNode>("mem:graph:nodes", "node_1", {
      id: "node_1",
      type: "concept",
      name: "billing",
      properties: { project: "billing", agentId: "architect" },
      sourceObservationIds: ["obs_source"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await kv.set<GraphEdge>("mem:graph:edges", "edge_1", {
      id: "edge_1",
      type: "related_to",
      sourceNodeId: "node_1",
      targetNodeId: "node_2",
      weight: 1,
      sourceObservationIds: ["obs_source"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      sourceObservationId: "obs_source",
      project: "billing",
      agentId: "architect",
      dryRun: false,
      apply: true,
    })) as {
      mutationApplied: boolean;
      blockers: string[];
      warnings: string[];
      actions: Array<{ kind: string; applied: boolean; targetIds: string[] }>;
    };

    const node = await kv.get<GraphNode>("mem:graph:nodes", "node_1");
    const edge = await kv.get<GraphEdge>("mem:graph:edges", "edge_1");

    expect(report.mutationApplied).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(node?.stale).toBe(true);
    expect(node?.updatedAt).toBeTruthy();
    expect(edge?.stale).toBe(true);
    expect(report.actions.find((action) => action.kind === "mark_stale")).toMatchObject({
      applied: true,
      targetIds: ["node_1", "edge_1"],
    });
  });

  it("deletes id-bearing relation rows when apply can enforce them", async () => {
    await kv.set("mem:memories", "mem_1", memory({ id: "mem_1" }));
    await kv.set(
      "mem:memories",
      "mem_2",
      memory({
        id: "mem_2",
        title: "Derived",
        sourceObservationIds: [],
        sourceHash: undefined,
        sourceUri: undefined,
      }),
    );
    await kv.set("mem:relations", "rel_1", {
      id: "rel_1",
      type: "derives",
      sourceId: "mem_1",
      targetId: "mem_2",
      createdAt: "2026-06-01T00:10:00.000Z",
      confidence: 0.8,
    });

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      memoryId: "mem_1",
      dryRun: false,
      apply: true,
      mode: "review",
    })) as {
      mutationApplied: boolean;
      warnings: string[];
      blockers: string[];
      actions: Array<{ kind: string; applied: boolean; targetIds: string[] }>;
    };

    const relation = await kv.get("mem:relations", "rel_1");
    const source = await kv.get<Memory>("mem:memories", "mem_1");
    const derived = await kv.get<Memory>("mem:memories", "mem_2");

    expect(report.mutationApplied).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.blockers).toEqual([]);
    expect(relation).toBeNull();
    expect(source?.reviewState).toBe("needs_review");
    expect(derived?.reviewState).toBe("needs_review");
    expect(report.actions.find((action) => action.kind === "delete_relation")).toMatchObject({
      applied: true,
      targetIds: ["rel_1"],
    });
  });

  it("blocks apply when impacted rows include report-only provenance", async () => {
    await kv.set("mem:memories", "mem_1", memory({ id: "mem_1" }));
    await kv.set(
      "mem:memories",
      "mem_2",
      memory({
        id: "mem_2",
        title: "Derived",
        sourceObservationIds: [],
        sourceHash: undefined,
        sourceUri: undefined,
      }),
    );
    await kv.set("mem:relations", "rel_1", {
      type: "derives",
      sourceId: "mem_1",
      targetId: "mem_2",
      createdAt: "2026-06-01T00:10:00.000Z",
      confidence: 0.8,
    });
    await kv.set<GraphNode>("mem:graph:nodes", "node_1", {
      id: "node_1",
      type: "concept",
      name: "billing",
      properties: { project: "billing" },
      sourceObservationIds: ["obs_source"],
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await kv.set<AgentEvent>("mem:agent-events", "evt_1", {
      id: "evt_1",
      timestamp: "2026-06-01T00:11:00.000Z",
      type: "memory_written",
      project: "billing",
      agentId: "architect",
      targetIds: ["mem_1"],
      memoryIds: ["mem_1"],
      observationIds: ["obs_source"],
    });
    await kv.set<MemoryRevision>("mem:memory-history", "rev_1", {
      id: "rev_1",
      memoryId: "mem_1",
      action: "create",
      createdAt: "2026-06-01T00:00:00.000Z",
    });

    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      sourceObservationId: "obs_source",
      project: "billing",
      agentId: "architect",
      dryRun: false,
      apply: true,
      mode: "tombstone",
    })) as {
      mutationApplied: boolean;
      blockers: string[];
      warnings: string[];
      actions: Array<{ kind: string; applied: boolean }>;
    };

    const first = await kv.get<Memory>("mem:memories", "mem_1");
    const second = await kv.get<Memory>("mem:memories", "mem_2");
    const node = await kv.get<GraphNode>("mem:graph:nodes", "node_1");

    expect(report.mutationApplied).toBe(false);
    expect(report.warnings).toEqual([
      "memory_relation_not_enforced: legacy relation rows are report-only because rows do not carry stable kv ids (1)",
      "agent_event_not_enforced: agent events are immutable provenance and are report-only (1)",
      "memory_revision_not_enforced: memory revisions are retained for audit and restore and are report-only (1)",
    ]);
    expect(report.blockers).toEqual(
      report.warnings.map((warning) => `apply_blocked_non_enforced: ${warning}`),
    );
    expect(first?.lifecycleState).toBe("active");
    expect(first?.reviewState).toBe("reviewed");
    expect(second?.lifecycleState).toBe("active");
    expect(node?.stale).toBeUndefined();
    expect(report.actions.find((action) => action.kind === "tombstone")?.applied).toBe(false);
    expect(report.actions.filter((action) => action.kind === "not_enforced")).toHaveLength(3);
  });

  it("fails closed when no selector is provided", async () => {
    const report = (await sdk.trigger("mem::deletion-propagation-report", {
      dryRun: false,
      apply: true,
    })) as { blockers: string[]; counts: { memories: number }; mutationApplied: boolean };

    expect(report.blockers).toEqual([
      "selector_required: provide memoryId, sourceObservationId, sourceHash, sourceUri, or targetId",
    ]);
    expect(report.counts.memories).toBe(0);
    expect(report.mutationApplied).toBe(false);
  });
});
