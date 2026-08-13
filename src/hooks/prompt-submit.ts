#!/usr/bin/env node
import { buildLineage, eventFields, safeString } from "./_lineage.js";
import { deliverHookRequests } from "./_delivery.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

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
  const lineage = buildLineage(data, "prompt_submit", { sessionId });

  await deliverHookRequests({
    restUrl: REST_URL,
    secret: SECRET,
    requests: [{
      path: "/agentmemory/observe",
      kind: "observation",
      body: {
        hookType: "prompt_submit",
        ...eventFields(lineage),
        timestamp: new Date().toISOString(),
        data: { prompt: safeString(data.prompt ?? data.userPrompt, 20_000), lineage },
      },
    }],
  });
}

main();
