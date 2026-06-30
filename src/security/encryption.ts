import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

export const LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION =
  "agentmemory.local-json.v1" as const;
export const LOCAL_JSON_ENCRYPTION_ALGORITHM = "AES-256-GCM" as const;
export const LOCAL_JSON_KEY_WRAP_ALGORITHM = "scrypt+A256GCMKW" as const;
export const DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV =
  "AGENTMEMORY_ENCRYPTION_PASSPHRASE";

export type LocalJsonEncryptionEnvelopeVersion =
  typeof LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION;
export type LocalJsonEncryptionAlgorithm = typeof LOCAL_JSON_ENCRYPTION_ALGORITHM;
export type LocalJsonKeyWrapAlgorithm = typeof LOCAL_JSON_KEY_WRAP_ALGORITHM;
export type LocalJsonEncryptionErrorCode =
  | "MISSING_PASSPHRASE"
  | "INVALID_JSON_PAYLOAD"
  | "INVALID_KEY_DERIVATION"
  | "INVALID_ENVELOPE"
  | "UNSUPPORTED_ENVELOPE_VERSION"
  | "ENCRYPTION_FAILED"
  | "DECRYPTION_FAILED";

export interface LocalJsonScryptParameters {
  n: number;
  r: number;
  p: number;
  keyLength: 32;
}

export interface LocalJsonEnvelopeScryptParameters
  extends LocalJsonScryptParameters {
  salt: string;
}

export interface LocalJsonEncryptedBytes {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface LocalJsonEncryptedKey extends LocalJsonEncryptedBytes {
  algorithm: LocalJsonKeyWrapAlgorithm;
  keyRef?: string;
  scrypt: LocalJsonEnvelopeScryptParameters;
}

export interface LocalJsonEncryptionEnvelopeV1 {
  version: LocalJsonEncryptionEnvelopeVersion;
  mediaType: "application/json";
  algorithm: LocalJsonEncryptionAlgorithm;
  createdAt: string;
  keyManagement: LocalJsonEncryptedKey;
  payload: LocalJsonEncryptedBytes;
}

export type LocalJsonEncryptionEnvelope = LocalJsonEncryptionEnvelopeV1;

export interface LocalJsonEncryptionKeySource {
  passphrase?: string;
  env?: EnvLike;
  envVar?: string;
  keyRef?: string;
}

export interface LocalJsonEncryptionOptions {
  keyRef?: string;
  now?: () => Date;
  scrypt?: Partial<LocalJsonScryptParameters>;
  /**
   * Reuse a caller-supplied salt for the scrypt key-wrapping derivation. When
   * many envelopes share one salt + params, the derived wrapping key is served
   * from the in-process cache after the first derivation, so a bulk read such
   * as EncryptedStateKV.list() pays for at most one scrypt invocation instead
   * of one per item. Omit to keep the legacy per-envelope random-salt behaviour.
   */
  salt?: Buffer;
}

type EnvLike = Record<string, string | undefined>;

const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DEFAULT_SCRYPT: LocalJsonScryptParameters = {
  n: 16_384,
  r: 8,
  p: 1,
  keyLength: DATA_KEY_BYTES,
};
const MAX_SCRYPT_N = 65_536;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 4;

const WRAPPING_KEY_CACHE_MAX = 64;
const wrappingKeyCache = new Map<string, Buffer>();
let lastScryptDerivationCount = 0;

/**
 * Total scrypt derivations performed since process start. Bulk decrypt paths
 * (EncryptedStateKV.list) assert this counter does not grow per item, proving
 * the wrapping-key cache keeps the cost at one scrypt per distinct salt+params.
 */
export function localJsonScryptDerivationCount(): number {
  return lastScryptDerivationCount;
}

export class LocalJsonEncryptionError extends Error {
  readonly code: LocalJsonEncryptionErrorCode;

  constructor(code: LocalJsonEncryptionErrorCode, message: string) {
    super(message);
    this.name = "LocalJsonEncryptionError";
    this.code = code;
  }
}

export function localJsonEncryptionKeySourceFromEnv(
  env: EnvLike = process.env,
  envVar = DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV,
): LocalJsonEncryptionKeySource {
  return { env, envVar };
}

/**
 * Derives a stable, non-secret salt for the scrypt key-wrapping step from a key
 * source. Reusing one salt across every envelope written by a single adapter
 * lets the wrapping-key cache serve a bulk decrypt (list()) after a single
 * scrypt invocation. The salt is a SHA-256 of the passphrase plus a fixed
 * context label, so it is deterministic across process restarts without
 * exposing the passphrase. It is not used as cryptographic key material — it
 * only domain-separates the scrypt derivation, which the random per-item data
 * key still protects.
 */
export function deriveDeterministicLocalJsonSalt(
  keySource: string | LocalJsonEncryptionKeySource,
  keyRef?: string,
): Buffer {
  const source = resolveKeySource(keySource, keyRef);
  return createHash("sha256")
    .update("agentmemory.local-json.kek-salt.v1", "utf8")
    .update("\0", "utf8")
    .update(source.passphrase, "utf8")
    .digest()
    .subarray(0, SALT_BYTES);
}

export function encryptLocalJsonPayload(
  payload: unknown,
  keySource: string | LocalJsonEncryptionKeySource,
  options: LocalJsonEncryptionOptions = {},
): LocalJsonEncryptionEnvelope {
  const plaintext = serializeJsonPayload(payload);
  const source = resolveKeySource(keySource, options.keyRef);
  const scrypt = normalizeScryptParameters(options.scrypt);
  const salt = resolveEncryptionSalt(options.salt);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  const wrappingKey = deriveWrappingKey(source.passphrase, salt, scrypt);

  try {
    const createdAt = (options.now ?? (() => new Date()))().toISOString();
    const envelopeScrypt = {
      ...scrypt,
      salt: encodeBase64Url(salt),
    };
    const encryptedKey = encryptBytes(
      dataKey,
      wrappingKey,
      keyWrapAad(source.keyRef, envelopeScrypt, createdAt),
    );
    const encryptedPayload = encryptBytes(
      plaintext,
      dataKey,
      payloadAad(source.keyRef, createdAt),
    );

    return {
      version: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
      mediaType: "application/json",
      algorithm: LOCAL_JSON_ENCRYPTION_ALGORITHM,
      createdAt,
      keyManagement: {
        algorithm: LOCAL_JSON_KEY_WRAP_ALGORITHM,
        keyRef: source.keyRef,
        scrypt: envelopeScrypt,
        ...encryptedKey,
      },
      payload: encryptedPayload,
    };
  } catch (error) {
    throw toLocalJsonEncryptionError(
      error,
      "ENCRYPTION_FAILED",
      "Unable to encrypt local JSON payload.",
    );
  } finally {
    plaintext.fill(0);
    dataKey.fill(0);
    wrappingKey.fill(0);
    salt.fill(0);
  }
}

export function decryptLocalJsonPayload<T = unknown>(
  envelope: unknown,
  keySource: string | LocalJsonEncryptionKeySource,
): T {
  const parsedEnvelope = parseEnvelope(envelope);
  const source = resolveKeySource(
    keySource,
    parsedEnvelope.keyManagement.keyRef,
  );
  const salt = decodeBase64Url(parsedEnvelope.keyManagement.scrypt.salt, SALT_BYTES);
  const wrappingKey = deriveWrappingKey(
    source.passphrase,
    salt,
    parsedEnvelope.keyManagement.scrypt,
  );
  let dataKey: Buffer | undefined;
  let plaintext: Buffer | undefined;

  try {
    dataKey = decryptBytes(
      parsedEnvelope.keyManagement,
      wrappingKey,
      keyWrapAad(
        parsedEnvelope.keyManagement.keyRef,
        parsedEnvelope.keyManagement.scrypt,
        parsedEnvelope.createdAt,
      ),
    );
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw redactedError("INVALID_ENVELOPE");
    }
    plaintext = decryptBytes(
      parsedEnvelope.payload,
      dataKey,
      payloadAad(parsedEnvelope.keyManagement.keyRef, parsedEnvelope.createdAt),
    );
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch (error) {
    if (
      error instanceof LocalJsonEncryptionError &&
      error.code === "INVALID_ENVELOPE"
    ) {
      throw error;
    }
    throw redactedError("DECRYPTION_FAILED");
  } finally {
    dataKey?.fill(0);
    plaintext?.fill(0);
    wrappingKey.fill(0);
    salt.fill(0);
  }
}

function serializeJsonPayload(payload: unknown): Buffer {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) {
      throw new TypeError("not-json");
    }
    return Buffer.from(serialized, "utf8");
  } catch {
    throw redactedError("INVALID_JSON_PAYLOAD");
  }
}

function resolveKeySource(
  keySource: string | LocalJsonEncryptionKeySource,
  keyRef: string | undefined,
): { passphrase: string; keyRef?: string } {
  if (typeof keySource === "string") {
    return {
      passphrase: requirePassphrase(keySource),
      keyRef,
    };
  }

  const envVar = keySource.envVar ?? DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV;
  const env = keySource.env ?? process.env;
  const envPassphrase = env[envVar];
  const passphrase = keySource.passphrase ?? envPassphrase;
  const resolvedKeyRef =
    keyRef ??
    keySource.keyRef ??
    (keySource.passphrase === undefined ? `env:${envVar}` : undefined);

  return {
    passphrase: requirePassphrase(passphrase),
    keyRef: resolvedKeyRef,
  };
}

function requirePassphrase(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw redactedError("MISSING_PASSPHRASE");
  }
  return value;
}

function normalizeScryptParameters(
  overrides: Partial<LocalJsonScryptParameters> | undefined,
): LocalJsonScryptParameters {
  const params = {
    ...DEFAULT_SCRYPT,
    ...overrides,
  };

  if (
    !isPowerOfTwo(params.n) ||
    params.n < 1024 ||
    params.n > MAX_SCRYPT_N ||
    !Number.isInteger(params.r) ||
    params.r < 1 ||
    params.r > MAX_SCRYPT_R ||
    !Number.isInteger(params.p) ||
    params.p < 1 ||
    params.p > MAX_SCRYPT_P ||
    params.keyLength !== DATA_KEY_BYTES
  ) {
    throw redactedError("INVALID_KEY_DERIVATION");
  }

  return params;
}

function resolveEncryptionSalt(salt: Buffer | undefined): Buffer {
  if (salt === undefined) return randomBytes(SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw redactedError("INVALID_KEY_DERIVATION");
  }
  // Copy so the caller-owned salt is unaffected by the finally fill(0) below.
  return Buffer.from(salt);
}

function wrappingKeyCacheKey(
  passphrase: string,
  salt: Buffer,
  params: LocalJsonScryptParameters,
): string {
  return `${params.n}:${params.r}:${params.p}:${params.keyLength}:${salt.toString(
    "base64url",
  )}:${createHash("sha256").update(passphrase, "utf8").digest("base64url")}`;
}

// Returns a fresh buffer the caller may safely zero. The cache keeps its own
// copy so repeated derivations with the same salt+params (the EncryptedStateKV
// list() path) run scrypt exactly once.
function deriveWrappingKey(
  passphrase: string,
  salt: Buffer,
  params: LocalJsonScryptParameters,
): Buffer {
  const normalized = normalizeScryptParameters(params);
  const cacheKey = wrappingKeyCacheKey(passphrase, salt, normalized);
  const cached = wrappingKeyCache.get(cacheKey);
  if (cached) {
    // Refresh LRU recency.
    wrappingKeyCache.delete(cacheKey);
    wrappingKeyCache.set(cacheKey, cached);
    return Buffer.from(cached);
  }
  try {
    lastScryptDerivationCount += 1;
    const derived = scryptSync(passphrase, salt, normalized.keyLength, {
      N: normalized.n,
      r: normalized.r,
      p: normalized.p,
      maxmem: 128 * normalized.n * normalized.r * 2,
    });
    wrappingKeyCache.set(cacheKey, Buffer.from(derived));
    while (wrappingKeyCache.size > WRAPPING_KEY_CACHE_MAX) {
      const oldest = wrappingKeyCache.keys().next().value;
      if (oldest === undefined) break;
      wrappingKeyCache.delete(oldest);
    }
    return derived;
  } catch {
    throw redactedError("INVALID_KEY_DERIVATION");
  }
}

function encryptBytes(
  plaintext: Buffer,
  key: Buffer,
  additionalData: Buffer,
): LocalJsonEncryptedBytes {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: encodeBase64Url(iv),
    tag: encodeBase64Url(tag),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

function decryptBytes(
  encrypted: LocalJsonEncryptedBytes,
  key: Buffer,
  additionalData: Buffer,
): Buffer {
  try {
    const iv = decodeBase64Url(encrypted.iv, IV_BYTES);
    const tag = decodeBase64Url(encrypted.tag, TAG_BYTES);
    const ciphertext = decodeBase64Url(encrypted.ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw redactedError("DECRYPTION_FAILED");
  }
}

function parseEnvelope(envelope: unknown): LocalJsonEncryptionEnvelopeV1 {
  if (!isRecord(envelope)) {
    throw redactedError("INVALID_ENVELOPE");
  }
  if (typeof envelope.version !== "string") {
    throw redactedError("INVALID_ENVELOPE");
  }
  if (envelope.version !== LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION) {
    throw redactedError("UNSUPPORTED_ENVELOPE_VERSION");
  }
  if (
    envelope.mediaType !== "application/json" ||
    envelope.algorithm !== LOCAL_JSON_ENCRYPTION_ALGORITHM ||
    typeof envelope.createdAt !== "string" ||
    !isRecord(envelope.keyManagement) ||
    !isRecord(envelope.payload)
  ) {
    throw redactedError("INVALID_ENVELOPE");
  }

  const keyManagement = parseEncryptedKey(envelope.keyManagement);
  const payload = parseEncryptedBytes(envelope.payload);
  return {
    version: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
    mediaType: "application/json",
    algorithm: LOCAL_JSON_ENCRYPTION_ALGORITHM,
    createdAt: envelope.createdAt,
    keyManagement,
    payload,
  };
}

function parseEncryptedKey(value: Record<string, unknown>): LocalJsonEncryptedKey {
  if (value.algorithm !== LOCAL_JSON_KEY_WRAP_ALGORITHM) {
    throw redactedError("INVALID_ENVELOPE");
  }
  const keyRef = optionalString(value.keyRef);
  const encryptedBytes = parseEncryptedBytes(value);
  if (!isRecord(value.scrypt)) {
    throw redactedError("INVALID_ENVELOPE");
  }

  const scrypt = {
    n: requiredNumber(value.scrypt.n),
    r: requiredNumber(value.scrypt.r),
    p: requiredNumber(value.scrypt.p),
    keyLength: requiredKeyLength(value.scrypt.keyLength),
    salt: requiredString(value.scrypt.salt),
  };
  const normalized = normalizeScryptParameters(scrypt);
  decodeBase64Url(scrypt.salt, SALT_BYTES);

  return {
    algorithm: LOCAL_JSON_KEY_WRAP_ALGORITHM,
    keyRef,
    scrypt: {
      ...normalized,
      salt: scrypt.salt,
    },
    ...encryptedBytes,
  };
}

function parseEncryptedBytes(value: Record<string, unknown>): LocalJsonEncryptedBytes {
  const encrypted = {
    iv: requiredString(value.iv),
    tag: requiredString(value.tag),
    ciphertext: requiredString(value.ciphertext),
  };
  decodeBase64Url(encrypted.iv, IV_BYTES);
  decodeBase64Url(encrypted.tag, TAG_BYTES);
  decodeBase64Url(encrypted.ciphertext);
  return encrypted;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw redactedError("INVALID_ENVELOPE");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw redactedError("INVALID_ENVELOPE");
  }
  return value;
}

function requiredNumber(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw redactedError("INVALID_ENVELOPE");
  }
  return value as number;
}

function requiredKeyLength(value: unknown): 32 {
  if (value !== DATA_KEY_BYTES) {
    throw redactedError("INVALID_ENVELOPE");
  }
  return DATA_KEY_BYTES;
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string, expectedLength?: number): Buffer {
  if (!BASE64URL.test(value)) {
    throw redactedError("INVALID_ENVELOPE");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || (expectedLength && decoded.length !== expectedLength)) {
    throw redactedError("INVALID_ENVELOPE");
  }
  return decoded;
}

function keyWrapAad(
  keyRef: string | undefined,
  scrypt: LocalJsonEnvelopeScryptParameters,
  createdAt: string,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
      algorithm: LOCAL_JSON_KEY_WRAP_ALGORITHM,
      createdAt,
      keyRef,
      scrypt,
    }),
    "utf8",
  );
}

function payloadAad(keyRef: string | undefined, createdAt: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
      mediaType: "application/json",
      algorithm: LOCAL_JSON_ENCRYPTION_ALGORITHM,
      createdAt,
      keyRef,
    }),
    "utf8",
  );
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactedError(code: LocalJsonEncryptionErrorCode): LocalJsonEncryptionError {
  const messages: Record<LocalJsonEncryptionErrorCode, string> = {
    MISSING_PASSPHRASE:
      "A local encryption passphrase is required before encrypting or decrypting data.",
    INVALID_JSON_PAYLOAD: "Payload must be JSON serializable before encryption.",
    INVALID_KEY_DERIVATION: "Local encryption key derivation failed.",
    INVALID_ENVELOPE: "Local encryption envelope is invalid.",
    UNSUPPORTED_ENVELOPE_VERSION:
      "Local encryption envelope version is not supported.",
    ENCRYPTION_FAILED: "Unable to encrypt local JSON payload.",
    DECRYPTION_FAILED: "Unable to decrypt local JSON envelope.",
  };
  return new LocalJsonEncryptionError(code, messages[code]);
}

function toLocalJsonEncryptionError(
  error: unknown,
  fallbackCode: LocalJsonEncryptionErrorCode,
  fallbackMessage: string,
): LocalJsonEncryptionError {
  if (error instanceof LocalJsonEncryptionError) {
    return error;
  }
  return new LocalJsonEncryptionError(fallbackCode, fallbackMessage);
}
