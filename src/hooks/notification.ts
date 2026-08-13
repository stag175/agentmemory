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
  const notificationType = data.notification_type ?? data.notificationType;
  if (notificationType !== "permission_prompt") return;

  const rawSessionId = data.session_id ?? data.sessionId;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : "unknown";
  const lineage = buildLineage(data, "notification", { sessionId });

  await deliverHookRequests({
    restUrl: REST_URL,
    secret: SECRET,
    requests: [{
      path: "/agentmemory/observe",
      kind: "observation",
      body: {
        hookType: "notification",
        ...eventFields(lineage),
        timestamp: new Date().toISOString(),
        data: {
          notification_type: notificationType,
          title: safeString(data.title),
          message: safeString(data.message),
          lineage,
        },
      },
    }],
  });
}

main();
