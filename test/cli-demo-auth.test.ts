import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo CLI auth", () => {
  const source = readFileSync("src/cli.ts", "utf-8");
  const demoPostHelpers = source.slice(
    source.indexOf("async function postJson"),
    source.indexOf("async function runDemoSearch"),
  );

  it("sends AGENTMEMORY_SECRET on every demo POST request", () => {
    expect(source).toContain("function demoJsonHeaders()");
    expect(source).toContain('headers["Authorization"] = `Bearer ${secret}`');
    expect(demoPostHelpers.match(/headers: demoJsonHeaders\(\)/g)).toHaveLength(3);
    expect(demoPostHelpers).not.toContain('headers: { "Content-Type": "application/json" }');
  });

  it("prints an authenticated cleanup command when the daemon uses a secret", () => {
    expect(source).toContain('const cleanupAuthHeader = process.env["AGENTMEMORY_SECRET"]');
    expect(source).toContain('curl${cleanupAuthHeader} -X DELETE');
  });
});
