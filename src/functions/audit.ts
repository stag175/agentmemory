import type { AuditChainHead, AuditEntry } from "../types.js";
import { KV, generateId } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { logger } from "../logger.js";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  AUDIT_CHAIN_HEAD_KEY,
  computeAuditChainHash,
  computeAuditEntryHash,
} from "./audit-integrity.js";

// Audit coverage policy (issue #125).
//
// Every structural deletion of a memory, observation, session, or
// semantic row MUST call recordAudit. Two shapes are allowed, keyed to
// whether the caller is scoped or bulk:
//
//   Scoped deletions — a user-visible, per-call action removing a
//   bounded set of items. Emit ONE audit row per call with targetIds
//   populated. Examples: mem::governance-delete, mem::forget.
//
//   Bulk deletions — automatic sweeps (retention, TTL eviction,
//   auto-forget) that can remove hundreds of rows per invocation.
//   Emit ONE batched audit row per invocation with targetIds listing
//   every removed id and details.evicted holding the count. Per-item
//   audit rows would flood the audit log during routine sweeps.
//
//   Either shape is required; silent deletes are not acceptable.
//
// operation field:
//   - "delete"          — permanent removal (governance, retention sweep, evict).
//   - "forget"          — forget/removal flows. Scoped when emitted by
//                         mem::forget (user-initiated); bulk-batched when
//                         emitted by mem::auto-forget (automatic sweep).
//   - everything else   — see AuditEntry["operation"] union in src/types.ts.
//
// When adding a new deletion path, add an explicit recordAudit call
// BEFORE kv.delete(...) and match one of the two shapes above.

export async function recordAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<AuditEntry> {
  const now = new Date().toISOString();
  // Serialize the head read/write so seq stays strictly monotonic and the
  // persisted chainHash links every append to the prior head. Without the
  // lock two concurrent appends could read the same prior head and produce
  // a duplicate seq / forked chain.
  return withKeyedLock(KV.auditChainHead, async () => {
    const head = await kv.get<AuditChainHead>(
      KV.auditChainHead,
      AUDIT_CHAIN_HEAD_KEY,
    );
    const prevSeq = head?.seq ?? 0;
    const prevChainHash = head?.chainHash ?? AUDIT_CHAIN_GENESIS_HASH;
    const seq = prevSeq + 1;

    const entry: AuditEntry = {
      id: generateId("aud"),
      timestamp: now,
      operation,
      userId,
      functionId,
      targetIds,
      details,
      qualityScore,
      seq,
    };
    // entryHash covers the entry content (seq included, chainHash excluded);
    // chainHash links it to the prior head. Both are persisted on the row.
    const entryHash = computeAuditEntryHash(entry);
    const chainHash = computeAuditChainHash(prevChainHash, entryHash, seq);
    entry.chainHash = chainHash;

    await kv.set(KV.audit, entry.id, entry);
    const nextHead: AuditChainHead = {
      seq,
      chainHash,
      entryId: entry.id,
      entryHash,
      count: (head?.count ?? 0) + 1,
      updatedAt: now,
    };
    await kv.set(KV.auditChainHead, AUDIT_CHAIN_HEAD_KEY, nextHead);
    return entry;
  });
}

export async function safeAudit(
  kv: StateKV,
  operation: AuditEntry["operation"],
  functionId: string,
  targetIds: string[],
  details: Record<string, unknown> = {},
  qualityScore?: number,
  userId?: string,
): Promise<void> {
  try {
    await recordAudit(kv, operation, functionId, targetIds, details, qualityScore, userId);
  } catch (err) {
    try {
      logger.warn("audit write failed", {
        functionId,
        operation,
        targetIds,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

export async function queryAudit(
  kv: StateKV,
  filter?: {
    operation?: AuditEntry["operation"];
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  },
): Promise<AuditEntry[]> {
  const all = await kv.list<AuditEntry>(KV.audit);
  let entries = [...all].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  if (filter?.operation) {
    entries = entries.filter((e) => e.operation === filter.operation);
  }
  if (filter?.dateFrom) {
    const from = new Date(filter.dateFrom).getTime();
    if (Number.isNaN(from)) {
      throw new Error(`Invalid dateFrom: ${filter.dateFrom}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= from);
  }
  if (filter?.dateTo) {
    const to = new Date(filter.dateTo).getTime();
    if (Number.isNaN(to)) {
      throw new Error(`Invalid dateTo: ${filter.dateTo}`);
    }
    entries = entries.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  return entries.slice(0, filter?.limit || 100);
}
