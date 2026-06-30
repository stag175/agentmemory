import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/state/reranker.js", () => ({
  rerank: vi.fn(async (_query: string, results: unknown[]) => results),
  isRerankerAvailable: vi.fn(() => true),
}));

import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { rerank } from "../src/state/reranker.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

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

function mockEmbeddingProvider(): EmbeddingProvider {
  return {
    name: "mock",
    dimensions: 2,
    embed: vi.fn(async () => new Float32Array([1, 0])),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0])),
    ),
  };
}

function mockGraphRetrieval(results: Array<{
  obsId: string;
  sessionId: string;
  score: number;
  graphContext: string;
  pathLength: number;
}> = []) {
  return {
    searchByEntities: vi.fn(async () => results),
    expandFromChunks: vi.fn(async () => results),
  };
}

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
    vi.mocked(rerank).mockClear();
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("applies candidate filters before result enrichment", async () => {
    const allowed = makeObs({
      id: "obs_allowed",
      sessionId: "ses_1",
      title: "auth allowed",
      narrative: "auth allowed candidate",
    });
    const blocked = makeObs({
      id: "obs_blocked",
      sessionId: "ses_2",
      title: "auth blocked",
      narrative: "auth blocked candidate",
    });
    bm25.add(allowed);
    bm25.add(blocked);
    await kv.set("mem:obs:ses_1", allowed.id, allowed);
    await kv.set("mem:obs:ses_2", blocked.id, blocked);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 10, {
      candidateFilter: (obsId) => obsId === allowed.id,
    });

    expect(results.map((r) => r.observation.id)).toEqual([allowed.id]);
  });

  it("fast mode skips graph retrieval and reranking", async () => {
    const obs1 = makeObs({
      id: "obs_fast_1",
      sessionId: "ses_1",
      title: "AuthRouter middleware",
      narrative: "AuthRouter auth middleware",
    });
    const obs2 = makeObs({
      id: "obs_fast_2",
      sessionId: "ses_1",
      title: "AuthRouter token checks",
      narrative: "AuthRouter token checks",
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", obs1.id, obs1);
    await kv.set("mem:obs:ses_1", obs2.id, obs2);

    const vector = new VectorIndex();
    vector.add(obs1.id, obs1.sessionId, new Float32Array([1, 0]));
    vector.add(obs2.id, obs2.sessionId, new Float32Array([1, 0]));

    const hybrid = new HybridSearch(
      bm25,
      vector,
      mockEmbeddingProvider(),
      kv as never,
      0.4,
      0.6,
      0.3,
      true,
    );
    const graph = mockGraphRetrieval([
      {
        obsId: "obs_graph",
        sessionId: "ses_graph",
        score: 1,
        graphContext: "AuthRouter graph",
        pathLength: 0,
      },
    ]);
    (hybrid as any).graphRetrieval = graph;

    const results = await hybrid.search("AuthRouter", 10, { searchMode: "fast" });

    expect(graph.searchByEntities).not.toHaveBeenCalled();
    expect(graph.expandFromChunks).not.toHaveBeenCalled();
    expect(rerank).not.toHaveBeenCalled();
    expect(results.map((r) => r.observation.id)).not.toContain("obs_graph");
  });

  it("balanced mode preserves graph expansion and reranking behavior", async () => {
    const obs1 = makeObs({
      id: "obs_balanced_1",
      sessionId: "ses_1",
      title: "AuthRouter middleware",
      narrative: "AuthRouter auth middleware",
    });
    const obs2 = makeObs({
      id: "obs_balanced_2",
      sessionId: "ses_1",
      title: "AuthRouter token checks",
      narrative: "AuthRouter token checks",
    });
    const graphObs = makeObs({
      id: "obs_graph_balanced",
      sessionId: "ses_graph",
      title: "Graph-linked AuthRouter decision",
      narrative: "Graph-linked AuthRouter decision",
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", obs1.id, obs1);
    await kv.set("mem:obs:ses_1", obs2.id, obs2);
    await kv.set("mem:obs:ses_graph", graphObs.id, graphObs);

    const vector = new VectorIndex();
    vector.add(obs1.id, obs1.sessionId, new Float32Array([1, 0]));
    vector.add(obs2.id, obs2.sessionId, new Float32Array([1, 0]));

    const hybrid = new HybridSearch(
      bm25,
      vector,
      mockEmbeddingProvider(),
      kv as never,
      0.4,
      0.6,
      0.3,
      true,
    );
    const graph = mockGraphRetrieval([
      {
        obsId: graphObs.id,
        sessionId: graphObs.sessionId,
        score: 1,
        graphContext: "AuthRouter graph",
        pathLength: 0,
      },
    ]);
    (hybrid as any).graphRetrieval = graph;

    const results = await hybrid.search("AuthRouter", 10, {
      searchMode: "balanced",
    });

    expect(graph.searchByEntities).toHaveBeenCalled();
    expect(graph.expandFromChunks).toHaveBeenCalled();
    expect(rerank).toHaveBeenCalled();
    expect(results.map((r) => r.observation.id)).toContain(graphObs.id);
  });

  it("deep mode allows graph retrieval and reranking when available", async () => {
    const obs1 = makeObs({
      id: "obs_deep_1",
      sessionId: "ses_1",
      title: "AuthRouter middleware",
      narrative: "AuthRouter auth middleware",
    });
    const obs2 = makeObs({
      id: "obs_deep_2",
      sessionId: "ses_1",
      title: "AuthRouter token checks",
      narrative: "AuthRouter token checks",
    });
    const graphObs = makeObs({
      id: "obs_graph_deep",
      sessionId: "ses_graph",
      title: "Deep graph AuthRouter decision",
      narrative: "Deep graph AuthRouter decision",
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", obs1.id, obs1);
    await kv.set("mem:obs:ses_1", obs2.id, obs2);
    await kv.set("mem:obs:ses_graph", graphObs.id, graphObs);

    const hybrid = new HybridSearch(
      bm25,
      null,
      null,
      kv as never,
      0.4,
      0.6,
      0.3,
      true,
    );
    const graph = mockGraphRetrieval([
      {
        obsId: graphObs.id,
        sessionId: graphObs.sessionId,
        score: 1,
        graphContext: "AuthRouter graph",
        pathLength: 0,
      },
    ]);
    (hybrid as any).graphRetrieval = graph;

    const results = await hybrid.search("AuthRouter", 10, { searchMode: "deep" });

    expect(graph.searchByEntities).toHaveBeenCalled();
    expect(rerank).toHaveBeenCalled();
    expect(results.map((r) => r.observation.id)).toContain(graphObs.id);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("uses the in-process VectorIndex path unchanged when no external store is wired (#13)", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const vector = new VectorIndex();
    vector.add(obs.id, obs.sessionId, new Float32Array([1, 0]));

    // Default constructor (no store argument) must run the existing in-process
    // VectorIndex path. The vector hit surfaces obs_1 with a non-zero
    // vectorScore, proving the in-process path served the read.
    const hybrid = new HybridSearch(
      bm25,
      vector,
      mockEmbeddingProvider(),
      kv as never,
    );

    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBeGreaterThan(0);
  });

  it("routes vector retrieval through a provided external store (#13)", async () => {
    const obs = makeObs({
      id: "obs_store",
      sessionId: "ses_store",
      title: "auth via external store",
      narrative: "auth via external store",
    });
    // Intentionally NOT added to the in-process VectorIndex — the only way this
    // obsId surfaces as a vector hit is via the external store.
    await kv.set("mem:obs:ses_store", obs.id, obs);

    const searchByVector = vi.fn(async () => [
      {
        id: "obs_store",
        score: 0.99,
        payload: { sessionId: "ses_store" },
      },
    ]);
    const store = {
      upsert: vi.fn(async () => {}),
      searchByVector,
      deleteByIds: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({
        reachable: true,
        status: 200,
        detail: "ok",
      })),
    };

    const hybrid = new HybridSearch(
      bm25,
      // A non-null in-process VectorIndex is supplied but MUST be ignored when
      // an external store is present.
      new VectorIndex(),
      mockEmbeddingProvider(),
      kv as never,
      0.4,
      0.6,
      0.3,
      false,
      store,
    );

    const results = await hybrid.search("auth", 10);

    expect(searchByVector).toHaveBeenCalledTimes(1);
    const [vector, limit] = searchByVector.mock.calls[0];
    expect(Array.isArray(vector)).toBe(true);
    expect(limit).toBe(20);
    expect(results.map((r) => r.observation.id)).toContain("obs_store");
    const stored = results.find((r) => r.observation.id === "obs_store");
    expect(stored?.vectorScore).toBe(0.99);
    expect(stored?.sessionId).toBe("ses_store");
  });

  it("setRetrievalStore late-binds the external store (#13)", async () => {
    const obs = makeObs({
      id: "obs_late",
      sessionId: "ses_late",
      title: "auth late bound",
      narrative: "auth late bound",
    });
    await kv.set("mem:obs:ses_late", obs.id, obs);

    const searchByVector = vi.fn(async () => [
      { id: "obs_late", score: 0.5, payload: { sessionId: "ses_late" } },
    ]);
    const store = {
      upsert: vi.fn(async () => {}),
      searchByVector,
      deleteByIds: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({
        reachable: true,
        status: 200,
        detail: "ok",
      })),
    };

    const hybrid = new HybridSearch(
      bm25,
      new VectorIndex(),
      mockEmbeddingProvider(),
      kv as never,
    );
    hybrid.setRetrievalStore(store);

    const results = await hybrid.search("auth", 10);
    expect(searchByVector).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.observation.id)).toContain("obs_late");
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });
});
