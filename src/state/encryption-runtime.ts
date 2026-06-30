import {
  decryptLocalJsonPayload,
  encryptLocalJsonPayload,
  localJsonEncryptionKeySourceFromEnv,
  type LocalJsonEncryptionKeySource,
} from "../security/encryption.js";
import {
  EncryptionPolicyError,
  encryptionPolicyFromEnv,
  evaluateEncryptionReadiness,
  setBackupArtifactEncryptionRuntimeWired,
  setStorageEncryptionRuntimeWired,
  type EncryptionPolicyConfig,
  type EncryptionReadinessReport,
} from "../security/encryption-policy.js";
import {
  createEncryptedStateKV,
  type EncryptedStateKV,
  type StateKVLike,
} from "./encrypted-kv.js";

type EnvLike = Record<string, string | undefined>;

export interface StateEncryptionRuntimeResult {
  kv: StateKVLike;
  encrypted: boolean;
  report: EncryptionReadinessReport;
  keyRef?: string;
}

export function configureStateEncryptionRuntime(
  base: StateKVLike,
  env: EnvLike = process.env,
): StateEncryptionRuntimeResult {
  const config = encryptionPolicyFromEnv(env);
  if (!isEncryptionRequestedForRuntime(config)) {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
    return {
      kv: base,
      encrypted: false,
      report: evaluateEncryptionReadiness(config),
    };
  }

  const keyRefs = requestedKeyRefs(config);
  const keyRef = config.database?.keyRef ?? keyRefs[0];
  let keySource: LocalJsonEncryptionKeySource | undefined;
  setStorageEncryptionRuntimeWired(false);
  setBackupArtifactEncryptionRuntimeWired(false);
  // The adapter wraps every encrypted surface with a single key. If distinct
  // per-surface keyRefs are configured we would silently honour only one and
  // store the others' data under the wrong key, so fail closed instead of
  // pretending each surface uses its declared keyRef.
  if (keyRefs.length > 1) {
    throw new EncryptionPolicyError(
      "ENCRYPTION_READINESS_FAILED",
      "Distinct per-surface encryption key references are configured, but the storage adapter honours a single key. Use one key reference (AGENTMEMORY_ENCRYPTION_KEY_REF) for all encrypted surfaces.",
      evaluateEncryptionReadiness(config),
    );
  }
  if (keyRef && keyRefs.length > 0) {
    for (const requestedKeyRef of keyRefs) {
      const requestedKeySource = keySourceFromEncryptionKeyRef(requestedKeyRef, env);
      assertEncryptionKeyUsable(requestedKeySource, requestedKeyRef);
    }
    keySource = keySourceFromEncryptionKeyRef(keyRef, env);
    setStorageEncryptionRuntimeWired(true);
    setBackupArtifactEncryptionRuntimeWired(config.backups?.enabled === true);
  } else {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
  }

  const report = evaluateEncryptionReadiness(config);
  if (report.status === "fail") {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
    throw new EncryptionPolicyError(
      report.missingFields.includes("storage.encryptionWired")
        ? "STORAGE_ENCRYPTION_NOT_WIRED"
        : "ENCRYPTION_READINESS_FAILED",
      "Encryption was requested, but storage encryption readiness failed.",
      report,
    );
  }
  if (!keyRef || !keySource) {
    setStorageEncryptionRuntimeWired(false);
    setBackupArtifactEncryptionRuntimeWired(false);
    throw new EncryptionPolicyError(
      "ENCRYPTION_READINESS_FAILED",
      "Encryption was requested, but no database encryption key reference was resolved.",
      report,
    );
  }

  return {
    kv: createEncryptedStateKV(base, keySource, {
      encryption: { keyRef },
      plaintextReadPolicy:
        env["AGENTMEMORY_ENCRYPTION_ALLOW_LEGACY_PLAINTEXT"] === "true"
          ? "allow"
          : "reject",
    }),
    encrypted: true,
    report,
    keyRef,
  };
}

export function keySourceFromEncryptionKeyRef(
  keyRef: string,
  env: EnvLike = process.env,
): LocalJsonEncryptionKeySource {
  const ref = keyRef.trim();
  if (ref.startsWith("env:")) {
    const envVar = ref.slice("env:".length).trim();
    return { env, envVar, keyRef: ref };
  }
  return {
    ...localJsonEncryptionKeySourceFromEnv(env),
    keyRef: ref,
  };
}

export function isEncryptedStateKV(value: StateKVLike): value is EncryptedStateKV {
  return value.constructor.name === "EncryptedStateKV";
}

function isEncryptionRequestedForRuntime(config: EncryptionPolicyConfig): boolean {
  return Boolean(
    config.mode === "remote" ||
      config.remote?.requested === true ||
      config.database?.enabled === true ||
      config.embeddings?.enabled === true ||
      config.transcripts?.enabled === true ||
      config.backups?.enabled === true,
  );
}

function requestedKeyRefs(config: EncryptionPolicyConfig): string[] {
  return [
    config.database,
    config.embeddings,
    config.transcripts,
    config.backups,
  ].flatMap((surface) =>
    surface?.enabled === true && surface.keyRef ? [surface.keyRef] : [],
  ).filter((value, index, array) => array.indexOf(value) === index);
}

function assertEncryptionKeyUsable(
  keySource: LocalJsonEncryptionKeySource,
  keyRef: string,
): void {
  const envelope = encryptLocalJsonPayload(
    { probe: "agentmemory-storage-encryption" },
    keySource,
    { keyRef },
  );
  decryptLocalJsonPayload(envelope, keySource);
}
