#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
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
//#region src/hooks/_delivery.ts
const MIN_DELIVERY_TIMEOUT_MS = 3e4;
const DEFAULT_MAX_BATCH = 8;
const DEFAULT_RETRY_BASE_MS = 1e3;
const DEFAULT_RETRY_MAX_MS = 6e4;
const PENDING_SUFFIX = ".pending.json";
const SENDING_MARKER = ".sending.";
function positiveInt(raw, fallback) {
	if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function hookDeliveryTimeoutMs() {
	return Math.max(MIN_DELIVERY_TIMEOUT_MS, positiveInt(process.env["AGENTMEMORY_HOOK_DELIVERY_TIMEOUT_MS"], MIN_DELIVERY_TIMEOUT_MS));
}
function hookOutboxDir() {
	return process.env["AGENTMEMORY_HOOK_OUTBOX_DIR"] || join(homedir(), ".agentmemory", "hook-outbox");
}
function normalizedBaseUrl(value) {
	return value.replace(/\/+$/, "");
}
function safeError(value) {
	return (value instanceof Error ? value.message : String(value)).replace(/[\r\n]+/g, " ").slice(0, 500);
}
async function ensureOutbox(dir) {
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
	await chmod(dir, 448).catch(() => {});
}
async function atomicWrite(path, value) {
	const tempPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
	const handle = await open(tempPath, "wx", 384);
	try {
		await handle.writeFile(value, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}
async function recordFailure(dir, delivery, error, status) {
	const line = JSON.stringify({
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		deliveryId: delivery.id,
		path: delivery.path,
		kind: delivery.kind,
		attempt: delivery.attempt,
		...status === void 0 ? {} : { status },
		error
	});
	await appendFile(join(dir, "delivery-errors.ndjson"), `${line}\n`, {
		encoding: "utf8",
		mode: 384,
		flag: "a"
	}).catch(() => {});
}
function isProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
function originalPendingName(claimedName) {
	const markerIndex = claimedName.indexOf(SENDING_MARKER);
	return markerIndex > 0 ? claimedName.slice(0, markerIndex) : null;
}
function claimOwnerPid(claimedName) {
	const markerIndex = claimedName.indexOf(SENDING_MARKER);
	if (markerIndex < 0) return null;
	const raw = claimedName.slice(markerIndex + 9).split(".")[0];
	if (!/^\d+$/.test(raw)) return null;
	const pid = Number(raw);
	return Number.isSafeInteger(pid) ? pid : null;
}
async function recoverAbandonedClaims(dir, names) {
	for (const name of names) {
		if (!name.includes(SENDING_MARKER)) continue;
		const original = originalPendingName(name);
		if (!original) continue;
		const pid = claimOwnerPid(name);
		let abandoned = pid === null || !isProcessAlive(pid);
		if (!abandoned) {
			const info = await stat(join(dir, name)).catch(() => null);
			const staleAfterMs = hookDeliveryTimeoutMs() * 2 + 5e3;
			abandoned = info !== null && Date.now() - info.mtimeMs > staleAfterMs;
		}
		if (!abandoned) continue;
		await rename(join(dir, name), join(dir, original)).catch(() => {});
	}
}
async function enqueue(dir, baseUrl, request) {
	if (!request.path.startsWith("/agentmemory/")) throw new Error(`refusing to spool non-agentmemory path: ${request.path}`);
	const id = randomUUID();
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const delivery = {
		version: 1,
		id,
		createdAt: now,
		updatedAt: now,
		baseUrl,
		path: request.path,
		body: JSON.stringify(request.body ?? {}),
		method: request.method ?? "POST",
		kind: request.kind ?? "hook_capture",
		attempt: 0
	};
	const name = `${Date.now().toString().padStart(13, "0")}-${id}${PENDING_SUFFIX}`;
	await atomicWrite(join(dir, name), JSON.stringify(delivery));
	return name;
}
async function claim(dir, name) {
	const claimed = `${name}${SENDING_MARKER}${process.pid}.${randomUUID()}`;
	try {
		await rename(join(dir, name), join(dir, claimed));
		return claimed;
	} catch {
		return null;
	}
}
function retryDelayMs(attempt) {
	const base = positiveInt(process.env["AGENTMEMORY_HOOK_RETRY_BASE_MS"], DEFAULT_RETRY_BASE_MS);
	const max = Math.max(base, positiveInt(process.env["AGENTMEMORY_HOOK_RETRY_MAX_MS"], DEFAULT_RETRY_MAX_MS));
	return Math.min(max, base * 2 ** Math.min(Math.max(attempt - 1, 0), 16));
}
async function restoreFailed(dir, claimedName, delivery, error, status) {
	const now = /* @__PURE__ */ new Date();
	delivery.attempt += 1;
	delivery.updatedAt = now.toISOString();
	delivery.lastAttemptAt = now.toISOString();
	delivery.lastError = error;
	delivery.lastStatus = status;
	delivery.nextAttemptAt = new Date(now.getTime() + retryDelayMs(delivery.attempt)).toISOString();
	const claimedPath = join(dir, claimedName);
	await atomicWrite(claimedPath, JSON.stringify(delivery));
	const original = originalPendingName(claimedName);
	if (!original) throw new Error(`invalid claimed delivery name: ${claimedName}`);
	await rename(claimedPath, join(dir, original));
	await recordFailure(dir, delivery, error, status);
}
async function deliverClaimed(dir, claimedName, secret) {
	const claimedPath = join(dir, claimedName);
	let delivery;
	try {
		delivery = JSON.parse(await readFile(claimedPath, "utf8"));
	} catch (error) {
		await recordFailure(dir, {
			id: claimedName,
			path: "unknown",
			kind: "corrupt_outbox",
			attempt: 0
		}, `corrupt outbox record: ${safeError(error)}`);
		return "failed";
	}
	if (delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > Date.now()) {
		const original = originalPendingName(claimedName);
		if (original) await rename(claimedPath, join(dir, original)).catch(() => {});
		return "skipped";
	}
	const headers = {
		"Content-Type": "application/json",
		"Idempotency-Key": delivery.id,
		"X-AgentMemory-Delivery-Id": delivery.id
	};
	if (secret) headers["Authorization"] = `Bearer ${secret}`;
	try {
		const response = await fetch(`${delivery.baseUrl}${delivery.path}`, {
			method: delivery.method,
			headers,
			body: delivery.body,
			signal: AbortSignal.timeout(hookDeliveryTimeoutMs())
		});
		if (!response.ok) {
			const message = `HTTP ${response.status}`;
			await restoreFailed(dir, claimedName, delivery, message, response.status);
			return "failed";
		}
		await unlink(claimedPath);
		return "delivered";
	} catch (error) {
		await restoreFailed(dir, claimedName, delivery, safeError(error));
		return "failed";
	}
}
/**
* Persist requests before attempting delivery, then acknowledge them only after
* an HTTP 2xx response. Failed and timed-out requests remain in the local
* outbox and are retried opportunistically by the next hook invocation.
*/
async function deliverHookRequests(options) {
	const dir = hookOutboxDir();
	const baseUrl = normalizedBaseUrl(options.restUrl);
	try {
		await ensureOutbox(dir);
	} catch (error) {
		console.error(`[agentmemory] hook outbox unavailable: ${safeError(error)}`);
		throw error;
	}
	const queuedNames = [];
	try {
		for (const request of options.requests) queuedNames.push(await enqueue(dir, baseUrl, request));
	} catch (error) {
		console.error(`[agentmemory] hook capture could not be persisted: ${safeError(error)}`);
		throw error;
	}
	await recoverAbandonedClaims(dir, await readdir(dir));
	const maxBatch = Math.max(queuedNames.length, positiveInt(process.env["AGENTMEMORY_HOOK_OUTBOX_MAX_BATCH"], DEFAULT_MAX_BATCH));
	const pendingNames = (await readdir(dir)).filter((name) => name.endsWith(PENDING_SUFFIX)).sort();
	const selected = [...queuedNames, ...pendingNames.filter((name) => !queuedNames.includes(name))].slice(0, maxBatch);
	const claimed = (await Promise.all(selected.map((name) => claim(dir, name)))).filter((name) => name !== null);
	const outcomes = await Promise.all(claimed.map((name) => deliverClaimed(dir, name, options.secret ?? "")));
	const remaining = (await readdir(dir)).filter((name) => name.endsWith(PENDING_SUFFIX) || name.includes(SENDING_MARKER)).length;
	return {
		queued: queuedNames.length,
		delivered: outcomes.filter((value) => value === "delivered").length,
		failed: outcomes.filter((value) => value === "failed").length,
		pending: remaining
	};
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
//#region src/hooks/session-start.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
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
	const sessionId = data.session_id || data.sessionId || `ses_${Date.now().toString(36)}`;
	const cwd = data.cwd || process.cwd();
	const project = resolveProject(data.cwd);
	const report = await deliverHookRequests({
		restUrl: REST_URL,
		secret: SECRET,
		requests: [{
			path: "/agentmemory/session/start",
			kind: "session_start",
			body: {
				...eventFields(buildLineage(data, "session_start", {
					sessionId,
					cwd,
					project
				})),
				sessionId,
				project,
				cwd,
				captureSource: "automatic_hook",
				hookType: "session_start"
			}
		}]
	});
	if (!INJECT_CONTEXT || report.delivered === 0) return;
	try {
		const res = await fetch(`${REST_URL}/agentmemory/context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				budget: 1500
			}),
			signal: AbortSignal.timeout(hookDeliveryTimeoutMs())
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(result.context);
		}
	} catch {}
}
main();
//#endregion
export {};

//# sourceMappingURL=session-start.mjs.map