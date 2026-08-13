import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Viewer Memories tab used to render in KV-insertion order, hiding new
// entries at the bottom of long lists (#674). loadMemories() now sorts
// the response newest-first on `createdAt` (fallback `updatedAt`) before
// renderMemories sees it. Matches the pattern already used by Sessions
// and Sessions/Metrics tabs, while Sessions now use their latest
// `updatedAt` activity (falling back to `startedAt`).
describe("viewer Memories tab sorts newest first (#674)", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("loadMemories sorts items by createdAt desc before storing in state", () => {
    expect(viewer).toMatch(
      /loadMemories[\s\S]*?items\.sort\(function\(a,\s*b\)\s*\{[\s\S]*?bc\.localeCompare\(ac\)/,
    );
  });

  it("sort falls back to updatedAt when createdAt is missing", () => {
    expect(viewer).toMatch(
      /\(a && a\.createdAt\) \|\| \(a && a\.updatedAt\)/,
    );
    expect(viewer).toMatch(
      /\(b && b\.createdAt\) \|\| \(b && b\.updatedAt\)/,
    );
  });

  it("Sessions sort by updatedAt with a startedAt fallback", () => {
    expect(viewer).toMatch(/function sessionActivityAt\(s\)/);
    expect(viewer).toMatch(/s\.updatedAt \|\| s\.startedAt/);
    expect(viewer).toMatch(/sort\(compareSessionActivity\)/);
  });
});
