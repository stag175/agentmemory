import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentmemoryHome,
  isBundledConfig,
  legacyDataMigrations,
  resolveEngineCwd,
  rewriteBundledConfig,
  runtimeConfigPath,
} from "../src/cli/engine-launch.js";

const HOME = "/Users/test";

describe("engine-launch path resolution", () => {
  it("agentmemoryHome and runtimeConfigPath anchor under ~/.agentmemory", () => {
    expect(agentmemoryHome(HOME)).toBe(join(HOME, ".agentmemory"));
    expect(runtimeConfigPath(HOME)).toBe(
      join(HOME, ".agentmemory", "iii-config.runtime.yaml"),
    );
  });

  it("isBundledConfig matches both package config locations", () => {
    const dist = "/opt/pkg/dist";
    expect(isBundledConfig(join(dist, "iii-config.yaml"), dist)).toBe(true);
    expect(isBundledConfig(join(dist, "..", "iii-config.yaml"), dist)).toBe(true);
    expect(isBundledConfig("/opt/pkg/iii-config.yaml", dist)).toBe(true);
    expect(isBundledConfig(join(HOME, ".agentmemory", "iii-config.yaml"), dist)).toBe(false);
    expect(isBundledConfig("/some/project/iii-config.yaml", dist)).toBe(false);
  });

  it("resolveEngineCwd keeps the invocation cwd for repo-local configs", () => {
    const repo = "/work/agentmemory";
    expect(resolveEngineCwd(join(repo, "iii-config.yaml"), repo, HOME)).toBe(repo);
  });

  it("resolveEngineCwd anchors at ~/.agentmemory for bundled and home configs", () => {
    const repo = "/work/some-project";
    expect(resolveEngineCwd("/opt/pkg/dist/iii-config.yaml", repo, HOME)).toBe(
      join(HOME, ".agentmemory"),
    );
    expect(
      resolveEngineCwd(join(HOME, ".agentmemory", "iii-config.yaml"), repo, HOME),
    ).toBe(join(HOME, ".agentmemory"));
    expect(resolveEngineCwd("/etc/custom-iii.yaml", repo, HOME)).toBe(
      join(HOME, ".agentmemory"),
    );
  });

  it("legacyDataMigrations pairs cwd data files with the home data dir", () => {
    const migrations = legacyDataMigrations("/work/proj", HOME);
    expect(migrations).toEqual([
      {
        from: join("/work/proj", "data", "state_store.db"),
        to: join(HOME, ".agentmemory", "data", "state_store.db"),
      },
      {
        from: join("/work/proj", "data", "stream_store"),
        to: join(HOME, ".agentmemory", "data", "stream_store"),
      },
    ]);
  });
});

describe("rewriteBundledConfig", () => {
  const SAMPLE = [
    "          file_path: ./data/state_store.db",
    "          file_path: ./data/stream_store",
    "      watch:",
    "        - src/**/*.ts",
    "      exec:",
    "        - node dist/index.mjs",
  ].join("\n");

  it("substitutes data paths, watch entry, and exec command with absolute paths", () => {
    const out = rewriteBundledConfig(SAMPLE, HOME, "/usr/bin/node", "/opt/pkg/dist/index.mjs");
    expect(out).toContain(
      `file_path: '${join(HOME, ".agentmemory", "data", "state_store.db")}'`,
    );
    expect(out).toContain(
      `file_path: '${join(HOME, ".agentmemory", "data", "stream_store")}'`,
    );
    expect(out).toContain("- '/opt/pkg/dist/index.mjs'");
    expect(out).toContain(`- '"/usr/bin/node" "/opt/pkg/dist/index.mjs"'`);
    expect(out).not.toContain("./data/");
    expect(out).not.toContain("src/**/*.ts");
  });

  it("escapes apostrophes in paths for single-quoted YAML", () => {
    const out = rewriteBundledConfig(
      SAMPLE,
      "/Users/o'brien",
      "/usr/bin/node",
      "/opt/pkg/dist/index.mjs",
    );
    expect(out).toContain("o''brien");
  });

  it("rewrites the real bundled config with no relative paths left", () => {
    const raw = readFileSync(join(import.meta.dirname, "..", "iii-config.yaml"), "utf-8");
    const out = rewriteBundledConfig(raw, HOME, process.execPath, "/opt/pkg/dist/index.mjs");
    expect(out).not.toContain("./data/");
    expect(out).not.toContain("src/**/*.ts");
    expect(out).not.toContain("- node dist/index.mjs");
    expect(out).toContain(join(HOME, ".agentmemory", "data", "state_store.db"));
    expect(out).toContain(join(HOME, ".agentmemory", "data", "stream_store"));
  });
});
