import type {
  CompactLessonResult,
  CompactSearchResult,
  ContextBlock,
  HybridSearchResult,
  PackedContext,
  QueryPlan,
  RankedEvidence,
  RetrievalMode,
  RetrievalQuery,
  SearchMode,
} from "../types.js";

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function normalizeSearchMode(value: unknown): SearchMode {
  return value === "fast" || value === "deep" ? value : "balanced";
}

export function normalizeRetrievalMode(value: unknown): RetrievalMode {
  return value === "local_graph" ||
    value === "global_community" ||
    value === "drift" ||
    value === "as_of"
    ? value
    : "basic";
}

export function buildQueryPlan(opts: {
  query?: string;
  searchMode?: unknown;
  retrievalMode?: unknown;
  streams: string[];
  filterStage: string;
  hardFilters?: Record<string, unknown>;
  requestedLimit?: number;
  overFetchLimit?: number;
  tokenBudget?: number;
  temporalFilter?: Record<string, unknown>;
  prefilter?: QueryPlan["prefilter"];
  warnings?: string[];
  mode?: QueryPlan["mode"];
}): QueryPlan {
  const hardFilters = opts.temporalFilter
    ? {
        ...(opts.hardFilters ?? {}),
        temporalValidity: opts.temporalFilter,
      }
    : opts.hardFilters;
  return {
    mode: opts.mode ?? "search",
    retrievalMode: normalizeRetrievalMode(opts.retrievalMode),
    searchMode: normalizeSearchMode(opts.searchMode),
    streams: opts.streams,
    filterStage: opts.filterStage,
    hardFilters,
    limits: {
      requested: opts.requestedLimit,
      overFetch: opts.overFetchLimit,
      tokenBudget: opts.tokenBudget,
    },
    prefilter: opts.prefilter,
    warnings: opts.warnings,
  };
}

export function retrievalQueryFromPlan(opts: {
  query?: string;
  searchMode?: unknown;
  retrievalMode?: unknown;
  limit?: number;
  tokenBudget?: number;
  filters?: RetrievalQuery["filters"];
}): RetrievalQuery {
  return {
    query: opts.query,
    searchMode: normalizeSearchMode(opts.searchMode),
    retrievalMode: normalizeRetrievalMode(opts.retrievalMode),
    limit: opts.limit,
    tokenBudget: opts.tokenBudget,
    filters: opts.filters,
  };
}

function communityKey(evidence: RankedEvidence): string {
  const metadata = evidence.metadata ?? {};
  const explicit = metadata.communityId ?? metadata.community ?? metadata.concept;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (evidence.graphContext?.trim()) return evidence.graphContext.trim().slice(0, 80);
  if (evidence.title?.trim()) return evidence.title.trim().split(/\s+/).slice(0, 3).join(" ");
  return evidence.sourceType;
}

function compactSnippet(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 3).trimEnd()}...`;
}

export function buildCommunitySummaries(
  evidence: RankedEvidence[],
  opts: { limit?: number; minMembers?: number } = {},
): RankedEvidence[] {
  const minMembers = Math.max(1, Math.floor(opts.minMembers ?? 1));
  const limit = Math.max(1, Math.floor(opts.limit ?? (evidence.length || 1)));
  const groups = new Map<string, RankedEvidence[]>();

  for (const item of evidence) {
    const key = communityKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length >= minMembers)
    .map(([key, members]) => {
      const sorted = [...members].sort((a, b) => {
        const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
        return scoreDelta !== 0 ? scoreDelta : a.rank - b.rank;
      });
      const sourceIds = [
        ...new Set(
          sorted.flatMap((item) =>
            item.sourceIds && item.sourceIds.length > 0 ? item.sourceIds : [item.id],
          ),
        ),
      ];
      const score =
        sorted.reduce((sum, item) => sum + (item.score ?? 0), 0) / sorted.length;
      const snippets = sorted
        .slice(0, 4)
        .map((item) => `- ${item.id}: ${compactSnippet(item.content)}`)
        .join("\n");
      return {
        id: `community_${key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "default"}`,
        sourceType: "community_summary" as const,
        rank: 0,
        title: `Community: ${key}`,
        content: `Community summary for ${key}\nSources:\n${snippets}`,
        score,
        sourceIds,
        reasons: ["global_community", "community_summary"],
        tokens: estimateContextTokens(snippets) + estimateContextTokens(key) + 8,
        metadata: {
          communityId: key,
          memberCount: sorted.length,
          sourceEvidenceIds: sorted.map((item) => item.id),
          provenance: sourceIds,
        },
      };
    })
    .sort((a, b) => {
      const sizeDelta =
        Number(b.metadata?.memberCount ?? 0) - Number(a.metadata?.memberCount ?? 0);
      const scoreDelta = (b.score ?? 0) - (a.score ?? 0);
      return sizeDelta !== 0 ? sizeDelta : scoreDelta;
    })
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function reasonsForScores(result: HybridSearchResult): string[] {
  return [
    result.bm25Score > 0 ? "keyword_match" : undefined,
    result.vectorScore > 0 ? "semantic_match" : undefined,
    result.graphScore > 0 ? "graph_match" : undefined,
  ].filter((reason): reason is string => Boolean(reason));
}

export function hybridResultToRankedEvidence(
  result: HybridSearchResult,
  index: number,
): RankedEvidence {
  return {
    id: result.observation.id,
    sourceType: "observation",
    rank: index + 1,
    title: result.observation.title,
    content: result.observation.narrative || result.observation.title || "",
    sessionId: result.sessionId,
    timestamp: result.observation.timestamp,
    score: result.combinedScore,
    sourceIds: [result.observation.id],
    reasons: reasonsForScores(result),
    components: {
      bm25: result.bm25Score,
      vector: result.vectorScore,
      graph: result.graphScore,
    },
    graphContext: result.graphContext,
    tokens: estimateContextTokens(
      result.observation.narrative || result.observation.title || "",
    ),
  };
}

export function compactSearchToRankedEvidence(
  result: CompactSearchResult,
  index: number,
): RankedEvidence {
  const content = result.title;
  return {
    id: result.obsId,
    sourceType: "observation",
    rank: index + 1,
    title: result.title,
    content,
    sessionId: result.sessionId,
    timestamp: result.timestamp,
    score: result.score,
    sourceIds: [result.obsId],
    reasons: ["compact_search_result"],
    tokens: estimateContextTokens(content),
  };
}

export function lessonToRankedEvidence(
  lesson: CompactLessonResult,
  index: number,
): RankedEvidence {
  return {
    id: lesson.lessonId,
    sourceType: "lesson",
    rank: index + 1,
    content: lesson.content,
    timestamp: lesson.createdAt,
    score: lesson.score,
    sourceIds: [lesson.lessonId],
    reasons: ["lesson_recall"],
    tokens: estimateContextTokens(lesson.content),
    metadata: {
      confidence: lesson.confidence,
      project: lesson.project,
      tags: lesson.tags,
    },
  };
}

export function contextBlockToRankedEvidence(
  block: ContextBlock,
  index: number,
): RankedEvidence {
  return {
    id: block.sourceIds?.[0] ?? `context_${index + 1}`,
    sourceType: block.type,
    rank: index + 1,
    content: block.content,
    timestamp: Number.isFinite(block.recency)
      ? new Date(block.recency).toISOString()
      : undefined,
    sourceIds: block.sourceIds,
    reasons: [`${block.type}_context`],
    tokens: block.tokens,
  };
}

export function formatEvidenceForContext(
  evidence: RankedEvidence,
  explain = false,
): string {
  if (!explain) return evidence.content;
  const source = [
    `rank=${evidence.rank}`,
    `type=${evidence.sourceType}`,
    evidence.score !== undefined ? `score=${evidence.score.toFixed(4)}` : undefined,
    evidence.reasons.length > 0 ? `why=${evidence.reasons.join(",")}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `<memory-source ${source}>\n${evidence.content}\n</memory-source>`;
}

export function packContext(opts: {
  evidence: RankedEvidence[];
  budgetTokens: number;
  header?: string;
  footer?: string;
  separator?: string;
  explain?: boolean;
}): PackedContext {
  const header = opts.header ?? "";
  const footer = opts.footer ?? "";
  const separator = opts.separator ?? "\n\n";
  const headerTokens = estimateContextTokens(header) + estimateContextTokens(footer);
  const budgetTokens = Math.max(1, Math.floor(opts.budgetTokens));
  let usedTokens = headerTokens;
  const selected: RankedEvidence[] = [];
  const ignored: RankedEvidence[] = [];
  const ignoredReport: PackedContext["budgetReport"]["ignored"] = [];

  for (const evidence of opts.evidence) {
    const content = formatEvidenceForContext(evidence, opts.explain);
    const contentTokens = estimateContextTokens(content);
    const tokens = Math.max(evidence.tokens ?? 0, contentTokens);
    const separatorTokens =
      selected.length > 0 ? estimateContextTokens(separator) : 0;
    if (!content.trim()) {
      ignored.push(evidence);
      ignoredReport.push({
        id: evidence.id,
        rank: evidence.rank,
        tokens,
        reason: "empty_content",
      });
      continue;
    }
    if (usedTokens + separatorTokens + tokens > budgetTokens) {
      ignored.push(evidence);
      ignoredReport.push({
        id: evidence.id,
        rank: evidence.rank,
        tokens,
        reason: "token_budget_exceeded",
      });
      continue;
    }
    selected.push({ ...evidence, content, tokens });
    usedTokens += separatorTokens + tokens;
  }

  const body = selected.map((evidence) => evidence.content).join(separator);
  const context =
    selected.length > 0
      ? [header, body, footer].filter((part) => part.length > 0).join("\n")
      : "";

  return {
    context,
    selected,
    ignored,
    budgetReport: {
      budgetTokens,
      usedTokens: selected.length > 0 ? usedTokens : 0,
      headerTokens,
      selectedCount: selected.length,
      ignoredCount: ignored.length,
      selectedIds: selected.map((evidence) => evidence.id),
      ignored: ignoredReport,
    },
    tokens: selected.length > 0 ? usedTokens : 0,
    blocks: selected.length,
  };
}
