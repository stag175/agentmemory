import { TriggerAction, type ISdk } from "iii-sdk";
import { readFileSync } from "node:fs";
import { isManagedImagePath } from "../utils/image-store.js";
import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
  MemoryProvider,
} from "../types.js";
import { KV, STREAM } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  COMPRESSION_SYSTEM,
  buildCompressionPrompt,
} from "../prompts/compression.js";
import { VISION_DESCRIPTION_PROMPT } from "../prompts/vision.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { getSearchIndex, vectorIndexAddGuarded } from "./search.js";
import { CompressOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreCompression } from "../eval/quality.js";
import { compressWithRetry } from "../eval/self-correct.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { logger } from "../logger.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import type { LlmJob } from "../types.js";
import {
  beginCompressionAttempt,
  getLlmStaleRunningMs,
  isFailedJobCooled,
  isCompressedObservation,
  markCompressionFailed,
  markCompressionSucceeded,
  reopenCompressionJob,
  scheduleTerminalCompressionRetry,
  type CompressionJobPayload,
  type LlmJobMetadata,
} from "./llm-jobs.js";
import { buildSearchableRawObservation } from "./compress-synthetic.js";

const VALID_TYPES = new Set<string>([
  "file_read",
  "file_write",
  "file_edit",
  "command_run",
  "search",
  "web_fetch",
  "conversation",
  "error",
  "decision",
  "discovery",
  "subagent",
  "notification",
  "task",
  "image",
  "other",
]);

function parseCompressionXml(
  xml: string,
): Omit<CompressedObservation, "id" | "sessionId" | "timestamp"> | null {
  const rawType = getXmlTag(xml, "type");
  const title = getXmlTag(xml, "title");
  if (!rawType || !title) return null;
  const type = VALID_TYPES.has(rawType) ? rawType : "other";

  return {
    type: type as ObservationType,
    title,
    subtitle: getXmlTag(xml, "subtitle") || undefined,
    facts: getXmlChildren(xml, "facts", "fact"),
    narrative: getXmlTag(xml, "narrative"),
    concepts: getXmlChildren(xml, "concepts", "concept"),
    files: getXmlChildren(xml, "files", "file"),
    importance: Math.max(
      1,
      Math.min(10, parseInt(getXmlTag(xml, "importance") || "5", 10) || 5),
    ),
  };
}

export function registerCompressFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
  modelName?: string,
): void {
  const metadata: LlmJobMetadata = {
    // The provider wrapper is the actual execution path (and may include a
    // fallback chain); do not label attempts as merely the configured primary.
    provider: provider.name,
    model: modelName ?? provider.name,
  };
  const compressionLockMs = getLlmStaleRunningMs();

  sdk.registerFunction(
    "mem::compress",
    async (data: CompressionJobPayload) =>
      withKeyedLock(
        `llm-compress:${data.sessionId}:${data.observationId}`,
        async () => {
          // A persisted iii queue item and startup redrive can briefly overlap.
          // Re-check inside the lock so duplicate deliveries never double-call
          // the provider.
          const stored = await kv.get<RawObservation | CompressedObservation>(
            KV.observations(data.sessionId),
            data.observationId,
          );
          if (isCompressedObservation(stored)) {
            await markCompressionSucceeded(kv, data, metadata);
            return {
              success: true,
              compressed: stored,
              qualityScore: Math.round((stored.confidence ?? 0) * 100),
              idempotent: true,
            };
          }

          let priorJob = await kv.get<LlmJob>(
            KV.llmJobs,
            data.observationId,
          );
          if (
            priorJob?.status === "failed" &&
            priorJob.attempt >= priorJob.maxAttempts
          ) {
            if (data.force || isFailedJobCooled(priorJob)) {
              priorJob = await reopenCompressionJob(kv, priorJob);
            } else {
              return {
                success: false,
                error: "compression_failed",
                terminal: true,
                attempts: priorJob.attempt,
              };
            }
          }

          const raw =
            stored && !isCompressedObservation(stored) ? stored : data.raw;
          const effectiveData: CompressionJobPayload = { ...data, raw };
          const job = await beginCompressionAttempt(kv, effectiveData, metadata);
          const runningFallback = buildSearchableRawObservation(raw, "running", {
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
          });
          await kv.set(
            KV.observations(data.sessionId),
            data.observationId,
            runningFallback,
          );
          getSearchIndex().add(runningFallback);
          const startMs = Date.now();

          try {
            let imageDescription: string | undefined;
            const hasImage =
              raw.modality === "image" || raw.modality === "mixed";

            if (hasImage && raw.imageData && provider.describeImage) {
              try {
                let base64Data = raw.imageData;
                let mimeType = "image/png";

                if (
                  !raw.imageData.startsWith("/9j/") &&
                  !raw.imageData.startsWith("iVBOR")
                ) {
                  if (!isManagedImagePath(raw.imageData)) {
                    throw new Error(
                      `Refusing to read image outside managed store: ${raw.imageData}`,
                    );
                  }
                  const fileBuffer = readFileSync(raw.imageData);
                  base64Data = fileBuffer.toString("base64");
                  if (
                    raw.imageData.endsWith(".jpg") ||
                    raw.imageData.endsWith(".jpeg")
                  )
                    mimeType = "image/jpeg";
                  else if (raw.imageData.endsWith(".webp"))
                    mimeType = "image/webp";
                  else if (raw.imageData.endsWith(".gif"))
                    mimeType = "image/gif";
                }

                imageDescription = await provider.describeImage(
                  base64Data,
                  mimeType,
                  VISION_DESCRIPTION_PROMPT,
                );
                logger.info("Image described by vision model", {
                  obsId: data.observationId,
                });
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(
                  "Vision model call failed, falling back to text-only compression",
                  { obsId: data.observationId, error: msg },
                );
              }
            }

            const prompt = buildCompressionPrompt({
              hookType: raw.hookType,
              toolName: raw.toolName,
              toolInput: raw.toolInput,
              toolOutput: imageDescription
                ? `[Image Description]: ${imageDescription}\n\n${raw.toolOutput ?? ""}`
                : raw.toolOutput,
              userPrompt: raw.userPrompt,
              timestamp: raw.timestamp,
            });

        const validator = (response: string) => {
          const parsed = parseCompressionXml(response);
          if (!parsed) return { valid: false, errors: ["xml_parse_failed"] };
          const result = validateOutput(
            CompressOutputSchema,
            parsed,
            "mem::compress",
          );
          return result.valid
            ? { valid: true }
            : { valid: false, errors: result.result.errors };
        };

        const { response, retried } = await compressWithRetry(
          provider,
          COMPRESSION_SYSTEM,
          prompt,
          validator,
          1,
        );

        const parsed = parseCompressionXml(response);
        const validated = parsed
          ? validateOutput(CompressOutputSchema, parsed, "mem::compress")
          : null;
        if (!parsed || !validated?.valid) {
          logger.warn("Invalid compression output", {
            obsId: data.observationId,
            retried,
            errors:
              validated && !validated.valid
                ? validated.result.errors
                : ["xml_parse_failed"],
          });
          throw new Error(
            parsed ? "schema_validation_failed" : "parse_failed",
          );
        }

        const qualityScore = scoreCompression(parsed);

        const compressed: CompressedObservation = {
          id: data.observationId,
          sessionId: data.sessionId,
          timestamp: raw.timestamp,
          ...parsed,
          confidence: qualityScore / 100,
          enrichmentMode: "llm",
          enrichmentStatus: "succeeded",
          enrichmentQueuedAt: job.queuedAt,
          enrichmentStartedAt: job.startedAt,
          enrichmentFinishedAt: new Date().toISOString(),
          ...(hasImage ? { modality: raw.modality } : {}),
          ...(imageDescription ? { imageDescription } : {}),
          ...(raw.imageData ? { imageRef: raw.imageData } : {}),
          ...(raw.agentId ? { agentId: raw.agentId } : {}),
        };

        await kv.set(
          KV.observations(data.sessionId),
          data.observationId,
          compressed,
        );

        try {
          getSearchIndex().add(compressed);
        } catch (err) {
          logger.warn("Failed to index compressed observation into BM25", {
            obsId: compressed.id,
            sessionId: compressed.sessionId,
            title: compressed.title,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await vectorIndexAddGuarded(
          compressed.id,
          compressed.sessionId,
          compressed.title + " " + (compressed.narrative || ""),
          { kind: "observation", logId: compressed.id },
        );

        const streamResults = await Promise.allSettled([
          sdk.trigger({
            function_id: "stream::set",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.group(data.sessionId),
              item_id: data.observationId,
              data: { type: "compressed", observation: compressed },
            },
          }),
          sdk.trigger({
            function_id: "stream::send",
            payload: {
              stream_name: STREAM.name,
              group_id: STREAM.viewerGroup,
              id: `compressed-${data.observationId}`,
              type: "compressed_observation",
              data: {
                type: "compressed",
                observation: compressed,
                sessionId: data.sessionId,
              },
            },
            action: TriggerAction.Void(),
          }),
        ]);
        for (const result of streamResults) {
          if (result.status === "rejected") {
            logger.warn("Non-fatal stream publish failure after compress", {
              sessionId: data.sessionId,
              observationId: data.observationId,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::compress",
            latencyMs,
            true,
            qualityScore,
          );
        }

        await markCompressionSucceeded(kv, effectiveData, metadata, job);

        logger.info("Observation compressed", {
          obsId: data.observationId,
          type: compressed.type,
          importance: compressed.importance,
          qualityScore,
          retried,
        });

        return { success: true, compressed, qualityScore };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::compress", latencyMs, false);
        }
        logger.error("Compression failed", {
          obsId: data.observationId,
          error: msg,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
        });
        const failed = await markCompressionFailed(
          kv,
          effectiveData,
          metadata,
          job,
          err,
        );
        const searchableFailure = buildSearchableRawObservation(
          raw,
          failed.status === "failed" ? "failed" : "retrying",
          {
            queuedAt: failed.queuedAt,
            startedAt: failed.startedAt,
            ...(failed.status === "failed"
              ? { finishedAt: new Date().toISOString() }
              : {}),
            error: failed.error ?? msg,
          },
        );
        await kv.set(
          KV.observations(data.sessionId),
          data.observationId,
          searchableFailure,
        );
        // SearchIndex.add replaces the same ID. Keep the fallback recallable
        // without issuing a second embedding while the provider is unhealthy.
        getSearchIndex().add(searchableFailure);
        if (failed.status === "retrying") {
          // Throwing is intentional: iii-queue only retries rejected
          // invocations. Returning {success:false} acknowledged and dropped
          // transient provider failures in previous releases.
          throw new Error(`compression_retryable: ${msg}`);
        }
        scheduleTerminalCompressionRetry(
          sdk,
          kv,
          effectiveData,
          metadata,
        );
        return {
          success: false,
          error: "compression_failed",
          terminal: true,
          attempts: failed.attempt,
        };
      }
        },
        {
          timeoutMs: compressionLockMs,
          staleMs: compressionLockMs + 60_000,
        },
      ),
  );
}
