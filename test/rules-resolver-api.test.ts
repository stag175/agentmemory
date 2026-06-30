import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";
import { registerRulesResolverFunction } from "../src/functions/rules-resolver.js";
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
  // The NETWORK REST surface constrains workspaceRoot to the server's
  // configured allowedRoots and keeps allowCallerOptions FALSE. The default
  // registration in registerApiTriggers uses [process.cwd()]; these REST tests
  // pre-register mem::rules-resolve with allowedRoots covering the temp root so
  // legitimate in-bounds resolution succeeds (registerRulesResolverFunction is
  // idempotent per-sdk, so registerApiTriggers' later call is a no-op).
  function registerRestForRoot(root: string) {
    const sdk = mockSdk();
    registerRulesResolverFunction(sdk as never, { allowedRoots: [root] });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    return sdk;
  }

  it("exposes a whitelisted POST REST resolver that strips caller globs + content (network trust model)", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");
    write(join(root, "docs", "team.rules.md"), "custom team instructions\n");

    const sdk = registerRestForRoot(root);

    const response = await sdk.trigger("api::rules-resolve", {
      headers: {},
      body: {
        workspaceRoot: root,
        // Caller-supplied glob must be IGNORED on the network surface, so the
        // docs/*.rules.md custom file is not picked up.
        instructionGlobs: ["docs/*.rules.md"],
        maxBytes: 4096,
        // Caller-requested includeContent must be forced FALSE on the network
        // surface regardless of what the caller asks for.
        includeContent: true,
        ignored: "drop me",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    // includeContent is forced false despite the caller passing true.
    expect(response.body.includeContent).toBe(false);
    const rules = response.body.rules as Array<Record<string, unknown>>;
    // Only the always-on AGENTS.md is found; the caller glob was stripped.
    expect(rules.map((rule) => rule.relativePath).sort()).toEqual([
      "AGENTS.md",
    ]);
    expect(rules[0]).not.toHaveProperty("content");
  });

  it("forces includeContent false on the GET REST surface (network trust model)", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    const sdk = registerRestForRoot(root);

    const response = await sdk.trigger("api::rules-resolve-get", {
      headers: {},
      query_params: {
        workspaceRoot: root,
        // Caller asks for content; network surface must still strip it.
        includeContent: "true",
      },
    }) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body.includeContent).toBe(false);
    const rules = response.body.rules as Array<Record<string, unknown>>;
    expect(rules[0]).not.toHaveProperty("content");
  });

  it("returns HTTP 400 forbidden_root for a workspaceRoot outside allowedRoots", async () => {
    const allowedRoot = tempDir();
    const outsideRoot = tempDir();
    write(join(outsideRoot, "AGENTS.md"), "secret instructions\n");

    // Network surface only permits allowedRoot; outsideRoot is a sibling temp
    // dir that exists and is readable but is NOT within the allowed root.
    const sdk = registerRestForRoot(allowedRoot);

    const forbidden = await sdk.trigger("api::rules-resolve", {
      headers: {},
      body: { workspaceRoot: outsideRoot },
    }) as { status_code: number; body: { success: boolean; code: string; error: string } };
    expect(forbidden.status_code).toBe(400);
    expect(forbidden.body.success).toBe(false);
    expect(forbidden.body.code).toBe("forbidden_root");
    expect(forbidden.body.error).toContain("not within an allowed root");
  });

  it("returns clear REST 400s for invalid roots and globs", async () => {
    const root = tempDir();
    const sdk = registerRestForRoot(root);

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

  it("exposes the MCP schema and call handler with the network trust model", async () => {
    const root = tempDir();
    write(join(root, "AGENTS.md"), "codex instructions\n");

    expect(getAllTools().some((tool) => tool.name === "memory_rules_resolve")).toBe(true);

    // The MCP daemon is a NETWORK surface, so it constrains allowedRoots and
    // strips caller includeContent. Pre-register mem::rules-resolve with
    // allowedRoots covering the temp root (idempotent per sdk) so the in-bounds
    // resolution succeeds while content stays stripped.
    const sdk = mockSdk();
    registerRulesResolverFunction(sdk as never, { allowedRoots: [root] });
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
    // Network surface forces includeContent false despite the caller request.
    expect(payload.includeContent).toBe(false);
    expect(payload.rules[0]).not.toHaveProperty("content");
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
