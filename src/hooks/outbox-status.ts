import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export type HookOutboxStatus = {
  directory: string;
  pending: number;
  claimed: number;
  temporary: number;
  failureRecords: number;
  oldestPendingAt?: string;
  available: boolean;
  error?: string;
};

function outboxDir(): string {
  return (
    process.env["AGENTMEMORY_HOOK_OUTBOX_DIR"] ||
    join(homedir(), ".agentmemory", "hook-outbox")
  );
}

async function countLines(path: string): Promise<number> {
  let count = 0;
  try {
    const lines = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line.trim()) count += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return count;
}

export async function getHookOutboxStatus(): Promise<HookOutboxStatus> {
  const directory = outboxDir();
  try {
    const names = await readdir(directory);
    const pendingNames = names.filter((name) => name.endsWith(".pending.json"));
    const claimed = names.filter((name) => name.includes(".sending.")).length;
    const temporary = names.filter((name) => name.includes(".tmp.")).length;
    let oldestMs: number | undefined;
    for (const name of pendingNames) {
      const info = await stat(join(directory, name)).catch(() => null);
      if (info && (oldestMs === undefined || info.mtimeMs < oldestMs)) {
        oldestMs = info.mtimeMs;
      }
    }
    return {
      directory,
      pending: pendingNames.length,
      claimed,
      temporary,
      failureRecords: await countLines(
        join(directory, "delivery-errors.ndjson"),
      ),
      ...(oldestMs === undefined
        ? {}
        : { oldestPendingAt: new Date(oldestMs).toISOString() }),
      available: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directory,
        pending: 0,
        claimed: 0,
        temporary: 0,
        failureRecords: 0,
        available: true,
      };
    }
    return {
      directory,
      pending: 0,
      claimed: 0,
      temporary: 0,
      failureRecords: 0,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
