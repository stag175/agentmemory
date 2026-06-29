import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveWorkspaceRules } from "../src/functions/rules-resolver.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "rules-resolver-"));
  tempRoots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("resolveWorkspaceRules", () => {
  it("discovers known host rule sources and configurable instruction globs", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");
    write(join(root, "CLAUDE.md"), "claude instructions\n");
    write(join(root, "CONVENTIONS.md"), "team conventions\n");
    write(join(root, ".clinerules"), "cline instructions\n");
    write(
      join(root, ".cursor", "rules", "typescript.mdc"),
      [
        "---",
        "globs: src/**/*.ts",
        "description: TypeScript source guidance",
        "---",
        "Use explicit boundary validation.",
      ].join("\n"),
    );
    write(join(root, ".roo", "rules", "reviews.md"), "review instructions\n");
    write(join(root, ".windsurf", "rules", "style.md"), "style instructions\n");
    write(join(root, ".devin", "rules", "ops.md"), "ops instructions\n");
    write(join(root, "docs", "INSTRUCTIONS.md"), "custom instructions\n");

    const result = await resolveWorkspaceRules(root, {
      instructionGlobs: ["**/INSTRUCTIONS.md"],
    });

    expect(result.warnings).toEqual([]);
    expect(result.rules.map((rule) => rule.host).sort()).toEqual([
      "claude",
      "cline",
      "codex",
      "conventions",
      "cursor",
      "custom",
      "devin",
      "roo",
      "windsurf",
    ]);
    const cursorRule = result.rules.find((rule) => rule.host === "cursor");
    expect(cursorRule?.activation.mode).toBe("glob");
    expect(cursorRule?.activation.globs).toEqual(["src/**/*.ts"]);
    expect(cursorRule?.scope.kind).toBe("glob");
    expect(cursorRule?.relativePath).toBe(".cursor/rules/typescript.mdc");
  });

  it("gives more specific scoped rule files higher precedence", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "root instructions\n");
    write(join(root, "src", "AGENTS.md"), "src instructions\n");
    write(join(root, "src", "features", "AGENTS.md"), "feature instructions\n");

    const result = await resolveWorkspaceRules(root);
    const byPath = new Map(result.rules.map((rule) => [rule.relativePath, rule]));

    expect(byPath.get("src/AGENTS.md")?.precedence).toBeGreaterThan(
      byPath.get("AGENTS.md")!.precedence,
    );
    expect(byPath.get("src/features/AGENTS.md")?.precedence).toBeGreaterThan(
      byPath.get("src/AGENTS.md")!.precedence,
    );
    expect(result.rules[0].relativePath).toBe("src/features/AGENTS.md");
  });

  it("keeps content hashes stable across mtime changes", async () => {
    const root = tempDir();
    const path = join(root, "AGENTS.md");
    write(path, "same instructions\n");

    const first = await resolveWorkspaceRules(root);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    const second = await resolveWorkspaceRules(root);

    expect(second.rules[0].contentHash).toBe(first.rules[0].contentHash);
    expect(second.rules[0].metadata.contentHash).toBe(first.rules[0].contentHash);
    expect(second.rules[0].metadata.mtimeMs).not.toBe(first.rules[0].metadata.mtimeMs);
  });

  it("reports missing workspaces, oversized files, and unreadable files", async () => {
    const root = tempDir();
    const missing = await resolveWorkspaceRules(join(root, "missing"));
    expect(missing.rules).toEqual([]);
    expect(missing.warnings[0]?.code).toBe("workspace_missing");

    write(join(root, "AGENTS.md"), "x".repeat(32));
    const oversized = await resolveWorkspaceRules(root, { maxFileBytes: 8 });
    expect(oversized.rules).toEqual([]);
    expect(oversized.warnings.some((warning) => warning.code === "oversized_file")).toBe(true);

    write(join(root, "CLAUDE.md"), "unreadable\n");
    const unreadable = await resolveWorkspaceRules(root, {
      readFile: async (path) => {
        if (path.endsWith("CLAUDE.md")) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return "ok\n";
      },
    });
    expect(unreadable.rules.some((rule) => rule.relativePath === "CLAUDE.md")).toBe(false);
    expect(unreadable.warnings.some((warning) => warning.code === "unreadable_file")).toBe(true);
  });

  it("skips symlinked rule files when the platform can create them", async () => {
    const root = tempDir();
    const target = join(root, "target.md");
    const link = join(root, "AGENTS.md");
    write(target, "linked instructions\n");

    try {
      symlinkSync(target, link, "file");
    } catch {
      return;
    }

    const result = await resolveWorkspaceRules(root);
    expect(result.rules).toEqual([]);
    expect(result.warnings.some((warning) => warning.code === "symlink_skipped")).toBe(true);
  });
});
