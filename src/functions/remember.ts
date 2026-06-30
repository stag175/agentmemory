import { TriggerAction, type ISdk } from "iii-sdk";
import type { Memory, MemoryRevision } from "../types.js";
import { KV, generateId, jaccardSimilarity } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import {
  defaultMemoryLane,
  isMemorySearchable,
  memoryToObservation,
  normalizeMemoryLane,
  normalizeMemoryPrivacyScope,
  normalizeMemoryReviewState,
} from "../state/memory-utils.js";
import { deleteAccessLog } from "./access-tracker.js";
import { recordAudit } from "./audit.js";
import { getSearchIndex, vectorIndexAddGuarded, vectorIndexRemove, flushIndexSave } from "./search.js";
import { recordMemoryRevision } from "./memory-lifecycle.js";
import {
  redactOptionalString,
  redactStringArray,
  scanPrivateData,
  summarizePrivacyScans,
} from "./privacy.js";
import { getAgentId } from "../config.js";
import { logger } from "../logger.js";
import { safeRecordAgentEvent } from "./agent-events.js";
import { evaluateWriteGate, type WriteGateDecision } from "./write-gate.js";

type RememberWriteGateOption =
  | boolean
  | "review"
  | "require_pass"
  | "strict"
  | {
      mode?: "review" | "require_pass" | "strict";
      requirePass?: boolean;
    };

type GatedMemory = Memory & { writeGate: WriteGateDecision };

function shouldRequireGatePass(option: {
  requireGatePass?: boolean;
  writeGate?: RememberWriteGateOption;
}): boolean {
  if (option.requireGatePass === true) return true;
  if (option.writeGate === true) return true;
  if (
    option.writeGate === "require_pass" ||
    option.writeGate === "strict"
  ) {
    return true;
  }
  if (
    option.writeGate &&
    typeof option.writeGate === "object" &&
    !Array.isArray(option.writeGate)
  ) {
    return (
      option.writeGate.requirePass === true ||
      option.writeGate.mode === "require_pass" ||
      option.writeGate.mode === "strict"
    );
  }
  return false;
}

function isSameAgentScope(existing: Memory, agentId: string | undefined): boolean {
  if (agentId) return existing.agentId === agentId;
  return existing.agentId === undefined;
}

export function registerRememberFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::remember", 
    async (data: {
      content: string;
      type?: string;
      concepts?: string[];
      files?: string[];
      ttlDays?: number;
      sourceObservationIds?: string[];
      agentId?: string;
      project?: string;
      lane?: Memory["lane"];
      confidence?: number;
      privacyScope?: Memory["privacyScope"];
      ownerId?: string;
      branch?: string;
      commit?: string;
      sourceHash?: string;
      sourceType?: string;
      sourceUri?: string;
      reviewState?: Memory["reviewState"];
      requireGatePass?: boolean;
      writeGate?: RememberWriteGateOption;
    }) => {
      if (
        !data.content ||
        typeof data.content !== "string" ||
        !data.content.trim()
      ) {
        return { success: false, error: "content is required" };
      }
      if (data.files && !Array.isArray(data.files)) {
        return { success: false, error: "files must be an array" };
      }
      if (data.concepts && !Array.isArray(data.concepts)) {
        return { success: false, error: "concepts must be an array" };
      }
      if (data.sourceObservationIds && !Array.isArray(data.sourceObservationIds)) {
        return { success: false, error: "sourceObservationIds must be an array" };
      }
      const validTypes = new Set([
        "pattern",
        "preference",
        "architecture",
        "bug",
        "workflow",
        "fact",
      ]);
      const memType = validTypes.has(data.type || "")
        ? (data.type as Memory["type"])
        : "fact";
      const contentScan = scanPrivateData(data.content);
      const content = contentScan.redacted;
      const conceptRedaction = redactStringArray(data.concepts);
      const fileRedaction = redactStringArray(data.files);
      const sourceObservationRedaction = redactStringArray(
        data.sourceObservationIds,
      );
      const ownerIdRedaction = redactOptionalString(data.ownerId);
      const branchRedaction = redactOptionalString(data.branch);
      const commitRedaction = redactOptionalString(data.commit);
      const sourceHashRedaction = redactOptionalString(data.sourceHash);
      const sourceTypeRedaction = redactOptionalString(data.sourceType);
      const sourceUriRedaction = redactOptionalString(data.sourceUri);
      const projectRedaction = redactOptionalString(data.project);
      const laneRedaction = redactOptionalString(data.lane);
      const privacyScopeRedaction = redactOptionalString(data.privacyScope);
      const reviewStateRedaction = redactOptionalString(data.reviewState);
      const lane = normalizeMemoryLane(laneRedaction.value);
      const privacyScope = normalizeMemoryPrivacyScope(
        privacyScopeRedaction.value,
      );
      const reviewState = normalizeMemoryReviewState(reviewStateRedaction.value);

      const rawAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId
          : getAgentId();
      const agentIdRedaction = redactOptionalString(rawAgentId);
      const callAgentId =
        typeof agentIdRedaction.value === "string" &&
        agentIdRedaction.value.trim().length > 0
          ? agentIdRedaction.value.trim().slice(0, 128)
          : undefined;

      const privacySummary = summarizePrivacyScans(
        contentScan,
        conceptRedaction.scan,
        fileRedaction.scan,
        sourceObservationRedaction.scan,
        ownerIdRedaction.scan,
        branchRedaction.scan,
        commitRedaction.scan,
        sourceHashRedaction.scan,
        sourceTypeRedaction.scan,
        sourceUriRedaction.scan,
        projectRedaction.scan,
        agentIdRedaction.scan,
        laneRedaction.scan,
        privacyScopeRedaction.scan,
        reviewStateRedaction.scan,
      );

      const now = new Date().toISOString();
      // Normalize project early so every subsequent comparison and storage
      // operation uses the same cleaned value. Raw data.project must not be
      // referenced below this point.
      const project =
        typeof projectRedaction.value === "string" &&
        projectRedaction.value.trim().length > 0
          ? projectRedaction.value.trim()
          : undefined;

      return withKeyedLock("mem:remember", async () => {
        const existingMemories = await kv.list<Memory>(KV.memories);
        const comparableMemories = existingMemories.filter((existing) =>
          isSameAgentScope(existing, callAgentId),
        );
        const requireGatePass = shouldRequireGatePass(data);
        const writeGate: WriteGateDecision = {
          ...evaluateWriteGate({
            content,
            type: memType,
            concepts: conceptRedaction.values,
            files: fileRedaction.values,
            sourceObservationIds: sourceObservationRedaction.values.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            ),
            project,
            lane: lane ?? defaultMemoryLane(memType),
            privacyScope,
            ownerId: ownerIdRedaction.value,
            branch: branchRedaction.value,
            commit: commitRedaction.value,
            sourceHash: sourceHashRedaction.value,
            sourceType: sourceTypeRedaction.value,
            sourceUri: sourceUriRedaction.value,
            agentId: callAgentId,
            existingMemories: comparableMemories,
            privacySummary,
          }),
          mode: requireGatePass ? "require_pass" : "review",
        };

        if (requireGatePass && !writeGate.pass) {
          return {
            success: false,
            error: "write gate rejected memory",
            writeGate,
          };
        }

        let supersededId: string | undefined;
        let supersededVersion = 1;
        let supersededMemory: Memory | undefined;
        const lowerContent = content.toLowerCase();
        // Near-duplicate content supersedes the prior memory (dedup keeps the
        // latest). The write gate is advisory in the default "review" mode: it
        // records a decision for observability and the review queue but does not
        // suppress dedup or recall. Strict enforcement (require_pass) rejects a
        // failing write outright above, before it can reach this point. Only
        // redacted/quarantined writes are held back from superseding.
        if (!privacySummary.redactionApplied) {
          for (const existing of comparableMemories) {
            if (!isMemorySearchable(existing)) continue;
            // Never supersede a memory that belongs to a different project.
            // Both sides must have an explicit project for the guard to engage;
            // an unscoped memory (legacy, no project field) is treated as a
            // wildcard so pre-existing data is not stranded.
            if (project && existing.project && existing.project !== project) {
              continue;
            }
            const similarity = jaccardSimilarity(
              lowerContent,
              existing.content.toLowerCase(),
            );
            if (similarity > 0.7) {
              supersededId = existing.id;
              supersededVersion = existing.version ?? 1;
              supersededMemory = existing;
              break;
            }
          }
        }

        const memory: GatedMemory = {
          id: generateId("mem"),
          createdAt: now,
          updatedAt: now,
          type: memType,
          title: content.slice(0, 80),
          content,
          concepts: conceptRedaction.values,
          files: fileRedaction.values,
          sessionIds: [],
          strength: 7,
          confidence:
            typeof data.confidence === "number" && Number.isFinite(data.confidence)
              ? Math.max(0, Math.min(1, data.confidence))
              : undefined,
          version: supersededId ? supersededVersion + 1 : 1,
          parentId: supersededId,
          supersedes: supersededId ? [supersededId] : [],
          sourceObservationIds: sourceObservationRedaction.values.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
          isLatest: true,
          lane: lane ?? defaultMemoryLane(memType),
          lifecycleState: privacySummary.redactionApplied ? "quarantined" : "active",
          reviewState: privacySummary.redactionApplied
            ? "needs_review"
            : reviewState ?? "unreviewed",
          writeGate,
          ...(privacyScope
            ? { privacyScope }
            : privacySummary.redactionApplied
              ? { privacyScope: "user" as const }
              : {}),
          ...(privacySummary.redactionApplied
            ? {
                redactionApplied: true,
                sensitivityLabels: privacySummary.labels,
              }
            : {}),
          ...(ownerIdRedaction.value ? { ownerId: ownerIdRedaction.value } : {}),
          ...(branchRedaction.value ? { branch: branchRedaction.value } : {}),
          ...(commitRedaction.value ? { commit: commitRedaction.value } : {}),
          ...(sourceHashRedaction.value ? { sourceHash: sourceHashRedaction.value } : {}),
          ...(sourceTypeRedaction.value ? { sourceType: sourceTypeRedaction.value } : {}),
          ...(sourceUriRedaction.value ? { sourceUri: sourceUriRedaction.value } : {}),
          ...(callAgentId ? { agentId: callAgentId } : {}),
          ...(project !== undefined && { project }),
        };

        if (data.ttlDays && typeof data.ttlDays === "number" && data.ttlDays > 0) {
          memory.forgetAfter = new Date(Date.now() + data.ttlDays * 86400000).toISOString();
        }

        if (supersededMemory) {
          const supersededPrior: Memory = {
            ...supersededMemory,
            concepts: [...supersededMemory.concepts],
            files: [...supersededMemory.files],
            sessionIds: [...supersededMemory.sessionIds],
            supersedes: supersededMemory.supersedes
              ? [...supersededMemory.supersedes]
              : undefined,
            relatedIds: supersededMemory.relatedIds
              ? [...supersededMemory.relatedIds]
              : undefined,
            sourceObservationIds: supersededMemory.sourceObservationIds
              ? [...supersededMemory.sourceObservationIds]
              : undefined,
          };
          supersededMemory.isLatest = false;
          supersededMemory.lifecycleState = "superseded";
          await kv.set(KV.memories, supersededMemory.id, supersededMemory);
          await recordMemoryRevision(
            kv,
            supersededMemory.id,
            "supersede",
            supersededPrior,
            memory,
            { reason: "content similarity supersession" },
          );
          await safeRecordAgentEvent(kv, {
            type: "memory_superseded",
            timestamp: now,
            project: supersededMemory.project ?? project,
            agentId: supersededMemory.agentId ?? callAgentId,
            functionId: "mem::remember",
            targetIds: [supersededMemory.id, memory.id],
            memoryIds: [supersededMemory.id, memory.id],
            metadata: {
              supersededBy: memory.id,
              reason: "content similarity supersession",
            },
          });
        }
        await kv.set(KV.memories, memory.id, memory);
        await recordMemoryRevision(kv, memory.id, "create", null, memory);
        await safeRecordAgentEvent(kv, {
          type: "memory_written",
          timestamp: now,
          project: memory.project,
          agentId: memory.agentId,
          functionId: "mem::remember",
          targetIds: [memory.id],
          memoryIds: [memory.id],
          observationIds: memory.sourceObservationIds,
          metadata: {
            type: memory.type,
            lane: memory.lane,
            lifecycleState: memory.lifecycleState,
            reviewState: memory.reviewState,
            writeGate: {
              pass: memory.writeGate.pass,
              score: memory.writeGate.score,
              reasons: memory.writeGate.reasons,
            },
            supersedes: memory.supersedes ?? [],
            redactionApplied: memory.redactionApplied === true,
          },
        });
        try {
          await recordAudit(kv, "remember", "mem::remember", [memory.id], {
            type: memory.type,
            project: memory.project,
            lane: memory.lane,
            lifecycleState: memory.lifecycleState,
            reviewState: memory.reviewState,
            writeGate: {
              pass: memory.writeGate.pass,
              score: memory.writeGate.score,
              reasons: memory.writeGate.reasons,
              scores: memory.writeGate.scores,
            },
            redactionApplied: memory.redactionApplied === true,
            sensitivityLabels: memory.sensitivityLabels ?? [],
          });
        } catch (err) {
          logger.warn("audit write failed", {
            functionId: "mem::remember",
            operation: "remember",
            targetIds: [memory.id],
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Without this, mem::remember persists the row but the BM25
        // index never sees it, so memory_smart_search and memory_recall
        // return empty even seconds after save (#257). Use try/catch so
        // an indexing failure doesn't block the save itself — the
        // restart-time rebuild will pick the memory up either way.
        if (isMemorySearchable(memory)) {
          try {
            getSearchIndex().add(memoryToObservation(memory));
          } catch (err) {
            logger.warn("Failed to index saved memory into BM25", {
              memId: memory.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          await vectorIndexAddGuarded(
            memory.id,
            memory.sessionIds?.[0] ?? "memory",
            memory.title + " " + memory.content,
            { kind: "memory", logId: memory.id },
          );
        }

        if (supersededId) {
          await sdk.trigger({
            function_id: "mem::cascade-update",
            payload: {
              supersededMemoryId: supersededId,
            },
            action: TriggerAction.Void(),
          });
        }

        logger.info("Memory saved", {
          memId: memory.id,
          type: memory.type,
          project: memory.project,
        });
        return { success: true, memory };
      });
    },
  );

  sdk.registerFunction("mem::forget",
    async (data: {
      sessionId?: string;
      observationIds?: string[];
      memoryId?: string;
    }) => {
      let deleted = 0;
      const deletedMemoryIds: string[] = [];
      const deletedObservationIds: string[] = [];
      let purgedRevisionCount = 0;
      let deletedSession = false;
      const { decrementImageRef } = await import("./image-refs.js");

      if (data.memoryId) {
        const mem = await kv.get<Memory>(KV.memories, data.memoryId);
        if (mem) {
          const revisions = await kv
            .list<MemoryRevision>(KV.memoryHistory)
            .catch(() => []);
          const memoryRevisions = revisions.filter(
            (revision) => revision.memoryId === data.memoryId,
          );
          for (const revision of memoryRevisions) {
            await kv.delete(KV.memoryHistory, revision.id);
          }
          purgedRevisionCount = memoryRevisions.length;
          await kv.delete(KV.memories, data.memoryId);
          if (mem.imageRef) {
            await decrementImageRef(kv, sdk, mem.imageRef);
          }
          await deleteAccessLog(kv, data.memoryId);
          getSearchIndex().remove(data.memoryId);
          vectorIndexRemove(data.memoryId);
          deletedMemoryIds.push(data.memoryId);
          deleted++;
        }
      }

      if (
        data.sessionId &&
        data.observationIds &&
        data.observationIds.length > 0
      ) {
        for (const obsId of data.observationIds) {
          const obs = await kv.get<{ imageData?: string; imageRef?: string }>(
            KV.observations(data.sessionId),
            obsId,
          );
          await kv.delete(KV.observations(data.sessionId), obsId);
          if (obs?.imageData) await decrementImageRef(kv, sdk, obs.imageData);
          if (obs?.imageRef && obs.imageRef !== obs.imageData) {
            await decrementImageRef(kv, sdk, obs.imageRef);
          }
          getSearchIndex().remove(obsId);
          vectorIndexRemove(obsId);
          deletedObservationIds.push(obsId);
          deleted++;
        }
      }

      if (
        data.sessionId &&
        (!data.observationIds || data.observationIds.length === 0) &&
        !data.memoryId
      ) {
        const observations = await kv.list<{ id: string; imageData?: string; imageRef?: string }>(
          KV.observations(data.sessionId),
        );
        for (const obs of observations) {
          await kv.delete(KV.observations(data.sessionId), obs.id);
          if (obs.imageData) await decrementImageRef(kv, sdk, obs.imageData);
          if (obs.imageRef && obs.imageRef !== obs.imageData) {
            await decrementImageRef(kv, sdk, obs.imageRef);
          }
          getSearchIndex().remove(obs.id);
          vectorIndexRemove(obs.id);
          deletedObservationIds.push(obs.id);
          deleted++;
        }
        await kv.delete(KV.sessions, data.sessionId);
        await kv.delete(KV.summaries, data.sessionId);
        deletedSession = true;
        deleted += 2;
      }

      if (deleted > 0) {
        await flushIndexSave();
        await recordAudit(
          kv,
          "forget",
          "mem::forget",
          [...deletedMemoryIds, ...deletedObservationIds],
          {
            sessionId: data.sessionId,
            deleted,
            memoriesDeleted: deletedMemoryIds.length,
            observationsDeleted: deletedObservationIds.length,
            sessionDeleted: deletedSession,
            purgedRevisionCount,
            reason: "user-initiated forget",
          },
        );
        await safeRecordAgentEvent(kv, {
          type: "memory_forgotten",
          timestamp: new Date().toISOString(),
          sessionId: data.sessionId,
          functionId: "mem::forget",
          targetIds: [...deletedMemoryIds, ...deletedObservationIds],
          memoryIds: deletedMemoryIds,
          observationIds: deletedObservationIds,
          metadata: {
            deleted,
            memoriesDeleted: deletedMemoryIds.length,
            observationsDeleted: deletedObservationIds.length,
            sessionDeleted: deletedSession,
            purgedRevisionCount,
          },
        });
      }

      logger.info("Memory forgotten", { deleted });
      return { success: true, deleted };
    },
  );
}
