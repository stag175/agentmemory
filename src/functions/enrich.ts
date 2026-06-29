import type { ISdk } from "iii-sdk";
import type { ContextBudgetReport, Memory, RankedEvidence } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { logger } from "../logger.js";
import {
  estimateContextTokens,
  packContext,
} from "../retrieval/context-router.js";

const MAX_CONTEXT_LENGTH = 4000;
const MAX_CONTEXT_TOKENS = estimateContextTokens("x".repeat(MAX_CONTEXT_LENGTH));

type EnrichInput = {
  sessionId: string;
  files: string[];
  terms?: string[];
  toolName?: string;
  project?: string;
  explain?: boolean;
  includeReport?: boolean;
};

type EnrichResult = {
  context: string;
  truncated: boolean;
  budgetReport?: ContextBudgetReport;
};

function rankedEvidence(
  id: string,
  sourceType: RankedEvidence["sourceType"],
  rank: number,
  content: string,
  reasons: string[],
  sourceIds?: string[],
): RankedEvidence {
  return {
    id,
    sourceType,
    rank,
    content,
    sourceIds,
    reasons,
    tokens: estimateContextTokens(content),
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function registerEnrichFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::enrich",
    async (data: EnrichInput): Promise<EnrichResult> => {
      const includeReport =
        data.includeReport === true || data.explain === true;
      const project =
        typeof data.project === "string" && data.project.trim().length > 0
          ? data.project.trim()
          : undefined;

      const evidence: RankedEvidence[] = [];

      const fileContextPromise = sdk
        .trigger<{ sessionId: string; files: string[] }, { context: string }>({
          function_id: "mem::file-context",
          payload: {
            sessionId: data.sessionId,
            files: data.files,
          },
        })
        .catch(() => ({ context: "" }));

      const searchQueries: string[] = [
        ...data.files.map((f) => f.split("/").pop() || f),
        ...(data.terms || []),
      ].filter((q) => q.length > 0);

      const searchPromise =
        searchQueries.length > 0
          ? sdk
              .trigger<
                { query: string; limit: number; project?: string },
                { results: Array<{ observation: { narrative: string } }> }
              >({
                function_id: "mem::search",
                payload: {
                  query: searchQueries.join(" "),
                  limit: 5,
                  ...(project !== undefined && { project }),
                },
              })
              .catch(() => ({ results: [] }))
          : Promise.resolve({ results: [] });

      const bugMemoriesPromise = kv
        .list<Memory>(KV.memories)
        .then((memories) =>
          memories
            .filter(
              (m) =>
                m.type === "bug" &&
                m.isLatest &&
                // Guard only when both sides have an explicit project; unscoped memories pass through.
                (!project || !m.project || m.project === project) &&
                m.files.some((f) =>
                  data.files.some((df) => f.includes(df) || df.includes(f)),
                ),
            )
            .sort(
              (a, b) =>
                new Date(b.updatedAt || b.createdAt).getTime() -
                new Date(a.updatedAt || a.createdAt).getTime(),
            ),
        )
        .catch(() => []);

      const [fileContext, searchResult, bugMemories] = await Promise.all([
        fileContextPromise,
        searchPromise,
        bugMemoriesPromise,
      ]);

      if (fileContext.context) {
        evidence.push(
          rankedEvidence(
            "file_context",
            "context",
            evidence.length + 1,
            fileContext.context,
            ["file_context"],
          ),
        );
      }

      if (searchResult.results.length > 0) {
        const observations = searchResult.results
          .map((r) => r.observation?.narrative)
          .filter(Boolean)
          .map((n) => escapeXml(n as string))
          .join("\n");
        if (observations) {
          const content = `<agentmemory-relevant-context>\n${observations}\n</agentmemory-relevant-context>`;
          evidence.push(
            rankedEvidence(
              "relevant_context",
              "observation",
              evidence.length + 1,
              content,
              ["search_result"],
            ),
          );
        }
      }

      if (bugMemories.length > 0) {
        const bugs = bugMemories
          .slice(0, 3)
          .map((m) => `- ${escapeXml(m.title)}: ${escapeXml(m.content)}`)
          .join("\n");
        const content = `<agentmemory-past-errors>\n${bugs}\n</agentmemory-past-errors>`;
        evidence.push(
          rankedEvidence(
            "past_errors",
            "memory",
            evidence.length + 1,
            content,
            ["bug_memory"],
            bugMemories.slice(0, 3).map((m) => m.id),
          ),
        );
      }

      const packed = packContext({
        evidence,
        budgetTokens: MAX_CONTEXT_TOKENS,
        separator: "\n\n",
      });
      const fullContext = evidence.map((item) => item.content).join("\n\n");
      let context = packed.context;
      let truncated = packed.budgetReport.ignoredCount > 0;
      if (truncated) {
        context = fullContext.slice(0, MAX_CONTEXT_LENGTH);
      }
      if (context.length > MAX_CONTEXT_LENGTH) {
        context = context.slice(0, MAX_CONTEXT_LENGTH);
        truncated = true;
      }

      logger.info("Enrichment completed", {
        sessionId: data.sessionId,
        project,
        fileCount: data.files.length,
        contextLength: context.length,
        truncated,
      });

      const response: EnrichResult = { context, truncated };
      if (includeReport) response.budgetReport = packed.budgetReport;
      return response;
    },
  );
}
