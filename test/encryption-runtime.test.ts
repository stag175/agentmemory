import { beforeEach, describe, expect, it } from "vitest";

import {
  EncryptionPolicyError,
  isBackupArtifactEncryptionRuntimeWired,
  isStorageEncryptionRuntimeWired,
  setBackupArtifactEncryptionRuntimeWired,
  setStorageEncryptionRuntimeWired,
} from "../src/security/encryption-policy.js";
import {
  ENCRYPTED_STATE_VALUE_FORMAT,
  isEncryptedStateValue,
  type StateKVLike,
} from "../src/state/encrypted-kv.js";
import {
  configureStateEncryptionRuntime,
  keySourceFromEncryptionKeyRef,
} from "../src/state/encryption-runtime.js";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";

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
    update: async <T>(scope: string, key: string): Promise<T> => {
      return (store.get(scope)?.get(key) as T) ?? (null as T);
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

function readyEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGENTMEMORY_DB_ENCRYPTION: "true",
    AGENTMEMORY_EMBEDDINGS_ENCRYPTION: "true",
    AGENTMEMORY_TRANSCRIPTS_ENCRYPTION: "true",
    AGENTMEMORY_BACKUPS_ENCRYPTION: "true",
    AGENTMEMORY_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
    AGENTMEMORY_LOCAL_KEY: "correct horse battery",
    ...overrides,
  };
}

describe("state encryption runtime wiring", () => {
  beforeEach(() => {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
  });

  it("leaves StateKV pass-through when encryption is not requested", async () => {
    const base = memoryKV();
    const runtime = configureStateEncryptionRuntime(base, {});

    expect(runtime.encrypted).toBe(false);
    expect(runtime.kv).toBe(base);
    expect(runtime.report.cryptography.storageWired).toBe(false);
    expect(isStorageEncryptionRuntimeWired()).toBe(false);
  });

  it("wraps sensitive state scopes when all local encryption policy fields are ready", async () => {
    const base = memoryKV();
    const runtime = configureStateEncryptionRuntime(
      base,
      readyEnv({ AGENTMEMORY_BACKUPS_ENCRYPTION: "false" }),
    );
    const value = { id: "mem_1", content: "encrypted at rest" };

    await runtime.kv.set("mem:memories", value.id, value);

    const raw = base.raw("mem:memories", value.id);
    expect(runtime.encrypted).toBe(true);
    expect(runtime.keyRef).toBe("env:AGENTMEMORY_LOCAL_KEY");
    expect(runtime.report.status).toBe("pass");
    expect(runtime.report.cryptography.storageWired).toBe(true);
    expect(isStorageEncryptionRuntimeWired()).toBe(true);
    expect(isEncryptedStateValue(raw)).toBe(true);
    expect(raw).toMatchObject({ format: ENCRYPTED_STATE_VALUE_FORMAT });
    expect(JSON.stringify(raw)).not.toContain("encrypted at rest");
    await expect(runtime.kv.get("mem:memories", value.id)).resolves.toEqual(value);
  });

  it("encrypts the standalone local fallback InMemoryKV backing store", async () => {
    const base = new InMemoryKV();
    const runtime = configureStateEncryptionRuntime(
      base,
      readyEnv({ AGENTMEMORY_BACKUPS_ENCRYPTION: "false" }),
    );

    await runtime.kv.set("mem:memories", "mem_local", {
      id: "mem_local",
      content: "standalone secret",
    });

    const raw = await base.get("mem:memories", "mem_local");
    expect(runtime.encrypted).toBe(true);
    expect(isEncryptedStateValue(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("standalone secret");
    await expect(runtime.kv.get("mem:memories", "mem_local")).resolves.toEqual({
      id: "mem_local",
      content: "standalone secret",
    });
  });

  it("wires backup artifact encryption when requested and key readiness passes", () => {
    const runtime = configureStateEncryptionRuntime(memoryKV(), readyEnv());

    expect(runtime.encrypted).toBe(true);
    expect(runtime.report.status).toBe("pass");
    expect(runtime.report.missingFields).toEqual([]);
    expect(isStorageEncryptionRuntimeWired()).toBe(true);
    expect(isBackupArtifactEncryptionRuntimeWired()).toBe(true);
  });

  it("fails closed and resets runtime state when requested policy is incomplete", () => {
    expect(() =>
      configureStateEncryptionRuntime(memoryKV(), {
        AGENTMEMORY_DB_ENCRYPTION: "true",
        AGENTMEMORY_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
        AGENTMEMORY_LOCAL_KEY: "correct horse battery",
      }),
    ).toThrow(EncryptionPolicyError);
    expect(isStorageEncryptionRuntimeWired()).toBe(false);
    expect(isBackupArtifactEncryptionRuntimeWired()).toBe(false);
  });

  it("requires the env var referenced by an env key ref to be populated", () => {
    expect(() =>
      configureStateEncryptionRuntime(memoryKV(), {
        ...readyEnv({ AGENTMEMORY_LOCAL_KEY: undefined }),
      }),
    ).toThrow();
    expect(isStorageEncryptionRuntimeWired()).toBe(false);
    expect(isBackupArtifactEncryptionRuntimeWired()).toBe(false);
  });

  it("requires backup-specific key refs to resolve before claiming artifact wiring", () => {
    expect(() =>
      configureStateEncryptionRuntime(
        memoryKV(),
        readyEnv({
          AGENTMEMORY_BACKUPS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_BACKUP_KEY",
          AGENTMEMORY_BACKUP_KEY: undefined,
        }),
      ),
    ).toThrow();
    expect(isStorageEncryptionRuntimeWired()).toBe(false);
    expect(isBackupArtifactEncryptionRuntimeWired()).toBe(false);
  });

  it("fails closed when distinct per-surface key refs are configured", () => {
    expect(() =>
      configureStateEncryptionRuntime(
        memoryKV(),
        readyEnv({
          AGENTMEMORY_ENCRYPTION_KEY_REF: undefined,
          AGENTMEMORY_DB_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_DB_KEY",
          AGENTMEMORY_EMBEDDINGS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_EMB_KEY",
          AGENTMEMORY_TRANSCRIPTS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_DB_KEY",
          AGENTMEMORY_BACKUPS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_DB_KEY",
          AGENTMEMORY_DB_KEY: "correct horse battery",
          AGENTMEMORY_EMB_KEY: "second distinct passphrase",
        }),
      ),
    ).toThrow(EncryptionPolicyError);
    expect(isStorageEncryptionRuntimeWired()).toBe(false);
    expect(isBackupArtifactEncryptionRuntimeWired()).toBe(false);
  });

  it("accepts a single shared key ref across every surface", async () => {
    const base = memoryKV();
    const runtime = configureStateEncryptionRuntime(
      base,
      readyEnv({
        AGENTMEMORY_ENCRYPTION_KEY_REF: undefined,
        AGENTMEMORY_DB_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
        AGENTMEMORY_EMBEDDINGS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
        AGENTMEMORY_TRANSCRIPTS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
        AGENTMEMORY_BACKUPS_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
      }),
    );

    expect(runtime.encrypted).toBe(true);
    expect(runtime.keyRef).toBe("env:AGENTMEMORY_LOCAL_KEY");
    expect(isStorageEncryptionRuntimeWired()).toBe(true);
  });

  it("maps env key refs to the referenced passphrase env var", () => {
    const keySource = keySourceFromEncryptionKeyRef("env:AGENTMEMORY_LOCAL_KEY", {
      AGENTMEMORY_LOCAL_KEY: "secret",
    });

    expect(keySource).toMatchObject({
      envVar: "AGENTMEMORY_LOCAL_KEY",
      keyRef: "env:AGENTMEMORY_LOCAL_KEY",
    });
  });
});
