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
//#endregion
//#region src/hooks/notification.ts
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
	const notificationType = data.notification_type ?? data.notificationType;
	if (notificationType !== "permission_prompt") return;
	const rawSessionId = data.session_id ?? data.sessionId;
	const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 ? rawSessionId : "unknown";
	const lineage = buildLineage(data, "notification", { sessionId });
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "notification",
			...eventFields(lineage),
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			data: {
				notification_type: notificationType,
				title: safeString(data.title),
				message: safeString(data.message),
				lineage
			}
		}),
		signal: AbortSignal.timeout(2e3)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main();
//#endregion
export {};

//# sourceMappingURL=notification.mjs.map