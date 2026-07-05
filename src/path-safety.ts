import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export async function canonicalizePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export function parsePathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function resolveAllowedPath(
  requestedPath: string,
  allowedRoots: string[],
): Promise<string> {
  const resolved = resolve(requestedPath);
  const canonicalRequested = await canonicalizePath(resolved);
  const canonicalRoots = await Promise.all(
    allowedRoots
      .filter((entry) => entry.trim().length > 0)
      .map((entry) => canonicalizePath(resolve(entry))),
  );
  if (
    canonicalRoots.length === 0 ||
    !canonicalRoots.some((root) => isPathInside(root, canonicalRequested))
  ) {
    throw new Error("path is not within an allowed root");
  }
  return canonicalRequested;
}
