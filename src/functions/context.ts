import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  SessionSummary,
  ContextBlock,
  ProjectProfile,
  MemorySlot,
  Lesson,
  ContextBudgetReport,
  PackedContext,
  QueryPlan,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAccessBatch } from "./access-tracker.js";
import { logger } from "../logger.js";
import {
  isSlotsEnabled,
  listPinnedSlots,
  renderPinnedContext,
} from "./slots.js";
import {
  buildQueryPlan,
  contextBlockToRankedEvidence,
  packContext,
} from "../retrieval/context-router.js";

type ContextInput = {
  sessionId: string;
  project: string;
  budget?: number;
  explain?: boolean;
  includeReport?: boolean;
};

type ContextResult = {
  context: string;
  blocks: number;
  tokens: number;
  budgetReport?: ContextBudgetReport;
  packedContext?: PackedContext;
  queryPlan?: QueryPlan;
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function registerContextFunction(
  sdk: ISdk,
  kv: StateKV,
  tokenBudget: number,
): void {
  sdk.registerFunction("mem::context", 
    async (data: ContextInput): Promise<ContextResult> => {
      const budget = data.budget || tokenBudget;
      const explain = data.explain === true;
      const includeReport = explain || data.includeReport === true;
      const blocks: ContextBlock[] = [];

      const [pinnedSlots, profile, lessons] = await Promise.all([
        isSlotsEnabled()
          ? listPinnedSlots(kv).catch(() => [] as MemorySlot[])
          : Promise.resolve([] as MemorySlot[]),
        kv
          .get<ProjectProfile>(KV.profiles, data.project)
          .catch(() => null),
        kv.list<Lesson>(KV.lessons).catch(() => [] as Lesson[]),
      ]);

      const slotContent = renderPinnedContext(pinnedSlots);
      if (slotContent) {
        blocks.push({
          type: "memory",
          content: slotContent,
          tokens: estimateTokens(slotContent),
          recency: Date.now(),
        });
      }
      if (profile) {
        const profileParts = [];
        if (profile.topConcepts.length > 0) {
          profileParts.push(
            `Concepts: ${profile.topConcepts
              .slice(0, 8)
              .map((c) => c.concept)
              .join(", ")}`,
          );
        }
        if (profile.topFiles.length > 0) {
          profileParts.push(
            `Key files: ${profile.topFiles
              .slice(0, 5)
              .map((f) => f.file)
              .join(", ")}`,
          );
        }
        if (profile.conventions.length > 0) {
          profileParts.push(`Conventions: ${profile.conventions.join("; ")}`);
        }
        if (profile.commonErrors.length > 0) {
          profileParts.push(
            `Common errors: ${profile.commonErrors.slice(0, 3).join("; ")}`,
          );
        }
        if (profileParts.length > 0) {
          const profileContent = `## Project Profile\n${profileParts.join("\n")}`;
          blocks.push({
            type: "memory",
            content: profileContent,
            tokens: estimateTokens(profileContent),
            recency: new Date(profile.updatedAt).getTime(),
          });
        }
      }

      // Lessons — closes the loop opened by mem::lesson-save / mem::reflect.
      // Without this block, lessons sit in KV and only surface when the agent
      // thinks to call memory_lesson_recall. Ranking puts project-scoped
      // lessons ahead of global ones, then weights by confidence; we cap at
      // 10 to keep the block bounded since the outer token-budget loop
      // below will drop the whole block if it doesn't fit. #457.
      const relevantLessons = lessons
        .filter((l) => !l.deleted && (!l.project || l.project === data.project))
        .sort((a, b) => {
          const scoreA = (a.project === data.project ? 1.5 : 1) * a.confidence;
          const scoreB = (b.project === data.project ? 1.5 : 1) * b.confidence;
          return scoreB - scoreA;
        })
        .slice(0, 10);

      if (relevantLessons.length > 0) {
        const items = relevantLessons
          .map(
            (l) =>
              `- (${l.confidence.toFixed(2)}) ${l.content}${l.context ? ` — ${l.context}` : ""}`,
          )
          .join("\n");
        const lessonsContent = `## Lessons Learned\n${items}`;
        const mostRecent = relevantLessons.reduce((acc, l) => {
          const t = new Date(l.lastReinforcedAt || l.updatedAt).getTime();
          return t > acc ? t : acc;
        }, 0);
        blocks.push({
          type: "memory",
          content: lessonsContent,
          tokens: estimateTokens(lessonsContent),
          recency: mostRecent,
          sourceIds: relevantLessons.map((l) => l.id),
        });
      }

      const allSessions = await kv.list<Session>(KV.sessions);
      const sessions = allSessions
        .filter((s) => s.project === data.project && s.id !== data.sessionId)
        .sort(
          (a, b) =>
            new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        )
        .slice(0, 10);

      const summariesPerSession = await Promise.all(
        sessions.map((s) =>
          kv.get<SessionSummary>(KV.summaries, s.id).catch(() => null),
        ),
      );

      const sessionsNeedingObs: number[] = [];
      for (let i = 0; i < sessions.length; i++) {
        const summary = summariesPerSession[i];
        if (summary) {
          const content = `## ${summary.title}\n${summary.narrative}\nDecisions: ${summary.keyDecisions.join("; ")}\nFiles: ${summary.filesModified.join(", ")}`;
          blocks.push({
            type: "summary",
            content,
            tokens: estimateTokens(content),
            recency: new Date(summary.createdAt).getTime(),
          });
        } else {
          sessionsNeedingObs.push(i);
        }
      }

      const obsResults = await Promise.all(
        sessionsNeedingObs.map((i) =>
          kv
            .list<CompressedObservation>(KV.observations(sessions[i].id))
            .catch(() => []),
        ),
      );
      const scannedObservations = obsResults.reduce(
        (sum, observations) => sum + observations.length,
        0,
      );

      for (let j = 0; j < sessionsNeedingObs.length; j++) {
        const i = sessionsNeedingObs[j];
        const observations = obsResults[j];
        const important = observations.filter(
          (o) => o.title && o.importance >= 5,
        );

        if (important.length > 0) {
          const top = important
            .sort((a, b) => b.importance - a.importance)
            .slice(0, 5);
          const items = top
            .map((o) => `- [${o.type}] ${o.title}: ${o.narrative}`)
            .join("\n");
          const content = `## Session ${sessions[i].id.slice(0, 8)} (${sessions[i].startedAt})\n${items}`;
          blocks.push({
            type: "observation",
            content,
            tokens: estimateTokens(content),
            recency: new Date(sessions[i].startedAt).getTime(),
            sourceIds: top.map((o) => o.id),
          });
        }
      }

      blocks.sort((a, b) => b.recency - a.recency);

      const header = `<agentmemory-context project="${escapeXmlAttr(data.project)}">`;
      const footer = `</agentmemory-context>`;
      const evidence = blocks
        .map(contextBlockToRankedEvidence)
        .map((item) => (explain ? { ...item, tokens: undefined } : item));
      const packed = packContext({
        evidence,
        budgetTokens: budget,
        header,
        footer,
        separator: "\n\n",
        explain,
      });
      const queryPlan = explain
        ? buildQueryPlan({
            mode: "context",
            searchMode: "balanced",
            streams: [
              "pinned-slots",
              "project-profile",
              "lessons",
              "session-summaries",
              "observations",
            ],
            filterStage: "project and current-session filters before packing",
            hardFilters: {
              project: data.project,
              excludeSessionId: data.sessionId,
            },
            requestedLimit: blocks.length,
            overFetchLimit: blocks.length,
            tokenBudget: budget,
            prefilter: {
              candidateCount: blocks.length,
              scannedSessions: allSessions.length,
              scannedObservations,
            },
          })
        : undefined;

      const accessedIds = packed.selected.flatMap(
        (item) => item.sourceIds ?? [],
      );

      if (accessedIds.length > 0) {
        void recordAccessBatch(kv, accessedIds);
      }

      if (packed.blocks === 0) {
        logger.info("No context available", { project: data.project });
        const response: ContextResult = {
          context: "",
          blocks: 0,
          tokens: 0,
        };
        if (includeReport) response.budgetReport = packed.budgetReport;
        if (explain) {
          response.packedContext = packed;
          response.queryPlan = queryPlan;
        }
        return response;
      }

      logger.info("Context generated", {
        blocks: packed.blocks,
        tokens: packed.tokens,
      });
      const response: ContextResult = {
        context: packed.context,
        blocks: packed.blocks,
        tokens: packed.tokens,
      };
      if (includeReport) response.budgetReport = packed.budgetReport;
      if (explain) {
        response.packedContext = packed;
        response.queryPlan = queryPlan;
      }
      return response;
    },
  );
}
