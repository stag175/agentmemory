#!/usr/bin/env node

import { buildLineage, eventFields, sendAgentEvent } from "./_lineage.js";
import { deliverHookRequests } from "./_delivery.js";

// Inlined — see src/hooks/sdk-guard.ts for canonical version. Kept local
// per-hook so tsdown does not emit a shared hashed chunk that would churn
// the diff on every rebuild.
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

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

  if (isSdkChildContext(data)) {
    // Do not summarize from inside a Claude Agent SDK child session;
    // would re-enter agent-sdk provider and loop (see sdk-guard.ts).
    return;
  }

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const lineage = buildLineage(data, "stop", { sessionId });
  const fields = eventFields(lineage);
  const headers = authHeaders();

  await Promise.all([
    deliverHookRequests({
      restUrl: REST_URL,
      secret: SECRET,
      requests: [{
        path: "/agentmemory/summarize",
        kind: "session_summary_request",
        body: { ...fields, sessionId, async: true },
      }],
    }),
    sendAgentEvent(REST_URL, headers, {
      type: "custom",
      status: "ok",
      ...fields,
      functionId: "plugin::stop",
      metadata: {
        hookType: "stop",
        summarizeRequested: true,
        summarizeQueued: true,
        sessionEndRequested: false,
      },
    }),
  ]);
}

main();
