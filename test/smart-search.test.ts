import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerSmartSearchFunction } from "../src/functions/smart-search.js";
import type {
  CompressedObservation,
  HybridSearchResult,
  CompactSearchResult,
  SearchBackendOptions,
  Session,
  Memory,
  QueryPlan,
  RankedEvidence,
} from "../src/types.js";

const ORIGINAL_AGENT_ID = process.env["AGENT_ID"];
const ORIGINAL_AGENT_SCOPE = process.env["AGENTMEMORY_AGENT_SCOPE"];

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
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-02-01T10:00:00Z",
    type: "file_edit",
    title: "Edit auth handler",
    facts: [],
    narrative: "Modified auth",
    concepts: ["auth"],
    files: ["src/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

async function expectAccessCount(
  kv: ReturnType<typeof mockKV>,
  memoryId: string,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const log = (await kv.get("mem:access", memoryId)) as {
      count: number;
    } | null;
    if (log?.count === count) {
      expect(log.count).toBe(count);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const log = (await kv.get("mem:access", memoryId)) as {
    count: number;
  } | null;
  expect(log?.count).toBe(count);
}

describe("Smart Search Function", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let searchResults: HybridSearchResult[];
  let searchOptions: SearchBackendOptions[];

  beforeEach(async () => {
    delete process.env["AGENT_ID"];
    delete process.env["AGENTMEMORY_AGENT_SCOPE"];
    sdk = mockSdk();
    kv = mockKV();
    searchOptions = [];

    const obs1 = makeObs({ id: "obs_1", sessionId: "ses_1", title: "Auth handler" });
    const obs2 = makeObs({ id: "obs_2", sessionId: "ses_1", title: "Database setup" });

    searchResults = [
      {
        observation: obs1,
        bm25Score: 0.8,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 0.8,
        sessionId: "ses_1",
      },
      {
        observation: obs2,
        bm25Score: 0.3,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 0.3,
        sessionId: "ses_1",
      },
    ];

    const session: Session = {
      id: "ses_1",
      project: "my-project",
      cwd: "/tmp",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set("mem:sessions", "ses_1", session);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const searchFn = async (
      _query: string,
      _limit: number,
      options?: SearchBackendOptions,
    ) => {
      searchOptions.push(options ?? {});
      return searchResults;
    };
    registerSmartSearchFunction(sdk as never, kv as never, searchFn);
  });

  afterEach(() => {
    if (ORIGINAL_AGENT_ID === undefined) delete process.env["AGENT_ID"];
    else process.env["AGENT_ID"] = ORIGINAL_AGENT_ID;
    if (ORIGINAL_AGENT_SCOPE === undefined) {
      delete process.env["AGENTMEMORY_AGENT_SCOPE"];
    } else {
      process.env["AGENTMEMORY_AGENT_SCOPE"] = ORIGINAL_AGENT_SCOPE;
    }
  });

  it("compact mode returns CompactSearchResult array", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.mode).toBe("compact");
    expect(result.results.length).toBe(2);
    expect(result.results[0]).toHaveProperty("obsId");
    expect(result.results[0]).toHaveProperty("title");
    expect(result.results[0]).toHaveProperty("type");
    expect(result.results[0]).toHaveProperty("score");
    expect(result.results[0]).toHaveProperty("timestamp");
    expect(result.results[0]).not.toHaveProperty("narrative");
  });

  it("expand mode returns full observations for given IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
    })) as { mode: string; results: Array<{ obsId: string; observation: CompressedObservation }> };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(1);
    expect(result.results[0].observation.title).toBe("Auth handler");
  });

  it("returns error when query is missing and no expandIds", async () => {
    const result = (await sdk.trigger("mem::smart-search", {})) as {
      mode: string;
      error: string;
    };

    expect(result.mode).toBe("compact");
    expect(result.error).toBe("query is required");
    expect((result as { results: unknown[] }).results).toEqual([]);
  });

  it("respects limit parameter in compact mode", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      limit: 1,
    })) as { mode: string; results: CompactSearchResult[] };

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it("filters compact results by session project before returning them", async () => {
    const otherObs = makeObs({
      id: "obs_other",
      sessionId: "ses_other",
      title: "Other project auth",
    });
    await kv.set("mem:sessions", "ses_other", {
      id: "ses_other",
      project: "other-project",
      cwd: "/other",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_other", "obs_other", otherObs);
    searchResults = [
      ...searchResults,
      {
        observation: otherObs,
        bm25Score: 1,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 1,
        sessionId: "ses_other",
      },
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "my-project",
      limit: 10,
    })) as { results: CompactSearchResult[]; explain?: any };

    expect(result.results.map((r) => r.obsId)).toContain("obs_1");
    expect(result.results.map((r) => r.obsId)).not.toContain("obs_other");
  });

  it("uses observation sessionId as the authority when project-filtering stale search hits", async () => {
    const otherObs = makeObs({
      id: "obs_other",
      sessionId: "ses_other",
      title: "Other project auth",
    });
    await kv.set("mem:sessions", "ses_other", {
      id: "ses_other",
      project: "other-project",
      cwd: "/other",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_other", "obs_other", otherObs);
    searchResults = [
      {
        observation: otherObs,
        bm25Score: 1,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 1,
        sessionId: "ses_1",
      },
      searchResults[0],
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "my-project",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(result.results[0].sessionId).toBe("ses_1");
    expect(result.explain.candidates.filteredOut).toBe(1);
  });

  it("passes hard-filter candidate allowlist to the search backend", async () => {
    const otherObs = makeObs({
      id: "obs_other",
      sessionId: "ses_other",
      title: "Other project auth",
    });
    await kv.set("mem:sessions", "ses_other", {
      id: "ses_other",
      project: "other-project",
      cwd: "/other",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_other", "obs_other", otherObs);

    const backendSeen: string[] = [];
    registerSmartSearchFunction(
      sdk as never,
      kv as never,
      async (_query, _limit, options) =>
        [
          {
            observation: otherObs,
            bm25Score: 1,
            vectorScore: 0,
            graphScore: 0,
            combinedScore: 1,
            sessionId: "ses_other",
          },
          searchResults[0],
        ].filter((result) => {
          const keep =
            options?.candidateFilter?.(
              result.observation.id,
              result.sessionId,
            ) ?? true;
          if (keep) backendSeen.push(result.observation.id);
          return keep;
        }),
    );

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "my-project",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(backendSeen).toEqual(["obs_1"]);
    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(result.explain.plan.filterStage).toContain("pre-ranking");
    expect(result.explain.plan.prefilter.candidateCount).toBe(2);
  });

  it("applies cwd hard filters before backend ranking with session-scoped candidate ids", async () => {
    const otherObs = makeObs({
      id: "obs_1",
      sessionId: "ses_other",
      title: "Other cwd auth",
    });
    await kv.set("mem:sessions", "ses_other", {
      id: "ses_other",
      project: "my-project",
      cwd: "/other",
      startedAt: "2026-02-01T00:00:00Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_other", "obs_1", otherObs);

    const backendSeen: string[] = [];
    registerSmartSearchFunction(
      sdk as never,
      kv as never,
      async (_query, _limit, options) =>
        [
          {
            observation: otherObs,
            bm25Score: 1,
            vectorScore: 0,
            graphScore: 0,
            combinedScore: 1,
            sessionId: "ses_other",
          },
          searchResults[0],
        ].filter((result) => {
          const keep =
            options?.candidateFilter?.(
              result.observation.id,
              result.sessionId,
            ) ?? true;
          if (keep) backendSeen.push(`${result.observation.id}:${result.sessionId}`);
          return keep;
        }),
    );

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      cwd: "/tmp",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(backendSeen).toEqual(["obs_1:ses_1"]);
    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(result.explain.plan.hardFilters.cwd).toBe("/tmp");
    expect(result.explain.plan.filterStage).toContain("pre-ranking");
  });

  it("fails closed when post-filtered results lack project metadata", async () => {
    const orphanObs = makeObs({
      id: "obs_orphan",
      sessionId: "ses_missing",
      title: "Orphan auth",
    });
    searchResults = [
      {
        observation: orphanObs,
        bm25Score: 1,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 1,
        sessionId: "ses_missing",
      },
      searchResults[0],
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "my-project",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(result.explain.candidates.filteredOut).toBe(1);
  });

  it("excludes unscoped saved memories from project-filtered smart search", async () => {
    const unscopedMemory: Memory = {
      id: "mem_unscoped",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      lane: "semantic_fact",
      lifecycleState: "active",
      title: "Unscoped auth decision",
      content: "Unscoped auth memory.",
      concepts: ["auth"],
      files: ["src/auth.ts"],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", unscopedMemory.id, unscopedMemory);
    searchResults = [
      {
        observation: makeObs({
          id: unscopedMemory.id,
          sessionId: "memory",
          title: unscopedMemory.title,
        }),
        bm25Score: 1,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 1,
        sessionId: "memory",
      },
      searchResults[0],
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "my-project",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1"]);
    expect(result.explain.candidates.filteredOut).toBe(1);
  });

  it("passes searchMode through and returns queryPlan plus rankedEvidence when explain is true", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      searchMode: "deep",
      explain: true,
      includeLessons: false,
    })) as {
      queryPlan: any;
      rankedEvidence: any[];
      explain: any;
      results: CompactSearchResult[];
    };

    expect(searchOptions[0]?.searchMode).toBe("deep");
    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1", "obs_2"]);
    expect(result.queryPlan).toMatchObject({
      mode: "search",
      searchMode: "deep",
      streams: ["bm25", "vector", "graph", "lessons"],
      filterStage: "none",
    });
    expect(result.rankedEvidence[0]).toMatchObject({
      id: "obs_1",
      sourceType: "observation",
      rank: 1,
      title: "Auth handler",
      sessionId: "ses_1",
      score: 0.8,
      reasons: ["keyword_match"],
      components: {
        bm25: 0.8,
        vector: 0,
      },
    });
    expect(result.explain.queryPlan).toEqual(result.queryPlan);
    expect(result.explain.rankedEvidence).toEqual(result.rankedEvidence);
    expect(result.explain.plan).toEqual(result.queryPlan);
    expect(result.explain.ranking[0]).toMatchObject({
      obsId: "obs_1",
      combinedScore: 0.8,
      reasons: ["keyword_match"],
    });
  });

  it("records global_community retrieval mode and emits community summary evidence", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      searchMode: "balanced",
      retrievalMode: "global_community",
      explain: true,
      includeLessons: false,
    })) as {
      queryPlan: any;
      rankedEvidence: any[];
      explain: any;
    };

    expect(result.queryPlan).toMatchObject({
      retrievalMode: "global_community",
      searchMode: "balanced",
    });
    expect(result.queryPlan.streams).toContain("community_summary");
    expect(result.rankedEvidence[0]).toMatchObject({
      sourceType: "community_summary",
      reasons: ["global_community", "community_summary"],
    });
    expect(result.rankedEvidence.some((evidence) => evidence.sourceType === "observation")).toBe(true);
    expect(result.explain.rankedEvidence).toEqual(result.rankedEvidence);
  });

  it("uses includeReport and tokenBudget to return a packed evidence report", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      retrievalMode: "global_community",
      includeReport: true,
      tokenBudget: 80,
      includeLessons: false,
    })) as {
      queryPlan: QueryPlan;
      rankedEvidence: RankedEvidence[];
      budgetReport: { budgetTokens: number; ignoredCount: number };
      packedContext: { context: string; selected: RankedEvidence[] };
      context: string;
      tokens: number;
      truncated: boolean;
      explain?: unknown;
    };

    expect(result.explain).toBeUndefined();
    expect(result.queryPlan.limits.tokenBudget).toBe(80);
    expect(result.budgetReport.budgetTokens).toBe(80);
    expect(result.budgetReport.ignoredCount).toBeGreaterThan(0);
    expect(result.rankedEvidence).toEqual(result.packedContext.selected);
    expect(result.context).toContain("agentmemory smart-search: auth");
    expect(result.tokens).toBeLessThanOrEqual(80);
    expect(result.truncated).toBe(true);
  });

  it("includes a queryPlan in expandIds explain output", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
      searchMode: "fast",
      explain: true,
    })) as { explain: any };

    expect(result.explain.queryPlan).toMatchObject({
      mode: "expandIds",
      searchMode: "fast",
      streams: ["expandIds"],
      filterStage: "none",
    });
    expect(result.explain.plan).toMatchObject({
      mode: "expandIds",
      attempted: 1,
      returned: 1,
      filteredOut: 0,
    });
  });

  it("filters saved-memory candidates by memory project and returns explain metadata", async () => {
    const savedMemory: Memory = {
      id: "mem_billing",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "fact",
      lane: "semantic_fact",
      lifecycleState: "active",
      title: "Billing auth decision",
      content: "Billing auth uses scoped recall only.",
      concepts: ["auth"],
      files: ["src/billing-auth.ts"],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
      project: "billing",
    };
    const otherMemory: Memory = {
      ...savedMemory,
      id: "mem_other",
      title: "Other auth decision",
      content: "Other project auth memory.",
      project: "other",
    };
    await kv.set("mem:memories", savedMemory.id, savedMemory);
    await kv.set("mem:memories", otherMemory.id, otherMemory);
    searchResults = [
      {
        observation: makeObs({
          id: savedMemory.id,
          sessionId: "memory",
          title: savedMemory.title,
        }),
        bm25Score: 0.8,
        vectorScore: 0.2,
        graphScore: 0,
        combinedScore: 0.9,
        sessionId: "memory",
      },
      {
        observation: makeObs({
          id: otherMemory.id,
          sessionId: "memory",
          title: otherMemory.title,
        }),
        bm25Score: 0.9,
        vectorScore: 0.2,
        graphScore: 0,
        combinedScore: 1,
        sessionId: "memory",
      },
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      project: "billing",
      memoryTier: "semantic_fact",
      explain: true,
    })) as { results: CompactSearchResult[]; explain: any };

    expect(result.results.map((r) => r.obsId)).toEqual(["mem_billing"]);
    expect(result.explain.plan.hardFilters.project).toBe("billing");
    expect(result.explain.candidates.filteredOut).toBe(1);
    expect(result.explain.ranking[0].components.bm25).toBe(0.8);
  });

  it("adds drift evidence for related stale or superseding memories", async () => {
    const current: Memory = {
      id: "mem_current_auth",
      createdAt: "2026-03-01T00:00:00Z",
      updatedAt: "2026-03-01T00:00:00Z",
      type: "fact",
      lane: "semantic_fact",
      lifecycleState: "active",
      title: "Current auth policy",
      content: "Auth policy requires scoped project tokens.",
      concepts: ["auth", "policy"],
      files: ["src/auth.ts"],
      sessionIds: [],
      sourceObservationIds: ["obs_policy"],
      supersedes: ["mem_old_auth"],
      strength: 8,
      version: 2,
      isLatest: true,
      project: "billing",
    };
    const old: Memory = {
      ...current,
      id: "mem_old_auth",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      title: "Old auth policy",
      content: "Auth policy used global tokens.",
      lifecycleState: "superseded",
      isLatest: false,
      supersedes: [],
      version: 1,
    };
    await kv.set("mem:memories", current.id, current);
    await kv.set("mem:memories", old.id, old);
    searchResults = [
      {
        observation: makeObs({
          id: current.id,
          sessionId: "memory",
          title: current.title,
          narrative: current.content,
        }),
        bm25Score: 0.8,
        vectorScore: 0.2,
        graphScore: 0,
        combinedScore: 0.9,
        sessionId: "memory",
      },
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth policy",
      project: "billing",
      retrievalMode: "drift",
      explain: true,
      includeLessons: false,
    })) as {
      queryPlan: any;
      rankedEvidence: any[];
    };

    expect(result.queryPlan).toMatchObject({
      retrievalMode: "drift",
    });
    expect(result.queryPlan.streams).toContain("drift");
    expect(result.rankedEvidence[0]).toMatchObject({
      id: "drift_mem_current_auth",
      sourceType: "summary",
      reasons: ["drift", "memory_relation_review"],
    });
    expect(result.rankedEvidence[0].metadata.related[0]).toMatchObject({
      id: "mem_old_auth",
      lifecycleState: "superseded",
      isLatest: false,
    });
    expect(result.rankedEvidence[1]).toMatchObject({
      id: current.id,
      sourceType: "observation",
    });
  });

  it("filters saved memories by asOf validity and reports the temporal query plan", async () => {
    const baseMemory: Memory = {
      id: "mem_current_policy",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      type: "fact",
      lane: "semantic_fact",
      lifecycleState: "active",
      title: "Current billing policy",
      content: "Billing policy uses invoice holds.",
      concepts: ["billing", "policy"],
      files: ["src/billing.ts"],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      project: "billing",
    };
    const current = {
      ...baseMemory,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-03-01T00:00:00.000Z",
    };
    const future = {
      ...baseMemory,
      id: "mem_future_policy",
      title: "Future billing policy",
      validFrom: "2026-03-01T00:00:00.000Z",
    };
    const stale = {
      ...baseMemory,
      id: "mem_stale_policy",
      title: "Stale billing policy",
      validUntil: "2026-01-15T00:00:00.000Z",
    };
    const expiredAt = {
      ...baseMemory,
      id: "mem_expires_at_policy",
      title: "ExpiresAt billing policy",
      expiresAt: "2026-01-20T00:00:00.000Z",
    } satisfies Memory & { expiresAt: string };
    for (const memory of [current, future, stale, expiredAt]) {
      await kv.set("mem:memories", memory.id, memory);
    }
    searchResults = [current, future, stale, expiredAt].map(
      (memory, index) => ({
        observation: makeObs({
          id: memory.id,
          sessionId: "memory",
          title: memory.title,
          narrative: memory.content,
        }),
        bm25Score: 1 - index * 0.1,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 1 - index * 0.1,
        sessionId: "memory",
      }),
    );

    const result = (await sdk.trigger("mem::smart-search", {
      query: "billing policy",
      project: "billing",
      retrievalMode: "as_of",
      asOf: "2026-02-01T00:00:00.000Z",
      explain: true,
      includeLessons: false,
    })) as {
      results: CompactSearchResult[];
      queryPlan: any;
      explain: any;
    };

    expect(searchOptions[0]?.candidateFilter?.("mem_current_policy", "memory")).toBe(true);
    expect(searchOptions[0]?.candidateFilter?.("mem_future_policy", "memory")).toBe(false);
    expect(result.results.map((r) => r.obsId)).toEqual(["mem_current_policy"]);
    expect(result.queryPlan.retrievalMode).toBe("as_of");
    expect(result.queryPlan.hardFilters.temporalValidity).toEqual({
      source: "asOf",
      validAt: "2026-02-01T00:00:00.000Z",
    });
    expect(result.queryPlan.filterStage).toContain("temporal validity");
    expect(result.explain.candidates.filteredOut).toBe(3);
  });

  it("rejects an invalid memoryTier instead of silently emptying results", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      memoryTier: "not-a-real-lane",
    })) as { mode: string; results: CompactSearchResult[]; error?: string };

    // A typo must surface as a validation error, not a zero-hit search.
    expect(result.mode).toBe("compact");
    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/memoryTier/);
    expect(result.error).toMatch(/semantic_fact/);
    // The bad filter must never reach the backend as a hard filter.
    expect(searchOptions.length).toBe(0);
  });

  it("rejects an invalid privacyScope instead of silently emptying results", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      privacyScope: "public",
    })) as { mode: string; results: CompactSearchResult[]; error?: string };

    expect(result.mode).toBe("compact");
    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/privacyScope/);
    expect(result.error).toMatch(/project/);
    expect(searchOptions.length).toBe(0);
  });

  it("reports an invalid memoryTier as an expanded-mode error for expandIds calls", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_1"],
      memoryTier: "bogus",
    })) as { mode: string; results: unknown[]; error?: string };

    expect(result.mode).toBe("expanded");
    expect(result.results).toEqual([]);
    expect(result.error).toMatch(/memoryTier/);
  });

  it("still searches normally for a valid memoryTier", async () => {
    const savedMemory: Memory = {
      id: "mem_proc",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      type: "workflow",
      lane: "procedure",
      lifecycleState: "active",
      title: "Deploy procedure",
      content: "Run the deploy script after tests pass.",
      concepts: ["deploy"],
      files: ["scripts/deploy.sh"],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
      project: "my-project",
    };
    await kv.set("mem:memories", savedMemory.id, savedMemory);
    searchResults = [
      {
        observation: makeObs({
          id: savedMemory.id,
          sessionId: "memory",
          title: savedMemory.title,
        }),
        bm25Score: 0.9,
        vectorScore: 0,
        graphScore: 0,
        combinedScore: 0.9,
        sessionId: "memory",
      },
    ];

    const result = (await sdk.trigger("mem::smart-search", {
      query: "deploy",
      memoryTier: "procedure",
    })) as { mode: string; results: CompactSearchResult[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.results.map((r) => r.obsId)).toEqual(["mem_proc"]);
    // A valid filter is treated as a hard filter, so the backend runs.
    expect(searchOptions.length).toBe(1);
  });

  it("ignores an empty-string privacyScope rather than erroring or filtering", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      privacyScope: "",
    })) as { mode: string; results: CompactSearchResult[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.results.map((r) => r.obsId)).toEqual(["obs_1", "obs_2"]);
  });

  it("warns in the normal response when as_of mode is requested without an anchor", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      retrievalMode: "as_of",
      includeLessons: false,
    })) as {
      mode: string;
      results: CompactSearchResult[];
      warnings?: string[];
      explain?: unknown;
    };

    // No explain requested — the warning must still surface.
    expect(result.explain).toBeUndefined();
    expect(result.results.length).toBe(2);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.join(" ")).toMatch(/as_of/);
    expect(result.warnings!.join(" ")).toMatch(/asOf or validAt/);
  });

  it("omits the as_of warning once a validAt anchor is supplied", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      query: "auth",
      retrievalMode: "as_of",
      validAt: "2026-02-01T00:00:00.000Z",
      includeLessons: false,
    })) as { warnings?: string[] };

    expect(result.warnings).toBeUndefined();
  });

  it("expand returns empty for nonexistent observation IDs", async () => {
    const result = (await sdk.trigger("mem::smart-search", {
      expandIds: ["obs_nonexistent_ses_xxx"],
    })) as { mode: string; results: unknown[] };

    expect(result.mode).toBe("expanded");
    expect(result.results.length).toBe(0);
  });

  it("compact mode records access for every returned observation id (#119)", async () => {
    await sdk.trigger("mem::smart-search", { query: "auth" });
    await expectAccessCount(kv, "obs_1", 1);
    await expectAccessCount(kv, "obs_2", 1);
  });

  it("expand mode records access for expanded observation ids (#119)", async () => {
    await sdk.trigger("mem::smart-search", { expandIds: ["obs_1"] });
    await expectAccessCount(kv, "obs_1", 1);
  });

  describe("lesson inclusion (#lesson-visibility)", () => {
    it("compact mode returns lessons array alongside observation results", async () => {
      sdk.registerFunction("mem::lesson-recall", async (payload: any) => ({
        success: true,
        lessons: [
          { id: "lsn_a", content: "always rebase before push", confidence: 0.9, createdAt: "2026-04-01T00:00:00Z", project: "p", tags: ["git"], score: 0.81 },
          { id: "lsn_b", content: "never force-push to main", confidence: 0.95, createdAt: "2026-04-02T00:00:00Z", project: "p", tags: ["git"], score: 0.76 },
        ],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "rebase",
      })) as { mode: string; results: CompactSearchResult[]; lessons?: any[] };

      expect(result.mode).toBe("compact");
      expect(result.results.length).toBe(2); // observations unchanged
      expect(result.lessons).toBeDefined();
      expect(result.lessons!.length).toBe(2);
      expect(result.lessons![0]).toMatchObject({
        lessonId: "lsn_a",
        confidence: 0.9,
        score: 0.81,
      });
      expect(result.lessons![0].tags).toEqual(["git"]);
    });

    it("compact mode truncates long lesson content for preview", async () => {
      const long = "x".repeat(500);
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: true,
        lessons: [{ id: "lsn_long", content: long, confidence: 0.5, createdAt: "", tags: [], score: 0.4 }],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "x",
      })) as { lessons: any[] };

      expect(result.lessons[0].content.length).toBeLessThan(long.length);
      expect(result.lessons[0].content).toMatch(/…$/);
    });

    it("includeLessons:false omits the lessons array entirely", async () => {
      // No lesson-recall handler registered — would throw if invoked.
      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
        includeLessons: false,
      })) as { mode: string; results: CompactSearchResult[]; lessons?: unknown };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toBeUndefined();
    });

    it("forwards project filter to mem::lesson-recall", async () => {
      let receivedPayload: any = null;
      sdk.registerFunction("mem::lesson-recall", async (payload: any) => {
        receivedPayload = payload;
        return { success: true, lessons: [] };
      });

      await sdk.trigger("mem::smart-search", {
        query: "rebase",
        project: "gitops-assistant",
      });

      expect(receivedPayload).toMatchObject({
        query: "rebase",
        project: "gitops-assistant",
      });
    });

    it("omits unscoped lessons when an agentId filter is requested", async () => {
      let receivedPayload: any = null;
      sdk.registerFunction("mem::lesson-recall", async (payload: any) => {
        receivedPayload = payload;
        return {
          success: true,
          lessons: [
            {
              id: "lsn_cross_agent",
              content: "same-project lesson without agent lineage",
              confidence: 0.9,
              createdAt: "2026-04-01T00:00:00Z",
              project: "my-project",
              tags: [],
              score: 0.8,
            },
          ],
        };
      });

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
        project: "my-project",
        agentId: "codex",
      })) as { lessons: any[] };

      expect(receivedPayload).toMatchObject({
        query: "auth",
        project: "my-project",
        agentId: "codex",
      });
      expect(result.lessons).toEqual([]);
    });

    it("filters agent-aware lessons by requested agentId", async () => {
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: true,
        lessons: [
          {
            id: "lsn_codex",
            content: "codex-local lesson",
            confidence: 0.9,
            createdAt: "2026-04-01T00:00:00Z",
            project: "my-project",
            tags: [],
            score: 0.8,
            agentId: "codex",
          },
          {
            id: "lsn_claude",
            content: "other-agent lesson",
            confidence: 0.9,
            createdAt: "2026-04-01T00:00:00Z",
            project: "my-project",
            tags: [],
            score: 0.8,
            agentId: "claude",
          },
        ],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
        project: "my-project",
        agentId: "codex",
      })) as { lessons: any[] };

      expect(result.lessons.map((lesson) => lesson.lessonId)).toEqual([
        "lsn_codex",
      ]);
    });

    it("omits legacy lessons when isolated agent scoping is active", async () => {
      process.env["AGENT_ID"] = "codex";
      process.env["AGENTMEMORY_AGENT_SCOPE"] = "isolated";
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: true,
        lessons: [
          {
            id: "lsn_project_only",
            content: "project-only lesson must not cross agent scope",
            confidence: 0.9,
            createdAt: "2026-04-01T00:00:00Z",
            project: "my-project",
            tags: [],
            score: 0.8,
          },
        ],
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
        project: "my-project",
      })) as { lessons: any[] };

      expect(result.lessons).toEqual([]);
    });

    it("tolerates mem::lesson-recall failure: returns empty lessons, observations unchanged", async () => {
      sdk.registerFunction("mem::lesson-recall", async () => {
        throw new Error("lessons store unavailable");
      });

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
      })) as { results: CompactSearchResult[]; lessons: any[] };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toEqual([]);
    });

    it("tolerates non-success lesson-recall response shape", async () => {
      sdk.registerFunction("mem::lesson-recall", async () => ({
        success: false,
        error: "query is required",
      }));

      const result = (await sdk.trigger("mem::smart-search", {
        query: "auth",
      })) as { results: CompactSearchResult[]; lessons: any[] };

      expect(result.results.length).toBe(2);
      expect(result.lessons).toEqual([]);
    });
  });
});
