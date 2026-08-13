#!/usr/bin/env node
import { resolveProject } from "./_project.js";
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
  const agentId = data.agent_id || data.agentName;
  const agentType = data.agent_type || data.agentDisplayName || data.agentName;
  const lastMsg =
    typeof data.last_assistant_message === "string"
      ? data.last_assistant_message.slice(0, 4000)
      : "";

  await deliverHookRequests({
    restUrl: REST_URL,
    secret: SECRET,
    requests: [{
      path: "/agentmemory/observe",
      kind: "observation",
      body: {
        hookType: "subagent_stop",
        sessionId,
        project: resolveProject(data.cwd as string | undefined),
        cwd: (data.cwd as string | undefined) || process.cwd(),
        timestamp: new Date().toISOString(),
        data: {
          agent_id: agentId,
          agent_type: agentType,
          last_message: lastMsg,
        },
      },
    }],
  });
}

main();
