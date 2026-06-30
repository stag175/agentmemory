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
  createMemoryProposal,
  listMemoryProposals,
  approveMemoryProposal,
  rejectMemoryProposal,
  applyMemoryProposal,
  type MemoryProposal,
  type Principal,
} from "../src/functions/memory-proposals.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import type { AuditEntry, Memory } from "../src/types.js";

const READER: Principal = { actorId: "reader", permissions: ["project:read"] };
const WRITER: Principal = { actorId: "writer", permissions: ["project:write"] };
const REVIEWER: Principal = { actorId: "reviewer", permissions: ["project:write"] };
const GOVERNOR: Principal = {
  actorId: "governor",
  permissions: ["project:write", "governance:delete"],
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
    principal: Principal,
    input: Record<string, unknown>,
  ): Promise<{ success: true; proposal: MemoryProposal }> {
    const result = await createMemoryProposal(kv as never, principal, {
      project: "billing",
      ...input,
    });
    if (!result.success) throw new Error(`create failed: ${result.error}`);
    return result as { success: true; proposal: MemoryProposal };
  }

  it("requires project:write to propose and project:read to list", async () => {
    const denied = await createMemoryProposal(kv as never, READER, {
      action: "create",
      project: "billing",
      change: {
        content: "Billing memory proposals must require project write permission",
      },
    });

    expect(denied.success).toBe(false);
    expect((denied as { error: string }).error).toContain("project:write");

    const created = await createProposal(WRITER, {
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

    expect(created.proposal.status).toBe("pending");
    expect(created.proposal.requiredPermissions).toEqual(["project:write"]);
    expect(created.proposal.proposedBy).toBe("writer");

    const listDenied = await listMemoryProposals(kv as never, WRITER, {
      project: "billing",
    });
    // project:write alone does not satisfy project:read.
    expect(listDenied.success).toBe(false);
    expect((listDenied as { error: string }).error).toContain("project:read");

    const listed = await listMemoryProposals(kv as never, READER, {
      project: "billing",
    });
    expect(listed.success).toBe(true);
    if (!listed.success) throw new Error("list failed");
    expect(listed.total).toBe(1);
    expect(listed.proposals[0].id).toBe(created.proposal.id);
  });

  it("derives authorization only from the resolved principal, never from input fields", async () => {
    // Reader principal, but the (untrusted) input tries to smuggle elevated
    // permissions/roles. These input fields must be ignored entirely.
    const result = await createMemoryProposal(kv as never, READER, {
      action: "create",
      project: "billing",
      permissions: ["project:write"],
      roles: { admin: ["project:*"] },
      roleGrants: [{ name: "admin", permissions: ["governance:delete"] }],
      actorId: "attacker",
      change: { content: "Smuggled authorization must not be honored" },
    });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("project:write");
  });

  it("never honors a body-supplied or principal-supplied '*' wildcard", async () => {
    // A forged "*" in the principal must be stripped and ignored, so the
    // principal is treated as having no concrete grants.
    const forged: Principal = { actorId: "ghost", permissions: ["*"] };
    const result = await createMemoryProposal(kv as never, forged, {
      action: "create",
      project: "billing",
      change: { content: "Wildcard permission must not authorize a write" },
    });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("project:write");

    // Even a wildcard mixed with the domain wildcard form is rejected for
    // governance — only concrete grants count.
    const remembered = (await sdk.trigger("mem::remember", {
      content: "Deletion guard fact for wildcard test",
      type: "fact",
      project: "billing",
    })) as { memory: Memory };
    const deleteProposal = await createProposal(GOVERNOR, {
      action: "delete",
      change: { memoryId: remembered.memory.id, mode: "tombstone" },
    });
    const wildcardApprove = await approveMemoryProposal(kv as never, forged, {
      proposalId: deleteProposal.proposal.id,
    });
    expect(wildcardApprove.success).toBe(false);
    expect((wildcardApprove as { error: string }).error).toContain("project:write");
  });

  it("denies self-approval unless teamPolicy.allowSelfApproval is true", async () => {
    const created = await createProposal(WRITER, {
      action: "create",
      change: { content: "Self approval must be blocked by separation of duties" },
    });

    // The proposer (writer) cannot approve their own proposal.
    const selfApprove = await approveMemoryProposal(kv as never, WRITER, {
      proposalId: created.proposal.id,
    });
    expect(selfApprove.success).toBe(false);
    expect((selfApprove as { error: string }).error).toContain("self-approval");

    // A different reviewer can.
    const peerApprove = await approveMemoryProposal(kv as never, REVIEWER, {
      proposalId: created.proposal.id,
      reason: "peer reviewed",
    });
    expect(peerApprove.success).toBe(true);
    if (!peerApprove.success || !peerApprove.proposal) throw new Error("approve failed");
    expect(peerApprove.proposal.status).toBe("approved");
    expect(peerApprove.proposal.reviewedBy).toBe("reviewer");

    // With allowSelfApproval, the proposer may approve their own proposal.
    const selfServe: Principal = {
      actorId: "writer",
      permissions: ["project:write"],
      teamPolicy: { allowSelfApproval: true },
    };
    const created2 = await createProposal(WRITER, {
      action: "create",
      change: { content: "Self approval allowed when team policy opts in" },
    });
    const allowed = await approveMemoryProposal(kv as never, selfServe, {
      proposalId: created2.proposal.id,
    });
    expect(allowed.success).toBe(true);
    if (!allowed.success || !allowed.proposal) throw new Error("self-approve failed");
    expect(allowed.proposal.status).toBe("approved");
    expect(allowed.proposal.reviewedBy).toBe("writer");
  });

  it("requires the proposal's governance permissions to reject a delete proposal", async () => {
    const remembered = (await sdk.trigger("mem::remember", {
      content: "Deletion proposal governance must guard reject parity",
      type: "fact",
      project: "billing",
    })) as { memory: Memory };

    const deleteProposal = await createProposal(GOVERNOR, {
      action: "delete",
      change: { memoryId: remembered.memory.id, mode: "tombstone" },
      reason: "remove stale team memory",
    });
    expect(deleteProposal.proposal.requiredPermissions).toEqual([
      "project:write",
      "governance:delete",
    ]);

    // A project:write-only actor must NOT be able to veto a governance-gated
    // delete proposal.
    const rejectDenied = await rejectMemoryProposal(kv as never, WRITER, {
      proposalId: deleteProposal.proposal.id,
      reason: "trying to veto without governance",
    });
    expect(rejectDenied.success).toBe(false);
    expect((rejectDenied as { error: string }).error).toContain("governance:delete");

    // A governance actor can.
    const rejected = await rejectMemoryProposal(kv as never, GOVERNOR, {
      proposalId: deleteProposal.proposal.id,
      reason: "governance veto",
    });
    expect(rejected.success).toBe(true);
    if (!rejected.success || !rejected.proposal) throw new Error("reject failed");
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposal.reviewedBy).toBe("governor");
  });

  it("rejects a non-governance create proposal with project:write", async () => {
    const created = await createProposal(WRITER, {
      action: "create",
      change: { content: "Reject parity still allows write veto on write proposals" },
    });
    const rejected = await rejectMemoryProposal(kv as never, REVIEWER, {
      proposalId: created.proposal.id,
      reason: "needs a narrower source",
    });
    expect(rejected.success).toBe(true);
    if (!rejected.success || !rejected.proposal) throw new Error("reject failed");
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposal.reviewedBy).toBe("reviewer");
  });

  it("stamps audit proposedBy/reviewedBy/appliedBy and userId from the principal", async () => {
    const created = await createProposal(WRITER, {
      action: "create",
      change: {
        content: "Applied memory proposal should stamp audit identity from principal",
        type: "architecture",
        concepts: ["billing", "proposal"],
        sourceObservationIds: ["obs_apply_create"],
        sourceType: "manual",
        sourceUri: "file:///repo/billing/apply.md",
      },
    });

    await approveMemoryProposal(kv as never, REVIEWER, {
      proposalId: created.proposal.id,
    });

    const applied = await applyMemoryProposal(sdk as never, kv as never, REVIEWER, {
      proposalId: created.proposal.id,
      reason: "merge approved team memory PR",
    });
    expect(applied.success).toBe(true);
    if (!applied.success || !applied.proposal) throw new Error("apply failed");
    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.application?.appliedBy).toBe("reviewer");
    expect(applied.proposal.application?.functionId).toBe("mem::memory-create");

    const auditRows = await kv.list<AuditEntry>("mem:audit");

    const createAudit = auditRows.find(
      (row) => row.functionId === "mem::memory-proposal-create",
    );
    expect(createAudit?.userId).toBe("writer");
    expect(createAudit?.details).toMatchObject({ proposedBy: "writer", userId: "writer" });

    const approveAudit = auditRows.find(
      (row) => row.functionId === "mem::memory-proposal-approve",
    );
    expect(approveAudit?.userId).toBe("reviewer");
    expect(approveAudit?.details).toMatchObject({ reviewedBy: "reviewer", userId: "reviewer" });

    const applyAudit = auditRows.find(
      (row) =>
        row.functionId === "mem::memory-proposal-apply" &&
        row.details?.applyStatus === "applied",
    );
    expect(applyAudit?.userId).toBe("reviewer");
    expect(applyAudit?.details).toMatchObject({ appliedBy: "reviewer", userId: "reviewer" });
  });

  it("applies an approved create proposal through mem::memory-create", async () => {
    const created = await createProposal(WRITER, {
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

    await approveMemoryProposal(kv as never, REVIEWER, {
      proposalId: created.proposal.id,
    });

    const applied = await applyMemoryProposal(sdk as never, kv as never, REVIEWER, {
      proposalId: created.proposal.id,
      reason: "merge approved team memory PR",
    });
    expect(applied.success).toBe(true);
    if (!applied.success || !applied.proposal) throw new Error("apply failed");
    const result = applied.result as { success: true; memory: Memory };
    expect(applied.proposal.application?.functionId).toBe("mem::memory-create");
    expect(applied.proposal.application?.targetIds).toContain(result.memory.id);

    const stored = await kv.get<Memory>("mem:memories", result.memory.id);
    expect(stored).toMatchObject({
      project: "billing",
      sourceObservationIds: ["obs_apply_create"],
      sourceType: "manual",
      sourceUri: "file:///repo/billing/apply.md",
    });
  });

  it("requires governance delete before approving or applying deletion proposals", async () => {
    const remembered = (await sdk.trigger("mem::remember", {
      content: "Deletion proposal governance must guard this shared fact",
      type: "fact",
      project: "billing",
    })) as { memory: Memory };

    const proposal = await createProposal(GOVERNOR, {
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

    const approveDenied = await approveMemoryProposal(kv as never, REVIEWER, {
      proposalId: proposal.proposal.id,
    });
    expect(approveDenied.success).toBe(false);
    expect((approveDenied as { error: string }).error).toContain("governance:delete");

    // Use a second governance actor to satisfy separation of duties.
    const otherGovernor: Principal = {
      actorId: "governor-2",
      permissions: ["project:write", "governance:delete"],
    };
    const approved = await approveMemoryProposal(kv as never, otherGovernor, {
      proposalId: proposal.proposal.id,
    });
    expect(approved.success).toBe(true);
    if (!approved.success || !approved.proposal) throw new Error("approve failed");
    expect(approved.proposal.status).toBe("approved");

    const applyDenied = await applyMemoryProposal(sdk as never, kv as never, WRITER, {
      proposalId: proposal.proposal.id,
    });
    expect(applyDenied.success).toBe(false);
    expect((applyDenied as { error: string }).error).toContain("governance:delete");

    const applied = await applyMemoryProposal(sdk as never, kv as never, GOVERNOR, {
      proposalId: proposal.proposal.id,
      reason: "approved local governance deletion",
    });
    expect(applied.success).toBe(true);
    if (!applied.success || !applied.proposal) throw new Error("apply failed");
    expect(applied.proposal.status).toBe("applied");
    expect(applied.proposal.application?.functionId).toBe("mem::memory-delete");

    const stored = await kv.get<Memory>("mem:memories", remembered.memory.id);
    expect(stored?.lifecycleState).toBe("tombstoned");
  });

  it("registered handlers reject requests with no resolved principal", async () => {
    const denied = (await sdk.trigger("mem::memory-proposal-create", {
      action: "create",
      project: "billing",
      permissions: ["project:write"],
      change: { content: "raw payload without resolved principal is unauthorized" },
    })) as { success: boolean; error: string };
    expect(denied.success).toBe(false);
    expect(denied.error).toContain("principal");

    const allowed = (await sdk.trigger("mem::memory-proposal-create", {
      action: "create",
      project: "billing",
      principal: { actorId: "writer", permissions: ["project:write"] },
      change: { content: "resolved principal in payload authorizes the write" },
    })) as { success: boolean; proposal?: MemoryProposal };
    expect(allowed.success).toBe(true);
    expect(allowed.proposal?.proposedBy).toBe("writer");
  });
});
