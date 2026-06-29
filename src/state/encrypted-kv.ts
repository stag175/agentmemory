import type {
  LocalJsonEncryptionKeySource,
  LocalJsonEncryptionOptions,
  LocalJsonEncryptionEnvelope,
} from "../security/encryption.js";
import {
  LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
  decryptLocalJsonPayload,
  encryptLocalJsonPayload,
} from "../security/encryption.js";
import { KV } from "./schema.js";

export const ENCRYPTED_STATE_VALUE_FORMAT =
  "agentmemory.state.encrypted-json.v1" as const;

export type EncryptedStateKVErrorCode =
  | "PLAINTEXT_READ_BLOCKED"
  | "ENCRYPTED_UPDATE_UNSUPPORTED"
  | "INVALID_ENCRYPTED_STATE_VALUE";

export type StateScopeMatcher =
  | string
  | RegExp
  | ((scope: string) => boolean);

export type PlaintextReadPolicy = "reject" | "allow";

export interface StateKVLike {
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;
}

export interface EncryptedStateKVOptions {
  encryptedScopes?: StateScopeMatcher[];
  encryption?: LocalJsonEncryptionOptions;
  plaintextReadPolicy?: PlaintextReadPolicy;
}

export interface EncryptedStateValue {
  format: typeof ENCRYPTED_STATE_VALUE_FORMAT;
  envelope: LocalJsonEncryptionEnvelope;
}

interface EncryptedStatePayload {
  v: 1;
  scope: string;
  key: string;
  value: unknown;
}

export const DEFAULT_SENSITIVE_STATE_SCOPE_MATCHERS: StateScopeMatcher[] = [
  KV.memories,
  KV.summaries,
  KV.semantic,
  KV.procedural,
  KV.lessons,
  KV.insights,
  KV.memoryHistory,
  KV.agentEvents,
  KV.bm25Index,
  KV.imageEmbeddings,
  KV.slots,
  KV.globalSlots,
  (scope) => scope.startsWith("mem:emb:"),
  (scope) => scope.startsWith("mem:obs:"),
  (scope) => scope.startsWith("mem:enriched:"),
  (scope) => scope.startsWith("mem:team:"),
];

export class EncryptedStateKVError extends Error {
  readonly code: EncryptedStateKVErrorCode;

  constructor(code: EncryptedStateKVErrorCode, message: string) {
    super(message);
    this.name = "EncryptedStateKVError";
    this.code = code;
  }
}

export class EncryptedStateKV implements StateKVLike {
  private readonly encryptedScopes: StateScopeMatcher[];
  private readonly plaintextReadPolicy: PlaintextReadPolicy;
  private readonly encryption: LocalJsonEncryptionOptions;

  constructor(
    private readonly base: StateKVLike,
    private readonly keySource: string | LocalJsonEncryptionKeySource,
    options: EncryptedStateKVOptions = {},
  ) {
    this.encryptedScopes =
      options.encryptedScopes ?? DEFAULT_SENSITIVE_STATE_SCOPE_MATCHERS;
    this.plaintextReadPolicy = options.plaintextReadPolicy ?? "reject";
    this.encryption = options.encryption ?? {};
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    const value = await this.base.get<unknown>(scope, key);
    if (!this.shouldEncrypt(scope) || value === null) return value as T | null;
    return this.decryptStoredValue<T>(scope, key, value);
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    if (!this.shouldEncrypt(scope)) {
      return this.base.set(scope, key, value);
    }
    await this.base.set<EncryptedStateValue>(
      scope,
      key,
      this.encryptStateValue(scope, key, value),
    );
    return value;
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    if (this.shouldEncrypt(scope)) {
      throw new EncryptedStateKVError(
        "ENCRYPTED_UPDATE_UNSUPPORTED",
        "Encrypted state values cannot be patched with state::update.",
      );
    }
    return this.base.update<T>(scope, key, ops);
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.base.delete(scope, key);
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    const values = await this.base.list<unknown>(scope);
    if (!this.shouldEncrypt(scope)) return values as T[];
    return values.map((value) =>
      this.decryptStoredValue<T>(scope, undefined, value),
    );
  }

  private shouldEncrypt(scope: string): boolean {
    return this.encryptedScopes.some((matcher) => scopeMatches(matcher, scope));
  }

  private encryptStateValue(
    scope: string,
    key: string,
    value: unknown,
  ): EncryptedStateValue {
    return {
      format: ENCRYPTED_STATE_VALUE_FORMAT,
      envelope: encryptLocalJsonPayload(
        {
          v: 1,
          scope,
          key,
          value,
        } satisfies EncryptedStatePayload,
        this.keySource,
        this.encryption,
      ),
    };
  }

  private decryptStoredValue<T>(
    scope: string,
    key: string | undefined,
    value: unknown,
  ): T {
    if (!isEncryptedStateValue(value)) {
      if (this.plaintextReadPolicy === "allow") return value as T;
      throw new EncryptedStateKVError(
        "PLAINTEXT_READ_BLOCKED",
        "Encrypted state scope contains an unencrypted value.",
      );
    }

    const payload = decryptLocalJsonPayload<EncryptedStatePayload>(
      value.envelope,
      this.keySource,
    );
    if (
      payload.v !== 1 ||
      payload.scope !== scope ||
      (key !== undefined && payload.key !== key)
    ) {
      throw new EncryptedStateKVError(
        "INVALID_ENCRYPTED_STATE_VALUE",
        "Encrypted state value metadata does not match its storage location.",
      );
    }
    return payload.value as T;
  }
}

export function createEncryptedStateKV(
  base: StateKVLike,
  keySource: string | LocalJsonEncryptionKeySource,
  options: EncryptedStateKVOptions = {},
): EncryptedStateKV {
  return new EncryptedStateKV(base, keySource, options);
}

export function isEncryptedStateValue(
  value: unknown,
): value is EncryptedStateValue {
  if (!isRecord(value)) return false;
  if (value.format !== ENCRYPTED_STATE_VALUE_FORMAT) return false;
  if (!isRecord(value.envelope)) return false;
  return value.envelope.version === LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION;
}

function scopeMatches(matcher: StateScopeMatcher, scope: string): boolean {
  if (typeof matcher === "string") return matcher === scope;
  if (matcher instanceof RegExp) return matcher.test(scope);
  return matcher(scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
