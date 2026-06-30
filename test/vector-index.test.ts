import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VectorIndex } from "../src/state/vector-index.js";
import type { EmbeddingProvider } from "../src/types.js";
import type { RetrievalRuntimeStore } from "../src/state/retrieval-qdrant-adapter.js";
import {
  setVectorIndex,
  setEmbeddingProvider,
  setRetrievalStore,
  vectorIndexAddGuarded,
  vectorIndexRemove,
} from "../src/functions/search.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  bootLog: vi.fn(),
}));

describe("VectorIndex", () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex();
  });

  it("starts empty", () => {
    expect(index.size).toBe(0);
  });

  it("adds and retrieves vectors", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    expect(index.size).toBe(1);
  });

  it("removes a vector", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.remove("obs_1");
    expect(index.size).toBe(0);
  });

  it("returns empty array when searching empty index", () => {
    const results = index.search(new Float32Array([0.1, 0.2, 0.3]));
    expect(results).toEqual([]);
  });

  it("returns results sorted by cosine similarity", () => {
    index.add("obs_close", "ses_1", new Float32Array([1, 0, 0]));
    index.add("obs_far", "ses_1", new Float32Array([0, 1, 0]));
    index.add("obs_medium", "ses_1", new Float32Array([0.7, 0.7, 0]));

    const results = index.search(new Float32Array([1, 0, 0]));
    expect(results[0].obsId).toBe("obs_close");
    expect(results[0].score).toBeCloseTo(1.0, 5);
    expect(results[1].obsId).toBe("obs_medium");
    expect(results[2].obsId).toBe("obs_far");
    expect(results[2].score).toBeCloseTo(0.0, 5);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      index.add(`obs_${i}`, "ses_1", new Float32Array([i * 0.1, 0.5, 0.5]));
    }
    const results = index.search(new Float32Array([0.9, 0.5, 0.5]), 3);
    expect(results.length).toBe(3);
  });

  it("does not let disallowed top hits consume the result limit", () => {
    index.add("obs_blocked", "ses_1", new Float32Array([1, 0, 0]));
    index.add("obs_allowed", "ses_1", new Float32Array([0.8, 0.2, 0]));

    const results = index.search(
      new Float32Array([1, 0, 0]),
      1,
      (obsId) => obsId === "obs_allowed",
    );

    expect(results).toHaveLength(1);
    expect(results[0].obsId).toBe("obs_allowed");
  });

  it("clears all vectors", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.add("obs_2", "ses_1", new Float32Array([0.4, 0.5, 0.6]));
    index.clear();
    expect(index.size).toBe(0);
    expect(index.search(new Float32Array([0.1, 0.2, 0.3]))).toEqual([]);
  });

  it("serialize and deserialize round-trip preserves data", () => {
    index.add("obs_1", "ses_1", new Float32Array([0.1, 0.2, 0.3]));
    index.add("obs_2", "ses_2", new Float32Array([0.4, 0.5, 0.6]));

    const json = index.serialize();
    const restored = VectorIndex.deserialize(json);

    expect(restored.size).toBe(2);
    const results = restored.search(new Float32Array([0.1, 0.2, 0.3]), 2);
    expect(results.length).toBe(2);
    expect(results[0].obsId).toBe("obs_1");
    expect(results[0].sessionId).toBe("ses_1");
  });

  it("handles zero vectors without error", () => {
    index.add("obs_zero", "ses_1", new Float32Array([0, 0, 0]));
    const results = index.search(new Float32Array([1, 0, 0]));
    expect(results[0].score).toBe(0);
  });

  it("round-trip preserves dim + identity for pooled-Buffer sizes (#587)", () => {
    // 384-dim floats = 1536 bytes, comfortably inside Node's 8KB Buffer
    // pool. Without explicit byteOffset/byteLength in the base64 round-trip,
    // deserialise reads pool offset 0 and reports the entire pool as a
    // 2048-element view, which the live index then rejects with
    // "dimensions seen on disk: 2048".
    const DIM = 384;
    const vecs = Array.from({ length: 5 }, (_, n) => {
      const v = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) v[i] = n * 1000 + i;
      return v;
    });
    vecs.forEach((v, n) => index.add(`obs_${n}`, "ses_1", v));

    const restored = VectorIndex.deserialize(index.serialize());
    expect(restored.size).toBe(5);
    const { mismatches } = restored.validateDimensions(DIM);
    expect(mismatches).toEqual([]);
    for (let n = 0; n < 5; n++) {
      const results = restored.search(vecs[n], 1);
      expect(results[0].obsId).toBe(`obs_${n}`);
      expect(results[0].score).toBeCloseTo(1.0, 4);
    }
  });

  it("preserves bytes when source Float32Array is itself a sliced view (#587)", () => {
    // The encode side has the same risk: passing arr.buffer drops the
    // slice metadata if arr is a sub-view (subarray / typedArray.set).
    const backing = new Float32Array(8);
    for (let i = 0; i < 8; i++) backing[i] = i;
    const slice = backing.subarray(2, 6); // values 2, 3, 4, 5

    index.add("obs_slice", "ses_1", slice);
    const restored = VectorIndex.deserialize(index.serialize());
    const results = restored.search(new Float32Array([2, 3, 4, 5]), 1);
    expect(results[0].obsId).toBe("obs_slice");
    expect(results[0].score).toBeCloseTo(1.0, 4);
  });
});

describe("vector write-path dual-write to external retrieval store", () => {
  const EMBEDDING = new Float32Array([0.1, 0.2, 0.3]);

  function makeProvider(): EmbeddingProvider {
    return {
      name: "mock",
      dimensions: 3,
      embed: vi.fn(async () => EMBEDDING),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => EMBEDDING)),
    };
  }

  function makeStore(): RetrievalRuntimeStore {
    return {
      upsert: vi.fn(async () => {}),
      searchByVector: vi.fn(async () => []),
      deleteByIds: vi.fn(async () => {}),
      healthCheck: vi.fn(async () => ({
        reachable: true,
        status: 200,
        detail: "ok",
      })),
    };
  }

  // Microtask flush: vectorIndexRemove dual-deletes fire-and-forget, so its
  // store call resolves on a later microtask than the synchronous return.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  let localIndex: VectorIndex;

  beforeEach(() => {
    localIndex = new VectorIndex();
    setVectorIndex(localIndex);
    setEmbeddingProvider(makeProvider());
    setRetrievalStore(null);
  });

  afterEach(() => {
    // Reset module-level singletons so these tests don't leak into others.
    setRetrievalStore(null);
    setEmbeddingProvider(null);
    setVectorIndex(null);
    vi.clearAllMocks();
  });

  it("dual-writes the same embedding to store.upsert on add", async () => {
    const store = makeStore();
    setRetrievalStore(store);

    const ok = await vectorIndexAddGuarded("obs_1", "ses_1", "hello world", {
      kind: "observation",
      logId: "obs_1",
    });

    expect(ok).toBe(true);
    // Local index still written.
    expect(localIndex.size).toBe(1);
    // Store received the SAME embedding (as a number[]), keyed by id with
    // sessionId in the payload — matching the read-side mapping.
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledWith([
      { id: "obs_1", vector: Array.from(EMBEDDING), payload: { sessionId: "ses_1" } },
    ]);
  });

  it("dual-deletes by id from the store on remove", async () => {
    const store = makeStore();
    localIndex.add("obs_1", "ses_1", EMBEDDING);
    setRetrievalStore(store);

    vectorIndexRemove("obs_1");
    await flush();

    expect(localIndex.size).toBe(0);
    expect(store.deleteByIds).toHaveBeenCalledTimes(1);
    expect(store.deleteByIds).toHaveBeenCalledWith(["obs_1"]);
  });

  it("does not touch any store when none is configured", async () => {
    const store = makeStore();
    // store created but never wired via setRetrievalStore.

    const ok = await vectorIndexAddGuarded("obs_1", "ses_1", "hello", {
      kind: "observation",
      logId: "obs_1",
    });
    localIndex.add("obs_2", "ses_1", EMBEDDING);
    vectorIndexRemove("obs_2");
    await flush();

    expect(ok).toBe(true);
    expect(localIndex.size).toBe(1);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(store.deleteByIds).not.toHaveBeenCalled();
  });

  it("keeps the local add when the store upsert throws", async () => {
    const store = makeStore();
    (store.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("qdrant down"),
    );
    setRetrievalStore(store);

    const ok = await vectorIndexAddGuarded("obs_1", "ses_1", "hello", {
      kind: "observation",
      logId: "obs_1",
    });

    // External-store failure must not fail or block the local write.
    expect(ok).toBe(true);
    expect(localIndex.size).toBe(1);
    expect(store.upsert).toHaveBeenCalledTimes(1);
  });

  it("keeps the local remove when the store delete throws", async () => {
    const store = makeStore();
    (store.deleteByIds as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("qdrant down"),
    );
    localIndex.add("obs_1", "ses_1", EMBEDDING);
    setRetrievalStore(store);

    // Must not throw synchronously even though the store rejects.
    expect(() => vectorIndexRemove("obs_1")).not.toThrow();
    await flush();

    expect(localIndex.size).toBe(0);
    expect(store.deleteByIds).toHaveBeenCalledTimes(1);
  });
});
