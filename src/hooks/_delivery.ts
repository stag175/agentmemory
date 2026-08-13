import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_DELIVERY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BATCH = 8;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const PENDING_SUFFIX = ".pending.json";
const SENDING_MARKER = ".sending.";

export type HookDeliveryRequest = {
  path: string;
  body?: unknown;
  method?: "POST";
  kind?: string;
};

type StoredDelivery = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  baseUrl: string;
  path: string;
  body: string;
  method: "POST";
  kind: string;
  attempt: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastStatus?: number;
};

export type HookDeliveryReport = {
  queued: number;
  delivered: number;
  pending: number;
  failed: number;
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function hookDeliveryTimeoutMs(): number {
  return Math.max(
    MIN_DELIVERY_TIMEOUT_MS,
    positiveInt(
      process.env["AGENTMEMORY_HOOK_DELIVERY_TIMEOUT_MS"],
      MIN_DELIVERY_TIMEOUT_MS,
    ),
  );
}

export function hookOutboxDir(): string {
  return (
    process.env["AGENTMEMORY_HOOK_OUTBOX_DIR"] ||
    join(homedir(), ".agentmemory", "hook-outbox")
  );
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

async function ensureOutbox(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function recordFailure(
  dir: string,
  delivery: Pick<StoredDelivery, "id" | "path" | "kind" | "attempt">,
  error: string,
  status?: number,
): Promise<void> {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    deliveryId: delivery.id,
    path: delivery.path,
    kind: delivery.kind,
    attempt: delivery.attempt,
    ...(status === undefined ? {} : { status }),
    error,
  });
  await appendFile(join(dir, "delivery-errors.ndjson"), `${line}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a",
  }).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function originalPendingName(claimedName: string): string | null {
  const markerIndex = claimedName.indexOf(SENDING_MARKER);
  return markerIndex > 0 ? claimedName.slice(0, markerIndex) : null;
}

function claimOwnerPid(claimedName: string): number | null {
  const markerIndex = claimedName.indexOf(SENDING_MARKER);
  if (markerIndex < 0) return null;
  const raw = claimedName.slice(markerIndex + SENDING_MARKER.length).split(".")[0];
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : null;
}

async function recoverAbandonedClaims(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (!name.includes(SENDING_MARKER)) continue;
    const original = originalPendingName(name);
    if (!original) continue;
    const pid = claimOwnerPid(name);
    let abandoned = pid === null || !isProcessAlive(pid);
    if (!abandoned) {
      const info = await stat(join(dir, name)).catch(() => null);
      const staleAfterMs = hookDeliveryTimeoutMs() * 2 + 5_000;
      abandoned = info !== null && Date.now() - info.mtimeMs > staleAfterMs;
    }
    if (!abandoned) continue;
    await rename(join(dir, name), join(dir, original)).catch(() => {});
  }
}

async function enqueue(
  dir: string,
  baseUrl: string,
  request: HookDeliveryRequest,
): Promise<string> {
  if (!request.path.startsWith("/agentmemory/")) {
    throw new Error(`refusing to spool non-agentmemory path: ${request.path}`);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const delivery: StoredDelivery = {
    version: 1,
    id,
    createdAt: now,
    updatedAt: now,
    baseUrl,
    path: request.path,
    body: JSON.stringify(request.body ?? {}),
    method: request.method ?? "POST",
    kind: request.kind ?? "hook_capture",
    attempt: 0,
  };
  const name = `${Date.now().toString().padStart(13, "0")}-${id}${PENDING_SUFFIX}`;
  await atomicWrite(join(dir, name), JSON.stringify(delivery));
  return name;
}

async function claim(dir: string, name: string): Promise<string | null> {
  const claimed = `${name}${SENDING_MARKER}${process.pid}.${randomUUID()}`;
  try {
    await rename(join(dir, name), join(dir, claimed));
    return claimed;
  } catch {
    return null;
  }
}

function retryDelayMs(attempt: number): number {
  const base = positiveInt(
    process.env["AGENTMEMORY_HOOK_RETRY_BASE_MS"],
    DEFAULT_RETRY_BASE_MS,
  );
  const max = Math.max(
    base,
    positiveInt(
      process.env["AGENTMEMORY_HOOK_RETRY_MAX_MS"],
      DEFAULT_RETRY_MAX_MS,
    ),
  );
  return Math.min(max, base * 2 ** Math.min(Math.max(attempt - 1, 0), 16));
}

async function restoreFailed(
  dir: string,
  claimedName: string,
  delivery: StoredDelivery,
  error: string,
  status?: number,
): Promise<void> {
  const now = new Date();
  delivery.attempt += 1;
  delivery.updatedAt = now.toISOString();
  delivery.lastAttemptAt = now.toISOString();
  delivery.lastError = error;
  delivery.lastStatus = status;
  delivery.nextAttemptAt = new Date(now.getTime() + retryDelayMs(delivery.attempt)).toISOString();

  const claimedPath = join(dir, claimedName);
  await atomicWrite(claimedPath, JSON.stringify(delivery));
  const original = originalPendingName(claimedName);
  if (!original) throw new Error(`invalid claimed delivery name: ${claimedName}`);
  await rename(claimedPath, join(dir, original));
  await recordFailure(dir, delivery, error, status);
}

async function deliverClaimed(
  dir: string,
  claimedName: string,
  secret: string,
): Promise<"delivered" | "failed" | "skipped"> {
  const claimedPath = join(dir, claimedName);
  let delivery: StoredDelivery;
  try {
    delivery = JSON.parse(await readFile(claimedPath, "utf8")) as StoredDelivery;
  } catch (error) {
    await recordFailure(
      dir,
      { id: claimedName, path: "unknown", kind: "corrupt_outbox", attempt: 0 },
      `corrupt outbox record: ${safeError(error)}`,
    );
    return "failed";
  }

  if (
    delivery.nextAttemptAt &&
    Date.parse(delivery.nextAttemptAt) > Date.now()
  ) {
    const original = originalPendingName(claimedName);
    if (original) await rename(claimedPath, join(dir, original)).catch(() => {});
    return "skipped";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": delivery.id,
    "X-AgentMemory-Delivery-Id": delivery.id,
  };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;

  try {
    const response = await fetch(`${delivery.baseUrl}${delivery.path}`, {
      method: delivery.method,
      headers,
      body: delivery.body,
      signal: AbortSignal.timeout(hookDeliveryTimeoutMs()),
    });
    if (!response.ok) {
      const message = `HTTP ${response.status}`;
      await restoreFailed(dir, claimedName, delivery, message, response.status);
      return "failed";
    }
    await unlink(claimedPath);
    return "delivered";
  } catch (error) {
    await restoreFailed(dir, claimedName, delivery, safeError(error));
    return "failed";
  }
}

/**
 * Persist requests before attempting delivery, then acknowledge them only after
 * an HTTP 2xx response. Failed and timed-out requests remain in the local
 * outbox and are retried opportunistically by the next hook invocation.
 */
export async function deliverHookRequests(options: {
  restUrl: string;
  secret?: string;
  requests: HookDeliveryRequest[];
}): Promise<HookDeliveryReport> {
  const dir = hookOutboxDir();
  const baseUrl = normalizedBaseUrl(options.restUrl);
  try {
    await ensureOutbox(dir);
  } catch (error) {
    console.error(`[agentmemory] hook outbox unavailable: ${safeError(error)}`);
    throw error;
  }

  const queuedNames: string[] = [];
  try {
    for (const request of options.requests) {
      queuedNames.push(await enqueue(dir, baseUrl, request));
    }
  } catch (error) {
    console.error(`[agentmemory] hook capture could not be persisted: ${safeError(error)}`);
    throw error;
  }

  const initialNames = await readdir(dir);
  await recoverAbandonedClaims(dir, initialNames);
  const maxBatch = Math.max(
    queuedNames.length,
    positiveInt(
      process.env["AGENTMEMORY_HOOK_OUTBOX_MAX_BATCH"],
      DEFAULT_MAX_BATCH,
    ),
  );
  const pendingNames = (await readdir(dir))
    .filter((name) => name.endsWith(PENDING_SUFFIX))
    .sort();
  const selected = [
    ...queuedNames,
    ...pendingNames.filter((name) => !queuedNames.includes(name)),
  ].slice(0, maxBatch);
  const claimed = (
    await Promise.all(selected.map((name) => claim(dir, name)))
  ).filter((name): name is string => name !== null);
  const outcomes = await Promise.all(
    claimed.map((name) => deliverClaimed(dir, name, options.secret ?? "")),
  );
  const remaining = (await readdir(dir)).filter(
    (name) => name.endsWith(PENDING_SUFFIX) || name.includes(SENDING_MARKER),
  ).length;
  return {
    queued: queuedNames.length,
    delivered: outcomes.filter((value) => value === "delivered").length,
    failed: outcomes.filter((value) => value === "failed").length,
    pending: remaining,
  };
}
