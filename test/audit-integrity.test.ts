import { describe, expect, it } from "vitest";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  AUDIT_CHAIN_HEAD_KEY,
  buildAuditHashChain,
  computeAuditChainHash,
  computeAuditEntryHash,
  registerAuditIntegrityFunctions,
  type AuditHashChainReport,
  type AuditHashChainVerifyResult,
} from "../src/functions/audit-integrity.js";
import { recordAudit } from "../src/functions/audit.js";
import { KV } from "../src/state/schema.js";
import type { AuditChainHead, AuditEntry } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

type Kv = ReturnType<typeof mockKV>;

// Append three real, chained audit rows through recordAudit so each row gets a
// persisted seq + chainHash and the head pointer is maintained — the exact
// shape verification depends on.
async function seedChain(kv: Kv): Promise<AuditEntry[]> {
  const first = await recordAudit(
    kv as never,
    "observe",
    "mem::observe",
    ["obs_1"],
    { step: 1 },
  );
  const second = await recordAudit(
    kv as never,
    "forget",
    "mem::forget",
    ["mem_2"],
    { step: 2, reason: "test" },
  );
  const third = await recordAudit(
    kv as never,
    "remember",
    "mem::remember",
    ["mem_3"],
    { step: 3 },
  );
  return [first, second, third];
}

function rawAuditRows(kv: Kv): Promise<AuditEntry[]> {
  return kv.list<AuditEntry>(KV.audit);
}

describe("audit integrity hash chain", () => {
  it("persists a monotonic seq and chainHash on every appended row", async () => {
    const kv = mockKV();
    const [first, second, third] = await seedChain(kv);

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(third.seq).toBe(3);
    expect(first.chainHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.chainHash).not.toBe(first.chainHash);

    const head = await kv.get<AuditChainHead>(
      KV.auditChainHead,
      AUDIT_CHAIN_HEAD_KEY,
    );
    expect(head).not.toBeNull();
    expect(head?.seq).toBe(3);
    expect(head?.count).toBe(3);
    expect(head?.entryId).toBe(third.id);
    expect(head?.chainHash).toBe(third.chainHash);
  });

  it("produces a deterministic SHA-256 chain ordered by persisted seq", async () => {
    const kv = mockKV();
    const [first, second, third] = await seedChain(kv);

    const report = (await buildAuditHashChain(kv as never, {
      includeLinks: true,
    })) as AuditHashChainReport;
    const again = (await buildAuditHashChain(kv as never, {
      includeLinks: true,
    })) as AuditHashChainReport;

    expect(report.success).toBe(true);
    expect(report.algorithm).toBe("sha256");
    expect(report.scope.filteredEntries).toBe(3);
    expect(report.headHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.links?.map((link) => link.entryId)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(report.links?.map((link) => link.seq)).toEqual([1, 2, 3]);
    expect(report.links?.[0]?.previousHash).toBe(AUDIT_CHAIN_GENESIS_HASH);
    expect(report.links?.[1]?.previousHash).toBe(report.links?.[0]?.hash);
    expect(report.links?.[0]).not.toHaveProperty("details");
    // Recomputed link hashes equal the chainHash persisted at append time.
    expect(report.links?.map((link) => link.storedChainHash)).toEqual([
      first.chainHash,
      second.chainHash,
      third.chainHash,
    ]);
    expect(report.links?.map((link) => link.hash)).toEqual([
      first.chainHash,
      second.chainHash,
      third.chainHash,
    ]);
    expect(report.headHash).toBe(third.chainHash);
    expect(again.headHash).toBe(report.headHash);
    expect(again.links).toEqual(report.links);
  });

  it("verifies a healthy chain against a saved head and count", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);

    const chain = (await sdk.trigger("mem::audit-chain", {
      includeLinks: true,
    })) as AuditHashChainReport;
    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: chain.headHash,
      expectedCount: chain.scope.filteredEntries,
      expectedFirstEntryId: chain.firstEntryId,
      expectedLastEntryId: chain.lastEntryId,
    })) as AuditHashChainVerifyResult;

    expect(verification.success).toBe(true);
    expect(verification.valid).toBe(true);
    expect(verification.mismatches).toEqual([]);
    expect(verification.checked).toMatchObject({
      headHash: true,
      entryCount: true,
      persistedHead: true,
      chainContinuity: true,
    });
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
    expect(verification.links).toBeUndefined();
  });

  it("proves integrity from the persisted head even without caller anchors", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);

    const verification = (await sdk.trigger(
      "mem::audit-chain-verify",
      {},
    )) as AuditHashChainVerifyResult;

    expect(verification.valid).toBe(true);
    expect(verification.checked.persistedHead).toBe(true);
    expect(verification.checked.headHash).toBe(true);
    expect(verification.checked.entryCount).toBe(true);
    // The persisted head is an internal anchor, not a caller-supplied one.
    expect(verification.anchor.sources).toEqual([]);
  });

  it("requires both a head hash and a count to claim valid", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);
    // Drop the persisted head so the only proof available is what the caller
    // passes. A head hash alone must not be enough for valid:true.
    await kv.delete(KV.auditChainHead, AUDIT_CHAIN_HEAD_KEY);

    const chain = (await sdk.trigger("mem::audit-chain", {})) as AuditHashChainReport;

    const headOnly = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: chain.headHash,
    })) as AuditHashChainVerifyResult;
    expect(headOnly.checked.headHash).toBe(true);
    expect(headOnly.checked.entryCount).toBe(false);
    expect(headOnly.valid).toBe(false);

    const countOnly = (await sdk.trigger("mem::audit-chain-verify", {
      expectedCount: chain.scope.filteredEntries,
    })) as AuditHashChainVerifyResult;
    expect(countOnly.checked.headHash).toBe(false);
    expect(countOnly.valid).toBe(false);

    const both = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: chain.headHash,
      expectedCount: chain.scope.filteredEntries,
    })) as AuditHashChainVerifyResult;
    expect(both.valid).toBe(true);
  });

  it("does not claim valid for an empty log without an anchor", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);

    const unanchored = (await sdk.trigger(
      "mem::audit-chain-verify",
      {},
    )) as AuditHashChainVerifyResult;
    const computeOnly = (await sdk.trigger("mem::audit-chain-verify", {
      allowUnanchored: true,
    })) as AuditHashChainVerifyResult;

    expect(unanchored.valid).toBe(false);
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

  it("detects tampering of a middle row via the persisted chain hash", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    const [, second] = await seedChain(kv as Kv);
    const baseline = (await sdk.trigger("mem::audit-chain", {})) as AuditHashChainReport;

    // Edit the middle row's content in place but keep its persisted chainHash.
    await kv.set(KV.audit, second.id, {
      ...second,
      details: { step: 999, reason: "tampered" },
    });

    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: baseline.headHash,
      expectedCount: baseline.scope.filteredEntries,
    })) as AuditHashChainVerifyResult;

    expect(verification.valid).toBe(false);
    const kinds = verification.mismatches.map((mismatch) => mismatch.kind);
    // The edited middle row's recomputed hash no longer matches its stored
    // chainHash, and the recomputed head no longer matches the saved head.
    expect(kinds).toContain("stored_chain_hash");
    expect(kinds).toContain("head_hash");
  });

  it("detects reordering of rows by persisted seq", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    const [first, second, third] = await seedChain(kv as Kv);

    // Swap the seq values of the first two rows (a reorder attempt). Their
    // stored chainHashes now belong to the wrong positions.
    await kv.set(KV.audit, first.id, { ...first, seq: second.seq });
    await kv.set(KV.audit, second.id, { ...second, seq: first.seq });

    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: third.chainHash,
      expectedCount: 3,
    })) as AuditHashChainVerifyResult;

    expect(verification.valid).toBe(false);
    expect(verification.mismatches.map((mismatch) => mismatch.kind)).toContain(
      "stored_chain_hash",
    );
  });

  it("detects a seq gap as a violation", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    const [first, , third] = await seedChain(kv as Kv);

    // Remove the middle row entirely, leaving seq 1 then seq 3 (a gap).
    const all = await rawAuditRows(kv as Kv);
    const middle = all.find((row) => row.seq === 2);
    if (middle) await kv.delete(KV.audit, middle.id);

    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: third.chainHash,
      expectedCount: 3,
    })) as AuditHashChainVerifyResult;

    expect(first.seq).toBe(1);
    expect(verification.valid).toBe(false);
    const messages = verification.mismatches.map((mismatch) => mismatch.message);
    expect(messages.some((message) => message.includes("seq gap"))).toBe(true);
  });

  it("fails a fully rewritten log against the persisted head", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);

    // The attacker deletes every audit row and re-appends a brand new,
    // internally self-consistent chain (each row's stored chainHash is a valid
    // hash of its own contents and chains to the prior row). They cannot also
    // forge the persisted head pointer in the separate auditChainHead scope.
    const original = await rawAuditRows(kv as Kv);
    for (const row of original) await kv.delete(KV.audit, row.id);

    let previous = AUDIT_CHAIN_GENESIS_HASH;
    for (let index = 0; index < original.length; index++) {
      const seq = index + 1;
      const forged: AuditEntry = {
        ...original[index],
        seq,
        details: { step: seq, forged: true },
      };
      delete forged.chainHash;
      const entryHash = computeAuditEntryHash(forged);
      const chainHash = computeAuditChainHash(previous, entryHash, seq);
      forged.chainHash = chainHash;
      previous = chainHash;
      await kv.set(KV.audit, forged.id, forged);
    }

    const verification = (await sdk.trigger(
      "mem::audit-chain-verify",
      {},
    )) as AuditHashChainVerifyResult;

    // Every row is internally self-consistent (no stored_chain_hash issues),
    // but the persisted head still points at the original chain head.
    expect(
      verification.mismatches.some(
        (mismatch) => mismatch.kind === "stored_chain_hash",
      ),
    ).toBe(false);
    expect(verification.valid).toBe(false);
    expect(
      verification.mismatches.map((mismatch) => mismatch.kind),
    ).toContain("persisted_head_hash");
  });

  it("validates a provided chain and reports link mismatches", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);
    const chain = (await sdk.trigger("mem::audit-chain", {
      includeLinks: true,
    })) as AuditHashChainReport;

    const valid = (await sdk.trigger("mem::audit-chain-verify", {
      chain: chain.links,
    })) as AuditHashChainVerifyResult;
    expect(valid.valid).toBe(true);
    expect(valid.anchor.sources).toEqual(["chain"]);
    expect(valid.checked.providedChain).toBe(true);

    const tamperedLinks = (chain.links ?? []).map((link) => ({ ...link }));
    tamperedLinks[1].previousHash = AUDIT_CHAIN_GENESIS_HASH;
    const invalid = (await sdk.trigger("mem::audit-chain-verify", {
      chain: tamperedLinks,
    })) as AuditHashChainVerifyResult;

    expect(invalid.valid).toBe(false);
    const kinds = invalid.mismatches.map((mismatch) => mismatch.kind);
    // Broken internal continuity is caught before diffing against the recompute.
    expect(
      kinds.includes("provided_chain_continuity") ||
        kinds.includes("link_previousHash"),
    ).toBe(true);
  });

  it("treats a truncated verification window as a hard mismatch", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    const [, , third] = await seedChain(kv as Kv);

    const verification = (await sdk.trigger("mem::audit-chain-verify", {
      expectedHeadHash: third.chainHash,
      expectedCount: 3,
      limit: 1,
    })) as AuditHashChainVerifyResult;

    expect(verification.scope.truncated).toBe(true);
    expect(verification.valid).toBe(false);
    expect(verification.mismatches.map((mismatch) => mismatch.kind)).toContain(
      "scope_truncated",
    );
  });

  it("keeps chain generation bounded and rejects invalid limits", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerAuditIntegrityFunctions(sdk as never, kv as never);
    await seedChain(kv as Kv);

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
