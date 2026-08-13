import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const locks = new Map<string, Promise<void>>();
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 10 * 60_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function lockRoot(): string {
  return (
    process.env["AGENTMEMORY_LOCK_DIR"] ??
    join(homedir(), ".agentmemory", "locks")
  );
}

function lockPath(key: string): string {
  return join(lockRoot(), Buffer.from(key).toString("base64url"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface KeyedLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

function ownerProcessIsAlive(ownerText: string): boolean | undefined {
  const rawPid = ownerText.split(/\r?\n/, 1)[0]?.trim();
  if (!rawPid || !/^\d+$/.test(rawPid)) return undefined;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but is owned by another user. Any
    // unknown probe failure must fail closed rather than stealing its lock.
    return true;
  }
}

async function acquireProcessLock(
  key: string,
  options: KeyedLockOptions = {},
): Promise<() => Promise<void>> {
  if (process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"] === "true") {
    return async () => {};
  }

  const target = lockPath(key);
  const timeoutMs =
    options.timeoutMs ??
    parsePositiveInt(
      process.env["AGENTMEMORY_LOCK_TIMEOUT_MS"],
      DEFAULT_LOCK_TIMEOUT_MS,
    );
  const staleMs =
    options.staleMs ??
    parsePositiveInt(
      process.env["AGENTMEMORY_LOCK_STALE_MS"],
      DEFAULT_LOCK_STALE_MS,
    );
  const deadline = Date.now() + timeoutMs;

  await mkdir(dirname(target), { recursive: true });

  while (true) {
    try {
      await mkdir(target);
      await writeFile(
        join(target, "owner"),
        `${process.pid}\n${new Date().toISOString()}\n`,
        "utf-8",
      );
      return async () => {
        await rm(target, { recursive: true, force: true });
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      if (code !== "EEXIST") throw error;

      try {
        const [existing, ownerText] = await Promise.all([
          stat(target),
          readFile(join(target, "owner"), "utf-8").catch(() => ""),
        ]);
        const ownerAlive = ownerProcessIsAlive(ownerText);
        // A crashed process can leave a fresh directory behind. Reclaim it
        // immediately. Conversely, never age-delete a live owner's lock: LLM
        // calls may legitimately run longer than the historical 10m stale age.
        if (
          ownerAlive === false ||
          (ownerAlive === undefined && Date.now() - existing.mtimeMs > staleMs)
        ) {
          await rm(target, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring lock: ${key}`);
      }
      await sleep(25);
    }
  }
}

export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: KeyedLockOptions = {},
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = async () => {
    const release = await acquireProcessLock(key, options);
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  const next = prev.then(run, run);
  const cleanup = next.then(
    () => {},
    () => {},
  );
  locks.set(key, cleanup);
  cleanup.then(() => {
    if (locks.get(key) === cleanup) locks.delete(key);
  });
  return next;
}
