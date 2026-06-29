import { describe, expect, it, vi } from "vitest";
import {
  buildMemoryCliRequest,
  executeMemoryCliRequest,
  runMemoryCommand,
} from "../src/cli/memory-lifecycle.js";

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("memory lifecycle CLI", () => {
  it("maps create command to the explicit lifecycle endpoint", () => {
    expect(
      buildMemoryCliRequest([
        "create",
        "Use lifecycle create for sourced facts",
        "--type",
        "fact",
        "--concepts",
        "lifecycle,create",
        "--files",
        "src/functions/memory-lifecycle.ts",
        "--project",
        "agentmemory",
        "--lane",
        "semantic_fact",
        "--confidence",
        "0.8",
        "--source-observation-ids",
        "obs_1,obs_2",
        "--source-uri",
        "file:///repo/notes.md",
        "--require-gate-pass",
      ]),
    ).toEqual({
      method: "POST",
      path: "memory/create",
      body: {
        content: "Use lifecycle create for sourced facts",
        type: "fact",
        concepts: ["lifecycle", "create"],
        files: ["src/functions/memory-lifecycle.ts"],
        sourceObservationIds: ["obs_1", "obs_2"],
        project: "agentmemory",
        lane: "semantic_fact",
        confidence: 0.8,
        sourceUri: "file:///repo/notes.md",
        requireGatePass: true,
      },
    });
  });

  it("maps inspect and history commands to lifecycle endpoints", () => {
    expect(buildMemoryCliRequest(["inspect", "mem_1"])).toEqual({
      method: "POST",
      path: "memory/inspect",
      body: { memoryId: "mem_1" },
    });
    expect(buildMemoryCliRequest(["history", "mem_1"])).toEqual({
      method: "POST",
      path: "memory/history",
      body: { memoryId: "mem_1" },
    });
  });

  it("parses update flags into a lifecycle payload", () => {
    const validFrom = "2026-06-01T00:00:00.000Z";
    const validUntil = "2026-07-01T00:00:00.000Z";

    expect(
      buildMemoryCliRequest([
        "update",
        "mem_1",
        "--content",
        "new content",
        "--title=New title",
        "--concepts",
        "auth,jwt",
        "--files",
        "src/auth.ts,src/jwt.ts",
        "--strength",
        "8",
        "--confidence",
        "0.7",
        "--review-state",
        "verified",
        "--privacy-scope",
        "project",
        "--valid-from",
        validFrom,
        "--valid-until",
        validUntil,
        "--reason",
        "manual correction",
      ]),
    ).toEqual({
      method: "POST",
      path: "memory/update",
      body: {
        memoryId: "mem_1",
        content: "new content",
        title: "New title",
        concepts: ["auth", "jwt"],
        files: ["src/auth.ts", "src/jwt.ts"],
        strength: 8,
        confidence: 0.7,
        reviewState: "verified",
        privacyScope: "project",
        validFrom,
        validUntil,
        reason: "manual correction",
      },
    });
  });

  it("guards hard delete and defaults to tombstone", () => {
    expect(buildMemoryCliRequest(["delete", "mem_1"])).toEqual({
      method: "POST",
      path: "memory/delete",
      body: { memoryId: "mem_1", mode: "tombstone" },
    });

    expect(() =>
      buildMemoryCliRequest(["delete", "mem_1", "--mode", "hard"]),
    ).toThrow(/requires --yes/);

    expect(
      buildMemoryCliRequest(["delete", "mem_1", "--mode", "hard", "--yes"]),
    ).toEqual({
      method: "POST",
      path: "memory/delete",
      body: { memoryId: "mem_1", mode: "hard" },
    });
  });

  it("builds GET query requests for ledger and review queue", () => {
    expect(
      buildMemoryCliRequest([
        "ledger",
        "--project",
        "proj",
        "--state",
        "all",
        "--review-state",
        "needs_review",
        "--include-source-cards",
        "--limit",
        "25",
        "--offset",
        "50",
      ]),
    ).toEqual({
      method: "GET",
      path: "memory-ledger",
      query: {
        project: "proj",
        state: "all",
        reviewState: "needs_review",
        includeSourceCards: "true",
        limit: "25",
        offset: "50",
      },
    });

    expect(
      buildMemoryCliRequest([
        "review-queue",
        "--project=proj",
        "--limit=10",
      ]),
    ).toEqual({
      method: "GET",
      path: "memory-review-queue",
      query: { project: "proj", limit: "10" },
    });
  });

  it("builds search-explain requests with hard filters", () => {
    expect(
      buildMemoryCliRequest([
        "search-explain",
        "auth",
        "decision",
        "--project",
        "proj",
        "--limit",
        "5",
        "--search-mode",
        "deep",
        "--files",
        "src/auth.ts,src/session.ts",
        "--branch",
        "main",
        "--commit",
        "abc123",
        "--memory-tier",
        "semantic_fact",
        "--privacy-scope",
        "project",
        "--agent-id",
        "agent_a",
      ]),
    ).toEqual({
      method: "POST",
      path: "search/explain",
      body: {
        query: "auth decision",
        project: "proj",
        limit: 5,
        searchMode: "deep",
        files: ["src/auth.ts", "src/session.ts"],
        branch: "main",
        commit: "abc123",
        memoryTier: "semantic_fact",
        privacyScope: "project",
        agentId: "agent_a",
      },
    });
  });

  it("adds auth headers and query parameters when executing requests", async () => {
    const fetchImpl = vi.fn(async () => response({ success: true }));

    await executeMemoryCliRequest(
      {
        method: "GET",
        path: "memory-ledger",
        query: { limit: "5", includeSourceCards: "true" },
      },
      {
        baseUrl: "http://localhost:3111",
        env: { AGENTMEMORY_SECRET: "secret" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      "http://localhost:3111/agentmemory/memory-ledger?limit=5&includeSourceCards=true",
    );
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret",
    );
  });

  it("prints help without issuing a request", async () => {
    const fetchImpl = vi.fn();
    let output = "";

    await runMemoryCommand(["help"], {
      baseUrl: "http://localhost:3111",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      stdout: { write: (chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      } },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output).toContain("agentmemory memory inspect <memoryId>");
  });
});
