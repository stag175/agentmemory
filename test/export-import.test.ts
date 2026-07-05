import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { decryptLocalJsonPayload } from "../src/security/encryption.js";
import type { LocalJsonEncryptionEnvelope } from "../src/security/encryption.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
  AgentEvent,
  MemoryRevision,
} from "../src/types.js";
import { KV } from "../src/state/schema.js";

type EncryptedExportArtifact = {
  schema: "agentmemory.export.encrypted";
  schemaVersion: 1;
  encryptedAt: string;
  keyRef: string;
  envelope: LocalJsonEncryptionEnvelope;
};

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
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

const testAgentEvent: AgentEvent = {
  id: "agevt_1",
  timestamp: "2026-02-01T10:01:00Z",
  type: "memory_written",
  sessionId: "ses_1",
  project: "my-project",
  agentId: "codex",
  functionId: "mem::remember",
  targetIds: ["mem_1"],
  memoryIds: ["mem_1"],
};

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
    await kv.set("mem:agent-events", "agevt_1", testAgentEvent);
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe("0.9.28");
    expect(result.exportedAt).toBeDefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.schema).toBe("agentmemory.export");
    expect(result.manifest?.schemaVersion).toBe(1);
    expect(result.manifest?.version).toBe(result.version);
    expect(result.manifest?.createdAt).toBe(result.exportedAt);
    expect(result.manifest?.exportedAt).toBe(result.exportedAt);
    expect(result.manifest?.counts.sessions).toBe(1);
    expect(result.manifest?.counts.observations).toBe(1);
    expect(result.manifest?.counts.memories).toBe(1);
    expect(result.manifest?.counts.summaries).toBe(1);
    expect(result.manifest?.counts.observationBuckets).toBe(1);
    expect(result.manifest?.counts.agentEvents).toBe(1);
    expect(result.manifest?.hashes.sessions).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest?.hashes.observations).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest?.hashes.agentEvents).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
    expect(result.agentEvents?.length).toBe(1);
  });

  it("can return an encrypted backup export artifact", async () => {
    const previous = process.env.AGENTMEMORY_EXPORT_TEST_KEY;
    process.env.AGENTMEMORY_EXPORT_TEST_KEY = "test backup export passphrase";
    try {
      const result = (await sdk.trigger("mem::export", {
        encrypt: true,
        encryptionKeyRef: "env:AGENTMEMORY_EXPORT_TEST_KEY",
      })) as EncryptedExportArtifact;

      expect(result.schema).toBe("agentmemory.export.encrypted");
      expect(result.schemaVersion).toBe(1);
      expect(result.keyRef).toBe("env:AGENTMEMORY_EXPORT_TEST_KEY");
      expect(JSON.stringify(result)).not.toContain(testMemory.content);

      const decrypted = decryptLocalJsonPayload<ExportData>(result.envelope, {
        env: process.env,
        envVar: "AGENTMEMORY_EXPORT_TEST_KEY",
        keyRef: result.keyRef,
      });
      expect(decrypted.version).toBe("0.9.28");
      expect(decrypted.memories[0].id).toBe("mem_1");
      expect(decrypted.memories[0].content).toBe(testMemory.content);
      expect(decrypted.manifest?.hashes.memories).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTMEMORY_EXPORT_TEST_KEY;
      } else {
        process.env.AGENTMEMORY_EXPORT_TEST_KEY = previous;
      }
    }
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import dryRun returns a plan without mutating KV", async () => {
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_dry", observationCount: 1 }],
      observations: {
        ses_dry: [{ ...testObs, id: "obs_dry", sessionId: "ses_dry" }],
      },
      memories: [{ ...testMemory, id: "mem_dry", title: "Dry run memory" }],
      summaries: [{ ...testSummary, sessionId: "ses_dry" }],
      accessLogs: [
        { memoryId: "mem_missing", count: 1, lastAt: "2026-02-01T10:00:00Z", recent: [] },
      ],
      memoryHistory: [
        {
          id: "rev_missing",
          memoryId: "mem_missing",
          action: "create",
          createdAt: "2026-02-01T10:00:00Z",
        },
      ],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
      dryRun: true,
    })) as {
      success: boolean;
      dryRun: boolean;
      plan: {
        sourceCounts: { accessLogs: number; memoryHistory: number };
        wouldImport: {
          sessions: number;
          observations: number;
          memories: number;
          accessLogs: number;
          memoryHistory: number;
        };
        quarantined: number;
      };
      quarantine: { count: number; entries: Array<{ reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.plan.wouldImport.sessions).toBe(1);
    expect(result.plan.wouldImport.observations).toBe(1);
    expect(result.plan.wouldImport.memories).toBe(1);
    expect(result.plan.sourceCounts.accessLogs).toBe(1);
    expect(result.plan.sourceCounts.memoryHistory).toBe(1);
    expect(result.plan.wouldImport.accessLogs).toBe(0);
    expect(result.plan.wouldImport.memoryHistory).toBe(0);
    expect(result.plan.quarantined).toBe(2);
    expect(result.quarantine.entries.map((entry) => entry.reason)).toEqual([
      "access_log_missing_imported_memory",
      "memory_history_missing_imported_memory",
    ]);
    expect(await kv.get("mem:sessions", "ses_dry")).toBeNull();
    expect(await kv.get("mem:memories", "mem_dry")).toBeNull();
    expect(await kv.get("mem:obs:ses_dry", "obs_dry")).toBeNull();
    expect((await kv.list("mem:audit")).length).toBe(0);
  });

  it("redacts and gates secret-bearing core imports and memory history", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_secret", observationCount: 1 }],
      observations: {
        ses_secret: [
          {
            ...testObs,
            id: "obs_secret",
            sessionId: "ses_secret",
            title: `Secret title ${secret}`,
            facts: [`Saw ${secret}`],
            narrative: `Captured ${secret}`,
            raw: { token: secret },
          } as CompressedObservation & { raw: { token: string } },
        ],
      },
      memories: [
        {
          ...testMemory,
          id: "mem_secret",
          title: `Secret memory ${secret}`,
          content: `Do not import ${secret} as trusted knowledge`,
          concepts: ["secret-import"],
          sessionIds: ["ses_secret"],
          privacyScope: "team",
        },
      ],
      summaries: [],
      memoryHistory: [
        {
          id: "rev_secret",
          memoryId: "mem_secret",
          action: "create",
          createdAt: "2026-02-01T10:00:00Z",
          reason: `Imported ${secret}`,
          prior: { content: `old ${secret}` },
          next: { content: `new ${secret}` },
        },
      ],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as {
      success: boolean;
      observations: number;
      memories: number;
      memoryHistory: number;
      quarantined: number;
      quarantine: { entries: Array<{ reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);
    expect(result.memoryHistory).toBe(1);
    expect(result.quarantined).toBe(3);
    expect(result.quarantine.entries.map((entry) => entry.reason)).toEqual([
      "observation_redacted_or_sensitive",
      "memory_redacted_or_sensitive",
      "memory_history_redacted_or_sensitive",
    ]);
    expect(JSON.stringify(exportData)).toContain(secret);

    const storedMemory = (await kv.get(
      KV.memories,
      "mem_secret",
    )) as (Memory & {
      writeGate?: {
        pass: boolean;
        reasons: string[];
        flags: string[];
        sensitivityLabels: string[];
      };
    }) | null;
    expect(storedMemory).not.toBeNull();
    expect(JSON.stringify(storedMemory)).not.toContain(secret);
    expect(storedMemory).toMatchObject({
      lifecycleState: "quarantined",
      reviewState: "needs_review",
      privacyScope: "team",
      redactionApplied: true,
    });
    expect(storedMemory?.sensitivityLabels).toContain("github_token");
    expect(storedMemory?.writeGate?.pass).toBe(false);
    expect(storedMemory?.writeGate?.reasons).toContain("sensitive_content");
    expect(storedMemory?.writeGate?.flags).toContain("sensitivity_detected");

    const storedObservation = await kv.get<Record<string, unknown>>(
      KV.observations("ses_secret"),
      "obs_secret",
    );
    expect(JSON.stringify(storedObservation)).not.toContain(secret);
    expect(JSON.stringify(storedObservation)).toContain("[REDACTED_SECRET]");

    const storedHistory = await kv.get<MemoryRevision>(
      KV.memoryHistory,
      "rev_secret",
    );
    expect(JSON.stringify(storedHistory)).not.toContain(secret);
    expect(JSON.stringify(storedHistory)).toContain("[REDACTED_SECRET]");
  });

  it("redacts secret-bearing optional import sections before persistence", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [
        {
          id: "node_secret",
          type: "concept",
          name: `Secret graph ${secret}`,
          properties: { note: `Nested ${secret}` },
          sourceObservationIds: [],
          createdAt: "2026-02-01T10:00:00Z",
        },
      ],
      graphEdges: [
        {
          id: "edge_secret",
          type: "related_to",
          sourceNodeId: "node_secret",
          targetNodeId: "node_other",
          weight: 1,
          sourceObservationIds: [],
          createdAt: "2026-02-01T10:00:00Z",
          context: { reasoning: `because ${secret}` },
        },
      ],
      semanticMemories: [
        {
          id: "sem_secret",
          fact: `Semantic fact ${secret}`,
          confidence: 0.8,
          sourceSessionIds: [],
          sourceMemoryIds: [],
          accessCount: 0,
          lastAccessedAt: "2026-02-01T10:00:00Z",
          strength: 1,
          createdAt: "2026-02-01T10:00:00Z",
          updatedAt: "2026-02-01T10:00:00Z",
        },
      ],
      actions: [
        {
          id: "act_secret",
          title: `Action ${secret}`,
          description: "Follow up",
          status: "pending",
          priority: 1,
          createdAt: "2026-02-01T10:00:00Z",
          updatedAt: "2026-02-01T10:00:00Z",
          createdBy: "agent",
          tags: [],
          sourceObservationIds: [],
          sourceMemoryIds: [],
        },
      ],
      lessons: [
        {
          id: "lesson_secret",
          content: `Lesson ${secret}`,
          context: "import",
          confidence: 0.7,
          reinforcements: 0,
          source: "manual",
          sourceIds: [],
          tags: [],
          createdAt: "2026-02-01T10:00:00Z",
          updatedAt: "2026-02-01T10:00:00Z",
          decayRate: 0.01,
        },
      ],
      insights: [
        {
          id: "insight_secret",
          title: `Insight ${secret}`,
          content: "Imported insight",
          confidence: 0.7,
          reinforcements: 0,
          sourceConceptCluster: [],
          sourceMemoryIds: [],
          sourceLessonIds: [],
          sourceCrystalIds: [],
          tags: [],
          createdAt: "2026-02-01T10:00:00Z",
          updatedAt: "2026-02-01T10:00:00Z",
          decayRate: 0.01,
        },
      ],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as {
      success: boolean;
      quarantined: number;
      quarantine: { entries: Array<{ section: string; reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.quarantined).toBe(6);
    expect(result.quarantine.entries.map((entry) => entry.reason)).toEqual(
      Array.from({ length: 6 }, () => "optional_row_redacted_or_sensitive"),
    );
    expect(result.quarantine.entries.map((entry) => entry.section)).toEqual([
      "graphNodes",
      "graphEdges",
      "semanticMemories",
      "actions",
      "lessons",
      "insights",
    ]);

    const storedRows = [
      await kv.get(KV.graphNodes, "node_secret"),
      await kv.get(KV.graphEdges, "edge_secret"),
      await kv.get(KV.semantic, "sem_secret"),
      await kv.get(KV.actions, "act_secret"),
      await kv.get(KV.lessons, "lesson_secret"),
      await kv.get(KV.insights, "insight_secret"),
    ];
    expect(JSON.stringify(storedRows)).not.toContain(secret);
    expect(JSON.stringify(storedRows)).toContain("[REDACTED_SECRET]");
  });

  it("rejects core manifest count mismatches", async () => {
    const exportData = (await sdk.trigger("mem::export", {})) as ExportData;
    exportData.manifest!.counts.observationBuckets = 0;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("observationBuckets");
    expect(result.error).toContain("manifest_count_mismatch");
  });

  it("rejects malformed manifest hash digests", async () => {
    const exportData = (await sdk.trigger("mem::export", {})) as ExportData;
    exportData.manifest!.hashes.agentEvents = "not-a-sha";

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("manifest.hashes.agentEvents must be a sha256 hex digest");
  });

  it("quarantines optional sections with manifest hash mismatches", async () => {
    const exportData = (await sdk.trigger("mem::export", {})) as ExportData;
    exportData.manifest!.hashes.agentEvents = "0".repeat(64);
    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const result = (await freshSdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as {
      success: boolean;
      agentEvents: number;
      quarantined: number;
      integrity: { checked: boolean; ok: boolean };
      quarantine: { entries: Array<{ section: string; reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.agentEvents).toBe(0);
    expect(result.quarantined).toBe(1);
    expect(result.integrity).toMatchObject({ checked: true, ok: false });
    expect(result.quarantine.entries).toEqual([
      { section: "agentEvents", reason: "manifest_hash_mismatch", count: 1 },
    ]);
    expect(await freshKv.list<AgentEvent>(KV.agentEvents)).toEqual([]);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  it("restores existing data and audits intent when replace delete fails mid-pass", async () => {
    const baseKv = mockKV();
    let failOnMemoryDelete = false;
    const failingKv = {
      ...baseKv,
      delete: async (scope: string, key: string): Promise<void> => {
        if (failOnMemoryDelete && scope === KV.memories) {
          throw new Error("simulated KV delete failure");
        }
        return baseKv.delete(scope, key);
      },
    };
    const failingSdk = mockSdk();
    registerExportImportFunction(failingSdk as never, failingKv as never);

    await baseKv.set(KV.sessions, "ses_1", testSession);
    await baseKv.set(KV.observations("ses_1"), "obs_1", testObs);
    await baseKv.set(KV.memories, "mem_1", testMemory);
    await baseKv.set(KV.summaries, "ses_1", testSummary);

    failOnMemoryDelete = true;

    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await failingSdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("existing data was restored");

    // Sessions and observations were deleted before the memory delete threw;
    // rollback must put everything back exactly as it was.
    expect(await baseKv.get(KV.sessions, "ses_1")).toEqual(testSession);
    expect(await baseKv.get(KV.observations("ses_1"), "obs_1")).toEqual(
      testObs,
    );
    expect(await baseKv.get(KV.memories, "mem_1")).toEqual(testMemory);
    expect(await baseKv.get(KV.summaries, "ses_1")).toEqual(testSummary);
    // The new session must NOT have been written (import never reached writes).
    expect(await baseKv.get(KV.sessions, "ses_new")).toBeNull();

    // The destructive intent was audited before the delete pass began.
    const audit = (await baseKv.list(KV.audit)) as Array<{
      operation: string;
      details?: { phase?: string };
    }>;
    expect(
      audit.some(
        (entry) =>
          entry.operation === "import" &&
          entry.details?.phase === "replace-pre-delete",
      ),
    ).toBe(true);
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
    expect(reExported.agentEvents?.length).toBe(exported.agentEvents?.length);
  });

  it("quarantines invalid and redacted imported agent events", async () => {
    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const validEvent: AgentEvent = {
      ...testAgentEvent,
      id: "agevt_valid",
    };
    const invalidTypeEvent = {
      ...testAgentEvent,
      id: "agevt_invalid",
      type: "not_an_event",
    } as unknown as AgentEvent;
    const redactedEvent: AgentEvent = {
      ...testAgentEvent,
      id: "agevt_redacted",
      redactionApplied: true,
      sensitivityLabels: ["secret"],
    };
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      agentEvents: [validEvent, invalidTypeEvent, redactedEvent],
    };

    const result = (await freshSdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as {
      success: boolean;
      agentEvents: number;
      skipped: number;
      quarantined: number;
      quarantine: { count: number; entries: Array<{ reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.agentEvents).toBe(1);
    // `skipped` now counts only already-exists skips (item 17): quarantined
    // events are reported separately under `quarantined` and are no longer
    // double-counted as skipped.
    expect(result.skipped).toBe(0);
    expect(result.quarantined).toBe(2);
    expect(result.quarantine.count).toBe(2);
    expect(result.quarantine.entries.map((entry) => entry.reason)).toEqual([
      "agent_event_invalid_type",
      "agent_event_redacted_or_sensitive",
    ]);
    const importedEvents = await freshKv.list<AgentEvent>("mem:agent-events");
    expect(importedEvents.map((event) => event.id)).toEqual(["agevt_valid"]);
  });

  it("quarantines duplicate and malformed imported agent events", async () => {
    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const validEvent: AgentEvent = {
      ...testAgentEvent,
      id: "agevt_unique",
    };
    const duplicateEvent: AgentEvent = {
      ...testAgentEvent,
      id: "agevt_unique",
      timestamp: "2026-02-01T10:02:00Z",
    };
    const malformedArrayEvent = {
      ...testAgentEvent,
      id: "agevt_bad_array",
      memoryIds: ["mem_1", 7],
    } as unknown as AgentEvent;
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      agentEvents: [validEvent, duplicateEvent, malformedArrayEvent],
    };

    const result = (await freshSdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as {
      success: boolean;
      agentEvents: number;
      quarantined: number;
      quarantine: { entries: Array<{ reason: string }> };
    };

    expect(result.success).toBe(true);
    expect(result.agentEvents).toBe(1);
    expect(result.quarantined).toBe(2);
    expect(result.quarantine.entries.map((entry) => entry.reason)).toEqual([
      "agent_event_duplicate_id",
      "agent_event_memoryIds_must_be_string_array",
    ]);
    expect((await freshKv.list<AgentEvent>(KV.agentEvents)).map((event) => event.id)).toEqual([
      "agevt_unique",
    ]);
  });

  it("replace removes derived indexes for replaced agent events", async () => {
    await kv.set(KV.agentEventIndexes, "memoryId:mem_1", {
      eventIds: ["agevt_1"],
      updatedAt: "2026-02-01T10:01:00Z",
    });
    const exportData: ExportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(await kv.get(KV.agentEvents, "agevt_1")).toBeNull();
    expect(await kv.get(KV.agentEventIndexes, "memoryId:mem_1")).toBeNull();
  });

  it("rejects malformed optional arrays with a section-specific error", async () => {
    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      agentEvents: { id: "agevt_bad" },
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("agentEvents must be an array when provided; received object");
  });

  it("rejects malformed optional rows before replace deletes existing state", async () => {
    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      graphNodes: [{ label: "missing id" }],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("graphNodes[0].id must be a non-empty string");
    expect(await kv.get("mem:sessions", "ses_1")).toEqual(testSession);
    expect(await kv.get("mem:memories", "mem_1")).toEqual(testMemory);
    expect(await kv.get("mem:obs:ses_1", "obs_1")).toEqual(testObs);
    expect((await kv.list("mem:audit")).length).toBe(0);
  });

  it("rejects malformed current-version core rows before mutation", async () => {
    const exportData = {
      version: "0.9.27",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "" }],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("sessions[0].id must be a non-empty string");
    expect((await kv.list("mem:audit")).length).toBe(0);
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });
});
