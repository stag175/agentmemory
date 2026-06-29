import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("viewer Trust surface", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("exposes a visible Trust tab and view", () => {
    expect(viewer).toContain('<button data-tab="trust">Trust</button>');
    expect(viewer).toContain('<div id="view-trust" class="view"></div>');
    expect(viewer).toContain("'audit', 'trust', 'activity'");
  });

  it("loads ledger, review queue, agent events, and search explain through REST", () => {
    expect(viewer).toContain("apiGet('memory-ledger?' + ledgerParams.toString())");
    expect(viewer).toContain("apiGet('memory-review-queue?' + trustQueryString(20))");
    expect(viewer).toContain("apiGet('agent-events?' + trustQueryString(50))");
    expect(viewer).toContain("apiGet('memory/today?' + trustQueryString(20))");
    expect(viewer).toContain("apiPost('search/explain', body)");
    expect(viewer).toContain("explain: true");
    expect(viewer).toContain("includeReport: true");
    expect(viewer).toContain("tokenBudget: 1200");
  });

  it("labels retrieved and injected memories in the Memory Used drawer", () => {
    expect(viewer).toContain("Memory Used");
    expect(viewer).toContain("Prompt / task");
    expect(viewer).toContain("Trace</button>");
    expect(viewer).toContain("Retrieved");
    expect(viewer).toContain("Injected");
    expect(viewer).toContain("Ranking");
    expect(viewer).toContain("Plan");
    expect(viewer).toContain("result.packedContext || explain.packedContext");
    expect(viewer).toContain("packed && packed.selected");
    expect(viewer).toContain("trustEvidenceMemoryId");
    expect(viewer).toContain("No source evidence");
    expect(viewer).toContain("source-backed");
    expect(viewer).toContain("needs source");
    expect(viewer).toContain("Open Workbench");
  });

  it("exposes a reversible edit workbench using lifecycle REST endpoints", () => {
    expect(viewer).toContain("Reversible Edit Workbench");
    expect(viewer).toContain("id=\"trust-workbench-memory-id\"");
    expect(viewer).toContain("data-action=\"trust-workbench-preview-tombstone\"");
    expect(viewer).toContain("apiPost('memory/inspect', { memoryId: wb.memoryId })");
    expect(viewer).toContain("apiGet(historyPath)");
    expect(viewer).toContain("path: 'memory/update'");
    expect(viewer).toContain("path: 'memory/archive'");
    expect(viewer).toContain("path: 'memory/restore'");
    expect(viewer).toContain("path: 'memory/delete'");
    expect(viewer).toContain("mode: 'tombstone'");
    expect(viewer).toContain("dryRun: !!dryRun");
  });

  it("keeps the Trust tab in the existing tab loader", () => {
    expect(viewer).toMatch(/case 'trust': if \(!state\.trust\.loaded\) await loadTrust\(\); break;/);
    expect(viewer).toContain("Memory Used");
    expect(viewer).toContain("Memory Ledger");
    expect(viewer).toContain("Review Queue");
    expect(viewer).toContain("Agent Events");
  });

  it("surfaces the Today in Memory inbox inside the Trust tab", () => {
    expect(viewer).toContain("Today in Memory");
    expect(viewer).toContain("renderTrustToday(today)");
    expect(viewer).toContain("renderTrustTodaySection('Failed Commands'");
    expect(viewer).toContain("renderTrustTodaySection('Unresolved Claims'");
    expect(viewer).toContain("renderTrustTodaySection('Proposed Consolidations'");
    expect(viewer).toContain("todayRowMemoryId");
  });
});
