import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

type Estimate = {
  available: boolean;
  reason?: string;
  fullHistoryTokens?: number;
  retrievalTokens?: number;
  avoidedTokens?: number;
  percent?: number;
};

const viewer = readFileSync("src/viewer/index.html", "utf-8");
const functionSource = viewer.match(
  /function computeContextReductionEstimate\([\s\S]*?\n    }\n\n    function renderDashboard/,
)?.[0].replace(/\n\n    function renderDashboard$/, "");

if (!functionSource) throw new Error("context-reduction estimator missing from viewer");

const estimate = new Function(
  `${functionSource}; return computeContextReductionEstimate;`,
)() as (observations: number, budget: number, available: boolean) => Estimate;

describe("viewer context-reduction estimate", () => {
  it("compares one bounded retrieval with one full-history load", () => {
    expect(estimate(82, 2_000, true)).toEqual({
      available: true,
      fullHistoryTokens: 6_560,
      retrievalTokens: 2_000,
      avoidedTokens: 4_560,
      percent: 70,
    });
  });

  it("does not invent savings when history fits inside the retrieval budget", () => {
    expect(estimate(10, 2_000, true)).toMatchObject({
      available: true,
      fullHistoryTokens: 800,
      retrievalTokens: 800,
      avoidedTokens: 0,
      percent: 0,
    });
  });

  it("reports unavailable instead of rendering a misleading zero", () => {
    expect(estimate(82, 2_000, false)).toEqual({
      available: false,
      reason: "session metrics unavailable",
    });
    expect(estimate(0, 2_000, true)).toEqual({
      available: false,
      reason: "needs captured observations",
    });
  });

  it("uses a safe default for an invalid retrieval budget", () => {
    expect(estimate(100, Number.NaN, true)).toMatchObject({
      fullHistoryTokens: 8_000,
      retrievalTokens: 2_000,
      avoidedTokens: 6_000,
      percent: 75,
    });
  });

  it("labels the value as an estimate and removes unsupported cost claims", () => {
    expect(viewer).toContain("Context Reduction (est.)");
    expect(viewer).toContain("This is not measured host-model token usage or a billing estimate.");
    expect(viewer).not.toContain('<div class="label">Token Savings</div>');
    expect(viewer).not.toContain("$0.30 per 1K tokens");
  });
});
