import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerComplianceEvidenceFunction } from "../src/functions/compliance-evidence.js";
import { KV } from "../src/state/schema.js";
import type {
  AuditEntry,
  ComplianceEvidenceReport,
  Memory,
  TeamSharedItem,
} from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "agentmemory-compliance-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("mem::compliance-evidence", () => {
  it("builds a sanitized SOC2 evidence pack without raw memory or team content", async () => {
    const root = tempDir();
    writeFileSync(join(root, "AGENTS.md"), "rule body should stay hashed by default\n");

    const sdk = mockSdk();
    const kv = mockKV();
    registerComplianceEvidenceFunction(sdk as never, kv as never);

    await kv.set(KV.memories, "mem_1", {
      id: "mem_1",
      title: "Sanitized memory title",
      content: "raw secret memory body",
      type: "decision",
      project: "alpha",
      lifecycleState: "active",
      reviewState: "approved",
      privacyScope: "team",
      sourceType: "observation",
      sourceHash: "hash_1",
      sourceObservationIds: ["obs_1"],
      redactionApplied: true,
      sensitivityLabels: ["secret"],
      sessionIds: [],
      concepts: [],
      files: [],
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
      strength: 1,
      confidence: 1,
      version: 1,
      isLatest: true,
    } as unknown as Memory);
    await kv.set(KV.audit, "audit_1", {
      id: "audit_1",
      timestamp: "2026-06-28T00:00:00.000Z",
      operation: "delete",
      functionId: "mem::governance-delete",
      targetIds: ["mem_1"],
      details: { reason: "retention request" },
    } as unknown as AuditEntry);
    await kv.set(KV.teamShared("team_1"), "shared_1", {
      id: "shared_1",
      type: "memory",
      project: "alpha",
      visibility: "team",
      sharedBy: "alice",
      sharedAt: "2026-06-28T00:00:00.000Z",
      content: "raw shared team content",
    } as unknown as TeamSharedItem);

    const result = (await sdk.trigger("mem::compliance-evidence", {
      project: "alpha",
      workspaceRoot: root,
      teamPolicy: {
        teamId: "team_1",
        roles: {
          owner: ["project:*", "governance:delete"],
        },
        members: ["alice"],
      },
      releaseGateEvidence: {
        releaseGate: {
          distributionMetadata: { status: "pass", evidence: ["server.json"] },
          build: { status: "pass", evidence: ["npm run build"] },
          test: { status: "pass", evidence: ["npm test"] },
          docs: { status: "pass", evidence: ["npm run skills:check"] },
          packSmoke: { status: "pass", evidence: ["npm pack"] },
          redactionForget: { status: "pass", evidence: ["test"] },
          retrievalScope: { status: "pass", evidence: ["test"] },
          retrievalArena: { status: "not_run", evidence: [] },
          restMcpParity: { status: "pass", evidence: ["test"] },
        },
      },
    })) as ComplianceEvidenceReport;

    expect(result.success).toBe(true);
    expect(result.controls.map((control) => control.id)).toEqual([
      "access-posture",
      "audit-trail",
      "lifecycle-hygiene",
      "rules-provenance",
      "release-readiness",
    ]);
    expect(result.findings.some((finding) => finding.severity === "high")).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw secret memory body");
    expect(serialized).not.toContain("raw shared team content");
    expect(serialized).not.toContain("rule body should stay hashed");
    expect(result.evidenceRefs.some((ref) => ref.id === "memory:mem_1")).toBe(true);
    expect(result.evidenceRefs.some((ref) => ref.id === "team-shared:shared_1")).toBe(true);
  });

  it("marks missing policy and failed release gates as findings", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerComplianceEvidenceFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::compliance-evidence", {
      releaseGateEvidence: {
        releaseGate: {
          build: { status: "fail", failures: ["build failed"] },
        },
      },
    })) as ComplianceEvidenceReport;

    expect(result.findings.map((finding) => finding.id)).toContain(
      "access_policy_missing",
    );
    expect(result.findings.map((finding) => finding.id)).toContain(
      "release_gate_blocked_or_failed",
    );
    expect(result.nextActions.length).toBeGreaterThan(0);
  });
});
