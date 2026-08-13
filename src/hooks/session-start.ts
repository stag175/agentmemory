#!/usr/bin/env node
import { buildLineage, eventFields } from "./_lineage.js";
import { resolveProject } from "./_project.js";
import { deliverHookRequests, hookDeliveryTimeoutMs } from "./_delivery.js";

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Session-start hook.
//
// Always registers the session for observation tracking (so memories
// captured on PostToolUse get attached to the right session). Only writes
// project context to stdout — which Claude Code prepends to the very first
// turn — when AGENTMEMORY_INJECT_CONTEXT=true. Default off as of 0.8.10
// (#143); see pre-tool-use.ts for the full explanation.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

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

  if (isSdkChildContext(data)) return;

  const sessionId =
    ((data.session_id || data.sessionId) as string) ||
    `ses_${Date.now().toString(36)}`;
  const cwd = (data.cwd as string) || process.cwd();
  const project = resolveProject(data.cwd as string | undefined);
  const lineage = buildLineage(data, "session_start", {
    sessionId,
    cwd,
    project,
  });

  const registration = {
    path: "/agentmemory/session/start",
    kind: "session_start",
    body: {
      ...eventFields(lineage),
      sessionId,
      project,
      cwd,
      captureSource: "automatic_hook",
      hookType: "session_start",
    },
  };
  const report = await deliverHookRequests({
    restUrl: REST_URL,
    secret: SECRET,
    requests: [registration],
  });
  if (!INJECT_CONTEXT || report.delivered === 0) return;

  try {
    const res = await fetch(`${REST_URL}/agentmemory/context`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ sessionId, project, budget: 1500 }),
      signal: AbortSignal.timeout(hookDeliveryTimeoutMs()),
    });
    if (res.ok) {
      const result = (await res.json()) as { context?: string };
      if (result.context) {
        process.stdout.write(result.context);
      }
    }
  } catch {
    // silently fail -- don't block Claude Code startup
  }
}

main();
