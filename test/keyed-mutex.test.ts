import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withKeyedLock } from "../src/state/keyed-mutex.js";

const priorLockDir = process.env["AGENTMEMORY_LOCK_DIR"];
const priorDisableFileLocks = process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"];

function lockPath(root: string, key: string): string {
  return join(root, Buffer.from(key).toString("base64url"));
}

afterEach(() => {
  if (priorLockDir === undefined) delete process.env["AGENTMEMORY_LOCK_DIR"];
  else process.env["AGENTMEMORY_LOCK_DIR"] = priorLockDir;
  if (priorDisableFileLocks === undefined) {
    delete process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"];
  } else {
    process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"] = priorDisableFileLocks;
  }
});

describe("cross-process keyed mutex recovery", () => {
  it("immediately reclaims a fresh lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-lock-dead-"));
    process.env["AGENTMEMORY_LOCK_DIR"] = root;
    process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"] = "false";
    const key = "dead-owner";
    const target = lockPath(root, key);
    await mkdir(target);
    await writeFile(join(target, "owner"), "999999\n2026-08-13T00:00:00Z\n");

    await expect(
      withKeyedLock(key, async () => "recovered", {
        timeoutMs: 250,
        staleMs: 600_000,
      }),
    ).resolves.toBe("recovered");
    await expect(rm(target)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });

  it("never steals an old lock while its owner process is alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentmemory-lock-live-"));
    process.env["AGENTMEMORY_LOCK_DIR"] = root;
    process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"] = "false";
    const key = "live-owner";
    const target = lockPath(root, key);
    await mkdir(target);
    await writeFile(join(target, "owner"), `${process.pid}\n2020-01-01T00:00:00Z\n`);
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(target, old, old);

    await expect(
      withKeyedLock(key, async () => "stolen", {
        timeoutMs: 75,
        staleMs: 1,
      }),
    ).rejects.toThrow(`timed out acquiring lock: ${key}`);
    await rm(root, { recursive: true, force: true });
  });
});
