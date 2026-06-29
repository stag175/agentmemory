import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { getAllTools } from "../src/mcp/tools-registry.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import { handleToolCall } from "../src/mcp/standalone.js";
import { resetHandleForTests, setLivezProbe } from "../src/mcp/rest-proxy.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "rules-resolver-api-"));
  tempRoots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  resetHandleForTests();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rules resolver public adapters", () => {
  it("exposes a whitelisted POST REST resolver that strips content by default", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");
    write(join(root, "docs", "team.rules.md"), "custom team instructions\n");

    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = await sdk.trigger("api::rules-resolve", {
      headers: {},
      body: {
        workspaceRoot: root,
        instructionGlobs: ["docs/*.rules.md"],
        maxBytes: 4096,
        includeContent: false,
        ignored: "drop me",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.includeContent).toBe(false);
    const rules = response.body.rules as Array<Record<string, unknown>>;
    expect(rules.map((rule) => rule.relativePath).sort()).toEqual([
      "AGENTS.md",
      "docs/team.rules.md",
    ]);
    expect(rules[0]).not.toHaveProperty("content");
  });

  it("exposes GET REST resolution with includeContent parsing", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const response = await sdk.trigger("api::rules-resolve-get", {
      headers: {},
      query_params: {
        workspaceRoot: root,
        includeContent: "true",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    const rules = response.body.rules as Array<Record<string, unknown>>;
    expect(rules[0].content).toBe("codex instructions\n");
  });

  it("returns clear REST 400s for invalid roots and globs", async () => {
    const root = tempDir();
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const missing = await sdk.trigger("api::rules-resolve", {
      headers: {},
      body: { workspaceRoot: join(root, "missing") },
    }) as { status_code: number; body: { error: string } };
    expect(missing.status_code).toBe(400);
    expect(missing.body.error).toContain("workspaceRoot could not be read");

    const badGlob = await sdk.trigger("api::rules-resolve", {
      headers: {},
      body: { workspaceRoot: root, instructionGlobs: ["../secret.md"] },
    }) as { status_code: number; body: { error: string } };
    expect(badGlob.status_code).toBe(400);
    expect(badGlob.body.error).toContain("parent-directory traversal");
  });

  it("exposes the MCP schema and call handler", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    expect(getAllTools().some((tool) => tool.name === "memory_rules_resolve")).toBe(true);

    const sdk = mockSdk();
    registerMcpEndpoints(sdk as never, mockKV() as never, undefined);

    const response = await sdk.trigger("mcp::tools::call", {
      headers: {},
      body: {
        name: "memory_rules_resolve",
        arguments: {
          workspaceRoot: root,
          includeContent: true,
        },
      },
    }) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(response.status_code).toBe(200);
    const payload = JSON.parse(response.body.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.rules[0].content).toBe("codex instructions\n");
  });

  it("exposes local standalone resolution when the daemon is unreachable", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "standalone codex instructions\n");
    resetHandleForTests();
    setLivezProbe(async () => ({
      ok: false,
      status: 0,
      statusText: "forced local fallback",
    }));

    const response = await handleToolCall(
      "memory_rules_resolve",
      {
        workspaceRoot: root,
        includeContent: true,
      },
      new InMemoryKV(),
    );

    const payload = JSON.parse(response.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.fallback).toBe(true);
    expect(payload.rules[0].content).toBe("standalone codex instructions\n");
  });
});

describe("import REST adapter boundary", () => {
  it("whitelists import payload fields and rejects invalid strategies", async () => {
    const sdk = mockSdk();
    let importPayload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::import", async (payload) => {
      importPayload = payload as Record<string, unknown>;
      return { success: true };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);

    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };
    const response = await sdk.trigger("api::import", {
      headers: {},
      body: {
        exportData,
        strategy: "merge",
        dryRun: true,
        unexpected: "drop me",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(importPayload).toEqual({
      exportData,
      strategy: "merge",
      dryRun: true,
    });

    const rejected = await sdk.trigger("api::import", {
      headers: {},
      body: {
        exportData,
        strategy: "overwrite",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(rejected).toEqual({
      status_code: 400,
      body: { error: "strategy must be one of: merge, replace, skip" },
    });
  });
});
