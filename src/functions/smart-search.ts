import type { ISdk } from "iii-sdk";
import type {
  CompactLessonResult,
  CompactSearchResult,
  CompressedObservation,
  HybridSearchResult,
  Lesson,
  Memory,
  MemoryLane,
  MemoryPrivacyScope,
  QueryPlan,
  RankedEvidence,
  RetrievalMode,
  SearchBackendOptions,
  SearchMode,
  Session,
} from "../types.js";
import {
  buildQueryPlan,
  buildCommunitySummaries,
  hybridResultToRankedEvidence,
  normalizeRetrievalMode,
  normalizeSearchMode,
  packContext,
} from "../retrieval/context-router.js";
import { KV } from "../state/schema.js";
import {
  defaultMemoryLane,
  isMemorySearchable,
  isMemoryTemporallyCompatible,
  normalizeMemoryLane,
  normalizeMemoryPrivacyScope,
  normalizeTemporalValidityFilter,
  temporalValidityHardFilter,
  type TemporalValidityFilter,
} from "../state/memory-utils.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAccessBatch } from "./access-tracker.js";
import {
  getAgentId,
  getEnvVar,
  isAgentScopeIsolated,
  getFollowupWindowSeconds,
} from "../config.js";
import { logger } from "../logger.js";
import { getCounters } from "../telemetry/setup.js";

// #771: smart-search followup-rate diagnostic. Stored per session as
// the most recent search payload, used to detect whether the next
// search inside the window had a disjoint result set. sessionId is
// duplicated into the row so the hourly sweep can delete by it
// (StateKV.list returns values only).
export interface RecentSearch {
  sessionId: string;
  query: string;
  resultIds: string[];
  at: number;
}

// Module-scope counter mirror so `mem::diagnostic::followup-stats` can
// read the rate back without going through the OTEL collector. The
// OTEL counter is still the canonical export; this is an in-process
// convenience for `agentmemory status` + tests.
const followupStats = {
  followupWithinWindow: 0,
  agentInitiatedSearches: 0,
};

// Tracks the in-flight detection promises so tests (and shutdown
// flushes) can wait for all queued lock bodies to drain. The Set adds
// when a detection is queued and removes when it settles; size === 0
// means no pending detections.
const pendingFollowups = new Set<Promise<void>>();

export function getFollowupStats(): {
  followupWithinWindow: number;
  agentInitiatedSearches: number;
  rate: number;
} {
  const total = followupStats.agentInitiatedSearches;
  return {
    ...followupStats,
    rate: total > 0 ? followupStats.followupWithinWindow / total : 0,
  };
}

export async function flushPendingFollowups(): Promise<void> {
  // Snapshot the current pending set; new detections queued after the
  // snapshot run in a fresh batch.
  await Promise.all(Array.from(pendingFollowups));
}

export function resetFollowupStatsForTests(): void {
  followupStats.followupWithinWindow = 0;
  followupStats.agentInitiatedSearches = 0;
}

// Compact mode trims each lesson's content for at-a-glance display. The
// full content is fetched via memory_lesson_recall when the caller needs it.
const LESSON_CONTENT_PREVIEW_CHARS = 240;

// Accepted values for the memoryTier / privacyScope filters, used only
// to build the validation-error message. normalizeMemoryLane() and
// normalizeMemoryPrivacyScope() remain the source of truth for what is
// actually accepted; these lists are kept in sync with them.
const MEMORY_LANE_VALUES: MemoryLane[] = [
  "episode",
  "semantic_fact",
  "procedure",
  "reflection",
  "artifact_index",
];
const MEMORY_PRIVACY_SCOPE_VALUES: MemoryPrivacyScope[] = [
  "user",
  "project",
  "team",
  "agent",
  "temporary",
];

type SmartSearchFilters = {
  agentId?: string;
  project?: string;
  cwd?: string;
  branch?: string;
  commit?: string;
  files: string[];
  memoryTier?: MemoryLane;
  privacyScope?: MemoryPrivacyScope;
  temporal?: TemporalValidityFilter;
};

type CandidateMeta = {
  project?: string;
  cwd?: string;
  agentId?: string;
  files: string[];
  branch?: string;
  commit?: string;
  commitShas: string[];
  memory?: Memory;
  session?: Session;
};

type PrefilterPlan = {
  active: boolean;
  candidateIds?: Set<string>;
  scannedMemories: number;
  scannedSessions: number;
  scannedObservations: number;
};

type LessonScope = {
  project?: string;
  agentId?: string;
  isolated: boolean;
};

type AgentScopedLesson = Lesson & { score?: number; agentId?: unknown };

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function authoritativeSessionId(result: HybridSearchResult): string {
  return result.observation.sessionId || result.sessionId;
}

function searchCandidateKey(obsId: string, sessionId: string): string {
  return `${sessionId}\0${obsId}`;
}

function normalizeHybridSessionId(result: HybridSearchResult): HybridSearchResult {
  const sessionId = authoritativeSessionId(result);
  return sessionId === result.sessionId ? result : { ...result, sessionId };
}

function hasHardFilters(filters: SmartSearchFilters): boolean {
  return !!(
    filters.agentId ||
    filters.project ||
    filters.cwd ||
    filters.branch ||
    filters.commit ||
    filters.files.length > 0 ||
    filters.memoryTier ||
    filters.privacyScope ||
    filters.temporal
  );
}

async function candidateMeta(
  kv: StateKV,
  result: HybridSearchResult,
): Promise<CandidateMeta> {
  const memory = await kv
    .get<Memory>(KV.memories, result.observation.id)
    .catch(() => null);
  if (memory) {
    return {
      project: memory.project,
      agentId: memory.agentId,
      files: memory.files ?? [],
      branch: memory.branch,
      commit: memory.commit,
      commitShas: memory.commit ? [memory.commit] : [],
      memory,
    };
  }

  const sessionId = authoritativeSessionId(result);
  const session = await kv
    .get<Session>(KV.sessions, sessionId)
    .catch(() => null);
  return {
    project: session?.project,
    cwd: session?.cwd,
    agentId: result.observation.agentId,
    files: result.observation.files ?? [],
    commitShas: session?.commitShas ?? [],
    session: session ?? undefined,
  };
}

function matchesFilters(meta: CandidateMeta, filters: SmartSearchFilters): boolean {
  if (filters.agentId && meta.agentId !== filters.agentId) return false;
  if (filters.project && meta.project !== filters.project) return false;
  if (filters.cwd && meta.cwd !== filters.cwd) return false;
  if (filters.files.length > 0) {
    const haystack = new Set(meta.files);
    const hasFile = filters.files.some((f) => haystack.has(f));
    if (!hasFile) return false;
  }
  if (filters.branch && meta.branch !== filters.branch) return false;
  if (filters.commit) {
    const matchesCommit =
      meta.commit === filters.commit || meta.commitShas.includes(filters.commit);
    if (!matchesCommit) return false;
  }
  if (filters.memoryTier) {
    if (!meta.memory) return false;
    if ((meta.memory.lane ?? defaultMemoryLane(meta.memory.type)) !== filters.memoryTier) {
      return false;
    }
  }
  if (filters.privacyScope) {
    if (!meta.memory) return false;
    if ((meta.memory.privacyScope ?? "project") !== filters.privacyScope) {
      return false;
    }
  }
  if (meta.memory) {
    if (!isMemorySearchable(meta.memory)) return false;
    if (!isMemoryTemporallyCompatible(meta.memory, filters.temporal)) {
      return false;
    }
  }
  return true;
}

function buildHardFilters(filters: SmartSearchFilters): Record<string, unknown> {
  return {
    agentId: filters.agentId,
    project: filters.project,
    cwd: filters.cwd,
    branch: filters.branch,
    commit: filters.commit,
    files: filters.files,
    memoryTier: filters.memoryTier,
    privacyScope: filters.privacyScope,
  };
}

function filterStage(active: boolean, temporal?: TemporalValidityFilter): string {
  if (!active) return "none";
  return temporal
    ? "pre-ranking candidate allowlist plus temporal validity post-filter safety check"
    : "pre-ranking candidate allowlist plus post-filter safety check";
}

function memoryTokens(memory: Memory): Set<string> {
  return new Set(
    [memory.title, memory.content, ...(memory.concepts ?? []), ...(memory.files ?? [])]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((token) => token.length > 2),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function normalizeTokenBudget(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function memoryMatchesDriftScope(memory: Memory, filters: SmartSearchFilters): boolean {
  if (filters.agentId && memory.agentId !== filters.agentId) return false;
  if (filters.project && memory.project !== filters.project) return false;
  if (filters.branch && memory.branch !== filters.branch) return false;
  if (filters.commit && memory.commit !== filters.commit) return false;
  if (filters.memoryTier && (memory.lane ?? defaultMemoryLane(memory.type)) !== filters.memoryTier) {
    return false;
  }
  if (filters.privacyScope && (memory.privacyScope ?? "project") !== filters.privacyScope) {
    return false;
  }
  if (filters.files.length > 0) {
    const haystack = new Set((memory.files ?? []).map((file) => file.toLowerCase()));
    const wanted = filters.files.map((file) => file.toLowerCase());
    if (!wanted.some((file) => haystack.has(file))) return false;
  }
  return true;
}

function memoryRelationReasons(current: Memory, candidate: Memory): string[] {
  const reasons = new Set<string>();
  if ((current.supersedes ?? []).includes(candidate.id)) reasons.add("superseded_by_current");
  if ((candidate.supersedes ?? []).includes(current.id)) reasons.add("supersedes_current");
  const currentSources = new Set(current.sourceObservationIds ?? []);
  if ((candidate.sourceObservationIds ?? []).some((id) => currentSources.has(id))) {
    reasons.add("shared_source");
  }
  const currentConcepts = new Set((current.concepts ?? []).map((concept) => concept.toLowerCase()));
  if ((candidate.concepts ?? []).some((concept) => currentConcepts.has(concept.toLowerCase()))) {
    reasons.add("shared_concept");
  }
  const overlap = tokenOverlap(memoryTokens(current), memoryTokens(candidate));
  if (overlap >= 0.35) reasons.add("high_text_overlap");
  const state = candidate.lifecycleState ?? "active";
  if (candidate.isLatest === false || state === "superseded") reasons.add("stale_candidate");
  if (candidate.validFrom || candidate.validUntil || (candidate as { expiresAt?: string }).expiresAt || candidate.forgetAfter) {
    reasons.add("temporal_boundary");
  }
  return [...reasons];
}

async function buildDriftEvidence(
  kv: StateKV,
  opts: {
    query?: string;
    filters: SmartSearchFilters;
    results: HybridSearchResult[];
  },
): Promise<RankedEvidence[]> {
  const resultIds = new Set(opts.results.map((result) => result.observation.id));
  if (resultIds.size === 0) return [];
  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  const scoped = memories.filter((memory) => memoryMatchesDriftScope(memory, opts.filters));
  const byId = new Map(scoped.map((memory) => [memory.id, memory]));
  const selected = [...resultIds]
    .map((id) => byId.get(id))
    .filter((memory): memory is Memory => Boolean(memory));

  return selected.flatMap((memory) => {
    const related = scoped
      .filter((candidate) => candidate.id !== memory.id)
      .map((candidate) => ({
        memory: candidate,
        reasons: memoryRelationReasons(memory, candidate),
      }))
      .filter((entry) => entry.reasons.length > 0)
      .sort((a, b) => {
        const scoreDelta = b.reasons.length - a.reasons.length;
        if (scoreDelta !== 0) return scoreDelta;
        return String(b.memory.updatedAt).localeCompare(String(a.memory.updatedAt));
      })
      .slice(0, 5);
    const currentReasons = memoryRelationReasons(memory, memory).filter(
      (reason) => reason === "temporal_boundary",
    );
    if (related.length === 0 && currentReasons.length === 0) return [];
    const lines = [
      `Drift report for ${memory.title || memory.id}`,
      ...related.map((entry) =>
        `- ${entry.memory.id}: ${entry.memory.title || entry.memory.type} (${entry.reasons.join(", ")})`,
      ),
      ...currentReasons.map((reason) => `- ${memory.id}: current memory has ${reason}`),
    ];
    return [{
      id: `drift_${memory.id}`,
      sourceType: "summary" as const,
      rank: 0,
      title: `Drift: ${memory.title || memory.id}`,
      content: lines.join("\n"),
      score: related.length + currentReasons.length,
      sourceIds: [memory.id, ...related.map((entry) => entry.memory.id)],
      reasons: ["drift", "memory_relation_review"],
      tokens: Math.ceil(lines.join("\n").length / 3),
      metadata: {
        query: opts.query,
        memoryId: memory.id,
        relatedCount: related.length,
        related: related.map((entry) => ({
          id: entry.memory.id,
          reasons: entry.reasons,
          lifecycleState: entry.memory.lifecycleState ?? "active",
          isLatest: entry.memory.isLatest !== false,
          updatedAt: entry.memory.updatedAt,
        })),
      },
    }];
  });
}

async function buildCandidatePrefilter(
  kv: StateKV,
  filters: SmartSearchFilters,
): Promise<PrefilterPlan> {
  if (!hasHardFilters(filters)) {
    return {
      active: false,
      scannedMemories: 0,
      scannedSessions: 0,
      scannedObservations: 0,
    };
  }

  const candidateIds = new Set<string>();
  let scannedMemories = 0;
  let scannedSessions = 0;
  let scannedObservations = 0;

  const memories = await kv.list<Memory>(KV.memories).catch(() => []);
  for (const memory of memories) {
    scannedMemories++;
    const meta: CandidateMeta = {
      project: memory.project,
      cwd: undefined,
      agentId: memory.agentId,
      files: memory.files ?? [],
      branch: memory.branch,
      commit: memory.commit,
      commitShas: memory.commit ? [memory.commit] : [],
      memory,
    };
    if (matchesFilters(meta, filters)) {
      candidateIds.add(searchCandidateKey(memory.id, memory.sessionIds?.[0] ?? "memory"));
    }
  }

  const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
  for (const session of sessions) {
    scannedSessions++;
    const observations = await kv
      .list<CompressedObservation>(KV.observations(session.id))
      .catch(() => []);
    for (const observation of observations) {
      scannedObservations++;
      const meta: CandidateMeta = {
        project: session.project,
        cwd: session.cwd,
        agentId: observation.agentId,
        files: observation.files ?? [],
        commitShas: session.commitShas ?? [],
        session,
      };
      if (matchesFilters(meta, filters)) {
        candidateIds.add(searchCandidateKey(observation.id, observation.sessionId || session.id));
      }
    }
  }

  return {
    active: true,
    candidateIds,
    scannedMemories,
    scannedSessions,
    scannedObservations,
  };
}

async function applyHardFilters(
  kv: StateKV,
  results: HybridSearchResult[],
  filters: SmartSearchFilters,
): Promise<{
  results: HybridSearchResult[];
  metas: Map<string, CandidateMeta>;
  filteredOut: number;
}> {
  if (!hasHardFilters(filters)) {
    return {
      results: results.map(normalizeHybridSessionId),
      metas: new Map(),
      filteredOut: 0,
    };
  }
  const metas = new Map<string, CandidateMeta>();
  const scoped: HybridSearchResult[] = [];
  for (const result of results) {
    const meta = await candidateMeta(kv, result);
    metas.set(result.observation.id, meta);
    if (matchesFilters(meta, filters)) scoped.push(normalizeHybridSessionId(result));
  }
  return { results: scoped, metas, filteredOut: results.length - scoped.length };
}

function buildExplain(opts: {
  query?: string;
  searchMode: SearchMode;
  retrievalMode: RetrievalMode;
  filters: SmartSearchFilters;
  requestedLimit: number;
  overFetchLimit: number;
  tokenBudget?: number;
  rawHybridCount: number;
  filteredHybridCount: number;
  filteredOut: number;
  lessonsCount: number;
  results: HybridSearchResult[];
  prefilter: PrefilterPlan;
  driftEvidence?: RankedEvidence[];
}): {
  query?: string;
  searchMode: SearchMode;
  queryPlan: QueryPlan;
  rankedEvidence: RankedEvidence[];
  plan: QueryPlan;
  candidates: {
    rawHybrid: number;
    afterHardFilters: number;
    filteredOut: number;
    lessons: number;
  };
  ranking: Array<{
    rank: number;
    obsId: string;
    sessionId?: string;
    title?: string;
    combinedScore?: number;
    components?: RankedEvidence["components"];
    reasons: string[];
    graphContext?: string;
  }>;
  warnings: string[];
} {
  const hardFilters = buildHardFilters(opts.filters);
  const warnings: string[] = [];
  if (opts.filters.branch) {
    warnings.push("branch filters require branch metadata on memories; observations without branch metadata are excluded");
  }
  if (opts.filters.commit) {
    warnings.push("commit filters match memory.commit or Session.commitShas");
  }
  if (opts.retrievalMode === "as_of" && !opts.filters.temporal) {
    warnings.push("as_of retrieval mode uses asOf or validAt when supplied; no temporal filter was provided");
  }
  const streams = ["bm25", "vector", "graph", "lessons"];
  if (opts.retrievalMode === "global_community") {
    streams.push("community_summary");
  }
  if (opts.retrievalMode === "drift") {
    streams.push("drift");
  }
  const queryPlan = buildQueryPlan({
    query: opts.query,
    searchMode: opts.searchMode,
    retrievalMode: opts.retrievalMode,
    streams,
    filterStage: filterStage(opts.prefilter.active, opts.filters.temporal),
    hardFilters,
    temporalFilter: temporalValidityHardFilter(opts.filters.temporal),
    requestedLimit: opts.requestedLimit,
    overFetchLimit: opts.overFetchLimit,
    tokenBudget: opts.tokenBudget,
    prefilter: opts.prefilter.active
      ? {
          candidateCount: opts.prefilter.candidateIds?.size ?? 0,
          scannedMemories: opts.prefilter.scannedMemories,
          scannedSessions: opts.prefilter.scannedSessions,
          scannedObservations: opts.prefilter.scannedObservations,
        }
      : undefined,
    warnings,
  });
  const observationEvidence = opts.results.map(hybridResultToRankedEvidence);
  const communityEvidence = opts.retrievalMode === "global_community"
    ? buildCommunitySummaries(observationEvidence, {
        limit: Math.min(Math.max(observationEvidence.length, 1), 5),
      })
    : [];
  const prefixEvidence = [
    ...(opts.driftEvidence ?? []),
    ...communityEvidence,
  ].map((item, index) => ({ ...item, rank: index + 1 }));
  const rankedEvidence = [
    ...prefixEvidence,
    ...observationEvidence.map((item) => ({
      ...item,
      rank: item.rank + prefixEvidence.length,
    })),
  ];
  return {
    query: opts.query,
    searchMode: opts.searchMode,
    queryPlan,
    rankedEvidence,
    plan: queryPlan,
    candidates: {
      rawHybrid: opts.rawHybridCount,
      afterHardFilters: opts.filteredHybridCount,
      filteredOut: opts.filteredOut,
      lessons: opts.lessonsCount,
    },
    ranking: rankedEvidence.map((evidence) => ({
      rank: evidence.rank,
      obsId: evidence.id,
      sessionId: evidence.sessionId,
      title: evidence.title,
      combinedScore: evidence.score,
      components: evidence.components,
      reasons: evidence.reasons,
      graphContext: evidence.graphContext,
    })),
    warnings,
  };
}

export function registerSmartSearchFunction(
  sdk: ISdk,
  kv: StateKV,
  searchFn: (
    query: string,
    limit: number,
    options?: SearchBackendOptions,
  ) => Promise<HybridSearchResult[]>,
): void {
  sdk.registerFunction("mem::smart-search",
    async (data: {
      query?: string;
      expandIds?: Array<string | { obsId: string; sessionId: string }>;
      limit?: number;
      project?: string;
      cwd?: string;
      includeLessons?: boolean;
      explain?: boolean;
      searchMode?: SearchMode;
      retrievalMode?: RetrievalMode;
      files?: string[] | string;
      file?: string;
      filePath?: string;
      branch?: string;
      commit?: string;
      memoryTier?: MemoryLane;
      privacyScope?: MemoryPrivacyScope;
      asOf?: string;
      validAt?: string;
      includeReport?: boolean;
      tokenBudget?: number;
      // optional per-call agent filter for runtimes routing many
      // roles through one server. "*" opts out of the env-default
      // scope and returns hits from every agent.
      agentId?: string;
      // #771: session anchor for the followup-rate diagnostic. The
      // API trigger fills this from req.body / headers; direct
      // sdk.trigger callers can pass it explicitly.
      sessionId?: string;
      // #771: marks viewer-originated searches so the diagnostic
      // ignores them — only agent-initiated re-queries should count.
      source?: string;
    }) => {

      // Compute the agent filter once, up front. Both the expandIds
      // branch and the hybrid-search branch consult it — otherwise
      // expandIds becomes a cross-agent leak (#554 follow-up).
      //
      // #817 follow-up: fail-closed when isolated mode is on AND no
      // agent id is resolvable from any source. Silently letting
      // filterAgentId fall through to `undefined` would be the same
      // cross-agent leak this filter is meant to prevent.
      const isolated =
        isAgentScopeIsolated() ||
        getEnvVar("AGENTMEMORY_AGENT_SCOPE") === "isolated";
      const explicitAgentId =
        typeof data.agentId === "string" && data.agentId.trim().length > 0
          ? data.agentId.trim()
          : undefined;
      const wildcardAgent = explicitAgentId === "*";
      const envAgentId = isolated ? getAgentId() : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ?? envAgentId;
      const searchMode = normalizeSearchMode(data.searchMode);
      const retrievalMode = normalizeRetrievalMode(data.retrievalMode);
      const tokenBudget = normalizeTokenBudget(data.tokenBudget);
      const includeStructuredReport =
        data.explain === true || data.includeReport === true || tokenBudget !== undefined;
      // Validate enum filters up front so a typo can't silently empty
      // the result set. matchesFilters() compares the raw value with
      // strict equality, so an unrecognized memoryTier/privacyScope
      // would otherwise count as a hard filter that nothing satisfies.
      // We mirror the temporal path: a non-empty invalid value returns
      // a validation error instead of zero hits.
      const memoryTierRaw = asNonEmptyString(data.memoryTier);
      const memoryTier = normalizeMemoryLane(memoryTierRaw);
      if (memoryTierRaw && !memoryTier) {
        return {
          mode: data.expandIds && data.expandIds.length > 0 ? "expanded" : "compact",
          results: [],
          error:
            `memoryTier must be one of: ${MEMORY_LANE_VALUES.join(", ")}`,
        };
      }
      const privacyScopeRaw = asNonEmptyString(data.privacyScope);
      const privacyScope = normalizeMemoryPrivacyScope(privacyScopeRaw);
      if (privacyScopeRaw && !privacyScope) {
        return {
          mode: data.expandIds && data.expandIds.length > 0 ? "expanded" : "compact",
          results: [],
          error:
            `privacyScope must be one of: ${MEMORY_PRIVACY_SCOPE_VALUES.join(", ")}`,
        };
      }
      const filters: SmartSearchFilters = {
        agentId: filterAgentId,
        project: asNonEmptyString(data.project),
        cwd: asNonEmptyString(data.cwd),
        branch: asNonEmptyString(data.branch),
        commit: asNonEmptyString(data.commit),
        files: [
          ...parseStringList(data.files),
          ...parseStringList(data.file),
          ...parseStringList(data.filePath),
        ],
        memoryTier,
        privacyScope,
      };
      const temporal = normalizeTemporalValidityFilter({
        asOf: data.asOf,
        validAt: data.validAt,
      });
      if (temporal.error) {
        return {
          mode: data.expandIds && data.expandIds.length > 0 ? "expanded" : "compact",
          results: [],
          error: temporal.error,
        };
      }
      filters.temporal = temporal.filter;
      if (
        isolated &&
        !wildcardAgent &&
        !explicitAgentId &&
        !envAgentId
      ) {
        throw new Error(
          "mem::smart-search: AGENTMEMORY_AGENT_SCOPE=isolated is set but " +
            "no agent id is available (env AGENT_ID unset and no explicit " +
            "agentId in the call). Refusing to read cross-agent rows. " +
            'Pass agentId: "*" to opt in to a wildcard read.',
        );
      }

      if (data.expandIds && data.expandIds.length > 0) {
        const raw = data.expandIds.slice(0, 20);
        const items = raw.map((entry) => {
          if (typeof entry === "string") return { obsId: entry, sessionId: undefined as string | undefined };
          if (entry && typeof entry === "object" && typeof (entry as any).obsId === "string") {
            return { obsId: (entry as any).obsId, sessionId: (entry as any).sessionId as string | undefined };
          }
          return null;
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        const expanded: Array<{
          obsId: string;
          sessionId: string;
          observation: CompressedObservation;
        }> = [];

        const results = await Promise.all(
          items.map(({ obsId, sessionId }) =>
            findObservation(kv, obsId, sessionId).then((obs) =>
              obs ? { obsId, sessionId: obs.sessionId, observation: obs } : null,
            ),
          ),
        );
        for (const r of results) {
          if (r) expanded.push(r);
        }

        const scoped: typeof expanded = [];
        let filteredOutOfScope = 0;
        for (const entry of expanded) {
          const session = await kv
            .get<Session>(KV.sessions, entry.sessionId)
            .catch(() => null);
          const meta: CandidateMeta = {
            project: session?.project,
            cwd: session?.cwd,
            agentId: entry.observation.agentId,
            files: entry.observation.files ?? [],
            commitShas: session?.commitShas ?? [],
            session: session ?? undefined,
          };
          if (matchesFilters(meta, filters)) scoped.push(entry);
          else filteredOutOfScope++;
        }

        void recordAccessBatch(
          kv,
          scoped.map((e) => e.observation.id),
        );

        const truncated = data.expandIds.length > raw.length;
        logger.info("Smart search expanded", {
          requested: data.expandIds.length,
          attempted: raw.length,
          returned: scoped.length,
          filteredOutOfScope,
          truncated,
        });
        const response: {
          mode: "expanded";
          results: typeof scoped;
          truncated: boolean;
          explain?: unknown;
          queryPlan?: QueryPlan;
        } = { mode: "expanded", results: scoped, truncated };
        if (includeStructuredReport) {
          const queryPlan = buildQueryPlan({
            mode: "expandIds",
            searchMode,
            retrievalMode,
            streams: ["expandIds"],
            filterStage: filters.temporal
              ? "temporal validity post-filter safety check"
              : hasHardFilters(filters)
                ? "post-filter safety check"
                : "none",
            hardFilters: buildHardFilters(filters),
            temporalFilter: temporalValidityHardFilter(filters.temporal),
            requestedLimit: raw.length,
            overFetchLimit: raw.length,
            tokenBudget,
          });
          const explain = {
            searchMode,
            retrievalMode,
            queryPlan,
            plan: {
              mode: "expandIds",
              hardFilters: filters,
              attempted: raw.length,
              returned: scoped.length,
              filteredOut: filteredOutOfScope,
            },
          };
          response.queryPlan = queryPlan;
          if (data.explain) response.explain = explain;
        }
        return response;
      }

      if (!data.query || typeof data.query !== "string" || !data.query.trim()) {
        return { mode: "compact", results: [], error: "query is required" };
      }

      const limit = Math.max(1, Math.min(data.limit ?? 20, 100));
      // Lesson recall stays capped: lessons are denser than raw
      // observations so 10 covers most recall flows.
      const lessonLimit = Math.min(limit, 10);
      const includeLessons = data.includeLessons !== false;

      // Over-fetch when filtering. Hybrid search can't filter on
      // agentId (BM25/vector indexes don't carry it), so we ask the
      // searcher for more hits than we need and trim post-filter. 3×
      // is a defensible middle ground: enough headroom for a small
      // workload, capped at 300 so a 100-limit request never asks for
      // thousands of hits.
      const hardFiltering = hasHardFilters(filters);
      const modeMultiplier = searchMode === "fast" ? 2 : searchMode === "deep" ? 10 : 5;
      const overFetchLimit = hardFiltering
        ? Math.min(Math.max(limit * modeMultiplier, 100), 500)
        : searchMode === "deep"
          ? Math.min(limit * 3, 300)
          : limit;
      const prefilter = await buildCandidatePrefilter(kv, filters);
      const candidateFilter = prefilter.active
        ? (obsId: string, sessionId: string) =>
            prefilter.candidateIds?.has(searchCandidateKey(obsId, sessionId)) ?? false
        : undefined;

      const [hybridResults, lessons] = await Promise.all([
        searchFn(data.query, overFetchLimit, { candidateFilter, searchMode }),
        includeLessons
          ? recallLessons(sdk, data.query, lessonLimit, {
              project: filters.project,
              agentId: filters.agentId,
              isolated,
            })
          : Promise.resolve([]),
      ]);

      const scopedHybrid = await applyHardFilters(kv, hybridResults, filters);
      const filteredHybrid = scopedHybrid.results.slice(0, limit);

      const compact: CompactSearchResult[] = filteredHybrid.map((r) => ({
        obsId: r.observation.id,
        sessionId: r.sessionId,
        title: r.observation.title,
        type: r.observation.type,
        score: r.combinedScore,
        timestamp: r.observation.timestamp,
      }));

      void recordAccessBatch(
        kv,
        compact.map((r) => r.obsId),
      );

      // #771: followup-rate diagnostic. Only fires for agent-initiated
      // searches that carry a sessionId — viewer-originated searches
      // (source === "viewer") and direct-sdk callers without a session
      // anchor are skipped. The result-set comparison uses obsIds: a
      // disjoint set under the window suggests the previous call's
      // results were not used, which is our directional proxy for
      // reader-failure-with-evidence.
      if (
        data.sessionId &&
        typeof data.sessionId === "string" &&
        data.source !== "viewer" &&
        compact.length > 0
      ) {
        // Skip detection when retrieval returned nothing: an empty
        // result set is a retrieval failure, not a reader-failure
        // signal. Counting it as "disjoint from prior" would inflate
        // the rate every time search returns no hits.
        followupStats.agentInitiatedSearches++;
        // Off the critical response path. The withKeyedLock(sessionId)
        // call serializes detection per session, so two rapid
        // back-to-back searches from the same agent still see ordered
        // prior-row writes — the second call's lock body queues
        // behind the first's. Other sessions run in parallel.
        const sessionIdForFollowup = data.sessionId;
        const queryForFollowup = data.query;
        const compactForFollowup = compact;
        const detection = withKeyedLock(
          `recent-searches:${sessionIdForFollowup}`,
          () =>
            detectFollowup(
              kv,
              sessionIdForFollowup,
              queryForFollowup,
              compactForFollowup,
            ),
        )
          .catch((err) => {
            logger.warn("Smart search followup detection failed", {
              sessionId: sessionIdForFollowup,
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            pendingFollowups.delete(detection);
          });
        pendingFollowups.add(detection);
      }

      logger.info("Smart search compact", {
        query: data.query,
        results: compact.length,
        lessons: lessons.length,
      });
      const response: {
        mode: "compact";
        results: CompactSearchResult[];
        lessons?: CompactLessonResult[];
        explain?: unknown;
        queryPlan?: QueryPlan;
        rankedEvidence?: RankedEvidence[];
        budgetReport?: unknown;
        packedContext?: unknown;
        context?: string;
        tokens?: number;
        truncated?: boolean;
        warnings?: string[];
      } = { mode: "compact", results: compact };
      if (includeLessons) response.lessons = lessons;
      // as_of retrieval mode only takes effect when an asOf/validAt
      // anchor is supplied. Without one it silently behaves like a plain
      // search, so surface that in the normal response — not just inside
      // explain — to keep the report-only modes honest.
      if (retrievalMode === "as_of" && !filters.temporal) {
        response.warnings = [
          "as_of retrieval mode requires asOf or validAt; none was provided, so no temporal filter was applied",
        ];
      }
      if (includeStructuredReport) {
        const driftEvidence = retrievalMode === "drift"
          ? await buildDriftEvidence(kv, {
              query: data.query,
              filters,
              results: filteredHybrid,
            })
          : undefined;
        const explain = buildExplain({
          query: data.query,
          searchMode,
          retrievalMode,
          filters,
          requestedLimit: limit,
          overFetchLimit,
          tokenBudget,
          rawHybridCount: hybridResults.length,
          filteredHybridCount: scopedHybrid.results.length,
          filteredOut: scopedHybrid.filteredOut,
          lessonsCount: lessons.length,
          results: filteredHybrid,
          prefilter,
          driftEvidence,
        });
        let rankedEvidence = explain.rankedEvidence;
        if (tokenBudget !== undefined) {
          const packed = packContext({
            evidence: explain.rankedEvidence,
            budgetTokens: tokenBudget,
            header: `agentmemory smart-search: ${data.query}`,
            explain: true,
          });
          rankedEvidence = packed.selected;
          response.budgetReport = packed.budgetReport;
          response.packedContext = packed;
          response.context = packed.context;
          response.tokens = packed.tokens;
          response.truncated = packed.budgetReport.ignoredCount > 0;
          explain.rankedEvidence = rankedEvidence;
          explain.queryPlan.limits.tokenBudget = tokenBudget;
          explain.plan = explain.queryPlan;
          (explain as { budgetReport?: unknown }).budgetReport = packed.budgetReport;
          (explain as { packedContext?: unknown }).packedContext = packed;
        }
        if (data.explain) response.explain = explain;
        response.queryPlan = explain.queryPlan;
        response.rankedEvidence = rankedEvidence;
      }
      return response;
    },
  );
}

async function recallLessons(
  sdk: ISdk,
  query: string,
  limit: number,
  scope: LessonScope,
): Promise<CompactLessonResult[]> {
  if (scope.isolated && !scope.agentId) return [];
  try {
    const result = (await sdk.trigger({
      function_id: "mem::lesson-recall",
      payload: { query, limit, project: scope.project, agentId: scope.agentId },
    })) as { success?: boolean; lessons?: AgentScopedLesson[] };
    if (!result?.success || !Array.isArray(result.lessons)) return [];
    const lessons = scope.agentId
      ? result.lessons.filter((l) => l.agentId === scope.agentId)
      : result.lessons;
    return lessons.map((l) => ({
      lessonId: l.id,
      content:
        l.content.length > LESSON_CONTENT_PREVIEW_CHARS
          ? l.content.slice(0, LESSON_CONTENT_PREVIEW_CHARS) + "…"
          : l.content,
      confidence: l.confidence,
      score: l.score ?? l.confidence,
      createdAt: l.createdAt,
      project: l.project,
      tags: l.tags ?? [],
    }));
  } catch (err) {
    logger.warn("Smart search: mem::lesson-recall failed; returning empty lesson list", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function detectFollowup(
  kv: StateKV,
  sessionId: string,
  query: string,
  compact: CompactSearchResult[],
): Promise<void> {
  const now = Date.now();
  const windowMs = Math.max(1, getFollowupWindowSeconds()) * 1000;
  const currentIds = compact.map((r) => r.obsId);
  const current: RecentSearch = { sessionId, query, resultIds: currentIds, at: now };

  const prior = await kv
    .get<RecentSearch>(KV.recentSearches, sessionId)
    .catch(() => null);

  await kv.set(KV.recentSearches, sessionId, current);

  if (!prior || typeof prior.at !== "number") return;
  if (now - prior.at > windowMs) return;
  // Same query inside the window is a retry, not a follow-up; skip so a
  // duplicate request from a flaky client doesn't inflate the metric.
  if (typeof prior.query === "string" && prior.query === query) return;

  const priorIds = Array.isArray(prior.resultIds) ? prior.resultIds : [];
  const priorSet = new Set(priorIds);
  const hasOverlap = currentIds.some((id) => priorSet.has(id));
  if (hasOverlap) return;

  getCounters().smartSearchFollowupWithinWindow.add(1);
  followupStats.followupWithinWindow++;
  logger.info("Smart search followup detected", {
    sessionId,
    windowSeconds: Math.round(windowMs / 1000),
    priorQuery: prior.query,
    nextQuery: query,
    priorResultCount: priorIds.length,
    nextResultCount: currentIds.length,
  });
}

async function findObservation(
  kv: StateKV,
  obsId: string,
  sessionIdHint?: string,
): Promise<CompressedObservation | null> {
  if (sessionIdHint) {
    const obs = await kv
      .get<CompressedObservation>(KV.observations(sessionIdHint), obsId)
      .catch(() => null);
    if (obs) return obs;
  }

  const sessions = await kv.list<{ id: string }>(KV.sessions);
  for (let i = 0; i < sessions.length; i += 5) {
    const batch = sessions.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((s) =>
        kv.get<CompressedObservation>(KV.observations(s.id), obsId).catch(() => null),
      ),
    );
    const found = results.find((r) => r !== null);
    if (found) return found;
  }
  return null;
}
