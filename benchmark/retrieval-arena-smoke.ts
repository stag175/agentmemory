import { pathToFileURL } from "node:url";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { HybridSearch } from "../src/state/hybrid-search.js";
import type { CompressedObservation, EmbeddingProvider } from "../src/types.js";
import { generateDataset, type LabeledQuery } from "./dataset.js";

export interface RetrievalArenaThresholds {
  minHybridRecallAt5: number;
  minHybridRecallAt10: number;
  minHybridLiftAt5: number;
  maxHybridLatencyMs: number;
}

export interface RetrievalArenaSystemSummary {
  recallAt5: number;
  recallAt10: number;
  avgLatencyMs: number;
}

export interface RetrievalArenaSummary {
  schemaVersion: 1;
  name: "agentmemory-retrieval-arena-smoke";
  status: "pass" | "fail";
  generatedAt: string;
  dataset: {
    observations: number;
    queries: number;
  };
  thresholds: RetrievalArenaThresholds;
  systems: {
    bm25: RetrievalArenaSystemSummary;
    hybrid: RetrievalArenaSystemSummary;
  };
  lift: {
    recallAt5: number;
    recallAt10: number;
  };
  failures: string[];
}

const DEFAULT_THRESHOLDS: RetrievalArenaThresholds = {
  minHybridRecallAt5: 0.4,
  minHybridRecallAt10: 0.55,
  minHybridLiftAt5: -0.05,
  maxHybridLatencyMs: 50,
};

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function thresholdsFromEnv(): RetrievalArenaThresholds {
  return {
    minHybridRecallAt5: numberFromEnv(
      "ARENA_MIN_HYBRID_RECALL_AT_5",
      DEFAULT_THRESHOLDS.minHybridRecallAt5,
    ),
    minHybridRecallAt10: numberFromEnv(
      "ARENA_MIN_HYBRID_RECALL_AT_10",
      DEFAULT_THRESHOLDS.minHybridRecallAt10,
    ),
    minHybridLiftAt5: numberFromEnv(
      "ARENA_MIN_HYBRID_LIFT_AT_5",
      DEFAULT_THRESHOLDS.minHybridLiftAt5,
    ),
    maxHybridLatencyMs: numberFromEnv(
      "ARENA_MAX_HYBRID_LATENCY_MS",
      DEFAULT_THRESHOLDS.maxHybridLatencyMs,
    ),
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
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

function deterministicEmbedding(text: string, dims = 384): Float32Array {
  const arr = new Float32Array(dims);
  const words = text.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * 31 + i * 17) % dims;
      const idx2 = (word.charCodeAt(i) * 37 + i * 13 + word.length * 7) % dims;
      arr[idx] += 1;
      arr[idx2] += 0.5;
    }
  }
  const norm = Math.sqrt(arr.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < dims; i++) arr[i] /= norm;
  }
  return arr;
}

function recallAt(retrieved: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  const hits = relevantIds.filter((id) => topK.has(id)).length;
  return hits / relevantIds.length;
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function observeText(obs: CompressedObservation): string {
  return [obs.title, obs.narrative, ...obs.concepts, ...obs.facts].join(" ");
}

async function evaluateBm25(
  observations: CompressedObservation[],
  queries: LabeledQuery[],
): Promise<RetrievalArenaSystemSummary> {
  const index = new SearchIndex();
  for (const obs of observations) index.add(obs);

  const recall5: number[] = [];
  const recall10: number[] = [];
  const latencies: number[] = [];

  for (const query of queries) {
    const started = performance.now();
    const results = index.search(query.query, 20);
    latencies.push(performance.now() - started);
    const retrieved = results.map((result) => result.obsId);
    recall5.push(recallAt(retrieved, query.relevantObsIds, 5));
    recall10.push(recallAt(retrieved, query.relevantObsIds, 10));
  }

  return {
    recallAt5: average(recall5),
    recallAt10: average(recall10),
    avgLatencyMs: average(latencies),
  };
}

async function evaluateHybrid(
  observations: CompressedObservation[],
  queries: LabeledQuery[],
): Promise<RetrievalArenaSystemSummary> {
  const kv = mockKV();
  const bm25 = new SearchIndex();
  const vector = new VectorIndex();
  const dims = 384;

  for (const obs of observations) {
    bm25.add(obs);
    vector.add(obs.id, obs.sessionId, deterministicEmbedding(observeText(obs), dims));
    await kv.set(`mem:obs:${obs.sessionId}`, obs.id, obs);
  }

  const embedder: EmbeddingProvider = {
    name: "deterministic-smoke",
    dimensions: dims,
    embed: async (text: string) => deterministicEmbedding(text, dims),
    embedBatch: async (texts: string[]) =>
      texts.map((text) => deterministicEmbedding(text, dims)),
  };
  const hybrid = new HybridSearch(bm25, vector, embedder, kv as never, 0.4, 0.6, 0);

  const recall5: number[] = [];
  const recall10: number[] = [];
  const latencies: number[] = [];

  for (const query of queries) {
    const started = performance.now();
    const results = await hybrid.search(query.query, 20, { searchMode: "fast" });
    latencies.push(performance.now() - started);
    const retrieved = results.map((result) => result.observation.id);
    recall5.push(recallAt(retrieved, query.relevantObsIds, 5));
    recall10.push(recallAt(retrieved, query.relevantObsIds, 10));
  }

  return {
    recallAt5: average(recall5),
    recallAt10: average(recall10),
    avgLatencyMs: average(latencies),
  };
}

export function evaluateRetrievalArenaGate(
  systems: RetrievalArenaSummary["systems"],
  thresholds: RetrievalArenaThresholds,
): { status: "pass" | "fail"; failures: string[]; lift: RetrievalArenaSummary["lift"] } {
  const lift = {
    recallAt5: systems.hybrid.recallAt5 - systems.bm25.recallAt5,
    recallAt10: systems.hybrid.recallAt10 - systems.bm25.recallAt10,
  };
  const failures: string[] = [];

  if (systems.hybrid.recallAt5 < thresholds.minHybridRecallAt5) {
    failures.push(
      `hybrid recall@5 ${systems.hybrid.recallAt5.toFixed(3)} below ${thresholds.minHybridRecallAt5}`,
    );
  }
  if (systems.hybrid.recallAt10 < thresholds.minHybridRecallAt10) {
    failures.push(
      `hybrid recall@10 ${systems.hybrid.recallAt10.toFixed(3)} below ${thresholds.minHybridRecallAt10}`,
    );
  }
  if (lift.recallAt5 < thresholds.minHybridLiftAt5) {
    failures.push(
      `hybrid recall@5 lift ${lift.recallAt5.toFixed(3)} below ${thresholds.minHybridLiftAt5}`,
    );
  }
  if (systems.hybrid.avgLatencyMs > thresholds.maxHybridLatencyMs) {
    failures.push(
      `hybrid average latency ${systems.hybrid.avgLatencyMs.toFixed(2)}ms above ${thresholds.maxHybridLatencyMs}ms`,
    );
  }

  return { status: failures.length > 0 ? "fail" : "pass", failures, lift };
}

export async function runRetrievalArenaSmoke(
  thresholds: RetrievalArenaThresholds = thresholdsFromEnv(),
): Promise<RetrievalArenaSummary> {
  const { observations, queries } = generateDataset();
  const [bm25, hybrid] = await Promise.all([
    evaluateBm25(observations, queries),
    evaluateHybrid(observations, queries),
  ]);
  const systems = { bm25, hybrid };
  const gate = evaluateRetrievalArenaGate(systems, thresholds);

  return {
    schemaVersion: 1,
    name: "agentmemory-retrieval-arena-smoke",
    status: gate.status,
    generatedAt: new Date().toISOString(),
    dataset: {
      observations: observations.length,
      queries: queries.length,
    },
    thresholds,
    systems,
    lift: gate.lift,
    failures: gate.failures,
  };
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const summary = await runRetrievalArenaSmoke();
  console.log("agentmemory Retrieval Arena smoke");
  console.log(`  status: ${summary.status}`);
  console.log(
    `  corpus: ${summary.dataset.observations} observations, ${summary.dataset.queries} queries`,
  );
  console.log(
    `  bm25: recall@5 ${formatPct(summary.systems.bm25.recallAt5)}, recall@10 ${formatPct(summary.systems.bm25.recallAt10)}, avg ${summary.systems.bm25.avgLatencyMs.toFixed(2)}ms`,
  );
  console.log(
    `  hybrid: recall@5 ${formatPct(summary.systems.hybrid.recallAt5)}, recall@10 ${formatPct(summary.systems.hybrid.recallAt10)}, avg ${summary.systems.hybrid.avgLatencyMs.toFixed(2)}ms`,
  );
  console.log(
    `  lift: recall@5 ${formatPct(summary.lift.recallAt5)}, recall@10 ${formatPct(summary.lift.recallAt10)}`,
  );
  for (const failure of summary.failures) {
    console.error(`  failure: ${failure}`);
  }
  console.log(`RETRIEVAL_ARENA_SUMMARY_JSON=${JSON.stringify(summary)}`);
  process.exitCode = summary.status === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
