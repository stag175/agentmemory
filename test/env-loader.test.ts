import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const CAPTURE_CONTROL_ENV_KEYS = [
  "AGENTMEMORY_INCOGNITO",
  "AGENTMEMORY_CAPTURE_INCOGNITO",
  "AGENTMEMORY_CAPTURE_PAUSED",
  "AGENTMEMORY_PAUSE_CAPTURE",
  "AGENTMEMORY_CAPTURE_CONSENT",
  "AGENTMEMORY_CONSENT_CAPTURE",
  "AGENTMEMORY_CAPTURE",
  "AGENTMEMORY_AUTO_CAPTURE",
  "AGENTMEMORY_ENABLE_CAPTURE",
  "AGENTMEMORY_CAPTURE_ENABLED",
  "AGENTMEMORY_REQUIRE_CAPTURE_CONSENT",
] as const;
const ORIGINAL_CAPTURE_CONTROL_ENV = Object.fromEntries(
  CAPTURE_CONTROL_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof CAPTURE_CONTROL_ENV_KEYS)[number], string | undefined>;

let sandboxHome: string;

async function freshConfig() {
  vi.resetModules();
  return await import("../src/config.js");
}

function writeEnv(contents: string) {
  const dir = join(sandboxHome, ".agentmemory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env"), contents);
}

describe("loadEnvFile", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-env-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
    for (const key of CAPTURE_CONTROL_ENV_KEYS) {
      delete process.env[key];
    }
    delete process.env["AGENTMEMORY_DROP_STALE_INDEX"];
    delete process.env["CONSOLIDATION_ENABLED"];
    delete process.env["GRAPH_EXTRACTION_ENABLED"];
    delete process.env["TOKEN"];
    delete process.env["HASHVAL"];
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    for (const key of CAPTURE_CONTROL_ENV_KEYS) {
      const value = ORIGINAL_CAPTURE_CONTROL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("strips trailing inline # comments on unquoted values", async () => {
    writeEnv(
      [
        "AGENTMEMORY_AUTO_COMPRESS=true   # opt in to LLM compression",
        "CONSOLIDATION_ENABLED=true       # daily summarization",
        "GRAPH_EXTRACTION_ENABLED=true    # entity graph",
      ].join("\n"),
    );
    const cfg = await freshConfig();
    expect(cfg.isAutoCompressEnabled()).toBe(true);
    expect(cfg.isConsolidationEnabled()).toBe(true);
    expect(cfg.isGraphExtractionEnabled()).toBe(true);
  });

  it("preserves # inside double-quoted values", async () => {
    writeEnv('TOKEN="abc#def"');
    const cfg = await freshConfig();
    expect(cfg.getEnvVar("TOKEN")).toBe("abc#def");
  });

  it("preserves # inside single-quoted values", async () => {
    writeEnv("TOKEN='abc#def'");
    const cfg = await freshConfig();
    expect(cfg.getEnvVar("TOKEN")).toBe("abc#def");
  });

  it("treats hash without leading space as part of value", async () => {
    writeEnv("HASHVAL=abc#def");
    const cfg = await freshConfig();
    expect(cfg.getEnvVar("HASHVAL")).toBe("abc#def");
  });

  it("strips inline comment after a quoted value and unwraps quotes", async () => {
    writeEnv('TOKEN="abc" # trailing comment');
    const cfg = await freshConfig();
    expect(cfg.getEnvVar("TOKEN")).toBe("abc");
  });

  it("strips inline comment after a single-quoted value and unwraps quotes", async () => {
    writeEnv("TOKEN='abc' # trailing comment");
    const cfg = await freshConfig();
    expect(cfg.getEnvVar("TOKEN")).toBe("abc");
  });

  it("reads AGENTMEMORY_DROP_STALE_INDEX from the env file", async () => {
    writeEnv("AGENTMEMORY_DROP_STALE_INDEX=true");
    const cfg = await freshConfig();
    expect(cfg.isDropStaleIndexEnabled()).toBe(true);
  });

  it("can fail closed on automatic capture until consent is explicit", async () => {
    writeEnv("AGENTMEMORY_REQUIRE_CAPTURE_CONSENT=true");
    const cfg = await freshConfig();

    expect(cfg.getAutomaticCaptureControl()).toEqual({
      enabled: false,
      reason: "consent_required",
      source: "AGENTMEMORY_REQUIRE_CAPTURE_CONSENT",
    });

    process.env["AGENTMEMORY_CAPTURE_CONSENT"] = "true";
    expect(cfg.isAutomaticCaptureEnabled()).toBe(true);
  });
});
