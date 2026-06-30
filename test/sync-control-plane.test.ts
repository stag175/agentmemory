import { beforeEach, describe, expect, it } from "vitest";
import { registerSyncControlPlaneFunctions } from "../src/functions/sync-control-plane.js";
import { KV } from "../src/state/schema.js";
import type { AuditEntry } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

describe("managed sync control plane", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerSyncControlPlaneFunctions(sdk as never, kv as never);
  });

  it("registers local peers with loopback defaults and sanitized audit evidence", async () => {
    const result = (await sdk.trigger("mem::sync-peer-register", {
      name: "Laptop local",
    })) as {
      success: boolean;
      peer: {
        id: string;
        mode: string;
        endpoint: string;
        loopback: boolean;
        authPolicy: { kind: string };
        scopePolicy: { allowedScopes: string[]; remoteModeApproved: boolean };
      };
    };

    expect(result.success).toBe(true);
    expect(result.peer.id).toMatch(/^syncpeer_/);
    expect(result.peer.mode).toBe("local");
    expect(result.peer.endpoint).toBe("http://127.0.0.1:3111/");
    expect(result.peer.loopback).toBe(true);
    expect(result.peer.authPolicy.kind).toBe("none");
    expect(result.peer.scopePolicy.remoteModeApproved).toBe(false);
    expect(result.peer.scopePolicy.allowedScopes).toContain("memories");

    const audits = await kv.list<AuditEntry>(KV.audit);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.operation).toBe("mesh_sync");
    expect(audits[0]?.functionId).toBe("mem::sync-peer-register");
    expect(audits[0]?.details).toMatchObject({
      action: "sync.peer.register",
      peer: {
        mode: "local",
        endpointHost: "127.0.0.1",
        loopback: true,
        authKind: "none",
      },
    });
  });

  it("requires explicit auth and scope policy for remote peers and never stores raw tokens", async () => {
    const missingPolicy = (await sdk.trigger("mem::sync-peer-register", {
      name: "Remote peer",
      mode: "remote",
      endpoint: "https://sync.example.com/agentmemory",
    })) as { success: boolean; error: string };

    expect(missingPolicy.success).toBe(false);
    expect(missingPolicy.error).toContain("authPolicy");

    const rawSecret = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJ";
    const rawPolicy = (await sdk.trigger("mem::sync-peer-register", {
      name: "Remote peer",
      mode: "remote",
      endpoint: "https://sync.example.com/agentmemory",
      authPolicy: { kind: "bearer", token: rawSecret },
      scopePolicy: {
        allowedScopes: ["memories"],
        direction: "push",
        remoteModeApproved: true,
      },
    })) as { success: boolean; error: string };

    expect(rawPolicy.success).toBe(false);
    expect(rawPolicy.error).toContain("not include raw secrets");

    const registered = (await sdk.trigger("mem::sync-peer-register", {
      name: "Remote peer",
      mode: "remote",
      endpoint: "https://sync.example.com/agentmemory?token=should-strip",
      authPolicy: { kind: "bearer", tokenEnv: "AGENTMEMORY_SYNC_TOKEN" },
      scopePolicy: {
        allowedScopes: ["memories", "actions"],
        direction: "push",
        remoteModeApproved: true,
      },
    })) as {
      success: boolean;
      peer: {
        endpoint: string;
        mode: string;
        authPolicy: { kind: string; tokenEnv?: string };
        scopePolicy: { allowedScopes: string[]; remoteModeApproved: boolean };
      };
    };

    expect(registered.success).toBe(true);
    expect(registered.peer.mode).toBe("remote");
    expect(registered.peer.endpoint).toBe("https://sync.example.com/agentmemory");
    expect(registered.peer.authPolicy).toEqual({
      kind: "bearer",
      tokenEnv: "AGENTMEMORY_SYNC_TOKEN",
    });
    expect(registered.peer.scopePolicy.remoteModeApproved).toBe(true);
    expect(JSON.stringify(await kv.list(KV.state))).not.toContain(rawSecret);
    expect(JSON.stringify(await kv.list(KV.audit))).not.toContain(rawSecret);
  });

  it("builds a dry-run local sync plan without performing network work", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
      endpoint: "http://localhost:3111",
      scopePolicy: { allowedScopes: ["memories", "actions"], direction: "both" },
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Agentmemory workspace",
      workspaceRoot: "C:\\Users\\charl\\OneDrive\\Documents\\Agentmemory V2.0",
      allowedScopes: ["memories", "actions", "relations"],
    })) as { workspace: { id: string } };

    const result = (await sdk.trigger("mem::sync-plan", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "push",
      scopes: ["memories", "actions"],
      dryRun: false,
    })) as {
      success: boolean;
      plan: {
        dryRun: boolean;
        warnings: string[];
        summary: { ready: number; blocked: number };
        actions: Array<{ status: string; scopes: string[]; dryRun: boolean }>;
      };
    };

    expect(result.success).toBe(true);
    expect(result.plan.dryRun).toBe(true);
    expect(result.plan.warnings).toEqual([
      "sync plans are dry-run only in this control-plane foundation",
    ]);
    expect(result.plan.summary).toEqual({
      peers: 1,
      workspaces: 1,
      ready: 1,
      blocked: 0,
    });
    expect(result.plan.actions[0]).toMatchObject({
      status: "ready",
      scopes: ["memories", "actions"],
      dryRun: true,
    });
  });

  it("blocks remote plans for local-only workspaces until the workspace is explicitly remote-capable", async () => {
    const remotePeer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Remote peer",
      mode: "remote",
      endpoint: "https://sync.example.com/agentmemory",
      authPolicy: { kind: "signed-request", secretRef: "local-vault:sync" },
      scopePolicy: {
        allowedScopes: ["memories"],
        direction: "push",
        remoteModeApproved: true,
      },
    })) as { peer: { id: string } };
    const localOnly = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Local only",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const blocked = (await sdk.trigger("mem::sync-plan", {
      peerId: remotePeer.peer.id,
      workspaceId: localOnly.workspace.id,
      direction: "push",
      scopes: ["memories"],
    })) as {
      plan: { summary: { ready: number; blocked: number }; actions: Array<{ reasons: string[] }> };
    };

    expect(blocked.plan.summary).toMatchObject({ ready: 0, blocked: 1 });
    expect(blocked.plan.actions[0]?.reasons).toContain("workspace is local-only");

    const remoteCapable = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Remote capable",
      localOnly: false,
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const ready = (await sdk.trigger("mem::sync-plan", {
      peerId: remotePeer.peer.id,
      workspaceId: remoteCapable.workspace.id,
      direction: "push",
      scopes: ["memories"],
    })) as { plan: { summary: { ready: number; blocked: number } } };

    expect(ready.plan.summary).toMatchObject({ ready: 1, blocked: 0 });
  });

  it("records sanitized sync runs and exposes status without leaking evidence secrets", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const run = (await sdk.trigger("mem::sync-run-record", {
      planId: "syncplan_test",
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "push",
      status: "failed",
      itemCounts: { memories: 3 },
      errors: [`failed with ${secret}`],
      evidence: {
        authorization: `Bearer ${secret}`,
        callback: `https://user:pass@example.com/path?token=${secret}`,
        note: `operator pasted ${secret}`,
      },
    })) as {
      success: boolean;
      run: {
        id: string;
        status: string;
        errors: string[];
        evidence: { authorization?: string; callback?: string; note?: string };
      };
    };

    expect(run.success).toBe(true);
    expect(run.run.id).toMatch(/^syncrun_/);
    expect(run.run.status).toBe("failed");
    expect(run.run.errors[0]).toContain("[REDACTED_SECRET]");
    expect(run.run.evidence.authorization).toBe("[REDACTED_SECRET]");
    expect(run.run.evidence.callback).toBe("https://example.com/path");
    expect(run.run.evidence.note).toContain("[REDACTED_SECRET]");

    const status = (await sdk.trigger("mem::sync-status", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
    })) as { success: boolean; status: { runs: unknown[]; summary: { runs: number } } };

    expect(status.success).toBe(true);
    expect(status.status.summary.runs).toBe(1);
    expect(status.status.runs).toHaveLength(1);

    const serializedState = JSON.stringify(await kv.list(KV.state));
    const serializedAudit = JSON.stringify(await kv.list(KV.audit));
    expect(serializedState).not.toContain(secret);
    expect(serializedAudit).not.toContain(secret);
  });

  it("requires approval before materializing local apply snapshots", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };
    const exportData = {
      version: "0.9.27",
      exportedAt: "2026-06-29T12:00:00.000Z",
      memories: [{ id: "mem_a", content: "local snapshot", updatedAt: "2026-06-29T12:00:00.000Z" }],
    };

    const denied = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      exportData,
    })) as { success: boolean; error: string };

    expect(denied.success).toBe(false);
    expect(denied.error).toContain("approved true");

    const dryRun = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      exportData,
    })) as {
      success: boolean;
      apply: {
        status: string;
        dryRun: boolean;
        itemCounts: Record<string, number>;
        appliedCounts: Record<string, number>;
      };
    };

    expect(dryRun.success).toBe(true);
    expect(dryRun.apply.status).toBe("planned");
    expect(dryRun.apply.dryRun).toBe(true);
    expect(dryRun.apply.itemCounts.memories).toBe(1);
    expect(dryRun.apply.appliedCounts.memories).toBe(0);

    const status = (await sdk.trigger("mem::sync-status", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
    })) as { status: { applyRecords: unknown[]; runs: unknown[] } };

    expect(status.status.applyRecords).toHaveLength(0);
    expect(status.status.runs).toHaveLength(0);
  });

  it("applies local memory snapshots into a sanitized snapshot and run ledger", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

    const result = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        version: "0.9.27",
        exportedAt: "2026-06-29T12:00:00.000Z",
        memories: [
          {
            id: "mem_a",
            content: `operator pasted ${secret}`,
            updatedAt: "2026-06-29T12:00:00.000Z",
          },
        ],
      },
    })) as {
      success: boolean;
      apply: { status: string; snapshotIds: string[]; appliedCounts: Record<string, number> };
      run: { status: string; itemCounts: Record<string, number> };
    };

    expect(result.success).toBe(true);
    expect(result.apply.status).toBe("applied");
    expect(result.apply.snapshotIds).toHaveLength(1);
    expect(result.apply.appliedCounts.memories).toBe(1);
    expect(result.run.status).toBe("succeeded");
    expect(result.run.itemCounts.memories).toBe(1);

    const state = await kv.list<Record<string, unknown>>(KV.state);
    const snapshot = state.find((entry) => entry.kind === "sync-snapshot") as {
      payload: { content: string };
      digest: string;
    };
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.payload.content).toContain("[REDACTED_SECRET]");
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(JSON.stringify(await kv.list(KV.audit))).not.toContain(secret);

    const status = (await sdk.trigger("mem::sync-status", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
    })) as {
      status: {
        applyRecords: unknown[];
        runs: unknown[];
        summary: { applyRecords: number; runs: number };
      };
    };

    expect(status.status.applyRecords).toHaveLength(1);
    expect(status.status.runs).toHaveLength(1);
    expect(status.status.summary).toMatchObject({ applyRecords: 1, runs: 1 });
  });

  it("rejects conflicting duplicate rows within one local snapshot", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const result = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [
          { id: "mem_a", content: "first" },
          { id: "mem_a", content: "second" },
        ],
      },
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("conflicts with another mem_a row");
  });

  it("blocks conflicting local snapshots unless merge is explicitly approved", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const first = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [{ id: "mem_a", content: "first", updatedAt: "2026-06-29T12:00:00.000Z" }],
      },
    })) as { apply: { snapshotIds: string[] } };

    const blocked = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [{ id: "mem_a", content: "second", updatedAt: "2026-06-29T12:01:00.000Z" }],
      },
    })) as {
      success: boolean;
      apply: {
        status: string;
        conflictCount: number;
        appliedCounts: Record<string, number>;
        conflicts: Array<{ snapshotId: string; existingDigest: string; incomingDigest: string }>;
      };
      run: { status: string };
    };

    expect(blocked.success).toBe(true);
    expect(blocked.apply.status).toBe("blocked");
    expect(blocked.apply.conflictCount).toBe(1);
    expect(blocked.apply.appliedCounts.memories).toBe(0);
    expect(blocked.apply.conflicts[0]?.snapshotId).toBe(first.apply.snapshotIds[0]);
    expect(blocked.apply.conflicts[0]?.existingDigest).not.toBe(
      blocked.apply.conflicts[0]?.incomingDigest,
    );
    expect(blocked.run.status).toBe("blocked");

    const merged = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      conflictPolicy: "merge",
      exportData: {
        memories: [{ id: "mem_a", content: "second", updatedAt: "2026-06-29T12:01:00.000Z" }],
      },
    })) as {
      apply: {
        status: string;
        conflictCount: number;
        appliedCounts: Record<string, number>;
        snapshotIds: string[];
      };
      run: { status: string };
    };

    expect(merged.apply.status).toBe("applied");
    expect(merged.apply.conflictCount).toBe(1);
    expect(merged.apply.appliedCounts.memories).toBe(1);
    expect(merged.apply.snapshotIds[0]).toBe(first.apply.snapshotIds[0]);
    expect(merged.run.status).toBe("succeeded");

    const state = await kv.list<Record<string, unknown>>(KV.state);
    const snapshot = state.find(
      (entry) => entry.kind === "sync-snapshot" && entry.id === first.apply.snapshotIds[0],
    ) as { payload: { content: string }; previousDigest?: string };
    expect(snapshot.payload.content).toBe("second");
    expect(snapshot.previousDigest).toBe(blocked.apply.conflicts[0]?.existingDigest);
  });

  it("heals a peer after a failed run so a later local apply is allowed again", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    // A single forgeable failed run must not permanently brick the peer.
    const failed = (await sdk.trigger("mem::sync-run-record", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      status: "failed",
      itemCounts: { memories: 1 },
    })) as { success: boolean };
    expect(failed.success).toBe(true);

    const afterFail = (await sdk.trigger("mem::sync-status", {
      peerId: peer.peer.id,
    })) as { status: { peers: Array<{ status: string; statusReasons: string[] }> } };
    expect(afterFail.status.peers[0]?.status).toBe("blocked");
    expect(afterFail.status.peers[0]?.statusReasons).toContain("last run failed");

    // A blocked peer cannot apply locally.
    const blockedApply = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [{ id: "mem_a", content: "x", updatedAt: "2026-06-29T12:00:00.000Z" }],
      },
    })) as { success: boolean; error?: string; reasons?: string[] };
    expect(blockedApply.success).toBe(false);
    expect(blockedApply.reasons).toContain("last run failed");

    // A subsequent succeeded run heals the peer (run status is untrusted ledger input).
    const healed = (await sdk.trigger("mem::sync-run-record", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      status: "succeeded",
      itemCounts: { memories: 1 },
    })) as { success: boolean };
    expect(healed.success).toBe(true);

    const afterHeal = (await sdk.trigger("mem::sync-status", {
      peerId: peer.peer.id,
    })) as { status: { peers: Array<{ status: string; statusReasons: string[] }> } };
    expect(afterHeal.status.peers[0]?.status).toBe("ready");
    expect(afterHeal.status.peers[0]?.statusReasons).not.toContain("last run failed");

    // The healed peer can now apply locally.
    const applied = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [{ id: "mem_a", content: "x", updatedAt: "2026-06-29T12:00:00.000Z" }],
      },
    })) as { success: boolean; apply?: { status: string } };
    expect(applied.success).toBe(true);
    expect(applied.apply?.status).toBe("applied");
  });

  it("clears a blocked peer through the explicit set-status path", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    await sdk.trigger("mem::sync-run-record", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      status: "failed",
      itemCounts: { memories: 1 },
    });

    const cleared = (await sdk.trigger("mem::sync-peer-set-status", {
      peerId: peer.peer.id,
    })) as { success: boolean; peer: { status: string; statusReasons: string[] } };
    expect(cleared.success).toBe(true);
    expect(cleared.peer.status).toBe("ready");
    expect(cleared.peer.statusReasons).not.toContain("last run failed");

    const disabled = (await sdk.trigger("mem::sync-peer-set-status", {
      peerId: peer.peer.id,
      enabled: false,
    })) as { success: boolean; peer: { status: string } };
    expect(disabled.success).toBe(true);
    expect(disabled.peer.status).toBe("disabled");
  });

  it("rejects spoofed loopback hostnames and accepts genuine loopback addresses", async () => {
    const spoofed = (await sdk.trigger("mem::sync-peer-register", {
      name: "Spoofed loopback",
      mode: "local",
      endpoint: "http://127.0.0.1.evil.com/",
    })) as { success: boolean; error?: string };
    expect(spoofed.success).toBe(false);
    expect(spoofed.error).toContain("remote endpoints require mode remote");

    const genuine = (await sdk.trigger("mem::sync-peer-register", {
      name: "Genuine loopback",
      mode: "local",
      endpoint: "http://127.0.0.1:4000/",
    })) as { success: boolean; peer: { loopback: boolean; endpointHost: string } };
    expect(genuine.success).toBe(true);
    expect(genuine.peer.loopback).toBe(true);
    expect(genuine.peer.endpointHost).toBe("127.0.0.1");

    // A spoofed loopback hostname is correctly classified as non-loopback, so it can
    // only register as a remote peer (and never satisfies local-apply loopback checks).
    const asRemote = (await sdk.trigger("mem::sync-peer-register", {
      name: "Spoofed as remote",
      mode: "remote",
      endpoint: "http://127.0.0.1.evil.com/",
      authPolicy: { kind: "bearer", tokenEnv: "TOK" },
      scopePolicy: { allowedScopes: ["memories"], direction: "pull", remoteModeApproved: true },
    })) as { success: boolean; peer: { loopback: boolean } };
    expect(asRemote.success).toBe(true);
    expect(asRemote.peer.loopback).toBe(false);
  });

  it("skips merge writes whose incoming row is older than the stored snapshot", async () => {
    const peer = (await sdk.trigger("mem::sync-peer-register", {
      name: "Local peer",
    })) as { peer: { id: string } };
    const workspace = (await sdk.trigger("mem::sync-workspace-register", {
      name: "Workspace",
      allowedScopes: ["memories"],
    })) as { workspace: { id: string } };

    const newer = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      exportData: {
        memories: [{ id: "mem_a", content: "newer", updatedAt: "2026-06-29T12:05:00.000Z" }],
      },
    })) as { apply: { snapshotIds: string[] } };

    const stale = (await sdk.trigger("mem::sync-local-apply", {
      peerId: peer.peer.id,
      workspaceId: workspace.workspace.id,
      direction: "pull",
      scopes: ["memories"],
      dryRun: false,
      approved: true,
      conflictPolicy: "merge",
      exportData: {
        // Older incoming row must not overwrite the newer stored snapshot.
        memories: [{ id: "mem_a", content: "older", updatedAt: "2026-06-29T12:00:00.000Z" }],
      },
    })) as {
      success: boolean;
      apply: {
        status: string;
        conflictCount: number;
        staleCount: number;
        appliedCounts: Record<string, number>;
        snapshotIds: string[];
        staleSkips: Array<{
          reason: string;
          snapshotId: string;
          incomingUpdatedAt?: string;
          existingUpdatedAt?: string;
        }>;
      };
    };

    expect(stale.success).toBe(true);
    expect(stale.apply.conflictCount).toBe(1);
    expect(stale.apply.staleCount).toBe(1);
    expect(stale.apply.appliedCounts.memories).toBe(0);
    expect(stale.apply.snapshotIds).toHaveLength(0);
    expect(stale.apply.staleSkips[0]?.reason).toBe("incoming_not_newer");
    expect(stale.apply.staleSkips[0]?.snapshotId).toBe(newer.apply.snapshotIds[0]);

    // The stored snapshot still holds the newer content.
    const state = await kv.list<Record<string, unknown>>(KV.state);
    const snapshot = state.find(
      (entry) => entry.kind === "sync-snapshot" && entry.id === newer.apply.snapshotIds[0],
    ) as { payload: { content: string } };
    expect(snapshot.payload.content).toBe("newer");
  });
});
