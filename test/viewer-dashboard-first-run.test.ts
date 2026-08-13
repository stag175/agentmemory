import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("viewer dashboard first-run state", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("requires a successful sessions response before showing first-run guidance", () => {
    expect(viewer).toMatch(/sessionsAvailable:\s*false/);
    expect(viewer).toMatch(/sessionsAvailable = !!\(results\[1\] && Array\.isArray\(results\[1\]\.sessions\)\)/);
    expect(viewer).toMatch(/var genuineFirstRun = d\.sessionsAvailable && d\.memoriesAvailable/);
    expect(viewer).toContain("sessions?agentId=*");
    expect(viewer).toContain("memories?latest=true&limit=500&agentId=*");
  });

  it("renders a retryable unavailable state instead of lying about first run", () => {
    expect(viewer).toContain("Session data temporarily unavailable");
    expect(viewer).toContain("could not verify session history");
  });

  it("preserves last-known-good data and prevents stale refreshes from winning", () => {
    expect(viewer).toMatch(/var dashboardLoadGeneration = 0/);
    expect(viewer).toMatch(/generation !== dashboardLoadGeneration/);
    expect(viewer).toMatch(/if \(state\.dashboard\.sessionsAvailable\) state\.dashboard\.sessions = results\[1\]\.sessions/);
  });
});
