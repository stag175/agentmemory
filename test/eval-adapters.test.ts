import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BENCHMARK_ADAPTERS,
  defaultBenchmarkAdapters,
  knownBenchmarkAdapters,
  resolveBenchmarkAdapters,
} from "../eval/runner/adapters/index.js";
import { UnavailableAdapterError } from "../eval/runner/adapters/unavailable.js";
import { grepAdapter } from "../eval/runner/adapters/grep.js";
import { aggregate, scoreQuestion } from "../eval/runner/score.js";
import type { Question, Session } from "../eval/runner/types.js";

const DATA_DIR = resolve(__dirname, "..", "eval", "data", "coding-agent-life-v1");
const sessions = JSON.parse(readFileSync(`${DATA_DIR}/sessions.json`, "utf8")) as Session[];
const queries = JSON.parse(readFileSync(`${DATA_DIR}/queries.json`, "utf8")) as Array<
  Omit<Question, "haystack">
>;

const coreAdapters = ["grep", "vector", "agentmemory"];
const competitorAdapters = [
  "mem0",
  "letta",
  "zep-graphiti",
  "langmem",
  "basic-memory",
  "openmemory",
  "supermemory",
];
const requiredTaskCategories = [
  "bug-replay",
  "stale-branch-trap",
  "pr-review-recall",
  "repo-onboarding",
  "failed-fix-avoidance",
  "deletion-correctness",
  "cross-agent-handoff",
];

describe("eval scaffold", () => {
  it("benchmark adapter registry exposes the runner default order", () => {
    expect(defaultBenchmarkAdapters()).toEqual(coreAdapters);
    expect(knownBenchmarkAdapters()).toEqual([...coreAdapters, ...competitorAdapters]);
    expect(resolveBenchmarkAdapters().map((descriptor) => descriptor.name)).toEqual([
      "grep",
      "vector",
      "agentmemory",
    ]);
    expect(resolveBenchmarkAdapters("grep, agentmemory").map((descriptor) => descriptor.name)).toEqual([
      "grep",
      "agentmemory",
    ]);
    expect(resolveBenchmarkAdapters(["vector", "grep"]).map((descriptor) => descriptor.name)).toEqual([
      "vector",
      "grep",
    ]);
  });

  it("benchmark adapter registry rejects unknown adapters with options", () => {
    expect(() => resolveBenchmarkAdapters("grep,missing")).toThrow(
      `unknown adapter: missing. options: ${[...coreAdapters, ...competitorAdapters].join(",")}`,
    );
  });

  it("benchmark adapter descriptors are complete and match adapters", () => {
    for (const descriptor of BENCHMARK_ADAPTERS) {
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.adapter.name.length).toBeGreaterThan(0);
      expect(descriptor.backend.length).toBeGreaterThan(0);
      expect(typeof descriptor.requiresApiKey).toBe("boolean");
      if (descriptor.requiresApiKey) {
        expect(descriptor.apiKeyEnv).toBeTruthy();
      }
      expect(descriptor.availability?.status).toMatch(/available|unavailable/);
    }
  });

  it("competitor descriptors resolve but report unavailable diagnostics", async () => {
    const descriptors = resolveBenchmarkAdapters(competitorAdapters);
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(competitorAdapters);
    for (const descriptor of descriptors) {
      expect(descriptor.defaultEnabled).toBe(false);
      expect(descriptor.availability?.status).toBe("unavailable");
      expect(descriptor.availability?.optionalExecutable).toBeTruthy();
      try {
        await descriptor.adapter.init([]);
        throw new Error("expected adapter init to skip");
      } catch (err) {
        expect(err).toBeInstanceOf(UnavailableAdapterError);
        const unavailable = err as UnavailableAdapterError;
        expect(unavailable.code).toBe("BENCHMARK_ADAPTER_UNAVAILABLE");
        expect(unavailable.skip).toMatchObject({
          status: "skipped",
          reason: "adapter_unavailable",
          adapter: descriptor.name,
          missing: {
            executableEnv: descriptor.availability?.optionalExecutable,
            configEnv: descriptor.availability?.optionalConfigEnv,
          },
          installHint: expect.stringContaining("does not bundle or auto-install competitor SDKs"),
        });
        expect(unavailable.toJSON()).toEqual({
          code: unavailable.code,
          skip: unavailable.skip,
        });
      }
    }
  });

  it("coding-agent-life-v1 corpus is well-formed", () => {
    expect(sessions.length).toBeGreaterThan(0);
    expect(queries.length).toBeGreaterThan(0);
    const sessionIds = new Set(sessions.map((s) => s.id));
    for (const q of queries) {
      expect(q.goldSessionIds.length).toBeGreaterThan(0);
      for (const id of q.goldSessionIds) {
        expect(sessionIds.has(id)).toBe(true);
      }
      expect(q.taskCategory).toBeTruthy();
      expect(q.taskTags?.length).toBeGreaterThan(0);
    }
  });

  it("coding-agent-life-v1 covers coding-memory task categories", () => {
    const categories = new Set(queries.map((q) => q.taskCategory));
    for (const category of requiredTaskCategories) {
      expect(categories.has(category)).toBe(true);
    }
  });

  it("grep adapter ranks gold session in top-5 for most queries", async () => {
    const state = await grepAdapter.init(sessions);
    let hits = 0;
    for (const q of queries) {
      const ranked = await grepAdapter.query(q.question, state, 5);
      const topIds = new Set(ranked.map((r) => r.sessionId));
      if (q.goldSessionIds.some((id) => topIds.has(id))) hits += 1;
    }
    expect(hits / queries.length).toBeGreaterThan(0.5);
  });

  it("scoreQuestion computes P@K, R@K, hit, topGoldRank", () => {
    const q: Question = {
      id: "test",
      type: "single-session",
      question: "?",
      goldSessionIds: ["a", "b"],
      haystack: [],
    };
    const ranked = [
      { sessionId: "x", score: 0.9 },
      { sessionId: "a", score: 0.7 },
      { sessionId: "y", score: 0.5 },
      { sessionId: "b", score: 0.3 },
    ];
    const row = scoreQuestion(q, ranked, 5, "test", 12);
    expect(row.hit).toBe(true);
    expect(row.recallAtK).toBe(1);
    expect(row.precisionAtK).toBeCloseTo(2 / 5);
    expect(row.topGoldRank).toBe(2);
  });

  it("scoreQuestion handles miss", () => {
    const q: Question = {
      id: "test",
      type: "x",
      question: "?",
      goldSessionIds: ["a"],
      haystack: [],
    };
    const ranked = [
      { sessionId: "x", score: 1 },
      { sessionId: "y", score: 0.5 },
    ];
    const row = scoreQuestion(q, ranked, 5, "test", 5);
    expect(row.hit).toBe(false);
    expect(row.recallAtK).toBe(0);
    expect(row.topGoldRank).toBeNull();
  });

  it("aggregate computes per-adapter and per-type means", () => {
    const q: Question = {
      id: "1",
      type: "t1",
      question: "?",
      goldSessionIds: ["a"],
      haystack: [],
    };
    const row1 = scoreQuestion(q, [{ sessionId: "a", score: 1 }], 5, "grep", 10);
    const row2 = scoreQuestion(q, [{ sessionId: "x", score: 1 }], 5, "grep", 20);
    const agg = aggregate([row1, row2]);
    expect(agg.byAdapter.grep.hit).toBe(1);
    expect(agg.byAdapter.grep.n).toBe(2);
    expect(agg.byType.t1.grep.n).toBe(2);
  });
});
