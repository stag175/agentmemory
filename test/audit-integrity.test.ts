import { describe, expect, it } from "vitest";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  buildAuditHashChain,
  registerAuditIntegrityFunctions,
  type AuditHashChainReport,
  type AuditHashChainVerifyResult,
} from "../src/functions/audit-integrity.js";
import { KV } from "../src/state/schema.js";
import type { AuditEntry } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function auditEntry(
  id: string,
  timestamp: string,
  overrides: Partial<AuditEntry> = {},
): AuditEntry {
  return {
    id,
    timestamp,
    operation: "observe",
    functionId: "mem::observe",
    targetIds: [id.replace("aud_", "obs_")],
    details: { source: "test" },
    ...overrides,
  };
}

async function seedAuditRows(kv: ReturnType<typeof mockKV>): Promise<AuditEntry[]> {
  const first = auditEntry("aud_1", "2026-06-29T00:00:01.000Z", {
    details: { step: 1 },
  });
  const second = auditEntry("aud_2", "2026-06-29T00:00:02.000Z", {
    operation: "delete",
    functionId: "mem::forget",
    details: { step: 2, reason: "test" },
  });
  await kv.set(KV.audit, second.id, second);
  await kv.set(KV.audit, first.id, first);
  return [first, second];
}

describe("audit integrity hash chain", () => {
  it("produces a deterministic SHA-256 chain over audit entries", async () => {
    const kv = mockKV();
    await seedAuditRows(kv);

    const report = (await buildAuditHashChain(kv as never, {
      includeLinks: true,
    })) as AuditHashChainReport;
    const again = (await buildAuditHashChain(kv as never, {
      includeLinks: true,
    })) as AuditHashChainReport;

    expect(report.success).toBe(true);
    expect(report.algorithm).toBe("sha256");
    expect(report.scope.selectedEntries).toBe(2);
    expect(report.headHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.links?.map((link) => link.entryId)).toEqual(["aud_1", "aud_2"]);
    expect(report.links?.[0]?.previousHash).toBe(AUDIT_CHAIN_GENESIS_HASH);
    expect(report.links?.[1]?.previousHash).toBe(report.links?.[0]?.hash);
    expect(report.links?.[0]).not.toHaveProperty("details");
    expect(again.headHash).toBe(report.headHash);
    expect(again.links).toEqual(report.links);
  });

  it("registers produce and verify functions with expected anchors", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedAuditRows(kv);

    const chain = (await sdk.trigger("mem::audit-chain", {
      includeLinks: true,
    })) as AuditHashChainReport;
    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: chain.headHash,
      expectedCount: chain.scope.selectedEntries,
      expectedFirstEntryId: chain.firstEntryId,
      expectedLastEntryId: chain.lastEntryId,
    })) as AuditHashChainVerifyResult;

    expect(verification.success).toBe(true);
    expect(verification.valid).toBe(true);
    expect(verification.anchor).toMatchObject({
      required: true,
      provided: true,
      allowUnanchored: false,
      sources: [
        "expectedHeadHash",
        "expectedCount",
        "expectedFirstEntryId",
        "expectedLastEntryId",
      ],
    });
    expect(verification.mismatches).toEqual([]);
    expect(verification.links).toBeUndefined();
  });

  it("does not claim audit verification is valid without an external anchor", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedAuditRows(kv);

    const unanchored = (await sdk.trigger(
      "mem::audit-chain-verify",
      {},
    )) as AuditHashChainVerifyResult;
    const computeOnly = (await sdk.trigger("mem::audit-chain-verify", {
      allowUnanchored: true,
    })) as AuditHashChainVerifyResult;

    expect(unanchored.valid).toBe(false);
    expect(unanchored.anchor).toMatchObject({
      required: true,
      provided: false,
      allowUnanchored: false,
      sources: [],
    });
    expect(unanchored.mismatches.map((mismatch) => mismatch.kind)).toContain(
      "external_anchor_required",
    );
    expect(computeOnly.valid).toBe(true);
    expect(computeOnly.anchor).toMatchObject({
      required: false,
      provided: false,
      allowUnanchored: true,
    });
  });

  it("detects audit row tampering against a prior head hash", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    const [, second] = await seedAuditRows(kv);
    const baseline = (await sdk.trigger("mem::audit-chain", {})) as AuditHashChainReport;

    await kv.set(KV.audit, second.id, {
      ...second,
      details: { step: 999, reason: "tampered" },
    });

    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: baseline.headHash,
      expectedCount: baseline.scope.selectedEntries,
    })) as AuditHashChainVerifyResult;

    expect(verification.valid).toBe(false);
    expect(verification.mismatches.map((mismatch) => mismatch.kind)).toContain(
      "head_hash",
    );
  });

  it("verifies a provided chain and reports link mismatches", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedAuditRows(kv);
    const chain = (await sdk.trigger("mem::audit-chain", {
      includeLinks: true,
    })) as AuditHashChainReport;

    const valid = (await sdk.trigger("mem::audit-chain-verify", {
      chain: chain.links,
    })) as AuditHashChainVerifyResult;
    expect(valid.valid).toBe(true);
    expect(valid.anchor.sources).toEqual(["chain"]);

    const tamperedLinks = (chain.links ?? []).map((link) => ({ ...link }));
    tamperedLinks[1].previousHash = AUDIT_CHAIN_GENESIS_HASH;
    const invalid = (await sdk.trigger("mem::audit-chain-verify", {
      chain: tamperedLinks,
    })) as AuditHashChainVerifyResult;

    expect(invalid.valid).toBe(false);
    expect(invalid.mismatches.map((mismatch) => mismatch.kind)).toContain(
      "link_previousHash",
    );
  });

  it("keeps chain generation bounded and rejects invalid limits", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedAuditRows(kv);
    await kv.set(
      KV.audit,
      "aud_3",
      auditEntry("aud_3", "2026-06-29T00:00:03.000Z"),
    );

    const bounded = (await sdk.trigger("mem::audit-chain", {
      limit: 2,
    })) as AuditHashChainReport;
    expect(bounded.scope.selectedEntries).toBe(2);
    expect(bounded.scope.truncated).toBe(true);
    expect(bounded.links).toHaveLength(2);

    const rejected = (await sdk.trigger("mem::audit-chain", {
      limit: 10001,
    })) as { success: false; error: string };
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("limit");
  });
});
