import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV,
  LOCAL_JSON_ENCRYPTION_ALGORITHM,
  LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
  LocalJsonEncryptionError,
  decryptLocalJsonPayload,
  encryptLocalJsonPayload,
  localJsonEncryptionKeySourceFromEnv,
} from "../src/security/encryption.js";

const fastScrypt = {
  n: 1024,
  r: 8,
  p: 1,
  keyLength: 32,
} as const;

function flipBase64Url(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

function expectLocalJsonError(
  action: () => unknown,
  code: LocalJsonEncryptionError["code"],
): LocalJsonEncryptionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalJsonEncryptionError);
    expect((error as LocalJsonEncryptionError).code).toBe(code);
    return error as LocalJsonEncryptionError;
  }
  throw new Error("Expected LocalJsonEncryptionError");
}

describe("local JSON envelope encryption", () => {
  it("round-trips JSON through a versioned AES-256-GCM envelope", () => {
    const payload = {
      id: "mem_123",
      nested: { count: 2, ok: true },
      secret: "do-not-leak",
    };
    const envelope = encryptLocalJsonPayload(payload, "correct horse battery", {
      keyRef: "test:key",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      scrypt: fastScrypt,
    });

    expect(envelope).toMatchObject({
      version: LOCAL_JSON_ENCRYPTION_ENVELOPE_VERSION,
      mediaType: "application/json",
      algorithm: LOCAL_JSON_ENCRYPTION_ALGORITHM,
      createdAt: "2026-01-01T00:00:00.000Z",
      keyManagement: {
        algorithm: "scrypt+A256GCMKW",
        keyRef: "test:key",
        scrypt: {
          n: fastScrypt.n,
          r: fastScrypt.r,
          p: fastScrypt.p,
          keyLength: fastScrypt.keyLength,
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("do-not-leak");
    expect(
      decryptLocalJsonPayload<typeof payload>(
        envelope,
        "correct horse battery",
      ),
    ).toEqual(payload);
  });

  it("derives the wrapping key from an environment passphrase", () => {
    const env = {
      [DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV]: "env-passphrase",
    };
    const keySource = localJsonEncryptionKeySourceFromEnv(env);
    const envelope = encryptLocalJsonPayload({ ok: true }, keySource, {
      scrypt: fastScrypt,
    });

    expect(envelope.keyManagement.keyRef).toBe(
      `env:${DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV}`,
    );
    expect(decryptLocalJsonPayload(envelope, keySource)).toEqual({ ok: true });
  });

  it("fails closed when no passphrase is available", () => {
    const keySource = localJsonEncryptionKeySourceFromEnv({});
    const error = expectLocalJsonError(
      () =>
        encryptLocalJsonPayload({ ok: true }, keySource, {
          scrypt: fastScrypt,
        }),
      "MISSING_PASSPHRASE",
    );

    expect(String(error)).not.toContain(
      DEFAULT_LOCAL_JSON_ENCRYPTION_PASSPHRASE_ENV,
    );
  });

  it("rejects non-JSON payloads before encryption", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expectLocalJsonError(
      () =>
        encryptLocalJsonPayload(circular, "correct horse battery", {
          scrypt: fastScrypt,
        }),
      "INVALID_JSON_PAYLOAD",
    );
  });

  it("uses redaction-safe errors for wrong keys and tampered envelopes", () => {
    const envelope = encryptLocalJsonPayload(
      { secret: "classified-local-memory" },
      "correct horse battery",
      { scrypt: fastScrypt },
    );
    const wrongKeyError = expectLocalJsonError(
      () => decryptLocalJsonPayload(envelope, "wrong passphrase"),
      "DECRYPTION_FAILED",
    );
    const tamperedEnvelope = {
      ...envelope,
      payload: {
        ...envelope.payload,
        ciphertext: flipBase64Url(envelope.payload.ciphertext),
      },
    };
    const tamperError = expectLocalJsonError(
      () =>
        decryptLocalJsonPayload(
          tamperedEnvelope,
          "correct horse battery",
        ),
      "DECRYPTION_FAILED",
    );
    const headerTamperError = expectLocalJsonError(
      () =>
        decryptLocalJsonPayload(
          { ...envelope, createdAt: "2026-02-01T00:00:00.000Z" },
          "correct horse battery",
        ),
      "DECRYPTION_FAILED",
    );

    for (const error of [wrongKeyError, tamperError, headerTamperError]) {
      expect(String(error)).not.toContain("classified-local-memory");
      expect(String(error)).not.toContain("correct horse battery");
      expect(String(error)).not.toContain("wrong passphrase");
      expect(String(error)).not.toContain(envelope.payload.ciphertext);
    }
  });

  it("rejects unsupported envelope versions without attempting plaintext recovery", () => {
    const envelope = encryptLocalJsonPayload({ ok: true }, "passphrase", {
      scrypt: fastScrypt,
    });
    const futureEnvelope = {
      ...envelope,
      version: "agentmemory.local-json.v99",
    };

    expectLocalJsonError(
      () => decryptLocalJsonPayload(futureEnvelope, "passphrase"),
      "UNSUPPORTED_ENVELOPE_VERSION",
    );
  });
});
