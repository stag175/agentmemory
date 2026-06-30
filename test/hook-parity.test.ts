import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");

// Guards against two real regressions found in the roadmap-branch audit:
// (1) the notification hook leaking unredacted permission-prompt text, and
// (2) the bundled plugin lineage helper drifting out of parity with its
//     TypeScript source. roadmap-gap-smoke only checks the symbols EXIST;
//     these assertions check the security-relevant BEHAVIOR is present.
describe("hook source parity guards", () => {
  it("notification hook redacts title and message via safeString at the source", () => {
    const src = read("src/hooks/notification.ts");
    expect(src).toContain("safeString");
    expect(src).toMatch(/title:\s*safeString\(data\.title\)/);
    expect(src).toMatch(/message:\s*safeString\(data\.message\)/);
    // The raw passthrough that the audit flagged must not return.
    expect(src).not.toMatch(/title:\s*data\.title\s*,/);
    expect(src).not.toMatch(/message:\s*data\.message\s*,/);
  });

  it("bundled _lineage.mjs stays in capture-source parity with src/hooks/_lineage.ts", () => {
    const ts = read("src/hooks/_lineage.ts");
    const mjs = read("plugin/scripts/_lineage.mjs");
    // Both must stamp the automatic capture source — the .mjs previously
    // omitted it, silently mislabelling hook-captured events.
    expect(ts).toContain('captureSource: "automatic_hook"');
    expect(mjs).toContain('captureSource: "automatic_hook"');
    // Both expose the same lineage surface.
    for (const sym of ["buildLineage", "eventFields", "sendAgentEvent"]) {
      expect(ts).toContain(sym);
      expect(mjs).toContain(sym);
    }
  });
});
