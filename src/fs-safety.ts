import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { parse, relative, resolve, sep } from "node:path";
import type { Stats } from "node:fs";

function nofollowFlag(): number {
  return (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
}

function sameIdentity(a: Stats, b: Stats): boolean {
  if (a.dev === 0 && a.ino === 0) return true;
  if (b.dev === 0 && b.ino === 0) return true;
  return a.dev === b.dev && a.ino === b.ino;
}

function symlinkError(): Error {
  const err = new Error("symlinks are not supported");
  (err as NodeJS.ErrnoException).code = "ELOOP";
  return err;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function assertRegularFilePath(path: string): Promise<Stats> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw symlinkError();
  if (!stat.isFile()) {
    throw new Error("path must point to a regular file");
  }
  return stat;
}

export async function readTextFileNoSymlink(path: string): Promise<string> {
  await assertNoSymlinkPrefix(path);
  const before = await assertRegularFilePath(path);
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(path, constants.O_RDONLY | nofollowFlag());
    const opened = await fd.stat();
    if (!opened.isFile()) throw new Error("path must point to a regular file");
    if (!sameIdentity(before, opened)) throw symlinkError();
    await assertNoSymlinkPrefix(path);
    const after = await assertRegularFilePath(path);
    if (!sameIdentity(after, opened)) throw symlinkError();
    return await fd.readFile("utf-8");
  } finally {
    await fd?.close().catch(() => {});
  }
}

export async function writeTextFileNoSymlink(
  path: string,
  content: string,
): Promise<void> {
  await assertNoSymlinkPrefix(path);
  const before = await lstatOrNull(path);
  if (before?.isSymbolicLink()) throw symlinkError();
  if (before && !before.isFile()) {
    throw new Error("path must point to a regular file");
  }

  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | nofollowFlag(),
    );
    const opened = await fd.stat();
    if (!opened.isFile()) throw new Error("path must point to a regular file");
    if (before && !sameIdentity(before, opened)) throw symlinkError();
    await fd.writeFile(content, "utf-8");
    await assertNoSymlinkPrefix(path);
    const after = await assertRegularFilePath(path);
    if (!sameIdentity(after, opened)) throw symlinkError();
  } finally {
    await fd?.close().catch(() => {});
  }
}

async function assertNoSymlinkPrefix(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const rel = relative(parsed.root, absolute);
  const parts = rel.split(sep).filter(Boolean);
  let current = parsed.root;

  for (const part of parts) {
    current = resolve(current, part);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw symlinkError();
    if (!stat.isDirectory() && current !== absolute) {
      throw new Error("path prefix is not a directory");
    }
  }
}

export async function ensureDirectoryNoSymlink(path: string): Promise<void> {
  await assertNoSymlinkPrefix(path);
  await mkdir(path, { recursive: true });
  await assertNoSymlinkPrefix(path);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw symlinkError();
  if (!stat.isDirectory()) {
    throw new Error("path must point to a directory");
  }
}
