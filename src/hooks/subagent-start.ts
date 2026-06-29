#!/usr/bin/env node
import {
  buildLineage,
  eventFields,
  firstString,
  safeMetadata,
  sendAgentEvent,
  targetIdsFor,
} from "./_lineage.js";

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// Passive telemetry only — nothing reads the response, so the previous
// `await` was pure latency. Tightened from 2000ms to a defensive cap so a
// slow/unreachable server can't stack onto every concurrent subagent
// startup (#221).
const TIMEOUT_MS = 800;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (isSdkChildContext(data)) return;

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const agentId = firstString(data.agent_id, data.agentId, data.agentName);
  const agentType = firstString(
    data.agent_type,
    data.agentDisplayName,
    data.agentName,
  );
  const lineage = buildLineage(data, "subagent_start", { sessionId, agentId });
  const fields = eventFields(lineage);
  const headers = authHeaders();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      hookType: "subagent_start",
      ...fields,
      timestamp: new Date().toISOString(),
      data: {
        agent_id: lineage.agentId,
        agent_type: agentType,
        lineage,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {});

  sendAgentEvent(REST_URL, headers, {
    type: "custom",
    status: "pending",
    ...fields,
    functionId: "plugin::subagent_start",
    fromAgentId: firstString(data.parent_agent_id, data.parentAgentId),
    toAgentId: lineage.agentId,
    targetIds: targetIdsFor(lineage.agentId),
    metadata: {
      hookType: "subagent_start",
      agentType: safeMetadata(agentType),
    },
  });
  setTimeout(() => process.exit(0), 500).unref();
}

main();
