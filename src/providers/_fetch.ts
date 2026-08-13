import { getEnvVar } from "../config.js";
import { LONG_RUNNING_TIMEOUT_MS, positiveTimeoutMs } from "../backpressure.js";

export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const ms =
    timeoutMs !== undefined
      ? positiveTimeoutMs(String(timeoutMs))
      : positiveTimeoutMs(
          getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS"),
          LONG_RUNNING_TIMEOUT_MS,
        );

  const ctl = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctl.signal])
    : ctl.signal;
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal }).finally(() => clearTimeout(t));
}
