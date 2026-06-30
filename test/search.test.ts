import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSearchFunction, getSearchIndex, rebuildIndex, setVectorIndex, setEmbeddingProvider, getVectorIndex } from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("mem::search", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSearchFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-01-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);

    const obsA: CompressedObservation = {
      id: "obs_a",
      sessionId: "ses_1",
      timestamp: "2026-01-01T00:00:00Z",
      type: "decision",
      title: "Auth middleware decision",
      subtitle: "JWT strategy",
      facts: ["Use rotating refresh tokens"],
      narrative: "Implemented auth middleware with JWT refresh rotation.",
      concepts: ["auth", "jwt"],
      files: ["src/auth.ts"],
      importance: 8,
    };
    const obsB: CompressedObservation = {
      id: "obs_b",
      sessionId: "ses_1",
      timestamp: "2026-01-02T00:00:00Z",
      type: "file_edit",
      title: "UI button styling",
      facts: ["Updated primary button color"],
      narrative: "Adjusted button styles in the settings page.",
      concepts: ["ui", "css"],
      files: ["src/ui/button.tsx"],
      importance: 4,
    };

    await kv.set(KV.observations("ses_1"), obsA.id, obsA);
    await kv.set(KV.observations("ses_1"), obsB.id, obsB);

    // Module-level SearchIndex singleton would leak across tests; reset.
    getSearchIndex().clear();
  });

  it("returns full format by default", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth middleware",
    })) as { format: string; results: Array<{ observation: CompressedObservation }> };

    expect(result.format).toBe("full");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.observation.id).toBe("obs_a");
  });

  it("returns compact format when requested", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth",
      format: "compact",
    })) as { format: string; results: Array<{ obsId: string; title: string }> };

    expect(result.format).toBe("compact");
    expect(result.results[0]?.obsId).toBe("obs_a");
    expect(result.results[0]?.title).toBe("Auth middleware decision");
  });

  it("returns narrative text and respects token budget", async () => {
    const result = (await sdk.trigger("mem::search", {
      query: "auth ui",
      format: "narrative",
      token_budget: 20,
    })) as {
      format: string;
      results: Array<{ obsId: string }>;
      text: string;
      tokens_used: number;
      tokens_budget: number;
      truncated: boolean;
    };

    expect(result.format).toBe("narrative");
    expect(result.tokens_budget).toBe(20);
    expect(result.tokens_used).toBeLessThanOrEqual(20);
    expect(typeof result.text).toBe("string");
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid format values", async () => {
    await expect(
      sdk.trigger("mem::search", { query: "auth", format: "verbose" }),
    ).rejects.toThrow("format must be one of");
  });

  it("surfaces saved memories from KV.memories (#265)", async () => {
    // mem::remember persists to KV.memories under a synthetic sessionId
    // ("memory") that has no corresponding KV.observations entry. mem::search
    // must fall back to KV.memories or memory_recall returns empty.
    await kv.set(KV.memories, "mem_x1", {
      id: "mem_x1",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      title: "Pineapple belongs on pizza",
      content: "Pineapple belongs on pizza for testing fallback path.",
      concepts: ["pineapple", "pizza"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    });
    // Force the rebuild to pick up the new memory (mem::search only
    // rebuilds on first call when idx.size === 0).
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "pineapple pizza",
      format: "compact",
    })) as { results: Array<{ obsId: string; title: string }> };

    const hit = result.results.find((r) => r.obsId === "mem_x1");
    expect(hit).toBeDefined();
    expect(hit?.title).toBe("Pineapple belongs on pizza");
  });

  it("filters saved memories by validAt validity", async () => {
    const baseMemory: Memory = {
      id: "mem_billing_current",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Billing policy",
      content: "Billing policy keeps invoice holds active.",
      concepts: ["billing", "policy"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      lifecycleState: "active",
    };
    const current = {
      ...baseMemory,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
    };
    const future = {
      ...baseMemory,
      id: "mem_billing_future",
      title: "Future billing policy",
      validFrom: "2026-03-01T00:00:00.000Z",
    };
    const stale = {
      ...baseMemory,
      id: "mem_billing_stale",
      title: "Stale billing policy",
      validUntil: "2026-01-15T00:00:00.000Z",
    };
    const expiredAt = {
      ...baseMemory,
      id: "mem_billing_expires_at",
      title: "ExpiresAt billing policy",
      expiresAt: "2026-01-20T00:00:00.000Z",
    } satisfies Memory & { expiresAt: string };

    for (const memory of [current, future, stale, expiredAt]) {
      await kv.set(KV.memories, memory.id, memory);
    }
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "billing policy",
      format: "compact",
      validAt: "2026-02-01T00:00:00.000Z",
    })) as { results: Array<{ obsId: string; title: string }> };

    expect(result.results.map((r) => r.obsId)).toEqual(["mem_billing_current"]);
  });

  it("filters saved memories by agentId before returning compact recall", async () => {
    const baseMemory: Memory = {
      id: "mem_agent_a",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Scoped phoenix policy",
      content: "Scoped phoenix policy belongs to one agent.",
      concepts: ["phoenix", "policy"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      lifecycleState: "active",
      agentId: "codex-a",
    };
    await kv.set(KV.memories, baseMemory.id, baseMemory);
    await kv.set(KV.memories, "mem_agent_b", {
      ...baseMemory,
      id: "mem_agent_b",
      title: "Scoped phoenix policy other",
      agentId: "codex-b",
    });
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "scoped phoenix policy",
      format: "compact",
      agentId: "codex-a",
    })) as { results: Array<{ obsId: string }> };

    expect(result.results.map((r) => r.obsId)).toEqual(["mem_agent_a"]);
  });

  it("excludes gate-flagged needs_review memories from recall (#fail-open)", async () => {
    const passing: Memory = {
      id: "mem_recallable",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      title: "Quokka recall policy",
      content: "Quokka recall policy is trusted and recallable.",
      concepts: ["quokka", "policy"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      lifecycleState: "active",
      reviewState: "unreviewed",
    };
    const flagged: Memory = {
      ...passing,
      id: "mem_flagged",
      title: "Quokka recall flagged",
      content: "Quokka recall flagged write awaiting review.",
      reviewState: "needs_review",
    };
    const rejected: Memory = {
      ...passing,
      id: "mem_rejected",
      title: "Quokka recall rejected",
      content: "Quokka recall rejected write.",
      reviewState: "rejected",
    };

    for (const memory of [passing, flagged, rejected]) {
      await kv.set(KV.memories, memory.id, memory);
    }
    await rebuildIndex(kv as never);

    const result = (await sdk.trigger("mem::search", {
      query: "quokka recall policy",
      format: "compact",
    })) as { results: Array<{ obsId: string }> };

    const ids = result.results.map((r) => r.obsId);
    expect(ids).toContain("mem_recallable");
    expect(ids).not.toContain("mem_flagged");
    expect(ids).not.toContain("mem_rejected");
  });

  it("rebuildIndex populates the vector index", async () => {
    const mockEmbedder = {
      name: "test",
      dimensions: 3,
      embed: async (_text: string) => new Float32Array([0.1, 0.2, 0.3]),
      embedBatch: async (_texts: string[]) =>
        _texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    };
    setEmbeddingProvider(mockEmbedder);
    setVectorIndex(new VectorIndex());

    await rebuildIndex(kv as never);

    const vi = getVectorIndex();
    expect(vi).not.toBeNull();
    expect(vi!.size).toBeGreaterThan(0);

    // Cleanup
    setVectorIndex(null);
    setEmbeddingProvider(null);
  });
});
