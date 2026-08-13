export const LONG_RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

export const WORK_QUEUES = {
  compression: "agentmemory-compression",
  sessionLifecycle: "agentmemory-session-lifecycle",
  graphExtraction: "agentmemory-graph-extraction",
  slotReflection: "agentmemory-slot-reflection",
} as const;

export function positiveTimeoutMs(
  raw: string | null | undefined,
  fallback = LONG_RUNNING_TIMEOUT_MS,
): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
