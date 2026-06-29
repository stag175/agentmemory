import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerMemoryLifecycleFunctions } from "../src/functions/memory-lifecycle.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import type { AgentEvent, AuditEntry, Memory, MemoryRelation } from "../src/types.js";

describe("memory lifecycle roadmap surface", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    setIndexPersistence(null);
    registerRememberFunction(sdk as never, kv as never);
    registerMemoryLifecycleFunctions(sdk as never, kv as never);
    sdk.registerFunction("mem::cascade-update", async () => ({ success: true }));
  });

  it("creates memories through the explicit lifecycle function", async () => {
    await kv.set("mem:sessions", "ses_create", {
      id: "ses_create",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-06-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_create", "obs_create", {
      id: "obs_create",
      sessionId: "ses_create",
      timestamp: "2026-06-01T00:01:00Z",
      type: "decision",
      title: "Explicit create decision",
      facts: [],
      narrative: "Explicit create should preserve provenance.",
      concepts: ["billing"],
      files: ["src/billing.ts"],
      importance: 7,
    });

    const created = (await sdk.trigger("mem::memory-create", {
      content:
        "Use project-scoped lifecycle memory for billing architecture decisions because source cards are required",
      type: "architecture",
      project: "billing",
      concepts: ["billing", "lifecycle"],
      files: ["src/billing.ts"],
      sourceObservationIds: ["obs_create"],
      sourceType: "manual",
      sourceUri: "file:///repo/billing/notes.md",
      lane: "semantic_fact",
      confidence: 0.91,
      requireGatePass: true,
    })) as {
      success: boolean;
      memory: Memory & { writeGate?: { pass: boolean } };
      sourceCard: { project?: string; observations: unknown[] };
      history: Array<{ action: string }>;
      searchable: boolean;
    };

    expect(created.success).toBe(true);
    expect(created.memory.type).toBe("architecture");
    expect(created.memory.project).toBe("billing");
    expect(created.memory.writeGate?.pass).toBe(true);
    expect(created.sourceCard.project).toBe("billing");
    expect(created.sourceCard.observations).toHaveLength(1);
    expect(created.history.map((h) => h.action)).toEqual(["create"]);
    expect(created.searchable).toBe(true);
    expect(getSearchIndex().has(created.memory.id)).toBe(true);
  });

  it("records create history and inspect returns a source card", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Use scoped project memory for billing service bugs",
      type: "fact",
      project: "billing",
      confidence: 0.82,
      lane: "semantic_fact",
      sourceObservationIds: ["obs_1"],
    })) as { memory: Memory };

    await kv.set("mem:sessions", "ses_1", {
      id: "ses_1",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-06-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_1", "obs_1", {
      id: "obs_1",
      sessionId: "ses_1",
      timestamp: "2026-06-01T00:01:00Z",
      type: "decision",
      title: "Billing memory decision",
      facts: [],
      narrative: "The billing service needs scoped memory.",
      concepts: ["billing"],
      files: ["src/billing.ts"],
      importance: 7,
    });

    const inspected = (await sdk.trigger("mem::memory-inspect", {
      memoryId: created.memory.id,
    })) as {
      success: boolean;
      memory: Memory;
      sourceCard: { project?: string; observations: unknown[] };
      history: Array<{ action: string }>;
      searchable: boolean;
    };

    expect(inspected.success).toBe(true);
    expect(inspected.memory.lifecycleState).toBe("active");
    expect(inspected.memory.lane).toBe("semantic_fact");
    expect(inspected.sourceCard.project).toBe("billing");
    expect(inspected.sourceCard.observations).toHaveLength(1);
    expect(inspected.history.map((h) => h.action)).toContain("create");
    expect(inspected.searchable).toBe(true);
  });

  it("redacts and quarantines sensitive direct remembers before indexing", async () => {
    const secret = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const created = (await sdk.trigger("mem::remember", {
      content: `Never store this token ${secret}`,
      type: "fact",
      project: "billing",
    })) as { success: boolean; memory: Memory };

    expect(created.success).toBe(true);
    expect(created.memory.content).not.toContain(secret);
    expect(created.memory.content).toContain("[REDACTED_SECRET]");
    expect(created.memory.lifecycleState).toBe("quarantined");
    expect(created.memory.reviewState).toBe("needs_review");
    expect(created.memory.privacyScope).toBe("user");
    expect(created.memory.redactionApplied).toBe(true);
    expect(created.memory.sensitivityLabels).toContain("openai_project_key");
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    const stored = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(stored?.content).not.toContain(secret);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: Array<{ next?: Memory }> };
    expect(JSON.stringify(history.history)).not.toContain(secret);

    const auditRows = await kv.list<{ details: Record<string, unknown> }>(
      "mem:audit",
    );
    expect(JSON.stringify(auditRows)).not.toContain(secret);
    expect(auditRows[0]?.details.redactionApplied).toBe(true);

    const reviewQueue = (await sdk.trigger("mem::memory-review-queue", {
      project: "billing",
    })) as { queue: Array<{ memory: Memory; reasons: string[] }> };
    expect(reviewQueue.queue[0]?.memory.id).toBe(created.memory.id);
    expect(reviewQueue.queue[0]?.reasons).toContain("sensitive_quarantine");
  });

  it("redacts sensitive remember metadata before storage, history, audit, or indexing", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const created = (await sdk.trigger("mem::remember", {
      content: "Safe text with sensitive metadata",
      type: "fact",
      concepts: ["safe", secret],
      files: [`src/${secret}.ts`],
      sourceObservationIds: [`obs-${secret}`],
      sourceUri: `https://example.test/${secret}`,
      sourceHash: secret,
      branch: `feature/${secret}`,
      ownerId: secret,
      lane: secret as Memory["lane"],
      privacyScope: secret as Memory["privacyScope"],
      reviewState: secret as Memory["reviewState"],
    })) as { success: boolean; memory: Memory };

    expect(created.success).toBe(true);
    expect(created.memory.content).toBe("Safe text with sensitive metadata");
    expect(created.memory.lifecycleState).toBe("quarantined");
    expect(created.memory.reviewState).toBe("needs_review");
    expect(created.memory.privacyScope).toBe("user");
    expect(created.memory.lane).toBe("semantic_fact");
    expect(JSON.stringify(created.memory)).not.toContain(secret);
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    const stored = await kv.get<Memory>("mem:memories", created.memory.id);
    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: unknown[] };
    const auditRows = await kv.list("mem:audit");

    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(history.history)).not.toContain(secret);
    expect(JSON.stringify(auditRows)).not.toContain(secret);
  });

  it("update, expire, and restore preserve a revision trail and searchability", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Prefer vitest for lifecycle coverage",
      type: "workflow",
    })) as { memory: Memory };

    await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      content: "Prefer vitest for lifecycle and retrieval coverage",
      confidence: 0.9,
      reason: "tighten wording",
    });
    await sdk.trigger("mem::memory-expire", {
      memoryId: created.memory.id,
      reason: "stale recommendation",
    });

    const expired = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(expired?.lifecycleState).toBe("expired");
    expect(expired?.validUntil).toBeDefined();
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    await sdk.trigger("mem::memory-restore", {
      memoryId: created.memory.id,
      reason: "verified still true",
    });

    const restored = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(restored?.lifecycleState).toBe("active");
    expect(restored?.isLatest).toBe(true);
    expect(restored?.validUntil).toBeUndefined();
    expect(getSearchIndex().has(created.memory.id)).toBe(true);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: Array<{ action: string }> };
    expect(history.history.map((h) => h.action)).toEqual([
      "create",
      "update",
      "expire",
      "restore",
    ]);
  });

  it("updates valid windows and exposes current temporal inspect status", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Temporal rollout guidance is valid for the active quarter",
      type: "fact",
      project: "temporal",
      sourceObservationIds: ["obs_temporal"],
    })) as { memory: Memory };
    const validFrom = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();

    const updated = (await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      validFrom,
      validUntil,
      reason: "scope memory validity to the rollout window",
    })) as { success: boolean; memory: Memory };

    expect(updated.success).toBe(true);
    expect(updated.memory.validFrom).toBe(validFrom);
    expect(updated.memory.validUntil).toBe(validUntil);
    expect(getSearchIndex().has(created.memory.id)).toBe(true);

    const inspected = (await sdk.trigger("mem::memory-inspect", {
      memoryId: created.memory.id,
    })) as {
      success: boolean;
      searchable: boolean;
      review: { temporalStatus: string; reasons: string[] };
      history: Array<{ action: string; next?: Partial<Memory> }>;
    };

    expect(inspected.success).toBe(true);
    expect(inspected.searchable).toBe(true);
    expect(inspected.review.temporalStatus).toBe("current");
    expect(inspected.review.reasons).not.toContain("stale_valid_window");
    expect(inspected.history.at(-1)?.next?.validUntil).toBe(validUntil);
  });

  it("includes memories with stale valid windows in the review queue", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Temporary migration workaround expires after verification",
      type: "workflow",
      project: "stale-validity",
      sourceObservationIds: ["obs_stale_window"],
    })) as { memory: Memory };
    const validUntil = new Date(Date.now() - 60_000).toISOString();

    await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      validUntil,
      reason: "mark temporary guidance as past its validity window",
    });

    const inspected = (await sdk.trigger("mem::memory-inspect", {
      memoryId: created.memory.id,
    })) as {
      searchable: boolean;
      review: { temporalStatus: string; reasons: string[] };
    };
    expect(inspected.searchable).toBe(false);
    expect(inspected.review.temporalStatus).toBe("expired");
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    const reviewQueue = (await sdk.trigger("mem::memory-review-queue", {
      project: "stale-validity",
    })) as {
      queue: Array<{
        memory: Memory;
        reasons: string[];
        temporalStatus: string;
      }>;
    };

    const row = reviewQueue.queue.find((entry) => entry.memory.id === created.memory.id);
    expect(row?.temporalStatus).toBe("expired");
    expect(row?.reasons).toContain("expired_valid_window");
    expect(row?.reasons).toContain("stale_valid_window");
  });

  it("restore clears stale valid windows so active memories become searchable again", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Temporary rollout guidance can be refreshed after review",
      type: "workflow",
      project: "restore-temporal",
      sourceObservationIds: ["obs_restore_temporal"],
    })) as { memory: Memory };
    const validUntil = new Date(Date.now() - 60_000).toISOString();

    await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      validUntil,
      reason: "mark the guidance stale",
    });
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    const restored = (await sdk.trigger("mem::memory-restore", {
      memoryId: created.memory.id,
      reason: "reviewed and refreshed",
    })) as { success: boolean; memory: Memory };

    expect(restored.success).toBe(true);
    expect(restored.memory.lifecycleState).toBe("active");
    expect(restored.memory.validUntil).toBeUndefined();
    expect(getSearchIndex().has(created.memory.id)).toBe(true);

    const inspected = (await sdk.trigger("mem::memory-inspect", {
      memoryId: created.memory.id,
    })) as { searchable: boolean; review: { temporalStatus: string } };
    expect(inspected.searchable).toBe(true);
    expect(inspected.review.temporalStatus).toBe("current");
  });

  it("flags conflicting and suspected memories for review", async () => {
    const first = (await sdk.trigger("mem::remember", {
      content: "Feature flag alpha remains enabled for project conflict checks",
      type: "fact",
      project: "conflict",
      sourceObservationIds: ["obs_conflict_a"],
    })) as { memory: Memory };
    const second = (await sdk.trigger("mem::remember", {
      content: "Manual rollout approval blocks the project conflict release",
      type: "fact",
      project: "conflict",
      sourceObservationIds: ["obs_conflict_b"],
    })) as { memory: Memory };
    const suspected = (await sdk.trigger("mem::remember", {
      content: "todo",
      type: "fact",
      project: "conflict",
    })) as { memory: Memory };

    await kv.set<MemoryRelation>("mem:relations", "rel_conflict", {
      type: "contradicts",
      sourceId: first.memory.id,
      targetId: second.memory.id,
      createdAt: new Date().toISOString(),
      confidence: 0.9,
    });

    const reviewQueue = (await sdk.trigger("mem::memory-review-queue", {
      project: "conflict",
    })) as { queue: Array<{ memory: Memory; reasons: string[] }> };

    const conflictingRow = reviewQueue.queue.find(
      (entry) => entry.memory.id === first.memory.id,
    );
    const suspectedRow = reviewQueue.queue.find(
      (entry) => entry.memory.id === suspected.memory.id,
    );
    expect(conflictingRow?.reasons).toContain("conflicting_relation");
    expect(suspectedRow?.reasons).toContain("suspected_write_gate");
  });

  it("tombstone removes content from search and restore recovers from history", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Sensitive content can be tombstoned reversibly",
      type: "fact",
    })) as { memory: Memory };
    const validFrom = new Date(Date.now() - 60_000).toISOString();
    const validUntil = new Date(Date.now() + 86_400_000).toISOString();

    await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      validFrom,
      validUntil,
      reason: "add validity window before tombstone",
    });

    await sdk.trigger("mem::memory-delete", {
      memoryId: created.memory.id,
      reason: "user requested removal",
    });

    const tombstone = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(tombstone?.lifecycleState).toBe("tombstoned");
    expect(tombstone?.content).toBe("");
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    await sdk.trigger("mem::memory-restore", {
      memoryId: created.memory.id,
      reason: "restore requested",
    });

    const restored = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(restored?.content).toBe("Sensitive content can be tombstoned reversibly");
    expect(restored?.lifecycleState).toBe("active");
    expect(restored?.validFrom).toBe(validFrom);
    expect(restored?.validUntil).toBe(validUntil);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: Array<{ action: string; next?: Partial<Memory> }> };
    expect(history.history.map((h) => h.action)).toEqual([
      "create",
      "update",
      "tombstone",
      "restore",
    ]);
    expect(history.history.at(-1)?.next?.validUntil).toBe(validUntil);
  });

  it("hard delete purges memory rows and revision history", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Hard delete should not preserve payload in history",
      type: "fact",
    })) as { memory: Memory };

    await sdk.trigger("mem::memory-delete", {
      memoryId: created.memory.id,
      mode: "hard",
      reason: "erase permanently",
    });

    expect(await kv.get<Memory>("mem:memories", created.memory.id)).toBeNull();
    expect(getSearchIndex().has(created.memory.id)).toBe(false);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: unknown[] };
    expect(history.history).toEqual([]);
  });

  it("dry-runs source-linked deletion without mutating matching memories", async () => {
    const first = (await sdk.trigger("mem::remember", {
      content: "Source-linked deletion should find the first billing memory",
      type: "fact",
      project: "billing",
      agentId: "codex-a",
      sourceObservationIds: ["obs_source_delete"],
    })) as { memory: Memory };
    const second = (await sdk.trigger("mem::remember", {
      content: "Source-linked deletion should find the second billing memory",
      type: "workflow",
      project: "billing",
      agentId: "codex-a",
      sourceObservationIds: ["obs_source_delete"],
    })) as { memory: Memory };
    const other = (await sdk.trigger("mem::remember", {
      content: "Other projects sharing a source are reported but not targeted",
      type: "fact",
      project: "other",
      agentId: "codex-a",
      sourceObservationIds: ["obs_source_delete"],
    })) as { memory: Memory };

    const result = (await sdk.trigger("mem::memory-delete", {
      sourceObservationId: "obs_source_delete",
      project: "billing",
      agentId: "codex-a",
      dryRun: true,
      reason: "source removed upstream",
    })) as {
      success: boolean;
      deleted: number;
      dryRun: boolean;
      wouldDelete: number;
      propagation: {
        matched: number;
        targetIds: string[];
        deletedIds: string[];
        mutationAllowed: boolean;
      };
    };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.wouldDelete).toBe(2);
    expect(result.propagation.matched).toBe(3);
    expect(result.propagation.targetIds.sort()).toEqual(
      [first.memory.id, second.memory.id].sort(),
    );
    expect(result.propagation.deletedIds).toEqual([]);
    expect(result.propagation.mutationAllowed).toBe(true);
    const firstAfter = await kv.get<Memory>("mem:memories", first.memory.id);
    const secondAfter = await kv.get<Memory>("mem:memories", second.memory.id);
    const otherAfter = await kv.get<Memory>("mem:memories", other.memory.id);
    expect(firstAfter?.lifecycleState).not.toBe("tombstoned");
    expect(secondAfter?.lifecycleState).not.toBe("tombstoned");
    expect(otherAfter?.lifecycleState).toBe("active");
    expect(firstAfter?.content).toContain("Source-linked deletion should find");
    expect(secondAfter?.content).toContain("Source-linked deletion should find");
  });

  it("propagates source-linked tombstones inside the requested project and agent scope", async () => {
    const first = (await sdk.trigger("mem::remember", {
      content: "Deleted source should tombstone this billing decision",
      type: "fact",
      project: "billing",
      agentId: "codex-a",
      sourceObservationIds: ["obs_source_tombstone"],
    })) as { memory: Memory };
    const second = (await sdk.trigger("mem::remember", {
      content: "Deleted source should tombstone this billing workflow",
      type: "workflow",
      project: "billing",
      agentId: "codex-a",
      sourceObservationIds: ["obs_source_tombstone"],
    })) as { memory: Memory };
    const otherAgent = (await sdk.trigger("mem::remember", {
      content: "A different agent scope must not be deleted accidentally",
      type: "fact",
      project: "billing",
      agentId: "codex-b",
      sourceObservationIds: ["obs_source_tombstone"],
    })) as { memory: Memory };

    const result = (await sdk.trigger("mem::memory-delete", {
      sourceObservationId: "obs_source_tombstone",
      project: "billing",
      agentId: "codex-a",
      reason: "source removed upstream",
    })) as {
      success: boolean;
      deleted: number;
      propagation: { deletedIds: string[]; targetIds: string[] };
    };

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(2);
    expect(result.propagation.deletedIds.sort()).toEqual(
      [first.memory.id, second.memory.id].sort(),
    );
    expect(result.propagation.targetIds.sort()).toEqual(
      [first.memory.id, second.memory.id].sort(),
    );

    const firstStored = await kv.get<Memory>("mem:memories", first.memory.id);
    const secondStored = await kv.get<Memory>("mem:memories", second.memory.id);
    const otherStored = await kv.get<Memory>("mem:memories", otherAgent.memory.id);
    expect(firstStored?.lifecycleState).toBe("tombstoned");
    expect(secondStored?.lifecycleState).toBe("tombstoned");
    expect(otherStored?.lifecycleState).toBe("active");
    expect(getSearchIndex().has(first.memory.id)).toBe(false);
    expect(getSearchIndex().has(second.memory.id)).toBe(false);
    expect(getSearchIndex().has(otherAgent.memory.id)).toBe(true);

    const auditRows = await kv.list<AuditEntry>("mem:audit");
    const sourceRows = auditRows.filter(
      (row) => row.details?.sourceLinked === true,
    );
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.every((row) => row.functionId === "mem::memory-delete")).toBe(true);
    expect(sourceRows.every((row) => row.details?.reason === "source removed upstream")).toBe(true);
    expect(sourceRows[0]?.details?.sourceSelector).toMatchObject({
      sourceObservationId: "obs_source_tombstone",
    });
    expect(sourceRows[0]?.details?.scope).toMatchObject({
      project: "billing",
      agentId: "codex-a",
    });
  });

  it("rejects source-linked mutation that would cross agent scopes", async () => {
    const first = (await sdk.trigger("mem::remember", {
      content: "Shared source hash for the first agent scoped memory",
      type: "fact",
      project: "billing",
      agentId: "codex-a",
      sourceHash: "hash-cross-agent",
    })) as { memory: Memory };
    const second = (await sdk.trigger("mem::remember", {
      content: "Shared source hash for the second agent scoped memory",
      type: "fact",
      project: "billing",
      agentId: "codex-b",
      sourceHash: "hash-cross-agent",
    })) as { memory: Memory };

    const result = (await sdk.trigger("mem::memory-delete", {
      sourceHash: "hash-cross-agent",
      project: "billing",
      reason: "source removed upstream",
    })) as {
      success: boolean;
      error: string;
      deleted: number;
      propagation: { blockers: string[]; mutationAllowed: boolean };
    };

    expect(result.success).toBe(false);
    expect(result.deleted).toBe(0);
    expect(result.error).toContain("agentId is required");
    expect(result.propagation.mutationAllowed).toBe(false);
    expect(result.propagation.blockers).toContain(
      "agentId is required when selector matches multiple agent scopes",
    );
    expect(await kv.get<Memory>("mem:memories", first.memory.id)).toMatchObject({
      lifecycleState: "active",
    });
    expect(await kv.get<Memory>("mem:memories", second.memory.id)).toMatchObject({
      lifecycleState: "active",
    });

    const auditRows = await kv.list<AuditEntry>("mem:audit");
    expect(auditRows.some((row) => row.details?.sourceLinked === true)).toBe(false);
  });

  it("validates source-linked selectors before mutating", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Invalid source selectors must not mutate this memory",
      type: "fact",
      project: "billing",
      agentId: "codex-a",
      sourceHash: "hash-validate-selector",
    })) as { memory: Memory };

    const result = (await sdk.trigger("mem::memory-delete", {
      sourceHash: 42,
      project: "billing",
      agentId: "codex-a",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("sourceHash must be a non-empty string");
    expect(await kv.get<Memory>("mem:memories", created.memory.id)).toMatchObject({
      lifecycleState: "active",
    });
  });

  it("does not record hard-delete success audit or event when row deletion fails", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Failed hard delete must not emit success records",
      type: "fact",
    })) as { memory: Memory };
    const originalDelete = kv.delete.bind(kv);
    vi.spyOn(kv, "delete").mockImplementation(async (scope, key) => {
      if (scope === "mem:memories" && key === created.memory.id) {
        throw new Error("delete failed");
      }
      return originalDelete(scope, key);
    });

    await expect(
      sdk.trigger("mem::memory-delete", {
        memoryId: created.memory.id,
        mode: "hard",
        reason: "erase permanently",
      }),
    ).rejects.toThrow("delete failed");

    expect(await kv.get<Memory>("mem:memories", created.memory.id)).not.toBeNull();
    const auditRows = await kv.list<AuditEntry>("mem:audit");
    expect(
      auditRows.some((row) => row.details?.action === "hard_delete"),
    ).toBe(false);
    const events = await kv.list<AgentEvent>("mem:agent-events");
    expect(events.some((event) => event.type === "memory_deleted")).toBe(false);
  });

  it("rejects invalid expiration timestamps without mutating the memory", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Expiration timestamps must be valid ISO dates",
      type: "fact",
    })) as { memory: Memory };

    const result = (await sdk.trigger("mem::memory-expire", {
      memoryId: created.memory.id,
      expiresAt: "not-a-date",
      reason: "bad operator input",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("expiresAt must be an ISO timestamp");

    const stored = await kv.get<Memory>("mem:memories", created.memory.id);
    expect(stored?.lifecycleState).toBe("active");
    expect(stored?.validUntil).toBeUndefined();
    expect(getSearchIndex().has(created.memory.id)).toBe(true);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: Array<{ action: string }> };
    expect(history.history.map((entry) => entry.action)).toEqual(["create"]);
  });

  it("redacts sensitive memory updates and moves the row out of search", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Safe operational detail",
      type: "workflow",
    })) as { memory: Memory };
    expect(getSearchIndex().has(created.memory.id)).toBe(true);

    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const updated = (await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      content: `Rotated token ${secret}`,
    })) as { success: boolean; memory: Memory };

    expect(updated.success).toBe(true);
    expect(updated.memory.content).not.toContain(secret);
    expect(updated.memory.lifecycleState).toBe("quarantined");
    expect(updated.memory.reviewState).toBe("needs_review");
    expect(updated.memory.sensitivityLabels).toContain("github_token");
    expect(getSearchIndex().has(created.memory.id)).toBe(false);
  });

  it("redacts sensitive update metadata and revision reasons", async () => {
    const created = (await sdk.trigger("mem::remember", {
      content: "Safe operational detail",
      type: "workflow",
    })) as { memory: Memory };

    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const updated = (await sdk.trigger("mem::memory-update", {
      memoryId: created.memory.id,
      content: "Still safe operational detail",
      concepts: ["workflow", secret],
      files: [`notes/${secret}.md`],
      reason: `operator pasted ${secret}`,
      actor: secret,
      privacyScope: secret as Memory["privacyScope"],
      reviewState: secret as Memory["reviewState"],
      lane: secret as Memory["lane"],
    })) as { success: boolean; memory: Memory };

    expect(updated.success).toBe(true);
    expect(updated.memory.lifecycleState).toBe("quarantined");
    expect(updated.memory.reviewState).toBe("needs_review");
    expect(updated.memory.privacyScope).toBe("user");
    expect(JSON.stringify(updated.memory)).not.toContain(secret);

    const history = (await sdk.trigger("mem::memory-history", {
      memoryId: created.memory.id,
    })) as { history: unknown[] };
    const auditRows = await kv.list("mem:audit");
    expect(JSON.stringify(history.history)).not.toContain(secret);
    expect(JSON.stringify(auditRows)).not.toContain(secret);
  });

  it("builds a today-in-memory inbox from daily observations, memories, and proposals", async () => {
    await kv.set("mem:sessions", "ses_today", {
      id: "ses_today",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-06-29T08:00:00Z",
      status: "completed",
      observationCount: 3,
      agentId: "codex",
    });
    await kv.set("mem:obs:ses_today", "obs_fail", {
      id: "obs_fail",
      sessionId: "ses_today",
      timestamp: "2026-06-29T09:00:00Z",
      type: "command_run",
      title: "npm test failed",
      facts: ["exit code 1"],
      narrative: "The billing test failed with an assertion error.",
      concepts: ["billing", "tests"],
      files: ["test/billing.test.ts"],
      importance: 8,
      agentId: "codex",
    });
    await kv.set("mem:obs:ses_today", "obs_fix", {
      id: "obs_fix",
      sessionId: "ses_today",
      timestamp: "2026-06-29T10:00:00Z",
      type: "decision",
      title: "Billing retry fix verified",
      facts: ["tests passed"],
      narrative: "The billing retry workflow was fixed and verified.",
      concepts: ["billing", "retry"],
      files: ["src/billing.ts"],
      importance: 9,
      agentId: "codex",
    });
    await kv.set("mem:obs:ses_today", "obs_claim", {
      id: "obs_claim",
      sessionId: "ses_today",
      timestamp: "2026-06-29T11:00:00Z",
      type: "discovery",
      title: "Unverified billing claim",
      facts: ["needs verification"],
      narrative: "An unresolved claim remains about billing retries.",
      concepts: ["billing", "claim"],
      files: ["src/billing.ts"],
      importance: 6,
      agentId: "codex",
    });
    const preference: Memory = {
      id: "mem_pref_today",
      createdAt: "2026-06-29T12:00:00Z",
      updatedAt: "2026-06-29T12:00:00Z",
      type: "preference",
      lane: "semantic_fact",
      lifecycleState: "active",
      reviewState: "unreviewed",
      title: "Billing preference",
      content: "Prefer narrow billing retry tests before broader suites.",
      concepts: ["billing", "tests"],
      files: ["test/billing.test.ts"],
      sessionIds: ["ses_today"],
      strength: 7,
      confidence: 0.92,
      version: 1,
      sourceObservationIds: ["obs_fix"],
      isLatest: true,
      project: "billing",
      agentId: "codex",
    };
    const lowConfidence: Memory = {
      ...preference,
      id: "mem_claim_today",
      type: "fact",
      title: "Billing claim",
      content: "Billing retries may still be flaky.",
      concepts: ["billing", "claim"],
      sourceObservationIds: [],
      confidence: 0.4,
    };
    await kv.set("mem:memories", preference.id, preference);
    await kv.set("mem:memories", lowConfidence.id, lowConfidence);
    await kv.set("mem:state", "team-memory-proposals:team_a", [
      {
        id: "prop_today",
        teamId: "team_a",
        project: "billing",
        action: "create",
        status: "pending",
        title: "Consolidate billing retry lesson",
        proposedAt: "2026-06-29T13:00:00Z",
        updatedAt: "2026-06-29T13:00:00Z",
      },
    ]);

    const inbox = (await sdk.trigger("mem::today-in-memory", {
      date: "2026-06-29",
      project: "billing",
      agentId: "codex",
      limit: 10,
    })) as {
      success: boolean;
      counts: Record<string, number>;
      failedCommands: Array<{ id: string }>;
      newPreferences: Array<{ id: string }>;
      proposedConsolidations: Array<{ id: string }>;
      unresolvedClaims: unknown[];
    };

    expect(inbox.success).toBe(true);
    expect(inbox.counts.observations).toBe(3);
    expect(inbox.failedCommands.map((row) => row.id)).toEqual(["obs_fail"]);
    expect(inbox.newPreferences.map((row) => row.id)).toEqual(["mem_pref_today"]);
    expect(inbox.proposedConsolidations.map((row) => row.id)).toEqual(["prop_today"]);
    expect(inbox.unresolvedClaims.length).toBeGreaterThanOrEqual(1);
  });

  it("suggests observation concepts that are not linked to matching memories", async () => {
    await kv.set("mem:sessions", "ses_mentions", {
      id: "ses_mentions",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-06-29T08:00:00Z",
      status: "completed",
      observationCount: 2,
    });
    await kv.set("mem:obs:ses_mentions", "obs_billing_unlinked", {
      id: "obs_billing_unlinked",
      sessionId: "ses_mentions",
      timestamp: "2026-06-29T09:00:00Z",
      type: "discovery",
      title: "Billing retry surfaced again",
      facts: [],
      narrative: "Billing retry behavior needs a backlink to existing memory.",
      concepts: ["billing", "retry"],
      files: ["src/billing.ts"],
      importance: 8,
    });
    await kv.set("mem:obs:ses_mentions", "obs_retry_linked", {
      id: "obs_retry_linked",
      sessionId: "ses_mentions",
      timestamp: "2026-06-29T10:00:00Z",
      type: "decision",
      title: "Retry policy already sourced",
      facts: [],
      narrative: "Retry policy is already linked.",
      concepts: ["retry", "orphan"],
      files: ["src/retry.ts"],
      importance: 7,
    });
    const billingMemory: Memory = {
      id: "mem_billing",
      createdAt: "2026-06-28T12:00:00Z",
      updatedAt: "2026-06-28T12:00:00Z",
      type: "fact",
      lane: "semantic_fact",
      lifecycleState: "active",
      reviewState: "reviewed",
      title: "Billing retry invariant",
      content: "Billing retry behavior is important.",
      concepts: ["billing"],
      files: ["src/billing.ts"],
      sessionIds: ["ses_mentions"],
      strength: 8,
      confidence: 0.9,
      version: 1,
      sourceObservationIds: [],
      isLatest: true,
      project: "billing",
    };
    const retryMemory: Memory = {
      ...billingMemory,
      id: "mem_retry",
      title: "Retry policy",
      content: "Retry policy is already linked.",
      concepts: ["retry"],
      sourceObservationIds: ["obs_billing_unlinked", "obs_retry_linked"],
    };
    await kv.set("mem:memories", billingMemory.id, billingMemory);
    await kv.set("mem:memories", retryMemory.id, retryMemory);

    const result = (await sdk.trigger("mem::memory-unlinked-mentions", {
      date: "2026-06-29",
      project: "billing",
      limit: 10,
    })) as {
      success: boolean;
      suggestions: Array<{
        normalizedConcept: string;
        status: string;
        candidateMemoryIds: string[];
        unlinkedObservationIds: string[];
      }>;
    };

    expect(result.success).toBe(true);
    const billing = result.suggestions.find(
      (row) => row.normalizedConcept === "billing",
    );
    const orphan = result.suggestions.find(
      (row) => row.normalizedConcept === "orphan",
    );
    expect(billing).toMatchObject({
      status: "existing_memory_unlinked",
      candidateMemoryIds: ["mem_billing"],
      unlinkedObservationIds: ["obs_billing_unlinked"],
    });
    expect(orphan).toMatchObject({
      status: "missing_memory",
      candidateMemoryIds: [],
      unlinkedObservationIds: ["obs_retry_linked"],
    });
    expect(
      result.suggestions.some((row) => row.normalizedConcept === "retry"),
    ).toBe(false);
  });
});
