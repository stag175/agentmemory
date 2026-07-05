import type { ISdk } from "iii-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SnapshotMeta,
  Session,
  Memory,
  GraphNode,
  AccessLogExport,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { VERSION } from "../version.js";
import { logger } from "../logger.js";
import {
  decryptLocalJsonPayload,
  encryptLocalJsonPayload,
  LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
} from "../security/encryption.js";
import { encryptionPolicyFromEnv } from "../security/encryption-policy.js";
import { keySourceFromEncryptionKeyRef } from "../state/encryption-runtime.js";

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

const execFileAsync = promisify(execFile);

type SnapshotState = {
  version: string;
  timestamp: string;
  sessions: Session[];
  memories: Memory[];
  graphNodes: GraphNode[];
  observations: Record<string, unknown[]>;
  accessLogs: AccessLogExport[];
};

type KeyedSnapshotRecord = { id?: unknown } & Record<string, unknown>;

type ScopeReplacement<T> = {
  scope: string;
  entries: Array<[string, T]>;
  deleteIds: string[];
};

async function gitExec(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!existsSync(join(dir, ".git"))) {
    await gitExec(dir, ["init"]);
    await gitExec(dir, ["config", "user.email", "agentmemory@local"]);
    await gitExec(dir, ["config", "user.name", "agentmemory"]);
  }
}

function backupEncryptionKeyRef(): string | undefined {
  const config = encryptionPolicyFromEnv();
  return config.backups?.enabled === true ? config.backups.keyRef : undefined;
}

function encodeSnapshotState(state: SnapshotState): {
  content: string;
  encrypted: boolean;
  keyRef?: string;
} {
  const keyRef = backupEncryptionKeyRef();
  if (!keyRef) {
    return {
      content: JSON.stringify(state, null, 2),
      encrypted: false,
    };
  }
  const envelope = encryptLocalJsonPayload(
    state,
    keySourceFromEncryptionKeyRef(keyRef),
    { keyRef },
  );
  return {
    content: JSON.stringify(envelope, null, 2),
    encrypted: true,
    keyRef,
  };
}

function decodeSnapshotState(content: string): SnapshotState {
  const parsed = JSON.parse(content) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { version?: unknown }).version ===
      LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION
  ) {
    const envelopeKeyRef = (parsed as {
      keyManagement?: { keyRef?: unknown };
    }).keyManagement?.keyRef;
    const keyRef =
      typeof envelopeKeyRef === "string" ? envelopeKeyRef : backupEncryptionKeyRef();
    if (!keyRef) {
      throw new Error("encrypted snapshot requires a configured backup encryption key");
    }
    return decryptLocalJsonPayload<SnapshotState>(
      parsed,
      keySourceFromEncryptionKeyRef(keyRef),
    );
  }
  return parsed as SnapshotState;
}

function recordId(record: KeyedSnapshotRecord): string | null {
  return typeof record.id === "string" && record.id.length > 0 ? record.id : null;
}

function accessLogId(record: AccessLogExport): string | null {
  return typeof record.memoryId === "string" && record.memoryId.length > 0
    ? record.memoryId
    : null;
}

async function planScopeReplacement<T>(
  kv: StateKV,
  scope: string,
  rows: T[],
  keyOf: (row: T) => string | null,
): Promise<ScopeReplacement<T>> {
  const target = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key) target.set(key, row);
  }

  const current = await kv.list<T>(scope).catch(() => [] as T[]);
  const deleteIds: string[] = [];
  for (const row of current) {
    const key = keyOf(row);
    if (key && !target.has(key)) deleteIds.push(key);
  }

  return {
    scope,
    entries: Array.from(target.entries()),
    deleteIds,
  };
}

async function applyScopeReplacement<T>(
  kv: StateKV,
  plan: ScopeReplacement<T>,
): Promise<void> {
  for (const [key, row] of plan.entries) {
    await kv.set(plan.scope, key, row);
  }
  for (const key of plan.deleteIds) {
    await kv.delete(plan.scope, key);
  }
}

export function registerSnapshotFunction(
  sdk: ISdk,
  kv: StateKV,
  snapshotDir: string,
): void {
  sdk.registerFunction("mem::snapshot-create", 
    async (data?: { message?: string }) => {

      try {
        await ensureGitRepo(snapshotDir);
        const ts = new Date().toISOString();

        const sessions = await kv.list<Session>(KV.sessions);
        const memories = await kv.list<Memory>(KV.memories);
        const graphNodes = await kv.list<GraphNode>(KV.graphNodes);
        const accessLogs = await kv
          .list<AccessLogExport>(KV.accessLog)
          .catch(() => [] as AccessLogExport[]);

        const observations: Record<string, unknown[]> = {};
        for (const session of sessions) {
          const obs = await kv
            .list(KV.observations(session.id))
            .catch(() => []);
          if (obs.length > 0) {
            observations[session.id] = obs;
          }
        }

        const state: SnapshotState = {
          version: VERSION,
          timestamp: ts,
          sessions,
          memories,
          graphNodes,
          observations,
          accessLogs,
        };
        const encodedState = encodeSnapshotState(state);

        writeFileSync(
          join(snapshotDir, "state.json"),
          encodedState.content,
          "utf-8",
        );

        await gitExec(snapshotDir, ["add", "."]);

        const message = data?.message || `Snapshot ${ts}`;
        try {
          await gitExec(snapshotDir, ["commit", "-m", message]);
        } catch (commitErr) {
          const errMsg =
            commitErr instanceof Error ? commitErr.message : String(commitErr);
          if (errMsg.includes("nothing to commit")) {
            return { success: true, message: "No changes to snapshot" };
          }
          throw commitErr;
        }

        const commitHash = await gitExec(snapshotDir, ["rev-parse", "HEAD"]);

        const meta: SnapshotMeta = {
          id: generateId("snap"),
          commitHash,
          createdAt: ts,
          message,
          stats: {
            sessions: sessions.length,
            observations: Object.values(observations).reduce(
              (sum, arr) => sum + arr.length,
              0,
            ),
            memories: memories.length,
            graphNodes: graphNodes.length,
          },
        };

        await recordAudit(kv, "export", "mem::snapshot-create", [meta.id], {
          commitHash,
          stats: meta.stats,
          encrypted: encodedState.encrypted,
          keyRef: encodedState.keyRef,
        });

        logger.info("Snapshot created", { commitHash });
        return { success: true, snapshot: meta };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  sdk.registerFunction("mem::snapshot-list",  async () => {
    try {
      if (!existsSync(join(snapshotDir, ".git"))) {
        return { snapshots: [] };
      }
      const log = await gitExec(snapshotDir, [
        "log",
        "--format=%H|%aI|%s",
        "-20",
      ]);
      const snapshots = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|");
          const [hash, date] = parts;
          const msg = parts.slice(2).join("|");
          return { commitHash: hash, createdAt: date, message: msg };
        });
      return { snapshots };
    } catch {
      return { snapshots: [] };
    }
  });

  sdk.registerFunction("mem::snapshot-restore", 
    async (data: { commitHash: string } | undefined) => {
      if (!data || typeof data.commitHash !== "string" || !data.commitHash.trim()) {
        return { success: false, error: "commitHash is required" };
      }
      if (!COMMIT_HASH_RE.test(data.commitHash)) {
        return { success: false, error: "Invalid commitHash format" };
      }

      try {
        await gitExec(snapshotDir, [
          "checkout",
          data.commitHash,
          "--",
          "state.json",
        ]);
        const content = readFileSync(join(snapshotDir, "state.json"), "utf-8");
        const state = decodeSnapshotState(content) as unknown as {
          sessions?: Array<{ id: string } & Record<string, unknown>>;
          memories?: Array<{ id: string } & Record<string, unknown>>;
          graphNodes?: Array<{ id: string } & Record<string, unknown>>;
          observations?: Record<
            string,
            Array<{ id: string } & Record<string, unknown>>
          >;
          accessLogs?: AccessLogExport[];
        };

        const sessions = Array.isArray(state.sessions) ? state.sessions : [];
        const memories = Array.isArray(state.memories) ? state.memories : [];
        const graphNodes = Array.isArray(state.graphNodes) ? state.graphNodes : [];
        const observations =
          state.observations && typeof state.observations === "object"
            ? state.observations
            : {};
        const accessLogs = Array.isArray(state.accessLogs) ? state.accessLogs : [];

        const currentSessions = await kv
          .list<KeyedSnapshotRecord>(KV.sessions)
          .catch(() => [] as KeyedSnapshotRecord[]);
        const observationSessionIds = new Set<string>();
        for (const session of currentSessions) {
          const id = recordId(session);
          if (id) observationSessionIds.add(id);
        }
        for (const session of sessions) {
          const id = recordId(session as KeyedSnapshotRecord);
          if (id) observationSessionIds.add(id);
        }
        for (const sessionId of Object.keys(observations)) {
          observationSessionIds.add(sessionId);
        }

        const plans: Array<ScopeReplacement<unknown>> = [
          await planScopeReplacement(
            kv,
            KV.sessions,
            sessions,
            (row) => recordId(row as KeyedSnapshotRecord),
          ),
          await planScopeReplacement(
            kv,
            KV.memories,
            memories,
            (row) => recordId(row as KeyedSnapshotRecord),
          ),
          await planScopeReplacement(
            kv,
            KV.graphNodes,
            graphNodes,
            (row) => recordId(row as KeyedSnapshotRecord),
          ),
          await planScopeReplacement(
            kv,
            KV.accessLog,
            accessLogs,
            (row) => accessLogId(row),
          ),
        ];

        for (const sessionId of observationSessionIds) {
          const rows = Array.isArray(observations[sessionId])
            ? observations[sessionId]
            : [];
          plans.push(
            await planScopeReplacement(
              kv,
              KV.observations(sessionId),
              rows,
              (row) => recordId(row as KeyedSnapshotRecord),
            ),
          );
        }

        const deletedTargets = plans.flatMap((plan) =>
          plan.deleteIds.map((id) => `${plan.scope}:${id}`),
        );
        if (deletedTargets.length > 0) {
          await recordAudit(kv, "delete", "mem::snapshot-restore", deletedTargets, {
            action: "snapshot.restore.delete_missing",
            commitHash: data.commitHash,
            deleted: deletedTargets.length,
          });
        }

        for (const plan of plans) {
          await applyScopeReplacement(kv, plan);
        }

        await gitExec(snapshotDir, ["checkout", "HEAD", "--", "state.json"]);

        await recordAudit(kv, "import", "mem::snapshot-restore", [], {
          commitHash: data.commitHash,
          sessions: sessions.length,
          memories: memories.length,
          graphNodes: graphNodes.length,
          deleted: deletedTargets.length,
        });

        logger.info("Snapshot restored", {
          commitHash: data.commitHash,
        });
        return { success: true, commitHash: data.commitHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Snapshot restore failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );
}
