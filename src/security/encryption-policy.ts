import {
  LOCAL_JSON_ENCRYPTION_ALGORITHM,
  LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
} from "./encryption.js";

export type EncryptionReadinessStatus = "pass" | "warn" | "fail";
export type EncryptionPolicyMode = "local" | "remote";
export type EncryptionPolicyErrorCode =
  | "ENCRYPTION_READINESS_FAILED"
  | "STORAGE_ENCRYPTION_NOT_WIRED";
export type EncryptionSurface =
  | "database"
  | "embeddings"
  | "transcripts"
  | "backups";

export interface EncryptionSurfacePolicy {
  enabled?: boolean;
  keyRef?: string;
}

export interface RemoteEncryptionPolicy {
  requested?: boolean;
  endpoint?: string;
  approved?: boolean;
  authRef?: string;
  allowedScopes?: string[];
  teamMode?: "private" | "shared";
  teamPolicyApproved?: boolean;
  teamId?: string;
  userId?: string;
  teamAllowedScopes?: string[];
}

export interface EncryptionPolicyConfig {
  mode?: EncryptionPolicyMode;
  database?: EncryptionSurfacePolicy;
  embeddings?: EncryptionSurfacePolicy;
  transcripts?: EncryptionSurfacePolicy;
  backups?: EncryptionSurfacePolicy;
  remote?: RemoteEncryptionPolicy;
}

export interface EncryptionReadinessCheck {
  id: EncryptionSurface | "remote" | "storage_wiring";
  label: string;
  status: EncryptionReadinessStatus;
  missingFields: string[];
  actions: string[];
}

export interface EncryptionReadinessReport {
  version: "encryption_policy_v1";
  status: EncryptionReadinessStatus;
  mode: EncryptionPolicyMode;
  cryptography: {
    implemented: boolean;
    storageWired: boolean;
    storageAdapterAvailable: boolean;
    module?: "src/security/encryption.ts";
    storageAdapterModule?: "src/state/encrypted-kv.ts";
    envelopeVersion?: typeof LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION;
    algorithm?: typeof LOCAL_JSON_ENCRYPTION_ALGORITHM;
    note: string;
  };
  remoteMode: {
    requested: boolean;
    enabled: boolean;
    status: EncryptionReadinessStatus;
    endpoint?: string;
    missingFields: string[];
    actions: string[];
  };
  checks: EncryptionReadinessCheck[];
  missingFields: string[];
  failures: string[];
  warnings: string[];
  summary: Record<EncryptionReadinessStatus, number>;
}

type EnvLike = Record<string, string | undefined>;

const SURFACES: Array<{
  id: EncryptionSurface;
  label: string;
  enabledEnv: string;
  keyRefEnv: string;
}> = [
  {
    id: "database",
    label: "State database",
    enabledEnv: "AGENTMEMORY_DB_ENCRYPTION",
    keyRefEnv: "AGENTMEMORY_DB_ENCRYPTION_KEY_REF",
  },
  {
    id: "embeddings",
    label: "Embedding index",
    enabledEnv: "AGENTMEMORY_EMBEDDINGS_ENCRYPTION",
    keyRefEnv: "AGENTMEMORY_EMBEDDINGS_ENCRYPTION_KEY_REF",
  },
  {
    id: "transcripts",
    label: "Transcript capture",
    enabledEnv: "AGENTMEMORY_TRANSCRIPTS_ENCRYPTION",
    keyRefEnv: "AGENTMEMORY_TRANSCRIPTS_ENCRYPTION_KEY_REF",
  },
  {
    id: "backups",
    label: "Backups",
    enabledEnv: "AGENTMEMORY_BACKUPS_ENCRYPTION",
    keyRefEnv: "AGENTMEMORY_BACKUPS_ENCRYPTION_KEY_REF",
  },
];

const COMMON_KEY_REF_ENV = "AGENTMEMORY_ENCRYPTION_KEY_REF";
const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "off", "disabled"]);
let storageEncryptionRuntimeWired = false;
let backupArtifactEncryptionRuntimeWired = false;

export class EncryptionPolicyError extends Error {
  readonly code: EncryptionPolicyErrorCode;
  readonly report: EncryptionReadinessReport;

  constructor(
    code: EncryptionPolicyErrorCode,
    message: string,
    report: EncryptionReadinessReport,
  ) {
    super(message);
    this.name = "EncryptionPolicyError";
    this.code = code;
    this.report = report;
  }
}

function cleanString(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function cleanList(values: string[] | undefined): string[] {
  return unique((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function parseCsv(value: string | undefined): string[] {
  return cleanList(value?.split(","));
}

function readBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return undefined;
}

function normalizeMode(value: string | undefined): EncryptionPolicyMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "remote") return normalized;
  return undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function fieldName(surface: EncryptionSurface, field: "enabled" | "keyRef"): string {
  return `${surface}.${field}`;
}

function surfaceEnv(id: EncryptionSurface, field: "enabled" | "keyRef"): string {
  const surface = SURFACES.find((entry) => entry.id === id);
  if (!surface) return COMMON_KEY_REF_ENV;
  return field === "enabled" ? surface.enabledEnv : surface.keyRefEnv;
}

function requiredAction(field: string): string {
  if (field.endsWith(".enabled")) {
    const surface = field.slice(0, field.indexOf(".")) as EncryptionSurface;
    return `Set ${surfaceEnv(surface, "enabled")}=true or provide ${field}=true in config.`;
  }
  if (field.endsWith(".keyRef")) {
    const surface = field.slice(0, field.indexOf(".")) as EncryptionSurface;
    return `Set ${surfaceEnv(surface, "keyRef")} or ${COMMON_KEY_REF_ENV} to a key reference, not key material.`;
  }
  if (field === "remote.endpoint") {
    return "Set a non-loopback HTTPS remote endpoint before requesting remote mode.";
  }
  if (field === "remote.approved") {
    return "Set AGENTMEMORY_REMOTE_MODE_APPROVED=true after reviewing the remote storage policy.";
  }
  if (field === "remote.authRef") {
    return "Set AGENTMEMORY_REMOTE_AUTH_REF or AGENTMEMORY_REMOTE_TOKEN_ENV to a credential reference.";
  }
  if (field === "remote.allowedScopes") {
    return "Set AGENTMEMORY_REMOTE_ALLOWED_SCOPES to the exact scopes remote mode may access.";
  }
  if (field === "remote.httpsEndpoint") {
    return "Use HTTPS/WSS for non-loopback remote endpoints or keep the endpoint local.";
  }
  if (field === "remote.nonLoopbackEndpoint") {
    return "Use a non-loopback endpoint for remote mode or set AGENTMEMORY_ENCRYPTION_MODE=local.";
  }
  if (field === "team.policyApproved") {
    return "Set AGENTMEMORY_TEAM_POLICY_APPROVED=true after approving team sharing boundaries.";
  }
  if (field === "team.id") {
    return "Set TEAM_ID or AGENTMEMORY_TEAM_ID for remote team mode.";
  }
  if (field === "team.userId") {
    return "Set USER_ID or AGENTMEMORY_USER_ID for remote team mode.";
  }
  if (field === "team.allowedScopes") {
    return "Set AGENTMEMORY_TEAM_ALLOWED_SCOPES to the scopes approved for team sharing.";
  }
  if (field === "backups.artifactEncryptionWired") {
    return "Wire snapshot/backup artifact writers through local JSON encryption before enabling backup encryption.";
  }
  return `Provide ${field}.`;
}

function statusRank(status: EncryptionReadinessStatus): number {
  return status === "fail" ? 2 : status === "warn" ? 1 : 0;
}

function overallStatus(checks: EncryptionReadinessCheck[]): EncryptionReadinessStatus {
  return checks.reduce<EncryptionReadinessStatus>(
    (current, check) =>
      statusRank(check.status) > statusRank(current) ? check.status : current,
    "pass",
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function parseEndpoint(value: string | undefined): URL | null {
  const endpoint = cleanString(value);
  if (!endpoint) return null;
  try {
    return new URL(endpoint);
  } catch {
    return null;
  }
}

function isRemoteEndpoint(value: string | undefined): boolean {
  const parsed = parseEndpoint(value);
  return Boolean(parsed && !isLoopbackHostname(parsed.hostname));
}

function isInsecureRemoteEndpoint(value: string | undefined): boolean {
  const parsed = parseEndpoint(value);
  return Boolean(
    parsed &&
      (parsed.protocol === "http:" || parsed.protocol === "ws:") &&
      !isLoopbackHostname(parsed.hostname),
  );
}

function checkSurface(
  id: EncryptionSurface,
  label: string,
  policy: EncryptionSurfacePolicy | undefined,
): EncryptionReadinessCheck {
  if (policy?.enabled === false) {
    return {
      id,
      label,
      status: "pass",
      missingFields: [],
      actions: [],
    };
  }
  const missingFields: string[] = [];
  if (policy?.enabled !== true) missingFields.push(fieldName(id, "enabled"));
  if (!cleanString(policy?.keyRef)) missingFields.push(fieldName(id, "keyRef"));
  const status: EncryptionReadinessStatus =
    missingFields.length > 0 ? "fail" : "pass";
  return {
    id,
    label,
    status,
    missingFields,
    actions: missingFields.map(requiredAction),
  };
}

function checkRemotePolicy(
  mode: EncryptionPolicyMode,
  remote: RemoteEncryptionPolicy | undefined,
): EncryptionReadinessCheck {
  const endpoint = cleanString(remote?.endpoint);
  const requested = remote?.requested === true || mode === "remote";
  const missingFields: string[] = [];

  if (requested) {
    if (!endpoint) missingFields.push("remote.endpoint");
    if (remote?.approved !== true) missingFields.push("remote.approved");
    if (!cleanString(remote?.authRef)) missingFields.push("remote.authRef");
    if (cleanList(remote?.allowedScopes).length === 0) {
      missingFields.push("remote.allowedScopes");
    }
    if (endpoint && !isRemoteEndpoint(endpoint)) {
      missingFields.push("remote.nonLoopbackEndpoint");
    }
    if (isInsecureRemoteEndpoint(endpoint)) {
      missingFields.push("remote.httpsEndpoint");
    }
  }

  const teamPolicyRequired = requested && Boolean(
    remote?.teamMode === "shared" ||
      remote?.teamPolicyApproved === true ||
      cleanString(remote?.teamId) ||
      cleanString(remote?.userId) ||
      cleanList(remote?.teamAllowedScopes).length > 0,
  );
  if (teamPolicyRequired) {
    if (remote?.teamPolicyApproved !== true) {
      missingFields.push("team.policyApproved");
    }
    if (!cleanString(remote?.teamId)) missingFields.push("team.id");
    if (!cleanString(remote?.userId)) missingFields.push("team.userId");
    if (cleanList(remote?.teamAllowedScopes).length === 0) {
      missingFields.push("team.allowedScopes");
    }
  }

  const status: EncryptionReadinessStatus =
    missingFields.length > 0 ? "fail" : "pass";
  return {
    id: "remote",
    label: "Remote and team policy",
    status,
    missingFields: unique(missingFields),
    actions: unique(missingFields).map(requiredAction),
  };
}

function checkStorageWiring(
  config: EncryptionPolicyConfig,
): EncryptionReadinessCheck {
  if (storageEncryptionRuntimeWired) {
    const missingFields =
      config.backups?.enabled === true && !backupArtifactEncryptionRuntimeWired
        ? ["backups.artifactEncryptionWired"]
        : [];
    return {
      id: "storage_wiring",
      label: "Storage encryption wiring",
      status: missingFields.length > 0 ? "fail" : "pass",
      missingFields,
      actions: missingFields.map(requiredAction),
    };
  }
  return {
    id: "storage_wiring",
    label: "Storage encryption wiring",
    status: "fail",
    missingFields: ["storage.encryptionWired"],
    actions: [
      "Wrap the process-level StateKV with createEncryptedStateKV from src/state/encrypted-kv.ts before treating encryption readiness as passing.",
    ],
  };
}

function isEncryptionRequested(config: EncryptionPolicyConfig): boolean {
  const mode = config.mode ?? "local";
  return (
    mode === "remote" ||
    config.remote?.requested === true ||
    SURFACES.some((surface) => config[surface.id]?.enabled === true)
  );
}

export function encryptionPolicyFromEnv(
  env: EnvLike = process.env,
): EncryptionPolicyConfig {
  const mode = normalizeMode(env["AGENTMEMORY_ENCRYPTION_MODE"]) ?? "local";
  const commonKeyRef = cleanString(env[COMMON_KEY_REF_ENV]);
  const endpoint =
    cleanString(env["AGENTMEMORY_REMOTE_ENDPOINT"]) ??
    cleanString(env["AGENTMEMORY_URL"]) ??
    cleanString(env["III_ENGINE_URL"]);
  const remoteRequested =
    mode === "remote" ||
    readBoolean(env["AGENTMEMORY_REMOTE_MODE"]) === true ||
    isRemoteEndpoint(endpoint);

  return {
    mode,
    database: readSurfacePolicy(env, "database", commonKeyRef),
    embeddings: readSurfacePolicy(env, "embeddings", commonKeyRef),
    transcripts: readSurfacePolicy(env, "transcripts", commonKeyRef),
    backups: readSurfacePolicy(env, "backups", commonKeyRef),
    remote: {
      requested: remoteRequested,
      endpoint,
      approved: readBoolean(env["AGENTMEMORY_REMOTE_MODE_APPROVED"]),
      authRef:
        cleanString(env["AGENTMEMORY_REMOTE_AUTH_REF"]) ??
        cleanString(env["AGENTMEMORY_REMOTE_TOKEN_ENV"]),
      allowedScopes: parseCsv(env["AGENTMEMORY_REMOTE_ALLOWED_SCOPES"]),
      teamMode: env["TEAM_MODE"] === "shared" ? "shared" : undefined,
      teamPolicyApproved: readBoolean(env["AGENTMEMORY_TEAM_POLICY_APPROVED"]),
      teamId:
        cleanString(env["AGENTMEMORY_TEAM_ID"]) ?? cleanString(env["TEAM_ID"]),
      userId:
        cleanString(env["AGENTMEMORY_USER_ID"]) ?? cleanString(env["USER_ID"]),
      teamAllowedScopes: parseCsv(env["AGENTMEMORY_TEAM_ALLOWED_SCOPES"]),
    },
  };
}

function readSurfacePolicy(
  env: EnvLike,
  id: EncryptionSurface,
  commonKeyRef: string | undefined,
): EncryptionSurfacePolicy {
  const surface = SURFACES.find((entry) => entry.id === id);
  if (!surface) return {};
  return {
    enabled: readBoolean(env[surface.enabledEnv]),
    keyRef: cleanString(env[surface.keyRefEnv]) ?? commonKeyRef,
  };
}

export function evaluateEncryptionReadiness(
  config: EncryptionPolicyConfig,
): EncryptionReadinessReport {
  const mode = config.mode ?? "local";
  const checks = [
    ...SURFACES.map((surface) =>
      checkSurface(surface.id, surface.label, config[surface.id]),
    ),
    checkRemotePolicy(mode, config.remote),
    checkStorageWiring(config),
  ];
  const status = overallStatus(checks);
  const missingFields = unique(checks.flatMap((check) => check.missingFields));
  const failures = checks
    .filter((check) => check.status === "fail")
    .flatMap((check) => check.actions);
  const warnings = checks
    .filter((check) => check.status === "warn")
    .flatMap((check) => check.actions);
  const remoteCheck = checks.find((check) => check.id === "remote");
  const requestedRemote = config.remote?.requested === true || mode === "remote";

  return {
    version: "encryption_policy_v1",
    status,
    mode,
    cryptography: {
      implemented: true,
      storageWired: storageEncryptionRuntimeWired,
      storageAdapterAvailable: true,
      module: "src/security/encryption.ts",
      storageAdapterModule: "src/state/encrypted-kv.ts",
      envelopeVersion: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
      algorithm: LOCAL_JSON_ENCRYPTION_ALGORITHM,
      note: storageEncryptionRuntimeWired
        ? "Local JSON envelope encryption/decryption and a StateKV-compatible adapter are wired into the worker runtime."
        : "Local JSON envelope encryption/decryption and a StateKV-compatible adapter are implemented, but the worker lifecycle is not wired through the adapter yet.",
    },
    remoteMode: {
      requested: requestedRemote,
      enabled: requestedRemote && remoteCheck?.status !== "fail",
      status: remoteCheck?.status ?? "pass",
      endpoint: cleanString(config.remote?.endpoint),
      missingFields: remoteCheck?.missingFields ?? [],
      actions: remoteCheck?.actions ?? [],
    },
    checks,
    missingFields,
    failures,
    warnings,
    summary: {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
    },
  };
}

export function evaluateEncryptionReadinessFromEnv(
  env: EnvLike = process.env,
): EncryptionReadinessReport {
  return evaluateEncryptionReadiness(encryptionPolicyFromEnv(env));
}

export function setStorageEncryptionRuntimeWired(wired: boolean): void {
  storageEncryptionRuntimeWired = wired;
}

export function isStorageEncryptionRuntimeWired(): boolean {
  return storageEncryptionRuntimeWired;
}

export function setBackupArtifactEncryptionRuntimeWired(wired: boolean): void {
  backupArtifactEncryptionRuntimeWired = wired;
}

export function isBackupArtifactEncryptionRuntimeWired(): boolean {
  return backupArtifactEncryptionRuntimeWired;
}

export function enforceRequestedEncryptionReadiness(
  config: EncryptionPolicyConfig,
): EncryptionReadinessReport {
  const report = evaluateEncryptionReadiness(config);
  if (!isEncryptionRequested(config) || report.status !== "fail") return report;
  const code = report.missingFields.includes("storage.encryptionWired")
    ? "STORAGE_ENCRYPTION_NOT_WIRED"
    : "ENCRYPTION_READINESS_FAILED";
  throw new EncryptionPolicyError(
    code,
    "Encryption was requested, but storage encryption readiness failed.",
    report,
  );
}

export function enforceRequestedEncryptionReadinessFromEnv(
  env: EnvLike = process.env,
): EncryptionReadinessReport {
  return enforceRequestedEncryptionReadiness(encryptionPolicyFromEnv(env));
}
