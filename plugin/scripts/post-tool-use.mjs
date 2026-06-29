#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
//#region src/hooks/_project.ts
const gitTopByDir = /* @__PURE__ */ new Map();
function findGitAncestor(dir) {
	const start = resolve(dir);
	const cached = gitTopByDir.get(start);
	if (cached) return cached;
	const visited = [];
	let current = start;
	while (true) {
		const currentCached = gitTopByDir.get(current);
		if (currentCached) {
			for (const item of visited) gitTopByDir.set(item, currentCached);
			return currentCached;
		}
		visited.push(current);
		if (existsSync(join(current, ".git"))) {
			for (const item of visited) gitTopByDir.set(item, current);
			return current;
		}
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	const ancestor = findGitAncestor(dir);
	if (ancestor) return basename(ancestor);
	return basename(dir);
}
//#endregion
//#region src/hooks/_lineage.ts
const SECRET_KEY_RE = /(?:^|[_-])(?:authorization|auth|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token)(?:$|[_-])/i;
const SECRET_VALUE_PATTERNS = [
	/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
	/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g
];
function redactString(value) {
	let redacted = value;
	for (const pattern of SECRET_VALUE_PATTERNS) redacted = redacted.replace(pattern, "[redacted]");
	return redacted.replace(/((?:authorization|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token)\s*[:=]\s*)[^\s'",;]+/gi, "$1[redacted]");
}
function safeString(value, max = 512) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (!trimmed) return void 0;
	return redactString(trimmed).slice(0, max);
}
function firstString(...values) {
	for (const value of values) {
		const safe = safeString(value);
		if (safe) return safe;
	}
}
function compactObject(value) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => {
		if (item === void 0 || item === null || item === "") return false;
		if (Array.isArray(item) && item.length === 0) return false;
		return true;
	}));
}
function safeMetadata(value, depth = 0) {
	if (value === null || value === void 0) return value;
	if (typeof value === "string") return redactString(value).slice(0, 2e3);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 4) return "[truncated]";
	if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeMetadata(item, depth + 1));
	if (typeof value !== "object") return String(value).slice(0, 512);
	const result = {};
	for (const [key, item] of Object.entries(value).slice(0, 50)) {
		const safeKey = safeString(key, 128) ?? "field";
		result[safeKey] = SECRET_KEY_RE.test(key) ? "[redacted]" : safeMetadata(item, depth + 1);
	}
	return result;
}
function summarizeValue(value) {
	if (value === null || value === void 0) return { kind: String(value) };
	if (typeof value === "string") return {
		kind: "string",
		length: value.length
	};
	if (typeof value === "number" || typeof value === "boolean") return { kind: typeof value };
	if (Array.isArray(value)) return {
		kind: "array",
		length: value.length
	};
	if (typeof value === "object") {
		const keys = Object.keys(value);
		const safeKeys = keys.filter((key) => !SECRET_KEY_RE.test(key)).slice(0, 30);
		return compactObject({
			kind: "object",
			keys: safeKeys,
			redactedKeyCount: keys.length - safeKeys.length
		});
	}
	return { kind: typeof value };
}
function detectFramework(data) {
	return firstString(data.framework, data.agent_framework, data.agentFramework, data.host, data.hostName, data.client, data.clientName, data.source, process.env["AGENTMEMORY_FRAMEWORK"]) ?? (process.env["COPILOT_PLUGIN_ROOT"] ? "copilot" : process.env["CLAUDE_PLUGIN_ROOT"] ? "claude-code" : void 0);
}
function buildLineage(data, hookType, overrides = {}) {
	const rawCwd = safeString(overrides.cwd, 1024) ?? safeString(data.cwd, 1024) ?? process.env["AGENTMEMORY_CWD"] ?? process.cwd();
	return compactObject({
		sessionId: safeString(overrides.sessionId) ?? firstString(data.session_id, data.sessionId, process.env["AGENTMEMORY_SESSION_ID"]) ?? "unknown",
		project: safeString(overrides.project) ?? firstString(data.project) ?? resolveProject(rawCwd),
		cwd: rawCwd,
		agentId: safeString(overrides.agentId) ?? firstString(data.agent_id, data.agentId, data.agentName, data.teammate_name, process.env["AGENTMEMORY_AGENT_ID"], process.env["AGENT_ID"]),
		framework: safeString(overrides.framework) ?? detectFramework(data),
		nativeId: safeString(overrides.nativeId) ?? firstString(data.native_id, data.nativeId, data.agent_native_id, data.agentNativeId, data.conversation_id, data.conversationId, data.thread_id, data.threadId),
		traceId: safeString(overrides.traceId) ?? firstString(data.trace_id, data.traceId, data.request_id, data.requestId),
		runId: safeString(overrides.runId) ?? firstString(data.run_id, data.runId),
		teamId: safeString(overrides.teamId) ?? firstString(data.team_id, data.teamId, data.team_name, data.teamName),
		taskId: safeString(overrides.taskId) ?? firstString(data.task_id, data.taskId),
		toolCallId: safeString(overrides.toolCallId) ?? firstString(data.tool_call_id, data.toolCallId, data.call_id, data.callId),
		parentEventId: safeString(overrides.parentEventId) ?? firstString(data.parent_event_id, data.parentEventId),
		correlationId: safeString(overrides.correlationId) ?? firstString(data.correlation_id, data.correlationId),
		hookType
	});
}
function eventFields(lineage) {
	const fields = {};
	for (const key of [
		"sessionId",
		"project",
		"cwd",
		"agentId",
		"framework",
		"nativeId",
		"traceId",
		"runId",
		"teamId",
		"taskId",
		"toolCallId",
		"parentEventId",
		"correlationId"
	]) if (lineage[key]) fields[key] = lineage[key];
	return fields;
}
function targetIdsFor(...values) {
	return [...new Set(values.map((value) => safeString(value)).filter((value) => typeof value === "string" && value.length > 0))].slice(0, 20);
}
function sendAgentEvent(restUrl, headers, event, timeoutMs = 1200) {
	const safeEventMetadata = event.metadata === void 0 ? void 0 : safeMetadata(event.metadata);
	const metadata = safeEventMetadata && typeof safeEventMetadata === "object" && !Array.isArray(safeEventMetadata) ? {
		captureSource: "automatic_hook",
		...safeEventMetadata
	} : {
		captureSource: "automatic_hook",
		value: safeEventMetadata
	};
	const body = compactObject({
		...event,
		metadata
	});
	fetch(`${restUrl}/agentmemory/agent-events`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	}).catch(() => {});
}
//#endregion
//#region src/hooks/post-tool-use.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || "unknown";
	const toolName = firstString(data.tool_name, data.toolName) ?? "unknown";
	const toolInput = data.tool_input ?? data.toolArgs;
	const lineage = buildLineage(data, "post_tool_use", { sessionId });
	const fields = eventFields(lineage);
	const headers = authHeaders();
	const timestamp = (/* @__PURE__ */ new Date()).toISOString();
	const { imageData, cleanOutput } = extractImageData(toolOutput(data));
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			hookType: "post_tool_use",
			...fields,
			timestamp,
			data: {
				tool_name: toolName,
				tool_input: safeMetadata(toolInput),
				tool_output: safeMetadata(truncate(cleanOutput, 8e3)),
				lineage,
				...imageData ? { image_data: imageData } : {}
			}
		}),
		signal: AbortSignal.timeout(3e3)
	}).catch(() => {});
	sendAgentEvent(REST_URL, headers, {
		type: "tool_completed",
		status: "ok",
		...fields,
		functionId: `tool:${toolName}`,
		targetIds: targetIdsFor(lineage.toolCallId, toolName),
		metadata: {
			hookType: "post_tool_use",
			toolName,
			toolInput: summarizeValue(toolInput),
			toolOutput: summarizeValue(cleanOutput)
		}
	});
	setTimeout(() => process.exit(0), 500).unref();
}
function toolOutput(data) {
	if (data.tool_response !== void 0) return data.tool_response;
	if (data.tool_output !== void 0) return data.tool_output;
	const result = data.tool_result ?? data.toolResult;
	if (typeof result === "object" && result !== null) {
		const obj = result;
		return obj.text_result_for_llm ?? obj.textResultForLlm ?? result;
	}
	return result;
}
function isBase64Image(val) {
	return typeof val === "string" && (val.startsWith("data:image/") || val.startsWith("iVBORw0KGgo") || val.startsWith("/9j/"));
}
function extractImageData(output) {
	if (isBase64Image(output)) return {
		imageData: output,
		cleanOutput: "[image data extracted]"
	};
	if (typeof output === "object" && output !== null && !Array.isArray(output)) {
		const obj = output;
		let imageData;
		const clean = {};
		for (const [key, val] of Object.entries(obj)) if (!imageData && isBase64Image(val)) {
			imageData = val;
			clean[key] = "[image data extracted]";
		} else clean[key] = val;
		return {
			imageData,
			cleanOutput: clean
		};
	}
	return {
		imageData: void 0,
		cleanOutput: output
	};
}
function truncate(value, max) {
	if (typeof value === "string" && value.length > max) return value.slice(0, max) + "\n[...truncated]";
	if (typeof value === "object" && value !== null) {
		const str = JSON.stringify(value);
		if (str.length > max) return str.slice(0, max) + "...[truncated]";
		return value;
	}
	return value;
}
main();
//#endregion
export {};

//# sourceMappingURL=post-tool-use.mjs.map