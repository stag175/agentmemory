import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextFileNoSymlink, writeTextFileNoSymlink } from "../src/fs-safety.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentmemory-fs-safety-"));
  roots.push(root);
  return root;
}

async function symlinkDir(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("fs-safety", () => {
  it("rejects writes through a symlinked parent directory", async () => {
    const root = await tempRoot();
    const safe = join(root, "safe");
    const moved = join(root, "safe-real");
    const outside = join(root, "outside");
    await mkdir(safe);
    await mkdir(outside);

    const target = join(safe, "out.md");
    await writeFile(target, "original", "utf-8");
    await rename(safe, moved);
    await symlinkDir(outside, safe);

    await expect(writeTextFileNoSymlink(target, "escaped")).rejects.toThrow(
      /symlink/i,
    );
    await expect(readFile(join(outside, "out.md"), "utf-8")).rejects.toThrow();
    await expect(readFile(join(moved, "out.md"), "utf-8")).resolves.toBe(
      "original",
    );
  });

  it("rejects reads through a symlinked parent directory", async () => {
    const root = await tempRoot();
    const safe = join(root, "safe");
    const moved = join(root, "safe-real");
    const outside = join(root, "outside");
    await mkdir(safe);
    await mkdir(outside);

    const target = join(safe, "secret.md");
    await writeFile(target, "original", "utf-8");
    await writeFile(join(outside, "secret.md"), "outside", "utf-8");
    await rename(safe, moved);
    await symlinkDir(outside, safe);

    await expect(readTextFileNoSymlink(target)).rejects.toThrow(/symlink/i);
  });
});
