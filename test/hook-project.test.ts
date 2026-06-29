import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveProject } from "../src/hooks/_project.js";

const repoRoot = resolve(import.meta.dirname, "..");
const repoBasename = basename(repoRoot);

describe("resolveProject — hook project basename resolver", () => {
  const originalEnv = process.env.AGENTMEMORY_PROJECT_NAME;

  beforeEach(() => {
    delete process.env.AGENTMEMORY_PROJECT_NAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENTMEMORY_PROJECT_NAME;
    } else {
      process.env.AGENTMEMORY_PROJECT_NAME = originalEnv;
    }
  });

  it("AGENTMEMORY_PROJECT_NAME env wins over everything", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "my-override";
    expect(resolveProject("/var/log")).toBe("my-override");
    expect(resolveProject(process.cwd())).toBe("my-override");
  });

  it("trims whitespace on env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "  spaced  ";
    expect(resolveProject("/var/log")).toBe("spaced");
  });

  it("ignores empty env override", () => {
    process.env.AGENTMEMORY_PROJECT_NAME = "   ";
    expect(resolveProject(repoRoot)).toBe(repoBasename);
  });

  it("returns git toplevel basename when cwd is inside a repo", () => {
    const top = resolveProject(repoRoot);
    expect(top).toBe(repoBasename);
  });

  it("returns git toplevel basename from a nested subdir", () => {
    const nested = join(repoRoot, "src", "hooks");
    expect(resolveProject(nested)).toBe(repoBasename);
  });

  it("walks ancestor .git markers before falling back to git shell", () => {
    const repo = mkdtempSync(join(tmpdir(), "amem-git-"));
    const nested = join(repo, "src", "hooks");
    try {
      mkdirSync(join(repo, ".git"));
      mkdirSync(nested, { recursive: true });
      expect(resolveProject(nested)).toBe(basename(repo));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to basename(cwd) when not in a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "amem-noproj-"));
    try {
      expect(resolveProject(dir)).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to process.cwd() when no cwd argument given", () => {
    expect(resolveProject()).toBe(resolveProject(process.cwd()));
  });

  it("defaults to process.cwd() when cwd argument is empty", () => {
    const currentProject = resolveProject(process.cwd());
    expect(resolveProject("")).toBe(currentProject);
    expect(resolveProject("   ")).toBe(currentProject);
  });
});
