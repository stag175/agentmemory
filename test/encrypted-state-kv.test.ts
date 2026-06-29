import { describe, expect, it } from "vitest";
import {
  ENCRYPTED_STATE_VALUE_FORMAT,
  EncryptedStateKVError,
  createEncryptedStateKV,
  isEncryptedStateValue,
  type StateKVLike,
} from "../src/state/encrypted-kv.js";

const fastScrypt = {
  n: 1024,
  r: 8,
  p: 1,
  keyLength: 32,
} as const;

function memoryKV(): StateKVLike & {
  raw: (scope: string, key: string) => unknown;
} {
  const store = new Map<string, Map<string, unknown>>();
  return {
    raw: (scope, key) => store.get(scope)?.get(key),
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    update: async <T>(): Promise<T> => {
      throw new Error("update should not be called in this test");
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const values = store.get(scope);
      return values ? (Array.from(values.values()) as T[]) : [];
    },
  };
}

function encryptedKV(base = memoryKV()) {
  return createEncryptedStateKV(base, "correct horse battery", {
    encryptedScopes: ["mem:memories"],
    encryption: {
      keyRef: "test:key",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      scrypt: fastScrypt,
    },
  });
}

describe("encrypted StateKV adapter", () => {
  it("stores encrypted envelopes while preserving the StateKV get/set/list shape", async () => {
    const base = memoryKV();
    const kv = encryptedKV(base);
    const value = { id: "mem_1", content: "classified local memory" };

    await expect(kv.set("mem:memories", value.id, value)).resolves.toEqual(
      value,
    );

    const raw = base.raw("mem:memories", value.id);
    expect(isEncryptedStateValue(raw)).toBe(true);
    expect(raw).toMatchObject({ format: ENCRYPTED_STATE_VALUE_FORMAT });
    expect(JSON.stringify(raw)).not.toContain("classified local memory");
    await expect(kv.get("mem:memories", value.id)).resolves.toEqual(value);
    await expect(kv.list("mem:memories")).resolves.toEqual([value]);
  });

  it("passes non-encrypted scopes through unchanged", async () => {
    const base = memoryKV();
    const kv = encryptedKV(base);
    const value = { id: "session_1", title: "plain session metadata" };

    await kv.set("mem:sessions", value.id, value);

    expect(base.raw("mem:sessions", value.id)).toEqual(value);
    await expect(kv.get("mem:sessions", value.id)).resolves.toEqual(value);
  });

  it("encrypts persisted search index shards by default", async () => {
    const base = memoryKV();
    const kv = createEncryptedStateKV(base, "correct horse battery", {
      encryption: {
        keyRef: "test:key",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        scrypt: fastScrypt,
      },
    });
    const value = { shard: "bm25 terms for private memory" };

    await kv.set("mem:index:bm25", "data", value);

    const raw = base.raw("mem:index:bm25", "data");
    expect(isEncryptedStateValue(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("private memory");
    await expect(kv.get("mem:index:bm25", "data")).resolves.toEqual(value);
  });

  it("encrypts embedding scopes by default", async () => {
    const base = memoryKV();
    const kv = createEncryptedStateKV(base, "correct horse battery", {
      encryption: {
        keyRef: "test:key",
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        scrypt: fastScrypt,
      },
    });
    const value = { vector: [0.1, 0.2], text: "private embedding source" };

    await kv.set("mem:emb:obs_1", "embedding", value);
    await kv.set("mem:image-embeddings", "image_1", value);

    expect(JSON.stringify(base.raw("mem:emb:obs_1", "embedding"))).not.toContain(
      "private embedding source",
    );
    expect(JSON.stringify(base.raw("mem:image-embeddings", "image_1"))).not.toContain(
      "private embedding source",
    );
    await expect(kv.get("mem:emb:obs_1", "embedding")).resolves.toEqual(value);
    await expect(kv.get("mem:image-embeddings", "image_1")).resolves.toEqual(value);
  });

  it("fails closed for plaintext reads and encrypted state::update attempts", async () => {
    const base = memoryKV();
    const kv = encryptedKV(base);
    await base.set("mem:memories", "legacy", { content: "legacy plaintext" });

    await expect(kv.get("mem:memories", "legacy")).rejects.toMatchObject({
      code: "PLAINTEXT_READ_BLOCKED" satisfies EncryptedStateKVError["code"],
    });
    await expect(
      kv.update("mem:memories", "legacy", [
        { type: "set", path: "/content", value: "patched" },
      ]),
    ).rejects.toMatchObject({
      code: "ENCRYPTED_UPDATE_UNSUPPORTED" satisfies EncryptedStateKVError["code"],
    });
  });
});
