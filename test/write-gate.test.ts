import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";
import type { Memory } from "../src/types.js";
import {
  evaluateWriteGate,
  type WriteGateDecision,
} from "../src/functions/write-gate.js";

type GatedMemory = Memory & { writeGate: WriteGateDecision };

describe("mem::remember write gate", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    setIndexPersistence(null);
    sdk.registerFunction("mem::cascade-update", async () => ({ success: true }));
    registerRememberFunction(sdk as never, kv as never);
  });

  it("passes high-quality scoped memories with provenance", async () => {
    const result = (await sdk.trigger("mem::remember", {
      content:
        "When rotating billing webhook secrets, update src/webhooks/rotate.ts and run npm test before deploying.",
      type: "workflow",
      concepts: ["billing", "webhook-rotation"],
      files: ["src/webhooks/rotate.ts"],
      project: "billing",
      sourceObservationIds: ["obs_1"],
      sourceType: "test",
      sourceUri: "file:///repo/src/webhooks/rotate.ts",
      branch: "main",
      commit: "abc123",
    })) as { success: boolean; memory: GatedMemory };

    expect(result.success).toBe(true);
    expect(result.memory.writeGate.pass).toBe(true);
    expect(result.memory.writeGate.reasons).toEqual(["accepted"]);
    expect(result.memory.writeGate.scores.quality).toBeGreaterThanOrEqual(0.75);
    expect(result.memory.reviewState).toBe("unreviewed");
    expect(result.memory.lifecycleState).toBe("active");
  });

  it("stores duplicate low-novelty memories but marks them for review", async () => {
    const payload = {
      content:
        "Always use the billing webhook rotation playbook before changing src/webhooks/rotate.ts.",
      type: "workflow",
      concepts: ["billing", "webhook-rotation"],
      files: ["src/webhooks/rotate.ts"],
      project: "billing",
      sourceObservationIds: ["obs_1"],
    };
    const first = (await sdk.trigger("mem::remember", payload)) as {
      memory: GatedMemory;
    };

    const duplicate = (await sdk.trigger("mem::remember", payload)) as {
      success: boolean;
      memory: GatedMemory;
    };

    expect(duplicate.success).toBe(true);
    expect(duplicate.memory.writeGate.pass).toBe(false);
    expect(duplicate.memory.writeGate.reasons).toContain("low_novelty");
    expect(duplicate.memory.writeGate.nearestMemoryId).toBe(first.memory.id);
    expect(duplicate.memory.reviewState).toBe("needs_review");
    expect(duplicate.memory.supersedes).toContain(first.memory.id);
  });

  it("does not let one agent supersede or downrank another agent's memory", async () => {
    const payload = {
      content:
        "Always use the billing webhook rotation playbook before changing src/webhooks/rotate.ts.",
      type: "workflow",
      concepts: ["billing", "webhook-rotation"],
      files: ["src/webhooks/rotate.ts"],
      project: "billing",
      sourceObservationIds: ["obs_1"],
    };
    const first = (await sdk.trigger("mem::remember", {
      ...payload,
      agentId: "agent-a",
    })) as { memory: GatedMemory };

    const second = (await sdk.trigger("mem::remember", {
      ...payload,
      agentId: "agent-b",
    })) as { success: boolean; memory: GatedMemory };

    expect(second.success).toBe(true);
    expect(second.memory.writeGate.nearestMemoryId).toBeUndefined();
    expect(second.memory.supersedes).toEqual([]);
    expect(second.memory.parentId).toBeUndefined();
    const storedFirst = await kv.get<Memory>(KV.memories, first.memory.id);
    expect(storedFirst?.lifecycleState).toBe("active");
    expect(storedFirst?.isLatest).toBe(true);
  });

  it("ignores temporally stale memories when scoring novelty", () => {
    const content =
      "When rotating billing webhook secrets, update src/webhooks/rotate.ts and run npm test before deploying.";
    const staleMemory: Memory = {
      id: "mem_stale",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      type: "workflow",
      title: content.slice(0, 80),
      content,
      concepts: ["billing", "webhook-rotation"],
      files: ["src/webhooks/rotate.ts"],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
      lifecycleState: "active",
      validUntil: new Date(Date.now() - 60_000).toISOString(),
      project: "billing",
    };

    const decision = evaluateWriteGate({
      content,
      type: "workflow",
      concepts: ["billing", "webhook-rotation"],
      files: ["src/webhooks/rotate.ts"],
      sourceObservationIds: ["obs_1"],
      project: "billing",
      lane: "procedure",
      existingMemories: [staleMemory],
      privacySummary: {
        redactionApplied: false,
        labels: [],
        matchCount: 0,
      },
    });

    expect(decision.pass).toBe(true);
    expect(decision.scores.novelty).toBe(1);
    expect(decision.nearestMemoryId).toBeUndefined();
  });

  it("stores sensitive memories as quarantined with gate metadata", async () => {
    const secret = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const result = (await sdk.trigger("mem::remember", {
      content: `Never store this token ${secret}`,
      type: "fact",
      project: "billing",
    })) as { success: boolean; memory: GatedMemory };

    expect(result.success).toBe(true);
    expect(result.memory.content).not.toContain(secret);
    expect(result.memory.lifecycleState).toBe("quarantined");
    expect(result.memory.reviewState).toBe("needs_review");
    expect(result.memory.writeGate.pass).toBe(false);
    expect(result.memory.writeGate.reasons).toContain("sensitive_content");
    expect(result.memory.writeGate.sensitivityLabels).toContain(
      "openai_project_key",
    );
    expect(JSON.stringify(result.memory.writeGate)).not.toContain(secret);
  });

  it("rejects low-quality writes when strict gate mode is requested", async () => {
    const result = (await sdk.trigger("mem::remember", {
      content: "todo",
      writeGate: "require_pass",
    })) as { success: boolean; error: string; writeGate: WriteGateDecision };

    expect(result.success).toBe(false);
    expect(result.error).toBe("write gate rejected memory");
    expect(result.writeGate.mode).toBe("require_pass");
    expect(result.writeGate.reasons).toContain("low_quality");
    expect(await kv.list(KV.memories)).toEqual([]);
  });
});
