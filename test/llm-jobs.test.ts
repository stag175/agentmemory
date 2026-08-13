import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { registerCompressFunction } from "../src/functions/compress.js";
import { registerObserveFunction } from "../src/functions/observe.js";
import { DedupMap } from "../src/functions/dedup.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import {
  beginCompressionAttempt,
  ensureCompressionJobQueued,
  getLlmPipelineStatus,
  isCompressedObservation,
  markCompressionSucceeded,
  rebuildLlmPipelineAggregate,
  redriveRawCompressionOrphans,
} from "../src/functions/llm-jobs.js";
import { buildSearchableRawObservation } from "../src/functions/compress-synthetic.js";
import { KV } from "../src/state/schema.js";
import type { LlmJob, MemoryProvider, RawObservation } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const searchIndexAdd = vi.hoisted(() => vi.fn());
const vectorIndexAddGuarded = vi.hoisted(() => vi.fn().mockResolvedValue(false));
vi.mock("../src/functions/search.js", () => ({
  getSearchIndex: () => ({ add: searchIndexAdd }),
  vectorIndexAddGuarded,
}));

const VALID_XML = `<type>file_edit</type>
<title>Updated durable queue</title>
<subtitle>Retry-safe compression</subtitle>
<facts><fact>One provider call produced the observation</fact></facts>
<narrative>The durable queue compressed the raw observation.</narrative>
<concepts><concept>durability</concept></concepts>
<files><file>src/functions/compress.ts</file></files>
<importance>8</importance>`;

function raw(id: string, sessionId = "ses_1"): RawObservation {
  return {
    id,
    sessionId,
    timestamp: "2026-08-13T12:00:00.000Z",
    hookType: "post_tool_use",
    toolName: "Edit",
    toolInput: { path: "src/functions/compress.ts" },
    toolOutput: "done",
    raw: { tool_name: "Edit" },
  };
}

afterEach(() => {
  delete process.env["AGENTMEMORY_LLM_JOB_MAX_ATTEMPTS"];
  delete process.env["AGENTMEMORY_LLM_STALE_RUNNING_MS"];
  delete process.env["AGENTMEMORY_LLM_FAILED_RETRY_COOLDOWN_MS"];
  delete process.env["AGENTMEMORY_AUTO_COMPRESS"];
  delete process.env["AGENTMEMORY_CAPTURE_CONSENT"];
  searchIndexAdd.mockClear();
  vectorIndexAddGuarded.mockClear();
});

describe("durable LLM compression jobs", () => {
  it("does not mistake a searchable pending placeholder for completed LLM output", () => {
    const source = raw("obs_pending");
    const pending = buildSearchableRawObservation(source, "queued", {
      queuedAt: source.timestamp,
    });

    expect(pending).toMatchObject({
      id: source.id,
      raw: source.raw,
      title: "Edit",
      enrichmentMode: "synthetic",
      enrichmentStatus: "queued",
    });
    expect(isCompressedObservation(pending)).toBe(false);
  });

  it("serializes duplicate deliveries and calls the provider once", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const observation = raw("obs_once");
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    await ensureCompressionJobQueued(
      kv as never,
      {
        observationId: observation.id,
        sessionId: observation.sessionId,
        raw: observation,
      },
      { provider: "mock", model: "mock-model" },
    );
    const compress = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return VALID_XML;
    });
    const provider: MemoryProvider = {
      name: "mock",
      compress,
      summarize: async () => "",
    };
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider,
      undefined,
      "mock-model",
    );
    const payload = {
      observationId: observation.id,
      sessionId: observation.sessionId,
      raw: observation,
    };

    const [first, duplicate] = (await Promise.all([
      sdk.trigger("mem::compress", payload),
      sdk.trigger("mem::compress", payload),
    ])) as Array<{ success: boolean; idempotent?: boolean }>;

    expect(first.success).toBe(true);
    expect(duplicate).toMatchObject({ success: true, idempotent: true });
    expect(compress).toHaveBeenCalledTimes(1);
    const stored = await kv.get(KV.observations(observation.sessionId), observation.id);
    expect(stored).toMatchObject({
      enrichmentMode: "llm",
      enrichmentStatus: "succeeded",
      title: "Updated durable queue",
    });
    expect(searchIndexAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: observation.id,
        enrichmentStatus: "succeeded",
      }),
    );
    expect(vectorIndexAddGuarded).toHaveBeenCalledTimes(1);
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "succeeded",
      attempt: 1,
      provider: "mock",
      model: "mock-model",
    });
  });

  it("rejects retryable failures and stops at the durable max-attempt limit", async () => {
    process.env["AGENTMEMORY_LLM_JOB_MAX_ATTEMPTS"] = "2";
    const sdk = mockSdk();
    const kv = mockKV();
    const observation = raw("obs_retry");
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    const provider: MemoryProvider = {
      name: "broken-provider",
      compress: vi.fn().mockRejectedValue(new Error("provider unavailable")),
      summarize: async () => "",
    };
    registerCompressFunction(sdk as never, kv as never, provider, undefined, "model-x");
    const payload = {
      observationId: observation.id,
      sessionId: observation.sessionId,
      raw: observation,
    };

    await expect(sdk.trigger("mem::compress", payload)).rejects.toThrow(
      "compression_retryable",
    );
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1,
    });

    await expect(sdk.trigger("mem::compress", payload)).resolves.toMatchObject({
      success: false,
      terminal: true,
      attempts: 2,
    });
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "failed",
      attempt: 2,
      error: "provider unavailable",
    });
    await expect(
      kv.get(KV.observations(observation.sessionId), observation.id),
    ).resolves.toMatchObject({
      raw: observation.raw,
      title: "Edit",
      enrichmentMode: "synthetic",
      enrichmentStatus: "failed",
      enrichmentError: "provider unavailable",
    });
    // Synthetic retry/failure replacements remain BM25 searchable but never
    // add vector-provider pressure while the LLM path is unhealthy.
    expect(searchIndexAdd).toHaveBeenCalled();
    expect(vectorIndexAddGuarded).not.toHaveBeenCalled();
  });

  it("reopens a terminal failure after cooldown without a daemon restart", async () => {
    process.env["AGENTMEMORY_LLM_JOB_MAX_ATTEMPTS"] = "1";
    process.env["AGENTMEMORY_LLM_FAILED_RETRY_COOLDOWN_MS"] = "10";
    const sdk = mockSdk();
    const kv = mockKV();
    const observation = raw("obs_terminal_cooldown");
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    const compress = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValueOnce(VALID_XML);
    const provider: MemoryProvider = {
      name: "recovering-provider",
      compress,
      summarize: async () => "",
    };
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider,
      undefined,
      "recovery-model",
    );
    const payload = {
      observationId: observation.id,
      sessionId: observation.sessionId,
      raw: observation,
    };

    await expect(sdk.trigger("mem::compress", payload)).resolves.toMatchObject({
      success: false,
      terminal: true,
      attempts: 1,
    });

    await vi.waitFor(
      async () => {
        await expect(
          kv.get<LlmJob>(KV.llmJobs, observation.id),
        ).resolves.toMatchObject({ status: "succeeded", attempt: 1 });
      },
      { timeout: 1_000, interval: 10 },
    );
    expect(compress).toHaveBeenCalledTimes(2);
  });

  it("repairs a missing LLM ledger when a delivery retry finds its observation", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "true";
    process.env["AGENTMEMORY_CAPTURE_CONSENT"] = "true";
    const sdk = mockSdk();
    const kv = mockKV();
    const dedupMap = new DedupMap();
    sdk.registerFunction("stream::set", async () => ({ success: true }));
    sdk.registerFunction("stream::send", async () => ({ success: true }));
    const compress = vi.fn(async () => ({ queued: true }));
    sdk.registerFunction("mem::compress", compress);
    registerObserveFunction(
      sdk as never,
      kv as never,
      dedupMap,
      undefined,
      { provider: "openai", model: "repair-model" },
    );
    const deliveryId = "delivery-ledger-repair-0001";
    const observationId = `obs_hook_${createHash("sha256")
      .update(deliveryId)
      .digest("hex")
      .slice(0, 32)}`;
    const observation = raw(observationId, "ses_delivery_repair");
    await kv.set(
      KV.observations(observation.sessionId),
      observation.id,
      buildSearchableRawObservation(observation, "queued"),
    );
    dedupMap.record(
      dedupMap.computeHash(observation.sessionId, "Edit", undefined),
    );

    await expect(
      sdk.trigger("mem::observe", {
        sessionId: observation.sessionId,
        project: "billing",
        cwd: "/repo/billing",
        hookType: observation.hookType,
        timestamp: observation.timestamp,
        deliveryId,
        data: observation.raw,
      }),
    ).resolves.toMatchObject({
      observationId,
      deduplicated: true,
      deliveryId,
    });

    expect(compress).toHaveBeenCalledTimes(1);
    await expect(
      kv.get<LlmJob>(KV.llmJobs, observationId),
    ).resolves.toMatchObject({
      status: "queued",
      provider: "openai",
      model: "repair-model",
      dispatchConfirmedAt: expect.any(String),
    });
    await expect(
      kv.list(KV.observations(observation.sessionId)),
    ).resolves.toHaveLength(1);
    dedupMap.stop();
  });

  it("durably retries parseable-but-schema-invalid XML instead of marking success", async () => {
    process.env["AGENTMEMORY_LLM_JOB_MAX_ATTEMPTS"] = "2";
    const sdk = mockSdk();
    const kv = mockKV();
    const observation = raw("obs_invalid_schema");
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    const invalid = `<type>file_edit</type>
<title>Looks parseable</title>
<facts></facts>
<narrative>Still invalid because facts must contain at least one fact.</narrative>
<concepts></concepts><files></files><importance>8</importance>`;
    const provider: MemoryProvider = {
      name: "actual-wrapper",
      compress: vi.fn().mockResolvedValue(invalid),
      summarize: async () => "",
    };
    registerCompressFunction(
      sdk as never,
      kv as never,
      provider,
      undefined,
      "executed-model",
    );
    const payload = {
      observationId: observation.id,
      sessionId: observation.sessionId,
      raw: observation,
    };

    await expect(sdk.trigger("mem::compress", payload)).rejects.toThrow(
      "schema_validation_failed",
    );
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1,
      provider: "actual-wrapper",
      model: "executed-model",
    });
    await expect(
      kv.get(KV.observations(observation.sessionId), observation.id),
    ).resolves.toMatchObject({
      enrichmentMode: "synthetic",
      enrichmentStatus: "retrying",
    });
    expect(vectorIndexAddGuarded).not.toHaveBeenCalled();
  });

  it("redrives only raw observations without active or successful ledger jobs", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-08-13T12:00:00.000Z",
      status: "active",
      observationCount: 4,
    });
    for (const id of ["obs_missing", "obs_queued", "obs_running", "obs_done"]) {
      await kv.set(KV.observations("ses_1"), id, raw(id));
    }
    const now = "2026-08-13T12:00:00.000Z";
    for (const [id, status] of [
      ["obs_queued", "queued"],
      ["obs_running", "running"],
      ["obs_done", "succeeded"],
    ] as const) {
      if (status === "running") {
        await beginCompressionAttempt(
          kv as never,
          { observationId: id, sessionId: "ses_1", raw: raw(id) },
          { provider: "mock", model: "model-x" },
        );
        continue;
      }
      await kv.set<LlmJob>(KV.llmJobs, id, {
        id,
        observationId: id,
        sessionId: "ses_1",
        status,
        attempt: status === "queued" ? 0 : 1,
        maxAttempts: 10,
        provider: "mock",
        model: "model-x",
        createdAt: now,
        updatedAt: now,
        ...(status === "queued" ? { dispatchConfirmedAt: now } : {}),
      });
    }
    const trigger = vi.fn().mockResolvedValue(undefined);
    const result = await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "mock", model: "model-x" },
      40,
    );

    expect(result).toEqual({
      scanned: 4,
      queued: 1,
      skipped: 3,
      remaining: 0,
    });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "mem::compress",
        payload: expect.objectContaining({ observationId: "obs_missing" }),
      }),
    );
  });

  it("requeues a stale running job but leaves a fresh running job alone", async () => {
    process.env["AGENTMEMORY_LLM_STALE_RUNNING_MS"] = "1000";
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-08-13T12:00:00.000Z",
      status: "active",
      observationCount: 2,
    });
    const stale = raw("obs_stale");
    const fresh = raw("obs_fresh");
    await kv.set(KV.observations("ses_1"), stale.id, stale);
    await kv.set(KV.observations("ses_1"), fresh.id, fresh);
    const now = Date.now();
    const staleStartedAt = new Date(now - 5_000).toISOString();
    await kv.set<LlmJob>(KV.llmJobs, stale.id, {
      id: stale.id,
      observationId: stale.id,
      sessionId: stale.sessionId,
      status: "running",
      attempt: 1,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: staleStartedAt,
      updatedAt: staleStartedAt,
      startedAt: staleStartedAt,
    });
    await beginCompressionAttempt(
      kv as never,
      { observationId: fresh.id, sessionId: fresh.sessionId, raw: fresh },
      { provider: "openai", model: "local-model" },
    );
    // Include a malformed legacy row: recovery must ignore it rather than
    // enumerating the accidental mem:obs:undefined scope.
    await kv.set(KV.sessions, "legacy", { status: "completed" });
    const trigger = vi.fn().mockResolvedValue(undefined);

    const result = await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "openai", model: "local-model" },
      40,
    );

    expect(result).toMatchObject({ queued: 1, remaining: 0 });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ observationId: stale.id }),
      }),
    );
    await expect(kv.get<LlmJob>(KV.llmJobs, stale.id)).resolves.toMatchObject({
      status: "queued",
      attempt: 1,
      error: "startup_recovery_stale_running",
    });
    await expect(kv.get<LlmJob>(KV.llmJobs, fresh.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
    });
  });

  it("immediately recovers a fresh running job owned by a prior daemon", async () => {
    process.env["AGENTMEMORY_LLM_STALE_RUNNING_MS"] = "1800000";
    const kv = mockKV();
    const observation = raw("obs_prior_runtime");
    const now = new Date().toISOString();
    await kv.set(KV.sessions, observation.sessionId, {
      id: observation.sessionId,
      project: "billing",
      cwd: "/repo/billing",
      startedAt: now,
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations(observation.sessionId), observation.id, observation);
    await kv.set<LlmJob>(KV.llmJobs, observation.id, {
      id: observation.id,
      observationId: observation.id,
      sessionId: observation.sessionId,
      status: "running",
      attempt: 1,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      // Legacy/prior-daemon rows have no current runtimeId.
    });
    const trigger = vi.fn().mockResolvedValue(undefined);

    const result = await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "openai", model: "local-model" },
      40,
    );

    expect(result).toMatchObject({ queued: 1, remaining: 0 });
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ observationId: observation.id }),
      }),
    );
  });

  it("repairs a running ledger row whose compressed observation is already durable", async () => {
    const kv = mockKV();
    const observation = raw("obs_committed_before_crash");
    const now = new Date().toISOString();
    await kv.set(KV.sessions, observation.sessionId, {
      id: observation.sessionId,
      project: "billing",
      cwd: "/repo/billing",
      startedAt: now,
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations(observation.sessionId), observation.id, {
      ...buildSearchableRawObservation(observation, "queued"),
      enrichmentMode: "llm",
      enrichmentStatus: "succeeded",
      enrichmentFinishedAt: now,
    });
    await kv.set<LlmJob>(KV.llmJobs, observation.id, {
      id: observation.id,
      observationId: observation.id,
      sessionId: observation.sessionId,
      status: "running",
      attempt: 1,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    });
    const trigger = vi.fn();

    await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "openai", model: "local-model" },
      40,
    );

    expect(trigger).not.toHaveBeenCalled();
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "succeeded",
      succeededAt: now,
    });
    const status = await getLlmPipelineStatus(
      kv as never,
      { provider: "openai", model: "local-model" },
    );
    expect(status).toMatchObject({ inFlight: 0, succeeded: 1 });
  });

  it("reopens a cooled terminal failure and preserves its searchable raw source", async () => {
    process.env["AGENTMEMORY_LLM_FAILED_RETRY_COOLDOWN_MS"] = "1";
    const kv = mockKV();
    const observation = raw("obs_cooled");
    const failedAt = new Date(Date.now() - 5_000).toISOString();
    await kv.set(KV.sessions, observation.sessionId, {
      id: observation.sessionId,
      project: "billing",
      cwd: "/repo/billing",
      startedAt: observation.timestamp,
      status: "active",
      observationCount: 1,
    });
    await kv.set(
      KV.observations(observation.sessionId),
      observation.id,
      buildSearchableRawObservation(observation, "failed", {
        finishedAt: failedAt,
        error: "provider unavailable",
      }),
    );
    await kv.set<LlmJob>(KV.llmJobs, observation.id, {
      id: observation.id,
      observationId: observation.id,
      sessionId: observation.sessionId,
      status: "failed",
      attempt: 10,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: failedAt,
      updatedAt: failedAt,
      failedAt,
      lastFailureAt: failedAt,
      error: "provider unavailable",
    });
    const trigger = vi.fn().mockResolvedValue(undefined);

    const result = await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "openai", model: "local-model" },
      40,
    );

    expect(result).toMatchObject({ scanned: 1, queued: 1, remaining: 0 });
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          observationId: observation.id,
          raw: expect.objectContaining({ raw: observation.raw }),
        }),
      }),
    );
    await expect(kv.get<LlmJob>(KV.llmJobs, observation.id)).resolves.toMatchObject({
      status: "queued",
      attempt: 0,
    });
  });

  it("cools a fresh terminal failure without hot-looping recovery scans", async () => {
    process.env["AGENTMEMORY_LLM_FAILED_RETRY_COOLDOWN_MS"] = "1800000";
    const kv = mockKV();
    const observation = raw("obs_cooling");
    const failedAt = new Date().toISOString();
    await kv.set(KV.sessions, observation.sessionId, {
      id: observation.sessionId,
      project: "billing",
      cwd: "/repo/billing",
      startedAt: observation.timestamp,
      status: "active",
      observationCount: 1,
    });
    await kv.set(
      KV.observations(observation.sessionId),
      observation.id,
      buildSearchableRawObservation(observation, "failed", {
        finishedAt: failedAt,
      }),
    );
    await kv.set<LlmJob>(KV.llmJobs, observation.id, {
      id: observation.id,
      observationId: observation.id,
      sessionId: observation.sessionId,
      status: "failed",
      attempt: 10,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: failedAt,
      updatedAt: failedAt,
      failedAt,
    });
    const trigger = vi.fn();

    const result = await redriveRawCompressionOrphans(
      { trigger } as never,
      kv as never,
      { provider: "openai", model: "local-model" },
      40,
    );

    expect(result).toMatchObject({
      scanned: 1,
      queued: 0,
      remaining: 1,
    });
    expect(result.retryAfterMs).toBeGreaterThan(1_700_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(1_800_000);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("surfaces status storage failure instead of fabricating a zero queue", async () => {
    const kv = mockKV();
    const originalGet = kv.get.bind(kv);
    const broken = {
      ...kv,
      get: vi.fn(async (scope: string, key: string) => {
        if (scope === KV.llmPipeline && key === "aggregate") {
          throw new Error("ledger unavailable");
        }
        return originalGet(scope, key);
      }),
    };

    await expect(
      getLlmPipelineStatus(
        broken as never,
        { provider: "openai", model: "local-model" },
      ),
    ).rejects.toThrow("ledger unavailable");
  });

  it("does not write a false-zero recovery checkpoint after an observation read failure", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_broken", {
      id: "ses_broken",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: new Date().toISOString(),
      status: "active",
      observationCount: 1,
    });
    const originalList = kv.list.bind(kv);
    const broken = {
      ...kv,
      list: vi.fn(async (scope: string) => {
        if (scope === KV.observations("ses_broken")) {
          throw new Error("observation scope unavailable");
        }
        return originalList(scope);
      }),
    };

    await expect(
      redriveRawCompressionOrphans(
        { trigger: vi.fn() } as never,
        broken as never,
        { provider: "openai", model: "local-model" },
      ),
    ).rejects.toThrow("observation scope unavailable");
    await expect(
      kv.get(KV.llmPipeline, "reconciliation"),
    ).resolves.toBeNull();
  });

  it("reports aggregate queue health and raw orphans", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "ses_1", {
      id: "ses_1",
      project: "billing",
      cwd: "/repo/billing",
      startedAt: "2026-08-13T12:00:00.000Z",
      status: "active",
      observationCount: 1,
    });
    await kv.set(KV.observations("ses_1"), "obs_orphan", raw("obs_orphan"));
    await kv.set(KV.llmPipeline, "reconciliation", {
      id: "reconciliation",
      reconciledAt: new Date().toISOString(),
      scanned: 1,
      queued: 0,
      skipped: 0,
      untrackedRaw: 1,
    });
    const now = new Date();
    const succeededAt = new Date(now.getTime() - 60_000).toISOString();
    await kv.set<LlmJob>(KV.llmJobs, "obs_success", {
      id: "obs_success",
      observationId: "obs_success",
      sessionId: "ses_1",
      status: "succeeded",
      attempt: 1,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: succeededAt,
      updatedAt: succeededAt,
      succeededAt,
    });
    await rebuildLlmPipelineAggregate(kv as never);

    const status = await getLlmPipelineStatus(
      kv as never,
      { provider: "fallback", model: "fallback-model" },
      { state: "closed" },
    );

    expect(status).toMatchObject({
      enabled: true,
      reason: "auto_compress_enabled",
      waiting: 0,
      inFlight: 0,
      retrying: 0,
      failed: 0,
      succeeded: 1,
      total: 1,
      throughput5m: 1,
      rawOrphans: 1,
      provider: "openai",
      model: "local-model",
      circuit: { state: "closed" },
    });
  });

  it("serves pipeline status without listing the historical job ledger", async () => {
    const kv = mockKV();
    await kv.set<LlmJob>(KV.llmJobs, "obs_done", {
      id: "obs_done",
      observationId: "obs_done",
      sessionId: "ses_1",
      status: "succeeded",
      attempt: 1,
      maxAttempts: 10,
      provider: "openai",
      model: "local-model",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      succeededAt: new Date().toISOString(),
    });
    await rebuildLlmPipelineAggregate(kv as never);
    const noLedgerScan = {
      ...kv,
      list: vi.fn().mockRejectedValue(new Error("job ledger must not be listed")),
    };

    await expect(
      getLlmPipelineStatus(
        noLedgerScan as never,
        { provider: "fallback", model: "fallback" },
      ),
    ).resolves.toMatchObject({ succeeded: 1, total: 1 });
    expect(noLedgerScan.list).not.toHaveBeenCalled();
  });

  it("keeps a successful job authoritative when aggregate persistence fails", async () => {
    const kv = mockKV();
    await rebuildLlmPipelineAggregate(kv as never);
    const originalSet = kv.set.bind(kv);
    const aggregateFailure = {
      ...kv,
      set: vi.fn(async (scope: string, key: string, value: unknown) => {
        if (scope === KV.llmPipeline && key === "aggregate") {
          throw new Error("aggregate unavailable");
        }
        return originalSet(scope, key, value);
      }),
    };
    const observation = raw("obs_success_survives_telemetry_failure");

    await expect(
      markCompressionSucceeded(
        aggregateFailure as never,
        {
          observationId: observation.id,
          sessionId: observation.sessionId,
          raw: observation,
        },
        { provider: "openai", model: "local-model" },
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      kv.get<LlmJob>(KV.llmJobs, observation.id),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("exposes the aggregate through the authenticated LLM status endpoint", async () => {
    process.env["AGENTMEMORY_AUTO_COMPRESS"] = "false";
    const sdk = mockSdk();
    const kv = mockKV();
    await rebuildLlmPipelineAggregate(kv as never);
    registerApiTriggers(
      sdk as never,
      kv as never,
      "status-secret",
      undefined,
      { name: "resilient(openai)", circuitState: { state: "closed" } },
      { provider: "openai", model: "local-model" },
    );

    const response = (await sdk.trigger("api::llm-status", {
      headers: { authorization: "Bearer status-secret" },
      query_params: {},
    })) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      enabled: false,
      reason: "auto_compress_disabled",
      waiting: 0,
      inFlight: 0,
      retrying: 0,
      failed: 0,
      succeeded: 0,
      total: 0,
      oldestAge: 0,
      oldestAgeMs: 0,
      lastDispatch: null,
      lastSuccess: null,
      lastFailure: null,
      throughput5m: 0,
      throughputPerMinute: 0,
      rawOrphans: 0,
      provider: "openai",
      model: "local-model",
      circuit: { state: "closed" },
    });
  });
});
