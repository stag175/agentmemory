#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deliverHookRequests } from "./_delivery.js";

const exec = promisify(execFile);

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, { cwd, timeout: 1500 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown> = {};
  if (input.trim()) {
    try {
      data = JSON.parse(input);
    } catch {
      // Direct invocation from .git/hooks/post-commit may pass no stdin.
    }
  }

  if (isSdkChildContext(data)) return;

  const cwd =
    (data.cwd as string) ||
    process.env["AGENTMEMORY_CWD"] ||
    process.cwd();
  const sessionId =
    (data.session_id as string) ||
    process.env["AGENTMEMORY_SESSION_ID"] ||
    undefined;

  const sha =
    process.env["AGENTMEMORY_COMMIT_SHA"] ||
    (await git(["rev-parse", "HEAD"], cwd));
  if (!sha) return;

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const repo = await git(["config", "--get", "remote.origin.url"], cwd);
  const message = await git(["log", "-1", "--pretty=%B", sha], cwd);
  const author = await git(["log", "-1", "--pretty=%an <%ae>", sha], cwd);
  const authoredAt = await git(["log", "-1", "--pretty=%aI", sha], cwd);
  const filesRaw = await git(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
    cwd,
  );
  const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : undefined;

  const body = {
    sessionId,
    sha,
    branch: branch || undefined,
    repo: repo || undefined,
    message: message || undefined,
    author: author || undefined,
    authoredAt: authoredAt || undefined,
    files,
  };

  await deliverHookRequests({
    restUrl: REST_URL,
    secret: SECRET,
    requests: [{
      path: "/agentmemory/session/commit",
      kind: "commit_link",
      body,
    }],
  });
}

main();
