#!/usr/bin/env node

import { deliverHookRequests, type HookDeliveryRequest } from "./_delivery.js";

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
  const requests: HookDeliveryRequest[] = [{
    path: "/agentmemory/session/end",
    kind: "session_end",
    body: {
      sessionId,
      captureSource: "automatic_hook",
      hookType: "session_end",
    },
  }];

  if (process.env["CONSOLIDATION_ENABLED"] === "true") {
    requests.push(
      {
        path: "/agentmemory/crystals/auto",
        kind: "auto_crystallize_request",
        body: { olderThanDays: 0, async: true },
      },
      {
        path: "/agentmemory/consolidate-pipeline",
        kind: "consolidation_request",
        body: { tier: "all", force: true, async: true },
      },
    );
  }

  if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") {
    requests.push({
      path: "/agentmemory/claude-bridge/sync",
      kind: "claude_bridge_sync",
      body: {},
    });
  }

  await deliverHookRequests({ restUrl: REST_URL, secret: SECRET, requests });
}

main();
