import type { z } from "zod";
import type { EvalResult } from "../types.js";

export type ReleaseGateStatus = "pass" | "fail" | "blocked" | "not_run";

const RELEASE_GATE_STATUSES = new Set<ReleaseGateStatus>([
  "pass",
  "fail",
  "blocked",
  "not_run",
]);

const SECRET_PATTERNS = [
  { name: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_secret_key", pattern: /sk-[A-Za-z0-9_-]{32,}/g },
  { name: "github_token", pattern: /gh[pousr]_[A-Za-z0-9_]{30,}/g },
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
];

export function isReleaseGateStatus(value: unknown): value is ReleaseGateStatus {
  return typeof value === "string" && RELEASE_GATE_STATUSES.has(value as ReleaseGateStatus);
}

export function findPotentialSecretLeaks(value: unknown): string[] {
  const text =
    typeof value === "string"
      ? value
      : value === undefined || value === null
        ? ""
        : JSON.stringify(value);
  if (!text) return [];
  const matches = new Set<string>();
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) matches.add(name);
  }
  return [...matches].sort();
}

export function validateInput<T>(
  schema: z.ZodType<T>,
  data: unknown,
  functionId: string,
): { valid: true; data: T } | { valid: false; result: EvalResult } {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { valid: true, data: parsed.data };
  }
  return {
    valid: false,
    result: {
      valid: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      qualityScore: 0,
      latencyMs: 0,
      functionId,
    },
  };
}

export function validateOutput<T>(
  schema: z.ZodType<T>,
  data: unknown,
  functionId: string,
): { valid: true; data: T } | { valid: false; result: EvalResult } {
  return validateInput(schema, data, functionId);
}
