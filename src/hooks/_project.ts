import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const gitTopByDir = new Map<string, string>();

function findGitAncestor(dir: string): string | undefined {
  const start = resolve(dir);
  const cached = gitTopByDir.get(start);
  if (cached) return cached;

  const visited: string[] = [];
  let current = start;
  while (true) {
    const currentCached = gitTopByDir.get(current);
    if (currentCached) {
      for (const item of visited) gitTopByDir.set(item, currentCached);
      return currentCached;
    }

    visited.push(current);
    if (existsSync(join(current, ".git"))) {
      for (const item of visited) gitTopByDir.set(item, current);
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// Resolution order: AGENTMEMORY_PROJECT_NAME env → git toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  const ancestor = findGitAncestor(dir);
  if (ancestor) return basename(ancestor);
  return basename(dir);
}
