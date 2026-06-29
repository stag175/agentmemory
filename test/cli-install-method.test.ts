import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyInstallMethod } from "../src/cli/install-method.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentmemory-install-method-"));
  roots.push(root);
  return root;
}

function writePackage(root: string, name = "@agentmemory/agentmemory"): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }, null, 2));
}

function writeSourceMarkers(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "cli.ts"), "");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("install method classification", () => {
  it("treats an agentmemory source checkout as source-upgradeable", () => {
    const root = tempRoot();
    writePackage(root);
    writeSourceMarkers(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({ cwd: root, cliDir: dist, env: {} });

    expect(method.kind).toBe("source-checkout");
    expect(method.plan).toBe("source");
    expect(method.packageRoot).toBe(root);
  });

  it("does not treat an arbitrary package.json as a source checkout", () => {
    const cwd = tempRoot();
    writePackage(cwd, "unrelated-app");
    const cliDir = join(tempRoot(), "dist");
    mkdirSync(cliDir, { recursive: true });

    const method = classifyInstallMethod({ cwd, cliDir, env: {} });

    expect(method.kind).toBe("unknown");
    expect(method.plan).toBe("noop");
  });

  it("requires source markers even when package identity matches", () => {
    const cwd = tempRoot();
    writePackage(cwd);
    const cliDir = join(tempRoot(), "dist");
    mkdirSync(cliDir, { recursive: true });

    const method = classifyInstallMethod({ cwd, cliDir, env: {} });

    expect(method.kind).toBe("unknown");
    expect(method.plan).toBe("noop");
  });

  it("detects npm global installs by npm prefix", () => {
    const prefix = tempRoot();
    const root = join(prefix, "lib", "node_modules", "@agentmemory", "agentmemory");
    writePackage(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({
      cwd: tempRoot(),
      cliDir: dist,
      env: { npm_config_prefix: prefix },
    });

    expect(method.kind).toBe("global-npm");
    expect(method.plan).toBe("global-npm");
    expect(method.packageRoot).toBe(root);
  });

  it("lets Homebrew Cellar paths win over generic node_modules heuristics", () => {
    const prefix = tempRoot();
    const root = join(
      prefix,
      "Cellar",
      "agentmemory",
      "0.9.27",
      "lib",
      "node_modules",
      "@agentmemory",
      "agentmemory",
    );
    writePackage(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({
      cwd: tempRoot(),
      cliDir: dist,
      env: {},
    });

    expect(method.kind).toBe("homebrew");
    expect(method.plan).toBe("guidance");
  });

  it("detects npx cache installs and returns guidance only", () => {
    const cache = tempRoot();
    const root = join(cache, "_npx", "abc123", "node_modules", "@agentmemory", "agentmemory");
    writePackage(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({ cwd: tempRoot(), cliDir: dist, env: {} });

    expect(method.kind).toBe("npx-cache");
    expect(method.plan).toBe("guidance");
    expect(method.guidance.join("\n")).toContain("@agentmemory/agentmemory@latest");
  });

  it("detects Codex plugin cache installs and returns guidance only", () => {
    const cache = tempRoot();
    const root = join(cache, ".codex", "plugins", "cache", "agentmemory");
    writePackage(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({ cwd: tempRoot(), cliDir: dist, env: {} });

    expect(method.kind).toBe("codex-plugin-cache");
    expect(method.plan).toBe("guidance");
  });

  it("detects Claude plugin cache installs and returns guidance only", () => {
    const cache = tempRoot();
    const root = join(cache, ".claude-plugin", "agentmemory");
    writePackage(root);
    const dist = join(root, "dist");
    mkdirSync(dist);

    const method = classifyInstallMethod({ cwd: tempRoot(), cliDir: dist, env: {} });

    expect(method.kind).toBe("claude-plugin-cache");
    expect(method.plan).toBe("guidance");
  });
});
