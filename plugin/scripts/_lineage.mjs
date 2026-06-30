import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const gitTopByDir = new Map();

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

const SECRET_KEY_RE = /(?:^|[_-])(?:authorization|auth|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token)(?:$|[_-])/i;
const SECRET_VALUE_PATTERNS = [
	/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
	/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g
];

export function redactString(value) {
	let redacted = value;
	for (const pattern of SECRET_VALUE_PATTERNS) {
		redacted = redacted.replace(pattern, "[redacted]");
	}
	return redacted.replace(
		/((?:authorization|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token)\s*[:=]\s*)[^\s'",;]+/gi,
		"$1[redacted]"
	);
}

export function safeString(value, max = 512) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (!trimmed) return void 0;
	return redactString(trimmed).slice(0, max);
}

export function firstString(...values) {
	for (const value of values) {
		const safe = safeString(value);
		if (safe) return safe;
	}
	return void 0;
}

export function compactObject(value) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => {
		if (item === void 0 || item === null || item === "") return false;
		if (Array.isArray(item) && item.length === 0) return false;
		return true;
	}));
}

export function safeMetadata(value, depth = 0) {
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

export function summarizeValue(value) {
	if (value === null || value === void 0) return { kind: String(value) };
	if (typeof value === "string") return { kind: "string", length: value.length };
	if (typeof value === "number" || typeof value === "boolean") return { kind: typeof value };
	if (Array.isArray(value)) return { kind: "array", length: value.length };
	if (typeof value === "object") {
		const keys = Object.keys(value);
		const safeKeys = keys.filter((key) => !SECRET_KEY_RE.test(key)).slice(0, 30);
		const redactedKeyCount = keys.length - safeKeys.length;
		return compactObject({
			kind: "object",
			keys: safeKeys,
			redactedKeyCount
		});
	}
	return { kind: typeof value };
}

function detectFramework(data) {
	return firstString(
		data.framework,
		data.agent_framework,
		data.agentFramework,
		data.host,
		data.hostName,
		data.client,
		data.clientName,
		data.source,
		process.env["AGENTMEMORY_FRAMEWORK"]
	) ?? (process.env["COPILOT_PLUGIN_ROOT"] ? "copilot" : process.env["CLAUDE_PLUGIN_ROOT"] ? "claude-code" : void 0);
}

export function buildLineage(data, hookType, overrides = {}) {
	const rawCwd = safeString(overrides.cwd, 1024) ?? safeString(data.cwd, 1024) ?? process.env["AGENTMEMORY_CWD"] ?? process.cwd();
	const sessionId = safeString(overrides.sessionId) ?? firstString(data.session_id, data.sessionId, process.env["AGENTMEMORY_SESSION_ID"]) ?? "unknown";
	const project = safeString(overrides.project) ?? firstString(data.project) ?? resolveProject(rawCwd);
	return compactObject({
		sessionId,
		project,
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

export function eventFields(lineage) {
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
	]) {
		if (lineage[key]) fields[key] = lineage[key];
	}
	return fields;
}

export function targetIdsFor(...values) {
	return [
		...new Set(values.map((value) => safeString(value)).filter((value) => typeof value === "string" && value.length > 0))
	].slice(0, 20);
}

export function sendAgentEvent(restUrl, headers, event, timeoutMs = 1200) {
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
