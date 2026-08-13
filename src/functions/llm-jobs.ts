import { TriggerAction, type ISdk } from "iii-sdk";
import { randomUUID } from "node:crypto";
import {
  LONG_RUNNING_TIMEOUT_MS,
  positiveTimeoutMs,
  WORK_QUEUES,
} from "../backpressure.js";
import { getEnvVar } from "../config.js";
import { logger } from "../logger.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV } from "../state/schema.js";
import type {
  CompressedObservation,
  LlmJob,
  LlmJobStatus,
  LlmPipelineAggregate,
  LlmPipelineCheckpoint,
  LlmPipelineStatus,
  RawObservation,
  Session,
} from "../types.js";

export interface CompressionJobPayload {
  observationId: string;
  sessionId: string;
  raw: RawObservation;
  /** Explicit operator/internal recovery of a terminal failed job. */
  force?: boolean;
}

export interface LlmJobMetadata {
  provider: string;
  model: string;
}

export const DEFAULT_LLM_JOB_MAX_ATTEMPTS = 10;
export const DEFAULT_LLM_STARTUP_REDRIVE_LIMIT = 40;
export const DEFAULT_LLM_FAILED_RETRY_COOLDOWN_MS = LONG_RUNNING_TIMEOUT_MS;
const compressionDispatchRetryTimers = new Map<string, NodeJS.Timeout>();
const terminalCompressionRetryTimers = new Map<string, NodeJS.Timeout>();
let aggregateRepairTimer: NodeJS.Timeout | null = null;
const LLM_PIPELINE_AGGREGATE_KEY = "aggregate";
const LLM_PIPELINE_AGGREGATE_LOCK = "mem:llm-pipeline:aggregate";
const THROUGHPUT_WINDOW_MS = 5 * 60_000;
const LLM_RUNTIME_ID = randomUUID();

const STATUS_FIELD: Record<
  LlmJobStatus,
  "waiting" | "inFlight" | "retrying" | "failed" | "succeeded"
> = {
  queued: "waiting",
  running: "inFlight",
  retrying: "retrying",
  failed: "failed",
  succeeded: "succeeded",
};

function pendingAt(job: LlmJob): string {
  return job.startedAt ?? job.queuedAt ?? job.createdAt ?? job.updatedAt;
}

function pruneSuccessBuckets(
  buckets: Record<string, number>,
  nowMs = Date.now(),
): Record<string, number> {
  const threshold = nowMs - THROUGHPUT_WINDOW_MS;
  return Object.fromEntries(
    Object.entries(buckets).filter(([epochSecond]) =>
      Number(epochSecond) * 1_000 >= threshold,
    ),
  );
}

function aggregateFromJobs(
  jobs: LlmJob[],
  now = new Date(),
): LlmPipelineAggregate {
  const aggregate: LlmPipelineAggregate = {
    id: "aggregate",
    version: 1,
    updatedAt: now.toISOString(),
    rebuiltAt: now.toISOString(),
    waiting: 0,
    inFlight: 0,
    retrying: 0,
    failed: 0,
    succeeded: 0,
    total: jobs.length,
    pendingSince: {},
    oldestPendingAt: null,
    lastDispatch: null,
    lastSuccess: null,
    lastFailure: null,
    successBuckets: {},
    provider: null,
    model: null,
    latestJobUpdatedAt: null,
  };
  const threshold = now.getTime() - THROUGHPUT_WINDOW_MS;
  for (const job of jobs) {
    aggregate[STATUS_FIELD[job.status]]++;
    if (["queued", "running", "retrying"].includes(job.status)) {
      aggregate.pendingSince[job.observationId] = pendingAt(job);
    }
    const dispatch = job.startedAt ?? job.dispatchConfirmedAt;
    if (dispatch && (!aggregate.lastDispatch || dispatch > aggregate.lastDispatch)) {
      aggregate.lastDispatch = dispatch;
    }
    if (job.succeededAt) {
      if (!aggregate.lastSuccess || job.succeededAt > aggregate.lastSuccess) {
        aggregate.lastSuccess = job.succeededAt;
      }
      const succeededMs = Date.parse(job.succeededAt);
      if (Number.isFinite(succeededMs) && succeededMs >= threshold) {
        const bucket = String(Math.floor(succeededMs / 1_000));
        aggregate.successBuckets[bucket] =
          (aggregate.successBuckets[bucket] ?? 0) + 1;
      }
    }
    if (
      job.lastFailureAt &&
      (!aggregate.lastFailure || job.lastFailureAt > aggregate.lastFailure)
    ) {
      aggregate.lastFailure = job.lastFailureAt;
    }
    if (
      !aggregate.latestJobUpdatedAt ||
      job.updatedAt > aggregate.latestJobUpdatedAt
    ) {
      aggregate.latestJobUpdatedAt = job.updatedAt;
      aggregate.provider = job.provider;
      aggregate.model = job.model;
    }
  }
  const pending = Object.values(aggregate.pendingSince).sort();
  aggregate.oldestPendingAt = pending[0] ?? null;
  return aggregate;
}

export async function rebuildLlmPipelineAggregate(
  kv: StateKV,
  jobs?: LlmJob[],
): Promise<LlmPipelineAggregate> {
  return withKeyedLock(LLM_PIPELINE_AGGREGATE_LOCK, async () => {
    const ledger = jobs ?? (await kv.list<LlmJob>(KV.llmJobs));
    const aggregate = aggregateFromJobs(ledger);
    await kv.set(
      KV.llmPipeline,
      LLM_PIPELINE_AGGREGATE_KEY,
      aggregate,
    );
    return aggregate;
  });
}

async function loadJobLedgerAndRebuildAggregate(
  kv: StateKV,
): Promise<LlmJob[]> {
  return withKeyedLock(LLM_PIPELINE_AGGREGATE_LOCK, async () => {
    const jobs = await kv.list<LlmJob>(KV.llmJobs);
    await kv.set(
      KV.llmPipeline,
      LLM_PIPELINE_AGGREGATE_KEY,
      aggregateFromJobs(jobs),
    );
    return jobs;
  });
}

function scheduleAggregateRepair(kv: StateKV, delayMs = 1_000): void {
  if (aggregateRepairTimer) return;
  aggregateRepairTimer = setTimeout(() => {
    aggregateRepairTimer = null;
    void rebuildLlmPipelineAggregate(kv).catch((error) => {
      logger.warn("LLM pipeline aggregate repair failed", {
        error: safeError(error),
      });
      scheduleAggregateRepair(kv, Math.min(delayMs * 2, 60_000));
    });
  }, Math.max(1_000, delayMs));
  aggregateRepairTimer.unref();
}

function applyJobTransition(
  aggregate: LlmPipelineAggregate,
  previous: LlmJob | null,
  next: LlmJob,
): LlmPipelineAggregate {
  const updated: LlmPipelineAggregate = {
    ...aggregate,
    pendingSince: { ...aggregate.pendingSince },
    successBuckets: pruneSuccessBuckets(aggregate.successBuckets),
    updatedAt: new Date().toISOString(),
  };
  if (!previous) updated.total++;
  if (!previous || previous.status !== next.status) {
    if (previous) {
      const priorField = STATUS_FIELD[previous.status];
      updated[priorField] = Math.max(0, updated[priorField] - 1);
    }
    updated[STATUS_FIELD[next.status]]++;
  }
  if (["queued", "running", "retrying"].includes(next.status)) {
    updated.pendingSince[next.observationId] = pendingAt(next);
  } else {
    delete updated.pendingSince[next.observationId];
  }
  const pending = Object.values(updated.pendingSince).sort();
  updated.oldestPendingAt = pending[0] ?? null;
  const dispatch = next.startedAt ?? next.dispatchConfirmedAt;
  if (dispatch && (!updated.lastDispatch || dispatch > updated.lastDispatch)) {
    updated.lastDispatch = dispatch;
  }
  if (
    next.status === "succeeded" &&
    previous?.status !== "succeeded" &&
    next.succeededAt
  ) {
    const bucket = String(Math.floor(Date.parse(next.succeededAt) / 1_000));
    updated.successBuckets[bucket] = (updated.successBuckets[bucket] ?? 0) + 1;
  }
  if (next.succeededAt && (!updated.lastSuccess || next.succeededAt > updated.lastSuccess)) {
    updated.lastSuccess = next.succeededAt;
  }
  if (
    next.lastFailureAt &&
    (!updated.lastFailure || next.lastFailureAt > updated.lastFailure)
  ) {
    updated.lastFailure = next.lastFailureAt;
  }
  if (!updated.latestJobUpdatedAt || next.updatedAt >= updated.latestJobUpdatedAt) {
    updated.latestJobUpdatedAt = next.updatedAt;
    updated.provider = next.provider;
    updated.model = next.model;
  }
  return updated;
}

async function persistLlmJob(kv: StateKV, next: LlmJob): Promise<LlmJob> {
  try {
    return await withKeyedLock(LLM_PIPELINE_AGGREGATE_LOCK, async () => {
      const previous = await kv.get<LlmJob>(KV.llmJobs, next.observationId);
      await kv.set(KV.llmJobs, next.observationId, next);
      const aggregate = await kv.get<LlmPipelineAggregate>(
        KV.llmPipeline,
        LLM_PIPELINE_AGGREGATE_KEY,
      );
      if (aggregate) {
        await kv.set(
          KV.llmPipeline,
          LLM_PIPELINE_AGGREGATE_KEY,
          applyJobTransition(aggregate, previous, next),
        );
      }
      return next;
    });
  } catch (error) {
    // The job ledger and observation are authoritative. Dashboard roll-up
    // contention or storage failure must never downgrade a successful LLM
    // call into a synthetic failure. Persist the job independently and repair
    // the derived aggregate out of band.
    await kv.set(KV.llmJobs, next.observationId, next);
    logger.warn("LLM pipeline aggregate update deferred", {
      observationId: next.observationId,
      status: next.status,
      error: safeError(error),
    });
    scheduleAggregateRepair(kv);
    return next;
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    // iii-config.yaml retries compression jobs at most ten times. Capping the
    // application ledger at the same value prevents a job from remaining in
    // `retrying` after the transport has exhausted its own delivery budget.
    ? Math.min(parsed, DEFAULT_LLM_JOB_MAX_ATTEMPTS)
    : fallback;
}

export function getLlmJobMaxAttempts(): number {
  return positiveInt(
    getEnvVar("AGENTMEMORY_LLM_JOB_MAX_ATTEMPTS"),
    DEFAULT_LLM_JOB_MAX_ATTEMPTS,
  );
}

export function getLlmStaleRunningMs(): number {
  return positiveTimeoutMs(
    getEnvVar("AGENTMEMORY_LLM_STALE_RUNNING_MS") ??
      getEnvVar("AGENTMEMORY_INVOCATION_TIMEOUT_MS"),
    LONG_RUNNING_TIMEOUT_MS,
  );
}

export function getLlmFailedRetryCooldownMs(): number {
  return positiveTimeoutMs(
    getEnvVar("AGENTMEMORY_LLM_FAILED_RETRY_COOLDOWN_MS"),
    DEFAULT_LLM_FAILED_RETRY_COOLDOWN_MS,
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
}

export function isCompressedObservation(
  observation: RawObservation | CompressedObservation | null,
): observation is CompressedObservation {
  const shaped = Boolean(
    observation &&
      typeof (observation as CompressedObservation).title === "string" &&
      Array.isArray((observation as CompressedObservation).facts) &&
      Array.isArray((observation as CompressedObservation).concepts),
  );
  if (!shaped) return false;
  const status = (observation as CompressedObservation).enrichmentStatus;
  // Pending/failed synthetic placeholders intentionally have compressed
  // search fields. They are not completed LLM output and must remain eligible
  // for duplicate delivery and startup recovery.
  return !status || status === "succeeded";
}

export function isFailedJobCooled(
  job: LlmJob,
  nowMs = Date.now(),
): boolean {
  if (job.status !== "failed") return false;
  const failedAtMs = Date.parse(job.failedAt ?? job.lastFailureAt ?? job.updatedAt);
  return (
    Number.isFinite(failedAtMs) &&
    nowMs - failedAtMs >= getLlmFailedRetryCooldownMs()
  );
}

function failedRetryRemainingMs(job: LlmJob, nowMs = Date.now()): number {
  const failedAtMs = Date.parse(
    job.failedAt ?? job.lastFailureAt ?? job.updatedAt,
  );
  if (!Number.isFinite(failedAtMs)) return 0;
  return Math.max(
    0,
    failedAtMs + getLlmFailedRetryCooldownMs() - nowMs,
  );
}

export async function reopenCompressionJob(
  kv: StateKV,
  job: LlmJob,
): Promise<LlmJob> {
  const now = new Date().toISOString();
  const reopened: LlmJob = {
    ...job,
    status: "retrying",
    attempt: 0,
    updatedAt: now,
    retryingAt: now,
    queuedAt: now,
    error: "compression_retry_window_reopened",
  };
  delete reopened.failedAt;
  delete reopened.startedAt;
  delete reopened.succeededAt;
  delete reopened.dispatchConfirmedAt;
  delete reopened.runtimeId;
  return persistLlmJob(kv, reopened);
}

export async function ensureCompressionJobQueued(
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
): Promise<LlmJob> {
  const existing = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
  if (
    existing?.status === "queued" ||
    existing?.status === "running" ||
    existing?.status === "succeeded"
  ) {
    return existing;
  }

  const now = new Date().toISOString();
  const job: LlmJob = {
    id: payload.observationId,
    observationId: payload.observationId,
    sessionId: payload.sessionId,
    status: "queued",
    attempt: existing?.attempt ?? 0,
    maxAttempts: existing?.maxAttempts ?? getLlmJobMaxAttempts(),
    provider: existing?.provider ?? metadata.provider,
    model: existing?.model ?? metadata.model,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    queuedAt: now,
    ...(existing?.lastFailureAt
      ? { lastFailureAt: existing.lastFailureAt }
      : {}),
    ...(existing?.error ? { error: existing.error } : {}),
  };
  return persistLlmJob(kv, job);
}

export async function beginCompressionAttempt(
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
): Promise<LlmJob> {
  const existing = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
  const now = new Date().toISOString();
  const job: LlmJob = {
    id: payload.observationId,
    observationId: payload.observationId,
    sessionId: payload.sessionId,
    status: "running",
    attempt: (existing?.attempt ?? 0) + 1,
    maxAttempts: existing?.maxAttempts ?? getLlmJobMaxAttempts(),
    // Queued metadata describes intent; a running attempt records the actual
    // provider wrapper/model handed to mem::compress for this execution.
    provider: metadata.provider,
    model: metadata.model,
    runtimeId: LLM_RUNTIME_ID,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    queuedAt: existing?.queuedAt ?? now,
    startedAt: now,
    ...(existing?.lastFailureAt
      ? { lastFailureAt: existing.lastFailureAt }
      : {}),
    ...(existing?.error ? { error: existing.error } : {}),
  };
  return persistLlmJob(kv, job);
}

export async function markCompressionSucceeded(
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
  job?: LlmJob | null,
): Promise<LlmJob> {
  const existing =
    job ?? (await kv.get<LlmJob>(KV.llmJobs, payload.observationId));
  const now = new Date().toISOString();
  const succeeded: LlmJob = {
    id: payload.observationId,
    observationId: payload.observationId,
    sessionId: payload.sessionId,
    status: "succeeded",
    attempt: existing?.attempt ?? 0,
    maxAttempts: existing?.maxAttempts ?? getLlmJobMaxAttempts(),
    provider: existing?.provider ?? metadata.provider,
    model: existing?.model ?? metadata.model,
    runtimeId: existing?.runtimeId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    queuedAt: existing?.queuedAt ?? now,
    startedAt: existing?.startedAt,
    succeededAt: now,
  };
  return persistLlmJob(kv, succeeded);
}

export async function markCompressionFailed(
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
  job: LlmJob,
  error: unknown,
): Promise<LlmJob> {
  const now = new Date().toISOString();
  const terminal = job.attempt >= job.maxAttempts;
  const failed: LlmJob = {
    ...job,
    observationId: payload.observationId,
    sessionId: payload.sessionId,
    provider: job.provider || metadata.provider,
    model: job.model || metadata.model,
    status: terminal ? "failed" : "retrying",
    updatedAt: now,
    lastFailureAt: now,
    ...(terminal ? { failedAt: now } : { retryingAt: now }),
    error: safeError(error),
  };
  return persistLlmJob(kv, failed);
}

export async function markCompressionDispatchFailed(
  kv: StateKV,
  payload: CompressionJobPayload,
  error: unknown,
): Promise<void> {
  const existing = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
  if (!existing || existing.status === "succeeded") return;
  const now = new Date().toISOString();
  await persistLlmJob(kv, {
    ...existing,
    status: "retrying",
    updatedAt: now,
    retryingAt: now,
    lastFailureAt: now,
    error: safeError(error),
  });
}

export async function markCompressionDispatched(
  kv: StateKV,
  observationId: string,
): Promise<void> {
  const existing = await kv.get<LlmJob>(KV.llmJobs, observationId);
  if (!existing || existing.status !== "queued") return;
  const now = new Date().toISOString();
  await persistLlmJob(kv, {
    ...existing,
    updatedAt: now,
    dispatchConfirmedAt: now,
  });
}

/**
 * Make sure a persisted observation has a durable compression job and that an
 * undispatched job reaches the iii queue. This is also the repair path for a
 * hook delivery that committed its observation immediately before a ledger or
 * queue failure: the delivery-derived observation ID makes the retry safe.
 */
export async function ensureCompressionJobDispatched(
  sdk: ISdk,
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
): Promise<LlmJob> {
  let job = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
  if (
    job?.status === "succeeded" ||
    job?.status === "running" ||
    (job?.status === "queued" && Boolean(job.dispatchConfirmedAt))
  ) {
    return job;
  }

  if (job?.status === "failed") {
    const remainingMs = failedRetryRemainingMs(job);
    if (remainingMs > 0) {
      scheduleTerminalCompressionRetry(
        sdk,
        kv,
        payload,
        metadata,
        remainingMs,
      );
      return job;
    }
    job = await reopenCompressionJob(kv, job);
  }

  job = await ensureCompressionJobQueued(kv, payload, metadata);
  if (
    job.status === "succeeded" ||
    job.status === "running" ||
    (job.status === "queued" && Boolean(job.dispatchConfirmedAt))
  ) {
    return job;
  }

  try {
    await sdk.trigger({
      function_id: "mem::compress",
      payload,
      action: TriggerAction.Enqueue({ queue: WORK_QUEUES.compression }),
    });
    await markCompressionDispatched(kv, payload.observationId);
  } catch (error) {
    await markCompressionDispatchFailed(kv, payload, error);
    scheduleCompressionDispatchRetry(sdk, kv, payload);
    throw error;
  }

  return (await kv.get<LlmJob>(KV.llmJobs, payload.observationId)) ?? job;
}

/**
 * Terminal failures stay visible and searchable, then are automatically
 * reopened after the configured cooldown while this daemon remains alive.
 * The ledger remains the authority; startup reconciliation covers crashes.
 */
export function scheduleTerminalCompressionRetry(
  sdk: ISdk,
  kv: StateKV,
  payload: CompressionJobPayload,
  metadata: LlmJobMetadata,
  delayMs = getLlmFailedRetryCooldownMs(),
): void {
  const timerKey = `${payload.sessionId}\0${payload.observationId}`;
  if (terminalCompressionRetryTimers.has(timerKey)) return;
  // Node clamps larger delays to 1ms. Wake at the largest supported delay and
  // recompute from durable timestamps instead of accidentally hot-looping.
  const safeDelayMs = Math.max(1, Math.min(delayMs, 2_147_000_000));
  const timer = setTimeout(() => {
    terminalCompressionRetryTimers.delete(timerKey);
    void (async () => {
      const current = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
      if (
        current?.status === "succeeded" ||
        current?.status === "running" ||
        (current?.status === "queued" && Boolean(current.dispatchConfirmedAt))
      ) {
        return;
      }
      if (current?.status === "failed") {
        const remainingMs = failedRetryRemainingMs(current);
        if (remainingMs > 0) {
          scheduleTerminalCompressionRetry(
            sdk,
            kv,
            payload,
            metadata,
            remainingMs,
          );
          return;
        }
      }
      await ensureCompressionJobDispatched(sdk, kv, payload, metadata);
    })().catch((error) => {
      logger.warn("Deferred terminal LLM compression retry failed", {
        observationId: payload.observationId,
        sessionId: payload.sessionId,
        error: safeError(error),
      });
      scheduleTerminalCompressionRetry(sdk, kv, payload, metadata, 60_000);
    });
  }, safeDelayMs);
  timer.unref();
  terminalCompressionRetryTimers.set(timerKey, timer);
}

export function scheduleCompressionDispatchRetry(
  sdk: ISdk,
  kv: StateKV,
  payload: CompressionJobPayload,
  delayMs = 60_000,
): void {
  if (compressionDispatchRetryTimers.has(payload.observationId)) return;
  const timer = setTimeout(() => {
    compressionDispatchRetryTimers.delete(payload.observationId);
    void (async () => {
      const job = await kv.get<LlmJob>(KV.llmJobs, payload.observationId);
      if (!job || job.status !== "retrying") return;
      await ensureCompressionJobQueued(kv, payload, {
        provider: job.provider,
        model: job.model,
      });
      try {
        await sdk.trigger({
          function_id: "mem::compress",
          payload,
          action: TriggerAction.Enqueue({ queue: WORK_QUEUES.compression }),
        });
        await markCompressionDispatched(kv, payload.observationId);
      } catch (error) {
        await markCompressionDispatchFailed(kv, payload, error);
        scheduleCompressionDispatchRetry(sdk, kv, payload, delayMs);
      }
    })().catch((error) => {
      logger.warn("Deferred LLM compression dispatch failed", {
        observationId: payload.observationId,
        sessionId: payload.sessionId,
        error: safeError(error),
      });
      scheduleCompressionDispatchRetry(sdk, kv, payload, delayMs);
    });
  }, Math.max(1_000, delayMs));
  timer.unref();
  compressionDispatchRetryTimers.set(payload.observationId, timer);
}

export async function getLlmPipelineStatus(
  kv: StateKV,
  defaults: LlmJobMetadata,
  circuit?: unknown,
  enabled = true,
): Promise<LlmPipelineStatus> {
  // This endpoint is polled by the dashboard. Reading and decrypting every
  // historical job on every poll caused event-loop lag as the ledger grew.
  // The startup reconciler builds this roll-up once; every transition updates
  // it atomically with the job row. Missing/corrupt state fails visibly rather
  // than fabricating a healthy zero queue.
  const aggregate = await kv.get<LlmPipelineAggregate>(
    KV.llmPipeline,
    LLM_PIPELINE_AGGREGATE_KEY,
  );
  if (!aggregate) {
    throw new Error("LLM pipeline aggregate unavailable");
  }
  const now = Date.now();
  const checkpoint = await kv.get<LlmPipelineCheckpoint>(
    KV.llmPipeline,
    "reconciliation",
  );
  const rawOrphans =
    (checkpoint?.untrackedRaw ?? 0) +
    aggregate.failed;
  const throughput5m = Object.values(
    pruneSuccessBuckets(aggregate.successBuckets, now),
  ).reduce((sum, count) => sum + count, 0);
  const oldestMs = aggregate.oldestPendingAt
    ? Date.parse(aggregate.oldestPendingAt)
    : Number.NaN;
  const oldestAgeMs = Number.isFinite(oldestMs)
    ? Math.max(0, now - oldestMs)
    : 0;

  return {
    enabled,
    reason: enabled ? "auto_compress_enabled" : "auto_compress_disabled",
    waiting: aggregate.waiting,
    inFlight: aggregate.inFlight,
    retrying: aggregate.retrying,
    failed: aggregate.failed,
    succeeded: aggregate.succeeded,
    total: aggregate.total,
    oldestAge: Math.round(oldestAgeMs / 1_000),
    oldestAgeMs,
    lastDispatch: aggregate.lastDispatch,
    lastSuccess: aggregate.lastSuccess,
    lastFailure: aggregate.lastFailure,
    throughput5m,
    throughputPerMinute: throughput5m / 5,
    rawOrphans,
    provider: aggregate.provider ?? defaults.provider,
    model: aggregate.model ?? defaults.model,
    ...(circuit === undefined ? {} : { circuit }),
  };
}

/**
 * Bounded, idempotent startup recovery for observations written before the
 * durable LLM ledger existed. Existing queued/running/succeeded jobs are left
 * to the persisted iii queue; retrying jobs may be re-dispatched after restart.
 */
export async function redriveRawCompressionOrphans(
  sdk: ISdk,
  kv: StateKV,
  metadata: LlmJobMetadata,
  limit = DEFAULT_LLM_STARTUP_REDRIVE_LIMIT,
): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
  remaining: number;
  retryAfterMs?: number;
}> {
  const safeLimit = Math.max(0, Math.min(Math.floor(limit), 1_000));
  if (safeLimit === 0) {
    return { scanned: 0, queued: 0, skipped: 0, remaining: 0 };
  }

  // Fail closed on control-plane reads. Persisting a zero checkpoint after a
  // read error would hide real untracked work from both recovery and the UI.
  const sessions = await kv.list<Session>(KV.sessions);
  const jobs = await loadJobLedgerAndRebuildAggregate(kv);
  const jobsById = new Map(jobs.map((job) => [job.observationId, job]));
  let scanned = 0;
  let queued = 0;
  let skipped = 0;
  let untrackedRaw = 0;
  let remaining = 0;
  let limitedWorkRemains = false;
  let earliestCooledRetryMs = Number.POSITIVE_INFINITY;
  let attempted = 0;
  const nowMs = Date.now();
  const staleRunningMs = getLlmStaleRunningMs();

  for (const session of sessions) {
    if (typeof session?.id !== "string" || session.id.length === 0) {
      skipped++;
      continue;
    }
    const observations = await kv.list<RawObservation | CompressedObservation>(
      KV.observations(session.id),
    );
    for (const observation of observations) {
      if (typeof observation?.id !== "string" || observation.id.length === 0) {
        skipped++;
        continue;
      }
      let existing = jobsById.get(observation.id);
      if (isCompressedObservation(observation)) {
        // The observation write precedes the final ledger transition. A daemon
        // crash in that narrow window can leave a permanently inflated
        // `running` count even though enrichment is already durable. Repair
        // only existing ledger rows; legacy compressed observations do not
        // need synthetic job history created for them.
        if (existing && existing.status !== "succeeded") {
          const succeededAt =
            observation.enrichmentFinishedAt ??
            existing.succeededAt ??
            new Date().toISOString();
          const repaired: LlmJob = {
            ...existing,
            status: "succeeded",
            updatedAt: succeededAt,
            succeededAt,
          };
          delete repaired.runtimeId;
          delete repaired.failedAt;
          delete repaired.retryingAt;
          await persistLlmJob(kv, repaired);
          jobsById.set(observation.id, repaired);
        }
        continue;
      }
      scanned++;
      const startedAtMs = existing?.startedAt
        ? Date.parse(existing.startedAt)
        : Number.NaN;
      const staleRunning =
        existing?.status === "running" &&
        (existing.runtimeId !== LLM_RUNTIME_ID ||
          !Number.isFinite(startedAtMs) ||
          nowMs - startedAtMs >= staleRunningMs);
      const undispatchedQueued =
        existing?.status === "queued" && !existing.dispatchConfirmedAt;
      const cooledFailure = Boolean(
        existing && isFailedJobCooled(existing, nowMs),
      );
      const recoverable =
        !existing ||
        existing.status === "retrying" ||
        staleRunning ||
        undispatchedQueued ||
        (existing.status === "failed" &&
          (existing.attempt < existing.maxAttempts || cooledFailure));
      if (!recoverable) {
        // A terminal failure remains searchable and is not hot-looped, but it
        // is still pending future recovery. Keeping `remaining` non-zero makes
        // the startup coordinator revisit it after the configured cooldown.
        if (existing?.status === "failed") {
          remaining++;
          const failedAtMs = Date.parse(
            existing.failedAt ?? existing.lastFailureAt ?? existing.updatedAt,
          );
          if (Number.isFinite(failedAtMs)) {
            earliestCooledRetryMs = Math.min(
              earliestCooledRetryMs,
              Math.max(
                1_000,
                failedAtMs + getLlmFailedRetryCooldownMs() - nowMs,
              ),
            );
          }
        }
        skipped++;
        continue;
      }
      if (attempted >= safeLimit) {
        remaining++;
        limitedWorkRemains = true;
        if (!existing) untrackedRaw++;
        continue;
      }
      if ((staleRunning || undispatchedQueued) && existing) {
        const recoveredAt = new Date().toISOString();
        existing = {
          ...existing,
          status: "retrying",
          updatedAt: recoveredAt,
          retryingAt: recoveredAt,
          lastFailureAt: recoveredAt,
          error: staleRunning
            ? "startup_recovery_stale_running"
            : "startup_recovery_unconfirmed_dispatch",
        };
        delete existing.runtimeId;
        await persistLlmJob(kv, existing);
        jobsById.set(observation.id, existing);
      }
      if (cooledFailure && existing) {
        existing = await reopenCompressionJob(kv, existing);
        jobsById.set(observation.id, existing);
      }
      const payload: CompressionJobPayload = {
        observationId: observation.id,
        sessionId: observation.sessionId || session.id,
        raw: observation,
      };
      const job = await ensureCompressionJobQueued(kv, payload, metadata);
      jobsById.set(observation.id, job);
      attempted++;
      try {
        await sdk.trigger({
          function_id: "mem::compress",
          payload,
          action: TriggerAction.Enqueue({ queue: WORK_QUEUES.compression }),
        });
        await markCompressionDispatched(kv, observation.id);
        queued++;
      } catch (error) {
        const retryJob: LlmJob = {
          ...job,
          status: "retrying",
          updatedAt: new Date().toISOString(),
          lastFailureAt: new Date().toISOString(),
          error: safeError(error),
        };
        await persistLlmJob(kv, retryJob);
        jobsById.set(observation.id, retryJob);
        remaining++;
        logger.warn("Failed to enqueue recovered LLM compression job", {
          observationId: observation.id,
          sessionId: payload.sessionId,
          error: safeError(error),
        });
      }
    }
    // Yield between session scopes so a large historical corpus cannot starve
    // health checks, hooks, or the viewer while startup recovery scans it.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const reconciledAt = new Date().toISOString();
  await kv.set<LlmPipelineCheckpoint>(KV.llmPipeline, "reconciliation", {
    id: "reconciliation",
    reconciledAt,
    scanned,
    queued,
    skipped,
    untrackedRaw,
  });

  return {
    scanned,
    queued,
    skipped,
    remaining,
    ...(remaining > 0
      ? {
          retryAfterMs: limitedWorkRemains
            ? 60_000
            : Number.isFinite(earliestCooledRetryMs)
              ? earliestCooledRetryMs
              : 60_000,
        }
      : {}),
  };
}

/**
 * One-pass startup reconciliation. Unlike repeatedly calling the bounded API,
 * this scans each encrypted observation scope only once, accumulates a bounded
 * candidate worklist, and yields between scopes so health/UI traffic stays
 * responsive. The queue still controls actual provider concurrency.
 */
export async function redriveAllRawCompressionOrphans(
  sdk: ISdk,
  kv: StateKV,
  metadata: LlmJobMetadata,
  candidateLimit = 1_000,
): Promise<{
  scanned: number;
  queued: number;
  skipped: number;
  remaining: number;
  retryAfterMs?: number;
}> {
  return redriveRawCompressionOrphans(
    sdk,
    kv,
    metadata,
    Math.max(1, Math.min(Math.floor(candidateLimit), 1_000)),
  );
}
