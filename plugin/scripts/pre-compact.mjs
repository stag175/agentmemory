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
//#region src/hooks/pre-compact.ts
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
	const project = resolveProject(data.cwd);
	if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") try {
		await fetch(`${REST_URL}/agentmemory/claude-bridge/sync`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(5e3)
		});
	} catch {}
	try {
		const res = await fetch(`${REST_URL}/agentmemory/context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				budget: 1500
			}),
			signal: AbortSignal.timeout(5e3)
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

//# sourceMappingURL=pre-compact.mjs.map