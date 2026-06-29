#!/usr/bin/env node
import {
  buildLineage,
  eventFields,
  firstString,
  safeMetadata,
  sendAgentEvent,
  summarizeValue,
  targetIdsFor,
} from "./_lineage.js";

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

  if (isSdkChildContext(data)) return;
  if (data.is_interrupt || data.isInterrupt) return;

  const sessionId = ((data.session_id || data.sessionId) as string) || "unknown";
  const toolName = firstString(data.tool_name, data.toolName) ?? "unknown";
  const toolInput = data.tool_input ?? data.toolArgs;
  const error = data.error ?? data.errorMessage;
  const lineage = buildLineage(data, "post_tool_failure", { sessionId });
  const fields = eventFields(lineage);
  const headers = authHeaders();
  const timestamp = new Date().toISOString();

  fetch(`${REST_URL}/agentmemory/observe`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      hookType: "post_tool_failure",
      ...fields,
      timestamp,
      data: {
        tool_name: toolName,
        tool_input: safeMetadata(
          typeof toolInput === "string"
            ? toolInput.slice(0, 4000)
            : JSON.stringify(safeMetadata(toolInput) ?? "").slice(0, 4000),
        ),
        error:
          typeof error === "string"
            ? safeMetadata(error.slice(0, 4000))
            : JSON.stringify(safeMetadata(error) ?? "").slice(0, 4000),
        lineage,
      },
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});

  sendAgentEvent(REST_URL, headers, {
    type: "tool_failed",
    status: "error",
    ...fields,
    functionId: `tool:${toolName}`,
    targetIds: targetIdsFor(lineage.toolCallId, toolName),
    metadata: {
      hookType: "post_tool_failure",
      toolName,
      toolInput: summarizeValue(toolInput),
      error: summarizeValue(error),
    },
  });
  setTimeout(() => process.exit(0), 500).unref();
}

main();
