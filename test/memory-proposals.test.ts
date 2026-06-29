import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/state/keyed-mutex.js", () => ({
  withKeyedLock: <T>(_key: string, fn: () => Promise<T>) => fn(),
}));

import { mockKV, mockSdk } from "./helpers/mocks.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerMemoryLifecycleFunctions } from "../src/functions/memory-lifecycle.js";
import {
  registerMemoryProposalFunctions,
  type MemoryProposal,
} from "../src/functions/memory-proposals.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import type { AuditEntry, Memory } from "../src/types.js";

const READ = { permissions: ["project:read"], actorId: "reader" };
const WRITE = { permissions: ["project:write"], actorId: "writer" };
const GOVERN = {
  permissions: ["project:write", "governance:delete"],
  actorId: "governor",
};

describe("memory proposal functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    getSearchIndex().clear();
    setIndexPersistence(null);
    registerRememberFunction(sdk as never, kv as never);
    registerMemoryLifecycleFunctions(sdk as never, kv as never);
    registerMemoryProposalFunctions(sdk as never, kv as never);
    sdk.registerFunction("mem::cascade-update", async () => ({ success: true }));
  });

  async function createProposal(
    input: Record<string, unknown>,
  ): Promise<{ success: true; proposal: MemoryProposal }> {
    return sdk.trigger("mem::memory-proposal-create", {
      ...WRITE,
      project: "billing",
      ...input,
    }) as Promise<{ success: true; proposal: MemoryProposal }>;
  }

  it("requires request-scoped permissions to propose and list changes", async () => {
    const denied = (await sdk.trigger("mem::memory-proposal-create", {
      action: "create",
      project: "billing",
      change: {
        content: "Billing memory proposals must require project write permission",
      },
    })) as { success: boolean; error: string };

    expect(denied.success).toBe(false);
    expect(denied.error).toContain("project:write");

    const created = await createProposal({
      action: "create",
      title: "Capture billing provenance",
      reason: "team memory PR",
      change: {
        content: "Billing proposal memory keeps local review provenance intact",
        type: "fact",
        sourceObservationIds: ["obs_prop_create"],
        sourceUri: "file:///repo/billing/notes.md",
      },
      provenance: {
        source: "local-team-pr",
        sessionId: "ses_prop_create",
      },
    });

    expect(created.success).toBe(true);
    expect(created.proposal.status).toBe("pending");
    expect(created.proposal.requiredPermissions).toEqual(["project:write"]);
    expect(created.proposal.proposedBy).toBe("writer");
    expect(created.proposal.provenance).toMatchObject({
      source: "local-team-pr",
      sessionId: "ses_prop_create",
    });

    const listDenied = (await sdk.trigger("mem::memory-proposal-list", {
      project: "billing",
      permissions: ["project:write"],
    })) as { success: boolean; error: string };

    expect(listDenied.success).toBe(false);
    expect(listDenied.error).toContain("project:read");

    const listed = (await sdk.trigger("mem::memory-proposal-list", {
      ...READ,
      project: "billing",
    })) as { success: true; proposals: MemoryProposal[]; total: number };

    expect(listed.success).toBe(true);
    expect(listed.total).toBe(1);
    expect(listed.proposals[0].id).toBe(created.proposal.id);

    const auditRows = await kv.list<AuditEntry>("mem:audit");
    const proposalAudit = auditRows.find(
      (row) => row.functionId === "mem::memory-proposal-create",
    );
    expect(proposalAudit?.userId).toBe("writer");
    expect(proposalAudit?.details).toMatchObject({
      proposalId: created.proposal.id,
      project: "billing",
      action: "create",
      status: "pending",
    });
  });

  it("approves and rejects proposals with request-local role grants", async () => {
    const approveMe = await createProposal({
      action: "create",
      change: {
        content: "Approved proposal should move through the pending review state",
        type: "workflow",
      },
    });
    const rejectMe = await createProposal({
      action: "create",
      change: {
        content: "Rejected proposal should preserve reviewer provenance",
        type: "fact",
      },
    });

    const approved = (await sdk.trigger("mem::memory-proposal-approve", {
      proposalId: approveMe.proposal.id,
      actorId: "owner",
      roles: {
        owner: ["project:*"],
      },
      reason: "ready for local apply",
    })) as { success: true; proposal: MemoryProposal };

    expect(approved.success).toBe(true);
    expect(approved.proposal.status).toBe("approved");
    expect(approved.proposal.reviewedBy).toBe("owner");
    expect(approved.proposal.reviewReason).toBe("ready for local apply");

    const rejected = (await sdk.trigger("mem::memory-proposal-reject", {
      proposalId: rejectMe.proposal.id,
      actorId: "maintainer",
      permissions: ["project:write"],
      reason: "needs a narrower source",
    })) as { success: true; proposal: MemoryProposal };

    expect(rejected.success).toBe(true);
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposal.reviewedBy).toBe("maintainer");

    const applyRejected = (await sdk.trigger("mem::memory-proposal-apply", {
      proposalId: rejectMe.proposal.id,
      permissions: ["project:write"],
    })) as { success: boolean; error: string };

    expect(applyRejected.success).toBe(false);
    expect(applyRejected.error).toBe("proposal is rejected");
  });

  it("applies an approved create proposal through mem::memory-create", async () => {
    const created = await createProposal({
      action: "create",
      change: {
        content:
          "Applied memory proposal should delegate creation and keep source provenance",
        type: "architecture",
        concepts: ["billing", "proposal"],
        files: ["src/billing.ts"],
        sourceObservationIds: ["obs_apply_create"],
        sourceType: "manual",
        sourceUri: "file:///repo/billing/apply.md",
      },
    });

    await sdk.trigger("mem::memory-proposal-approve", {
      ...WRITE,
      proposalId: created.proposal.id,
    });

    const applied = (await sdk.trigger("mem::memory-proposal-apply", {
      ...WRITE,
      proposalId: created.proposal.id,
      reason: "merge approved team memory PR",
    })) as {
      success: true;
      proposal: MemoryProposal;
      result: { success: true; memory: Memory };
    };

    expect(applied.success).toBe(true);
    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.application?.functionId).toBe("mem::memory-create");
    expect(applied.proposal.application?.targetIds).toContain(
      applied.result.memory.id,
    );

    const stored = await kv.get<Memory>("mem:memories", applied.result.memory.id);
    expect(stored).toMatchObject({
      project: "billing",
      sourceObservationIds: ["obs_apply_create"],
      sourceType: "manual",
      sourceUri: "file:///repo/billing/apply.md",
    });

    const auditRows = await kv.list<AuditEntry>("mem:audit");
    expect(
      auditRows.some((row) => row.functionId === "mem::remember"),
    ).toBe(true);
    expect(
      auditRows.some(
        (row) =>
          row.functionId === "mem::memory-proposal-apply" &&
          row.details?.applyFunctionId === "mem::memory-create",
      ),
    ).toBe(true);
  });

  it("requires governance delete before approving or applying deletion proposals", async () => {
    const remembered = (await sdk.trigger("mem::remember", {
      content: "Deletion proposal governance must guard this shared fact",
      type: "fact",
      project: "billing",
    })) as { memory: Memory };

    const proposal = await createProposal({
      action: "delete",
      change: {
        memoryId: remembered.memory.id,
        mode: "tombstone",
      },
      reason: "remove stale team memory",
    });

    expect(proposal.proposal.requiredPermissions).toEqual([
      "project:write",
      "governance:delete",
    ]);

    const approveDenied = (await sdk.trigger("mem::memory-proposal-approve", {
      ...WRITE,
      proposalId: proposal.proposal.id,
    })) as { success: boolean; error: string };

    expect(approveDenied.success).toBe(false);
    expect(approveDenied.error).toContain("governance:delete");

    const approved = (await sdk.trigger("mem::memory-proposal-approve", {
      ...GOVERN,
      proposalId: proposal.proposal.id,
    })) as { success: true; proposal: MemoryProposal };

    expect(approved.success).toBe(true);
    expect(approved.proposal.status).toBe("approved");

    const applyDenied = (await sdk.trigger("mem::memory-proposal-apply", {
      ...WRITE,
      proposalId: proposal.proposal.id,
    })) as { success: boolean; error: string };

    expect(applyDenied.success).toBe(false);
    expect(applyDenied.error).toContain("governance:delete");

    const applied = (await sdk.trigger("mem::memory-proposal-apply", {
      ...GOVERN,
      proposalId: proposal.proposal.id,
      reason: "approved local governance deletion",
    })) as { success: true; proposal: MemoryProposal };

    expect(applied.success).toBe(true);
    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.application?.functionId).toBe("mem::memory-delete");

    const stored = await kv.get<Memory>("mem:memories", remembered.memory.id);
    expect(stored?.lifecycleState).toBe("tombstoned");

    const auditRows = await kv.list<AuditEntry>("mem:audit");
    expect(
      auditRows.some((row) => row.functionId === "mem::memory-delete"),
    ).toBe(true);
    expect(
      auditRows.some(
        (row) =>
          row.functionId === "mem::memory-proposal-apply" &&
          row.details?.applyFunctionId === "mem::memory-delete",
      ),
    ).toBe(true);
  });
});
