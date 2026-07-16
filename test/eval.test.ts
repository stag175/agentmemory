import { describe, it, expect, vi } from "vitest";
import {
  ObserveInputSchema,
  CompressOutputSchema,
  SummaryOutputSchema,
  SearchInputSchema,
  ContextInputSchema,
  RememberInputSchema,
} from "../src/eval/schemas.js";
import { validateInput, validateOutput } from "../src/eval/validator.js";
import {
  scoreCompression,
  scoreMemorySpecificity,
  scoreRetrievalScopeCoverage,
  scoreSummary,
  scoreContextRelevance,
} from "../src/eval/quality.js";
import {
  findPotentialSecretLeaks,
  isReleaseGateStatus,
} from "../src/eval/validator.js";
import { MetricsStore } from "../src/eval/metrics-store.js";
import {
  evaluateRetrievalArenaGate,
  runRetrievalArenaSmoke,
  thresholdsFromEnv,
} from "../benchmark/retrieval-arena-smoke.js";
import { generateDataset, generateScaleDataset } from "../benchmark/dataset.js";

describe("Zod Schemas", () => {
  describe("ObserveInputSchema", () => {
    it("accepts valid input", () => {
      const result = ObserveInputSchema.safeParse({
        hookType: "post_tool_use",
        sessionId: "ses_abc",
        project: "my-project",
        cwd: "/home/user",
        timestamp: "2026-01-01T00:00:00Z",
        data: { tool_name: "Read" },
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing sessionId", () => {
      const result = ObserveInputSchema.safeParse({
        hookType: "post_tool_use",
        project: "my-project",
        cwd: "/home/user",
        timestamp: "2026-01-01T00:00:00Z",
        data: {},
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid hookType", () => {
      const result = ObserveInputSchema.safeParse({
        hookType: "invalid_hook",
        sessionId: "ses_abc",
        project: "my-project",
        cwd: "/home/user",
        timestamp: "2026-01-01T00:00:00Z",
        data: {},
      });
      expect(result.success).toBe(false);
    });
  });

  describe("CompressOutputSchema", () => {
    it("accepts valid output", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Edit auth module",
        facts: ["Added JWT validation"],
        narrative: "Modified the auth middleware to validate tokens",
        concepts: ["auth"],
        files: ["src/auth.ts"],
        importance: 7,
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty facts array", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Edit auth module",
        facts: [],
        narrative: "Modified the auth middleware to validate tokens",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects title over 120 chars", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "x".repeat(121),
        facts: ["fact"],
        narrative: "A narrative that is long enough",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });

    it("rejects importance outside 1-10", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Test",
        facts: ["fact"],
        narrative: "A valid narrative here",
        concepts: [],
        files: [],
        importance: 11,
      });
      expect(result.success).toBe(false);
    });

    it("rejects narrative under 10 chars", () => {
      const result = CompressOutputSchema.safeParse({
        type: "file_edit",
        title: "Test",
        facts: ["fact"],
        narrative: "short",
        concepts: [],
        files: [],
        importance: 5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SummaryOutputSchema", () => {
    it("accepts valid summary", () => {
      const result = SummaryOutputSchema.safeParse({
        title: "Session Summary",
        narrative: "This session focused on implementing authentication features and fixing bugs",
        keyDecisions: ["Use JWT"],
        filesModified: ["auth.ts"],
        concepts: ["auth"],
      });
      expect(result.success).toBe(true);
    });

    it("rejects short narrative", () => {
      const result = SummaryOutputSchema.safeParse({
        title: "Summary",
        narrative: "Too short",
        keyDecisions: [],
        filesModified: [],
        concepts: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("SearchInputSchema", () => {
    it("accepts valid search", () => {
      expect(SearchInputSchema.safeParse({ query: "auth" }).success).toBe(true);
    });

    it("accepts search with limit", () => {
      expect(
        SearchInputSchema.safeParse({ query: "auth", limit: 10 }).success,
      ).toBe(true);
    });

    it("rejects empty query", () => {
      expect(SearchInputSchema.safeParse({ query: "" }).success).toBe(false);
    });
  });

  describe("ContextInputSchema", () => {
    it("accepts valid input", () => {
      expect(
        ContextInputSchema.safeParse({
          sessionId: "ses_1",
          project: "proj",
        }).success,
      ).toBe(true);
    });
  });

  describe("RememberInputSchema", () => {
    it("accepts valid input", () => {
      expect(
        RememberInputSchema.safeParse({
          content: "Always use TypeScript",
          type: "preference",
        }).success,
      ).toBe(true);
    });

    it("rejects empty content", () => {
      expect(
        RememberInputSchema.safeParse({ content: "" }).success,
      ).toBe(false);
    });
  });
});

describe("Validator", () => {
  it("returns valid with correct data", () => {
    const result = validateInput(SearchInputSchema, { query: "test" }, "search");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.query).toBe("test");
    }
  });

  it("returns invalid with error details", () => {
    const result = validateInput(SearchInputSchema, { query: "" }, "search");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.result.functionId).toBe("search");
      expect(result.result.errors.length).toBeGreaterThan(0);
    }
  });

  it("validateOutput works same as validateInput", () => {
    const result = validateOutput(
      CompressOutputSchema,
      {
        type: "file_edit",
        title: "Test",
        facts: ["a"],
        narrative: "A long enough narrative",
        concepts: [],
        files: [],
        importance: 5,
      },
      "compress",
    );
    expect(result.valid).toBe(true);
  });
});

describe("Quality Scoring", () => {
  describe("scoreCompression", () => {
    it("returns 0 for empty object", () => {
      expect(scoreCompression({})).toBe(0);
    });

    it("returns 100 for perfect observation", () => {
      const score = scoreCompression({
        type: "file_edit",
        title: "A good title",
        facts: ["fact 1", "fact 2", "fact 3"],
        narrative: "A narrative that is definitely more than fifty characters long and provides good context",
        concepts: ["auth", "jwt"],
        importance: 7,
      });
      expect(score).toBe(100);
    });

    it("scores partial observations between 0 and 100", () => {
      const score = scoreCompression({
        title: "Test",
        facts: ["one"],
        narrative: "Short but valid narrative",
      });
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(100);
    });
  });

  describe("scoreSummary", () => {
    it("returns 0 for empty object", () => {
      expect(scoreSummary({})).toBe(0);
    });

    it("returns high score for complete summary", () => {
      const score = scoreSummary({
        title: "Session Summary Title",
        narrative:
          "This is a detailed narrative about what happened during the session with enough content to be meaningful and complete for review purposes",
        keyDecisions: ["Used JWT for auth", "Chose PostgreSQL"],
        filesModified: ["src/auth.ts", "src/db.ts"],
        concepts: ["authentication", "database"],
      });
      expect(score).toBeGreaterThanOrEqual(90);
    });
  });

  describe("scoreContextRelevance", () => {
    it("returns 0 for empty context", () => {
      expect(scoreContextRelevance("", "proj")).toBe(0);
    });

    it("scores higher when project is mentioned", () => {
      const withProject = scoreContextRelevance(
        "<context>This is for my-project with details</context>",
        "my-project",
      );
      const without = scoreContextRelevance(
        "<context>Some generic context details</context>",
        "my-project",
      );
      expect(withProject).toBeGreaterThan(without);
    });

    it("scores higher with more XML sections", () => {
      const multi = scoreContextRelevance(
        "<summary>A</summary><observations>B</observations><memories>C</memories><patterns>D</patterns>",
        "test",
      );
      const single = scoreContextRelevance("<summary>A</summary>", "test");
      expect(multi).toBeGreaterThan(single);
    });
  });

  describe("memory-specific helpers", () => {
    it("scores scoped memories with provenance higher than vague memories", () => {
      const scoped = scoreMemorySpecificity({
        title: "Billing token rotation",
        content:
          "The billing service rotates local development tokens after each sandbox reset.",
        concepts: ["billing", "tokens"],
        files: ["src/billing.ts"],
        project: "billing",
        sessionIds: ["ses_1"],
        sourceObservationIds: ["obs_1"],
        sourceHash: "abc123",
        confidence: 0.9,
      });
      const vague = scoreMemorySpecificity({
        title: "Thing",
        content: "Remember this",
      });

      expect(scoped).toBeGreaterThan(90);
      expect(vague).toBeLessThan(scoped);
    });

    it("scores retrieval scope coverage from latest memories only", () => {
      const coverage = scoreRetrievalScopeCoverage([
        { isLatest: true, project: "billing" },
        { isLatest: true },
        { isLatest: false },
        { isLatest: true, project: "old", deletedAt: "2026-01-01T00:00:00Z" },
      ]);

      expect(coverage).toEqual({
        score: 50,
        latestCount: 2,
        scopedCount: 1,
        unscopedCount: 1,
      });
    });
  });
});

describe("Release Gate Eval Helpers", () => {
  it("keeps Retrieval Arena benchmark inputs deterministic", () => {
    const first = generateDataset();
    const second = generateDataset();

    expect(first.observations.map((obs) => [obs.id, obs.timestamp])).toEqual(
      second.observations.map((obs) => [obs.id, obs.timestamp]),
    );
    expect(first.queries).toEqual(second.queries);
    expect(generateScaleDataset(16).map((obs) => [obs.id, obs.timestamp])).toEqual(
      generateScaleDataset(16).map((obs) => [obs.id, obs.timestamp]),
    );
  });

  it("recognizes the release-gate evidence statuses", () => {
    expect(isReleaseGateStatus("pass")).toBe(true);
    expect(isReleaseGateStatus("fail")).toBe(true);
    expect(isReleaseGateStatus("blocked")).toBe(true);
    expect(isReleaseGateStatus("not_run")).toBe(true);
    expect(isReleaseGateStatus("warn")).toBe(false);
  });

  it("detects high-risk secret patterns in memory-shaped payloads", () => {
    const leaks = findPotentialSecretLeaks({
      content: "Never store ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij here",
    });

    expect(leaks).toEqual(["github_token"]);
  });

  it("reports metrics quality as not_run before any calls exist", async () => {
    const store = new Map<string, Map<string, unknown>>();
    const kv = {
      get: async <T>(scope: string, key: string): Promise<T | null> =>
        (store.get(scope)?.get(key) as T) ?? null,
      set: async <T>(scope: string, key: string, data: T): Promise<T> => {
        if (!store.has(scope)) store.set(scope, new Map());
        store.get(scope)!.set(key, data);
        return data;
      },
      list: async <T>(scope: string): Promise<T[]> => {
        const entries = store.get(scope);
        return entries ? (Array.from(entries.values()) as T[]) : [];
      },
    };
    const metrics = new MetricsStore(kv as never);

    expect(await metrics.getQualityEvidence(["mem::remember"])).toEqual([
      {
        functionId: "mem::remember",
        status: "not_run",
        totalCalls: 0,
        failureCount: 0,
        avgQualityScore: 0,
      },
    ]);

    await metrics.record("mem::remember", 15, true, 90);
    await metrics.record("mem::forget", 25, false, 80);

    expect(await metrics.getQualityEvidence(["mem::remember", "mem::forget"])).toMatchObject([
      { functionId: "mem::remember", status: "pass" },
      { functionId: "mem::forget", status: "fail" },
    ]);
  });

  it("runs the Retrieval Arena smoke gate with honest pass and fail outcomes", async () => {
    const summary = await runRetrievalArenaSmoke({
      minHybridRecallAt5: 0,
      minHybridRecallAt10: 0,
      minHybridLiftAt5: -1,
      minHybridLiftAt10: -1,
      maxHybridLatencyMs: 10_000,
    });

    expect(summary.name).toBe("agentmemory-retrieval-arena-smoke");
    expect(summary.dataset.observations).toBeGreaterThan(0);
    expect(summary.dataset.queries).toBeGreaterThan(0);
    expect(summary.status).toBe("pass");
    expect(summary.systems.hybrid.recallAt5).toBeGreaterThanOrEqual(0);
    expect(summary.systems.hybrid.recallAt10).toBeGreaterThanOrEqual(
      summary.systems.hybrid.recallAt5,
    );

    const strictGate = evaluateRetrievalArenaGate(summary.systems, {
      minHybridRecallAt5: 1.01,
      minHybridRecallAt10: 1.01,
      minHybridLiftAt5: 1.01,
      minHybridLiftAt10: 1.01,
      maxHybridLatencyMs: 0,
    });

    expect(strictGate.status).toBe("fail");
    expect(strictGate.failures.length).toBeGreaterThan(0);
  });

  it("pins the default Retrieval Arena release thresholds", () => {
    for (const name of [
      "ARENA_MIN_HYBRID_RECALL_AT_5",
      "ARENA_MIN_HYBRID_RECALL_AT_10",
      "ARENA_MIN_HYBRID_LIFT_AT_5",
      "ARENA_MIN_HYBRID_LIFT_AT_10",
      "ARENA_MAX_HYBRID_LATENCY_MS",
    ]) {
      vi.stubEnv(name, "");
    }
    try {
      expect(thresholdsFromEnv()).toEqual({
        minHybridRecallAt5: 0.425,
        minHybridRecallAt10: 0.585,
        minHybridLiftAt5: 0,
        minHybridLiftAt10: 0,
        maxHybridLatencyMs: 50,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
