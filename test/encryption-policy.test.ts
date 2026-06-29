import { beforeEach, describe, expect, it } from "vitest";
import {
  EncryptionPolicyError,
  enforceRequestedEncryptionReadiness,
  enforceRequestedEncryptionReadinessFromEnv,
  encryptionPolicyFromEnv,
  evaluateEncryptionReadiness,
  evaluateEncryptionReadinessFromEnv,
  setBackupArtifactEncryptionRuntimeWired,
  setStorageEncryptionRuntimeWired,
} from "../src/security/encryption-policy.js";

function readyLocalEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    AGENTMEMORY_DB_ENCRYPTION: "true",
    AGENTMEMORY_EMBEDDINGS_ENCRYPTION: "true",
    AGENTMEMORY_TRANSCRIPTS_ENCRYPTION: "true",
    AGENTMEMORY_BACKUPS_ENCRYPTION: "true",
    AGENTMEMORY_ENCRYPTION_KEY_REF: "env:AGENTMEMORY_LOCAL_KEY",
    ...overrides,
  };
}

describe("encryption policy readiness", () => {
  beforeEach(() => {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
  });

  it("fails closed when local storage surfaces are not configured", () => {
    const report = evaluateEncryptionReadiness({});

    expect(report.version).toBe("encryption_policy_v1");
    expect(report.cryptography).toMatchObject({
      implemented: true,
      storageWired: false,
      storageAdapterAvailable: true,
      module: "src/security/encryption.ts",
      storageAdapterModule: "src/state/encrypted-kv.ts",
      envelopeVersion: "agentmemory.local-json.v1",
      algorithm: "AES-256-GCM",
    });
    expect(report.status).toBe("fail");
    expect(report.remoteMode.enabled).toBe(false);
    expect(report.summary.fail).toBe(5);
    expect(report.missingFields).toEqual([
      "database.enabled",
      "database.keyRef",
      "embeddings.enabled",
      "embeddings.keyRef",
      "transcripts.enabled",
      "transcripts.keyRef",
      "backups.enabled",
      "backups.keyRef",
      "storage.encryptionWired",
    ]);
    expect(report.failures).toContain(
      "Set AGENTMEMORY_DB_ENCRYPTION=true or provide database.enabled=true in config.",
    );
  });

  it("keeps local readiness failing until storage surfaces are wired", () => {
    const report = evaluateEncryptionReadinessFromEnv(readyLocalEnv());

    expect(report.status).toBe("fail");
    expect(report.summary).toEqual({ pass: 5, warn: 0, fail: 1 });
    expect(report.missingFields).toEqual(["storage.encryptionWired"]);
    expect(report.failures).toContain(
      "Wrap the process-level StateKV with createEncryptedStateKV from src/state/encrypted-kv.ts before treating encryption readiness as passing.",
    );
    expect(report.remoteMode).toMatchObject({
      requested: false,
      enabled: false,
      status: "pass",
    });
  });

  it("fails closed when encryption is requested before storage wiring is active", () => {
    expect(() =>
      enforceRequestedEncryptionReadinessFromEnv(readyLocalEnv()),
    ).toThrow(EncryptionPolicyError);
    try {
      enforceRequestedEncryptionReadinessFromEnv(readyLocalEnv());
    } catch (error) {
      expect(error).toBeInstanceOf(EncryptionPolicyError);
      expect((error as EncryptionPolicyError).code).toBe(
        "STORAGE_ENCRYPTION_NOT_WIRED",
      );
      expect((error as EncryptionPolicyError).report.missingFields).toEqual([
        "storage.encryptionWired",
      ]);
    }
  });

  it("keeps backup artifact encryption as a blocker until backup writers are wired", () => {
    setStorageEncryptionRuntimeWired(true);
    const report = evaluateEncryptionReadinessFromEnv(readyLocalEnv());

    expect(report.status).toBe("fail");
    expect(report.cryptography.storageWired).toBe(true);
    expect(report.summary).toEqual({ pass: 5, warn: 0, fail: 1 });
    expect(report.missingFields).toEqual(["backups.artifactEncryptionWired"]);
  });

  it("passes local readiness when StateKV and backup artifact writers are wired", () => {
    setStorageEncryptionRuntimeWired(true);
    setBackupArtifactEncryptionRuntimeWired(true);
    const report = evaluateEncryptionReadinessFromEnv(readyLocalEnv());

    expect(report.status).toBe("pass");
    expect(report.cryptography.storageWired).toBe(true);
    expect(report.summary).toEqual({ pass: 6, warn: 0, fail: 0 });
  });

  it("passes local StateKV readiness when backup artifact encryption is not requested", () => {
    setStorageEncryptionRuntimeWired(true);
    const report = evaluateEncryptionReadinessFromEnv(
      readyLocalEnv({
        AGENTMEMORY_BACKUPS_ENCRYPTION: "false",
        AGENTMEMORY_BACKUPS_ENCRYPTION_KEY_REF: undefined,
      }),
    );

    expect(report.status).toBe("pass");
    expect(report.cryptography.storageWired).toBe(true);
    expect(report.summary).toEqual({ pass: 6, warn: 0, fail: 0 });
  });

  it("does not throw the enforcement helper when encryption is not requested", () => {
    const report = enforceRequestedEncryptionReadiness({});

    expect(report.status).toBe("fail");
    expect(report.missingFields).toContain("storage.encryptionWired");
  });

  it("maps surface-specific key references ahead of the common key reference", () => {
    const policy = encryptionPolicyFromEnv(
      readyLocalEnv({
        AGENTMEMORY_DB_ENCRYPTION_KEY_REF: "file:/keys/db.keyref",
      }),
    );

    expect(policy.database?.keyRef).toBe("file:/keys/db.keyref");
    expect(policy.embeddings?.keyRef).toBe("env:AGENTMEMORY_LOCAL_KEY");
  });

  it("requires explicit remote policy before remote mode can be enabled", () => {
    const report = evaluateEncryptionReadinessFromEnv(
      readyLocalEnv({
        AGENTMEMORY_URL: "https://memory.example.com",
      }),
    );

    expect(report.status).toBe("fail");
    expect(report.remoteMode.requested).toBe(true);
    expect(report.remoteMode.enabled).toBe(false);
    expect(report.remoteMode.missingFields).toEqual([
      "remote.approved",
      "remote.authRef",
      "remote.allowedScopes",
    ]);
    expect(report.remoteMode.actions).toContain(
      "Set AGENTMEMORY_REMOTE_MODE_APPROVED=true after reviewing the remote storage policy.",
    );
  });

  it("rejects remote mode on loopback endpoints", () => {
    const report = evaluateEncryptionReadinessFromEnv(
      readyLocalEnv({
        AGENTMEMORY_ENCRYPTION_MODE: "remote",
        AGENTMEMORY_REMOTE_ENDPOINT: "http://127.0.0.1:3111",
        AGENTMEMORY_REMOTE_MODE_APPROVED: "true",
        AGENTMEMORY_REMOTE_AUTH_REF: "env:AGENTMEMORY_REMOTE_TOKEN",
        AGENTMEMORY_REMOTE_ALLOWED_SCOPES: "memories,actions",
      }),
    );

    expect(report.status).toBe("fail");
    expect(report.remoteMode.enabled).toBe(false);
    expect(report.remoteMode.missingFields).toContain(
      "remote.nonLoopbackEndpoint",
    );
  });

  it("rejects plaintext remote endpoints", () => {
    const report = evaluateEncryptionReadinessFromEnv(
      readyLocalEnv({
        AGENTMEMORY_ENCRYPTION_MODE: "remote",
        AGENTMEMORY_REMOTE_ENDPOINT: "http://memory.example.com",
        AGENTMEMORY_REMOTE_MODE_APPROVED: "true",
        AGENTMEMORY_REMOTE_AUTH_REF: "env:AGENTMEMORY_REMOTE_TOKEN",
        AGENTMEMORY_REMOTE_ALLOWED_SCOPES: "memories,actions",
      }),
    );

    expect(report.status).toBe("fail");
    expect(report.remoteMode.enabled).toBe(false);
    expect(report.remoteMode.missingFields).toContain("remote.httpsEndpoint");
  });

  it("validates remote mode policy while overall readiness waits on storage wiring", () => {
    const report = evaluateEncryptionReadinessFromEnv(
      readyLocalEnv({
        AGENTMEMORY_ENCRYPTION_MODE: "remote",
        AGENTMEMORY_REMOTE_ENDPOINT: "https://memory.example.com",
        AGENTMEMORY_REMOTE_MODE_APPROVED: "true",
        AGENTMEMORY_REMOTE_AUTH_REF: "env:AGENTMEMORY_REMOTE_TOKEN",
        AGENTMEMORY_REMOTE_ALLOWED_SCOPES: "memories,actions",
        TEAM_MODE: "shared",
        TEAM_ID: "platform",
        USER_ID: "agent-1",
        AGENTMEMORY_TEAM_POLICY_APPROVED: "true",
        AGENTMEMORY_TEAM_ALLOWED_SCOPES: "memories",
      }),
    );

    expect(report.status).toBe("fail");
    expect(report.remoteMode).toMatchObject({
      requested: true,
      enabled: true,
      status: "pass",
      endpoint: "https://memory.example.com",
    });
    expect(report.missingFields).toEqual(["storage.encryptionWired"]);
  });
});
