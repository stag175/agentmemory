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

const SECRET_KEY_RE = /(?:^|[_-])(?:authorization|auth|cookie|secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token)(?:$|[_-])/i;
const SECRET_VALUE_PATTERNS = [
	/\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
	/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g
];

function resolveProjectName(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	const ancestor = findGitAncestor(dir);
	if (ancestor) return basename(ancestor);
	return basename(dir);
}

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
	const record = data && typeof data === "object" && !Array.isArray(data) ? data : {};
	const rawCwd = typeof overrides.cwd === "string" ? overrides.cwd : typeof record.cwd === "string" ? record.cwd : process.env["AGENTMEMORY_CWD"] || process.cwd();
	const cwd = safeString(rawCwd, 1024) || process.cwd();
	const sessionId = safeString(overrides.sessionId) || firstString(record.session_id, record.sessionId, process.env["AGENTMEMORY_SESSION_ID"]) || "unknown";
	const project = safeString(overrides.project) || firstString(record.project) || resolveProjectName(cwd);
	return compactObject({
		sessionId,
		project,
		cwd,
		agentId: safeString(overrides.agentId) || firstString(record.agent_id, record.agentId, record.agentName, record.teammate_name, process.env["AGENTMEMORY_AGENT_ID"], process.env["AGENT_ID"]),
		framework: safeString(overrides.framework) || detectFramework(record),
		nativeId: safeString(overrides.nativeId) || firstString(record.native_id, record.nativeId, record.agent_native_id, record.agentNativeId, record.conversation_id, record.conversationId, record.thread_id, record.threadId),
		traceId: safeString(overrides.traceId) || firstString(record.trace_id, record.traceId, record.request_id, record.requestId),
		runId: safeString(overrides.runId) || firstString(record.run_id, record.runId),
		teamId: safeString(overrides.teamId) || firstString(record.team_id, record.teamId, record.team_name, record.teamName),
		taskId: safeString(overrides.taskId) || firstString(record.task_id, record.taskId),
		toolCallId: safeString(overrides.toolCallId) || firstString(record.tool_call_id, record.toolCallId, record.call_id, record.callId),
		parentEventId: safeString(overrides.parentEventId) || firstString(record.parent_event_id, record.parentEventId),
		correlationId: safeString(overrides.correlationId) || firstString(record.correlation_id, record.correlationId),
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
	const body = compactObject({
		...event,
		metadata: event.metadata === void 0 ? void 0 : safeMetadata(event.metadata)
	});
	fetch(`${restUrl}/agentmemory/agent-events`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs)
	}).catch(() => {});
}
