import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerContextFunction } from "../src/functions/context.js";
import { registerEnrichFunction } from "../src/functions/enrich.js";
import { KV } from "../src/state/schema.js";
import type { Session, SessionSummary } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
  };
}

type ContextHandler = (data: {
  sessionId: string;
  project: string;
  budget?: number;
  explain?: boolean;
  includeReport?: boolean;
}) => Promise<any>;

function wireContext(kv: ReturnType<typeof mockKV>, budget = 4000) {
  let handler: ContextHandler | undefined;
  const sdk = {
    registerFunction: vi.fn((id: string, cb: ContextHandler) => {
      if (id === "mem::context") handler = cb;
    }),
  } as unknown as import("iii-sdk").ISdk;
  registerContextFunction(sdk, kv as never, budget);
  if (!handler) throw new Error("mem::context not registered");
  return handler;
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerOverrides = new Map<string, Function>();
  return {
    registerFunction: (id: string, handler: Function) => {
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      if (triggerOverrides.has(id)) return triggerOverrides.get(id)!(payload);
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function registered: ${id}`);
      return fn(payload);
    },
    overrideTrigger: (id: string, handler: Function) => {
      triggerOverrides.set(id, handler);
    },
  };
}

async function seedSummary(
  kv: ReturnType<typeof mockKV>,
  opts: {
    id: string;
    project: string;
    startedAt: string;
    createdAt: string;
    title: string;
    narrative: string;
  },
) {
  const session: Session = {
    id: opts.id,
    project: opts.project,
    cwd: opts.project,
    startedAt: opts.startedAt,
    status: "completed",
    observationCount: 1,
  };
  const summary: SessionSummary = {
    sessionId: opts.id,
    project: opts.project,
    createdAt: opts.createdAt,
    title: opts.title,
    narrative: opts.narrative,
    keyDecisions: ["keep"],
    filesModified: ["a.ts"],
    concepts: [],
    observationCount: 1,
  };
  await kv.set(KV.sessions, session.id, session);
  await kv.set(KV.summaries, summary.sessionId, summary);
}

describe("Context Router packing in function callers", () => {
  it("reports selected and ignored context blocks under the token budget", async () => {
    const kv = mockKV();
    const handler = wireContext(kv);

    await seedSummary(kv, {
      id: "ses_recent",
      project: "proj",
      startedAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-02T00:00:00.000Z",
      title: "Recent",
      narrative: "short",
    });
    await seedSummary(kv, {
      id: "ses_older",
      project: "proj",
      startedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "Older",
      narrative: "long ".repeat(80),
    });

    const result = await handler({
      sessionId: "ses_current",
      project: "proj",
      budget: 45,
      includeReport: true,
    });

    expect(result.context).toContain("Recent");
    expect(result.context).not.toContain("Older");
    expect(result.blocks).toBe(1);
    expect(result.budgetReport.selectedCount).toBe(1);
    expect(result.budgetReport.ignoredCount).toBe(1);
    expect(result.budgetReport.ignored[0].reason).toBe(
      "token_budget_exceeded",
    );
  });

  it("returns no context with an empty budget report and explain plan", async () => {
    const kv = mockKV();
    const handler = wireContext(kv);

    const result = await handler({
      sessionId: "ses_current",
      project: "proj",
      includeReport: true,
      explain: true,
    });

    expect(result.context).toBe("");
    expect(result.blocks).toBe(0);
    expect(result.tokens).toBe(0);
    expect(result.budgetReport.selectedCount).toBe(0);
    expect(result.budgetReport.ignoredCount).toBe(0);
    expect(result.packedContext.context).toBe("");
    expect(result.queryPlan.mode).toBe("context");
    expect(result.queryPlan.prefilter.candidateCount).toBe(0);
  });

  it("keeps enrich truncation compatible and gates budget reports", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerEnrichFunction(sdk as never, kv as never);
    sdk.overrideTrigger("mem::file-context", async () => ({
      context: "x".repeat(5000),
    }));
    sdk.overrideTrigger("mem::search", async () => ({ results: [] }));

    const defaultResult = await sdk.trigger("mem::enrich", {
      sessionId: "ses_current",
      files: ["src/big.ts"],
    }) as { context: string; truncated: boolean; budgetReport?: unknown };

    expect(defaultResult.context.length).toBe(4000);
    expect(defaultResult.truncated).toBe(true);
    expect(defaultResult.budgetReport).toBeUndefined();

    const reportedResult = await sdk.trigger("mem::enrich", {
      sessionId: "ses_current",
      files: ["src/big.ts"],
      includeReport: true,
    }) as {
      context: string;
      truncated: boolean;
      budgetReport: { ignoredCount: number };
    };

    expect(reportedResult.context.length).toBe(4000);
    expect(reportedResult.truncated).toBe(true);
    expect(reportedResult.budgetReport.ignoredCount).toBe(1);
  });
});
