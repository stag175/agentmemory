import type { Memory, MemoryReviewState } from "../types.js";
import { jaccardSimilarity } from "../state/schema.js";
import type { PrivacyScanSummary } from "./privacy.js";

export type WriteGateMode = "review" | "require_pass";

export interface WriteGateInput {
  content: string;
  type: Memory["type"];
  concepts: string[];
  files: string[];
  sourceObservationIds: string[];
  project?: string;
  lane?: Memory["lane"];
  privacyScope?: Memory["privacyScope"];
  ownerId?: string;
  branch?: string;
  commit?: string;
  sourceHash?: string;
  sourceType?: string;
  sourceUri?: string;
  agentId?: string;
  existingMemories: Memory[];
  privacySummary: PrivacyScanSummary;
}

export interface WriteGateDecision {
  version: "write_gate_v1";
  pass: boolean;
  mode: WriteGateMode;
  score: number;
  reviewState: MemoryReviewState;
  scores: {
    novelty: number;
    quality: number;
    provenance: number;
    scope: number;
    sensitivity: number;
  };
  reasons: string[];
  flags: string[];
  nearestMemoryId?: string;
  nearestSimilarity?: number;
  sensitivityLabels: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

function tokenCount(content: string): number {
  return content.split(/\s+/).filter(Boolean).length;
}

function hasSpecificSignal(content: string): boolean {
  return (
    /[`"'/:\\]/.test(content) ||
    /\b[A-Z][A-Za-z0-9]+[A-Z][A-Za-z0-9]*\b/.test(content) ||
    /\b\d+(?:\.\d+)?\b/.test(content)
  );
}

function scoreQuality(input: WriteGateInput): number {
  const tokens = tokenCount(input.content);
  const lengthScore =
    tokens < 4 ? 0.1 : tokens < 8 ? 0.45 : tokens < 18 ? 0.72 : tokens < 120 ? 1 : 0.82;
  const specificityScore = clamp01(
    (input.concepts.length > 0 ? 0.25 : 0) +
      (input.files.length > 0 ? 0.25 : 0) +
      (input.project ? 0.15 : 0) +
      (input.sourceObservationIds.length > 0 ? 0.2 : 0) +
      (input.type !== "fact" ? 0.15 : 0) +
      (hasSpecificSignal(input.content) ? 0.15 : 0),
  );
  const clarityScore = /\b(?:always|never|prefer|requires?|use|avoid|when|because|must|should)\b/i.test(
    input.content,
  )
    ? 1
    : 0.55;

  return roundScore(lengthScore * 0.45 + specificityScore * 0.35 + clarityScore * 0.2);
}

function scoreProvenance(input: WriteGateInput): number {
  return roundScore(
    (input.sourceObservationIds.length > 0 ? 0.35 : 0) +
      (input.sourceHash ? 0.2 : 0) +
      (input.sourceUri ? 0.15 : 0) +
      (input.sourceType ? 0.1 : 0) +
      (input.commit ? 0.1 : 0) +
      (input.branch ? 0.05 : 0) +
      (input.agentId ? 0.05 : 0),
  );
}

function scoreScope(input: WriteGateInput): number {
  return roundScore(
    (input.project ? 0.3 : 0) +
      (input.privacyScope ? 0.2 : 0) +
      (input.lane ? 0.15 : 0) +
      (input.ownerId ? 0.1 : 0) +
      (input.files.length > 0 ? 0.15 : 0) +
      (input.concepts.length > 0 ? 0.1 : 0),
  );
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function isTemporallyComparableMemory(
  existing: Memory,
  nowMs: number,
): boolean {
  const forgetAfterMs = timestampMs(existing.forgetAfter);
  if (forgetAfterMs !== undefined && forgetAfterMs <= nowMs) return false;

  const validFromMs = timestampMs(existing.validFrom);
  if (existing.validFrom && validFromMs === undefined) return false;
  if (validFromMs !== undefined && validFromMs > nowMs) return false;

  const validUntilMs = timestampMs(existing.validUntil);
  if (existing.validUntil && validUntilMs === undefined) return false;
  if (validUntilMs !== undefined && validUntilMs <= nowMs) return false;

  return true;
}

function isComparableMemory(
  existing: Memory,
  project: string | undefined,
  nowMs: number,
): boolean {
  if (existing.isLatest === false) return false;
  if ((existing.lifecycleState ?? "active") !== "active") return false;
  if (!existing.content.trim()) return false;
  if (project && existing.project && existing.project !== project) return false;
  if (!isTemporallyComparableMemory(existing, nowMs)) return false;
  return true;
}

function scoreNovelty(input: WriteGateInput): {
  novelty: number;
  nearestMemoryId?: string;
  nearestSimilarity?: number;
} {
  let nearestMemoryId: string | undefined;
  let nearestSimilarity = 0;
  const lowerContent = input.content.toLowerCase();
  const nowMs = Date.now();

  for (const existing of input.existingMemories) {
    if (!isComparableMemory(existing, input.project, nowMs)) continue;
    const similarity = jaccardSimilarity(lowerContent, existing.content.toLowerCase());
    if (similarity > nearestSimilarity) {
      nearestSimilarity = similarity;
      nearestMemoryId = existing.id;
    }
  }

  return {
    novelty: roundScore(1 - nearestSimilarity),
    nearestMemoryId,
    nearestSimilarity: nearestMemoryId ? roundScore(nearestSimilarity) : undefined,
  };
}

export function evaluateWriteGate(input: WriteGateInput): WriteGateDecision {
  const novelty = scoreNovelty(input);
  const quality = scoreQuality(input);
  const provenance = scoreProvenance(input);
  const scope = scoreScope(input);
  const sensitivity = input.privacySummary.redactionApplied
    ? roundScore(Math.max(0, 1 - input.privacySummary.matchCount * 0.35))
    : 1;
  const score = roundScore(
    novelty.novelty * 0.3 +
      quality * 0.3 +
      provenance * 0.12 +
      scope * 0.13 +
      sensitivity * 0.15,
  );

  const reasons: string[] = [];
  const flags: string[] = [];

  if (input.privacySummary.redactionApplied) {
    reasons.push("sensitive_content");
    flags.push("sensitivity_detected");
  }
  if (novelty.novelty < 0.3) {
    reasons.push("low_novelty");
    flags.push("near_duplicate");
  }
  if (quality < 0.45) {
    reasons.push("low_quality");
    flags.push("underspecified");
  }
  if (provenance < 0.15) {
    reasons.push("weak_provenance");
  }
  if (scope < 0.15) {
    reasons.push("weak_scope");
  }
  if (score < 0.55) {
    reasons.push("low_composite_score");
  }

  const pass =
    !input.privacySummary.redactionApplied &&
    novelty.novelty >= 0.3 &&
    quality >= 0.45 &&
    score >= 0.55;

  return {
    version: "write_gate_v1",
    pass,
    mode: "review",
    score,
    reviewState: pass ? "unreviewed" : "needs_review",
    scores: {
      novelty: novelty.novelty,
      quality,
      provenance,
      scope,
      sensitivity,
    },
    reasons: reasons.length > 0 ? Array.from(new Set(reasons)) : ["accepted"],
    flags: Array.from(new Set(flags)),
    nearestMemoryId: novelty.nearestMemoryId,
    nearestSimilarity: novelty.nearestSimilarity,
    sensitivityLabels: [...input.privacySummary.labels],
  };
}
