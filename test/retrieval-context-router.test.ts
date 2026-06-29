import { describe, expect, it } from "vitest";
import {
  buildCommunitySummaries,
  buildQueryPlan,
  normalizeSearchMode,
  normalizeRetrievalMode,
  packContext,
} from "../src/retrieval/context-router.js";
import type { RankedEvidence } from "../src/types.js";

describe("context router helpers", () => {
  it("normalizes search mode with balanced as the safe default", () => {
    expect(normalizeSearchMode("fast")).toBe("fast");
    expect(normalizeSearchMode("deep")).toBe("deep");
    expect(normalizeSearchMode("balanced")).toBe("balanced");
    expect(normalizeSearchMode("turbo")).toBe("balanced");
    expect(normalizeSearchMode(undefined)).toBe("balanced");
  });

  it("normalizes retrieval mode with basic as the safe default", () => {
    expect(normalizeRetrievalMode("basic")).toBe("basic");
    expect(normalizeRetrievalMode("local_graph")).toBe("local_graph");
    expect(normalizeRetrievalMode("global_community")).toBe("global_community");
    expect(normalizeRetrievalMode("drift")).toBe("drift");
    expect(normalizeRetrievalMode("as_of")).toBe("as_of");
    expect(normalizeRetrievalMode("wide")).toBe("basic");
    expect(normalizeRetrievalMode(undefined)).toBe("basic");
  });

  it("builds a query plan with bounded retrieval metadata", () => {
    const plan = buildQueryPlan({
      query: "memory leaks",
      searchMode: "deep",
      retrievalMode: "global_community",
      streams: ["bm25", "vector"],
      filterStage: "pre-ranking",
      hardFilters: { project: "billing" },
      requestedLimit: 5,
      overFetchLimit: 25,
      tokenBudget: 200,
    });

    expect(plan.searchMode).toBe("deep");
    expect(plan.retrievalMode).toBe("global_community");
    expect(plan.streams).toEqual(["bm25", "vector"]);
    expect(plan.hardFilters).toEqual({ project: "billing" });
    expect(plan.limits).toEqual({
      requested: 5,
      overFetch: 25,
      tokenBudget: 200,
    });
  });

  it("builds source-grounded community summaries for global retrieval", () => {
    const summaries = buildCommunitySummaries([
      {
        id: "m1",
        sourceType: "memory",
        rank: 1,
        title: "Billing retry",
        content: "Retry billing webhook failures with idempotency keys.",
        sourceIds: ["obs_1"],
        score: 0.9,
        reasons: ["keyword_match"],
        metadata: { communityId: "billing-webhooks" },
      },
      {
        id: "m2",
        sourceType: "observation",
        rank: 2,
        title: "Billing retries",
        content: "The final fix used deterministic webhook retry windows.",
        sourceIds: ["obs_2"],
        score: 0.7,
        reasons: ["semantic_match"],
        metadata: { communityId: "billing-webhooks" },
      },
      {
        id: "m3",
        sourceType: "memory",
        rank: 3,
        title: "Auth policy",
        content: "Auth policy belongs to a separate community.",
        sourceIds: ["obs_3"],
        score: 0.5,
        reasons: ["graph_match"],
        metadata: { communityId: "auth-policy" },
      },
    ], { minMembers: 2 });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sourceType: "community_summary",
      title: "Community: billing-webhooks",
      sourceIds: ["obs_1", "obs_2"],
      reasons: ["global_community", "community_summary"],
      metadata: {
        communityId: "billing-webhooks",
        memberCount: 2,
        sourceEvidenceIds: ["m1", "m2"],
      },
    });
    expect(summaries[0].content).toContain("m1:");
    expect(summaries[0].content).toContain("m2:");
    expect(summaries[0].content).not.toContain("Auth policy");
  });

  it("exposes temporal validity filters in query plans", () => {
    const plan = buildQueryPlan({
      query: "billing policy",
      streams: ["bm25"],
      filterStage: "pre-ranking",
      hardFilters: { project: "billing" },
      temporalFilter: {
        source: "asOf",
        validAt: "2026-02-01T00:00:00.000Z",
      },
    });

    expect(plan.hardFilters).toMatchObject({
      project: "billing",
      temporalValidity: {
        source: "asOf",
        validAt: "2026-02-01T00:00:00.000Z",
      },
    });
  });

  it("packs selected and ignored evidence with a budget report", () => {
    const evidence: RankedEvidence[] = [
      {
        id: "a",
        sourceType: "memory",
        rank: 1,
        content: "short memory",
        tokens: 4,
        reasons: ["keyword_match"],
      },
      {
        id: "b",
        sourceType: "observation",
        rank: 2,
        content: "this block is too large for the remaining budget",
        tokens: 20,
        reasons: ["semantic_match"],
      },
    ];

    const packed = packContext({
      evidence,
      budgetTokens: 12,
      header: "<ctx>",
      footer: "</ctx>",
    });

    expect(packed.context).toContain("short memory");
    expect(packed.blocks).toBe(1);
    expect(packed.tokens).toBe(8);
    expect(packed.budgetReport.selectedIds).toEqual(["a"]);
    expect(packed.budgetReport.ignored).toEqual([
      {
        id: "b",
        rank: 2,
        tokens: 20,
        reason: "token_budget_exceeded",
      },
    ]);
  });

  it("annotates packed evidence when explain is requested", () => {
    const packed = packContext({
      evidence: [
        {
          id: "m1",
          sourceType: "memory",
          rank: 1,
          content: "annotated",
          score: 0.25,
          tokens: 4,
          reasons: ["graph_match"],
        },
      ],
      budgetTokens: 40,
      explain: true,
    });

    expect(packed.context).toContain("<memory-source");
    expect(packed.context).toContain("why=graph_match");
    expect(packed.selected[0].content).toContain("<memory-source");
  });

  it("counts emitted explain wrappers against the budget", () => {
    const packed = packContext({
      evidence: [
        {
          id: "a",
          sourceType: "memory",
          rank: 1,
          content: "small",
          tokens: 1,
          reasons: ["keyword_match"],
        },
        {
          id: "b",
          sourceType: "memory",
          rank: 2,
          content: "second",
          tokens: 1,
          reasons: ["semantic_match"],
        },
      ],
      budgetTokens: 20,
      separator: "\n\n",
      explain: true,
    });

    expect(packed.blocks).toBe(0);
    expect(packed.budgetReport.ignored.map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("counts separators between selected blocks against the budget", () => {
    const packed = packContext({
      evidence: [
        {
          id: "a",
          sourceType: "memory",
          rank: 1,
          content: "one",
          tokens: 1,
          reasons: ["keyword_match"],
        },
        {
          id: "b",
          sourceType: "memory",
          rank: 2,
          content: "two",
          tokens: 1,
          reasons: ["semantic_match"],
        },
      ],
      budgetTokens: 2,
      separator: "\n\n",
    });

    expect(packed.blocks).toBe(1);
    expect(packed.budgetReport.selectedIds).toEqual(["a"]);
    expect(packed.budgetReport.ignored).toEqual([
      {
        id: "b",
        rank: 2,
        tokens: 1,
        reason: "token_budget_exceeded",
      },
    ]);
  });
});
