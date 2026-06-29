import { describe, expect, it } from "vitest";
import {
  createRetrievalBackendAdapter,
  resolveRetrievalBackendConfig,
  SUPPORTED_RETRIEVAL_BACKENDS,
} from "../src/state/retrieval-backends.js";

describe("resolveRetrievalBackendConfig", () => {
  it("defaults to sqlite without opening a database", () => {
    const result = resolveRetrievalBackendConfig({});

    expect(result.ok).toBe(true);
    expect(result.descriptor.backend).toBe("sqlite");
    expect(result.descriptor.enabled).toBe(true);
    expect(result.descriptor.explicit).toBe(false);
    expect(result.descriptor.requiresExternalService).toBe(false);
    expect(result.descriptor.connectsDuringValidation).toBe(false);
    expect(result.descriptor.connection).toEqual({ kind: "none" });
    expect(result.descriptor.migrationSafetyNotes.join(" ")).toContain(
      "default local retrieval backend",
    );
  });

  it("accepts explicit sqlite path config", () => {
    const result = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "sqlite",
      AGENTMEMORY_SQLITE_PATH: "C:/agentmemory/state_store.db",
    });

    expect(result.ok).toBe(true);
    expect(result.descriptor.connection).toEqual({
      kind: "local-path",
      path: "C:/agentmemory/state_store.db",
    });
  });

  it("fails closed on invalid sqlite paths", () => {
    const result = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "sqlite",
      AGENTMEMORY_SQLITE_PATH: "C:/agentmemory/\0state_store.db",
    });

    expect(result.ok).toBe(false);
    expect(result.descriptor.enabled).toBe(false);
    expect(result.descriptor.connection).toEqual({ kind: "none" });
    expect(result.errors[0]).toContain("without null bytes");
  });

  it("fails closed for unsupported backends", () => {
    const result = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "pinecone",
    });

    expect(result.ok).toBe(false);
    expect(result.descriptor.backend).toBe("invalid");
    expect(result.descriptor.enabled).toBe(false);
    expect(result.errors[0]).toContain("Unsupported retrieval backend");
    expect(result.errors[0]).toContain(SUPPORTED_RETRIEVAL_BACKENDS.join(", "));
  });

  it("requires a local path for lancedb", () => {
    const missing = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "lancedb",
    });
    const configured = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "lance-db",
      LANCEDB_PATH: "./data/lancedb",
      AGENTMEMORY_RETRIEVAL_COLLECTION: "memories_v1",
    });

    expect(missing.ok).toBe(false);
    expect(missing.descriptor.enabled).toBe(false);
    expect(missing.errors[0]).toContain("requires AGENTMEMORY_LANCEDB_PATH");
    expect(configured.ok).toBe(true);
    expect(configured.descriptor.backend).toBe("lancedb");
    expect(configured.descriptor.collection).toBe("memories_v1");
    expect(configured.descriptor.connection).toEqual({
      kind: "local-path",
      path: "./data/lancedb",
    });
  });

  it("requires absolute http URLs for remote backends", () => {
    const missing = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
    });
    const invalid = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "weaviate",
      WEAVIATE_URL: "localhost:8080",
    });
    const configured = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "chroma",
      CHROMA_URL: "http://127.0.0.1:8000",
    });

    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("qdrant retrieval backend requires");
    expect(invalid.ok).toBe(false);
    expect(invalid.errors[0]).toContain("absolute http:// or https:// URL");
    expect(configured.ok).toBe(true);
    expect(configured.descriptor.connection).toMatchObject({
      kind: "http",
      url: "http://127.0.0.1:8000/",
      apiKeyRequired: false,
      apiKeyConfigured: false,
    });
  });

  it("fails closed when API key flags require missing credentials", () => {
    const result = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
      QDRANT_URL: "https://qdrant.internal",
      QDRANT_API_KEY_REQUIRED: "true",
    });

    expect(result.ok).toBe(false);
    expect(result.descriptor.enabled).toBe(false);
    expect(result.errors[0]).toContain("requires an API key");
    expect(result.errors[0]).toContain("QDRANT_API_KEY_REQUIRED is enabled");
  });

  it("requires API keys for known managed cloud URLs", () => {
    const missing = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "weaviate",
      WEAVIATE_URL: "https://demo.weaviate.cloud",
    });
    const configured = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "weaviate",
      WEAVIATE_URL: "https://demo.weaviate.cloud",
      WEAVIATE_API_KEY: "secret-value",
    });

    expect(missing.ok).toBe(false);
    expect(missing.errors[0]).toContain("cloud URLs require API key");
    expect(configured.ok).toBe(true);
    expect(configured.descriptor.connection).toEqual({
      kind: "http",
      url: "https://demo.weaviate.cloud/",
      apiKeyRequired: true,
      apiKeyConfigured: true,
      apiKeyEnvVar: "WEAVIATE_API_KEY",
    });
    expect(JSON.stringify(configured.descriptor)).not.toContain("secret-value");
  });

  it("keeps remote migration notes explicit and non-connecting", () => {
    const result = resolveRetrievalBackendConfig({
      AGENTMEMORY_RETRIEVAL_BACKEND: "chroma",
      CHROMA_URL: "http://localhost:8000",
      AGENTMEMORY_RETRIEVAL_API_KEY: "present-but-local",
    });

    expect(result.ok).toBe(true);
    expect(result.descriptor.connectsDuringValidation).toBe(false);
    expect(result.descriptor.migrationSafetyNotes.join(" ")).toContain(
      "never imports vendor clients or opens network connections",
    );
    expect(result.descriptor.migrationSafetyNotes.join(" ")).toContain(
      "Treat remote collections as derived indexes",
    );
    expect(result.descriptor.warnings[0]).toContain(
      "AGENTMEMORY_RETRIEVAL_API_KEY is configured but not required",
    );
  });
});

describe("createRetrievalBackendAdapter", () => {
  it("creates an available sqlite adapter without dependency or network checks", () => {
    const result = createRetrievalBackendAdapter({});

    expect(result.ok).toBe(true);
    expect(result.adapter.backend).toBe("sqlite");
    expect(result.adapter.availability).toMatchObject({
      status: "available",
      explicitConfigRequired: false,
      explicitlyConfigured: false,
    });
    expect(result.adapter.capabilities).toEqual({
      local: true,
      requiresVendorClient: false,
      requiresNetwork: false,
      derivedIndex: false,
    });
    expect(result.adapter.connectsDuringFactory).toBe(false);

    const plan = result.adapter.planHealthCheck();
    expect(plan.networkFreeByDefault).toBe(true);
    expect(plan.dependencyFreeByDefault).toBe(true);
    expect(plan.connectsDuringFactory).toBe(false);
    expect(plan.checks).toEqual([
      expect.objectContaining({ id: "config", status: "pass", mode: "static" }),
      expect.objectContaining({
        id: "dependency",
        status: "pass",
        mode: "static",
      }),
    ]);
  });

  it("rejects invalid backend configs at the adapter boundary", () => {
    const result = createRetrievalBackendAdapter({
      AGENTMEMORY_RETRIEVAL_BACKEND: "pinecone",
    });

    expect(result.ok).toBe(false);
    expect(result.adapter.backend).toBe("invalid");
    expect(result.adapter.availability.status).toBe("invalid");
    expect(result.adapter.connectsDuringFactory).toBe(false);
    expect(result.errors[0]).toContain("Unsupported retrieval backend");

    const plan = result.adapter.planHealthCheck();
    expect(plan.backend).toBe("invalid");
    expect(plan.checks[0]).toMatchObject({
      id: "config",
      status: "fail",
      mode: "static",
      blocking: true,
    });
    expect(plan.nextSteps.join(" ")).toContain(
      SUPPORTED_RETRIEVAL_BACKENDS.join(", "),
    );
  });

  it("represents external backends as unavailable unless explicitly configured", () => {
    const backends = ["lancedb", "qdrant", "weaviate", "chroma"] as const;

    for (const backend of backends) {
      const result = createRetrievalBackendAdapter({
        AGENTMEMORY_RETRIEVAL_BACKEND: backend,
      });

      expect(result.ok, backend).toBe(false);
      expect(result.adapter.backend, backend).toBe(backend);
      expect(result.adapter.availability, backend).toMatchObject({
        status: "unavailable",
        explicitConfigRequired: true,
        explicitlyConfigured: false,
      });
      expect(result.adapter.connectsDuringFactory, backend).toBe(false);

      const plan = result.adapter.planHealthCheck();
      expect(plan.networkFreeByDefault, backend).toBe(true);
      expect(plan.dependencyFreeByDefault, backend).toBe(true);
      expect(plan.checks[0], backend).toMatchObject({
        id: "config",
        status: "fail",
        mode: "static",
        blocking: true,
      });
    }
  });

  it("represents configured external backends without importing clients or probing health", () => {
    const configured = [
      {
        backend: "lancedb",
        env: {
          AGENTMEMORY_RETRIEVAL_BACKEND: "lancedb",
          AGENTMEMORY_LANCEDB_PATH: "./data/lancedb",
        },
        requiresNetwork: false,
      },
      {
        backend: "qdrant",
        env: {
          AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
          QDRANT_URL: "http://127.0.0.1:6333",
        },
        requiresNetwork: true,
      },
      {
        backend: "weaviate",
        env: {
          AGENTMEMORY_RETRIEVAL_BACKEND: "weaviate",
          WEAVIATE_URL: "http://127.0.0.1:8080",
        },
        requiresNetwork: true,
      },
      {
        backend: "chroma",
        env: {
          AGENTMEMORY_RETRIEVAL_BACKEND: "chroma",
          CHROMA_URL: "http://127.0.0.1:8000",
        },
        requiresNetwork: true,
      },
    ] as const;

    for (const { backend, env, requiresNetwork } of configured) {
      const result = createRetrievalBackendAdapter(env);

      expect(result.ok, backend).toBe(true);
      expect(result.adapter.backend, backend).toBe(backend);
      expect(result.adapter.availability, backend).toMatchObject({
        status: "available",
        explicitConfigRequired: true,
        explicitlyConfigured: true,
      });
      expect(result.adapter.capabilities.requiresVendorClient, backend).toBe(
        true,
      );
      expect(result.adapter.capabilities.requiresNetwork, backend).toBe(
        requiresNetwork,
      );
      expect(result.adapter.connectsDuringFactory, backend).toBe(false);

      const plan = result.adapter.planHealthCheck();
      expect(plan.checks, backend).toContainEqual(
        expect.objectContaining({
          id: "dependency",
          status: "not-run",
          mode: "manual",
          blocking: false,
        }),
      );
      if (requiresNetwork) {
        expect(plan.checks, backend).toContainEqual(
          expect.objectContaining({
            id: "connectivity",
            status: "not-run",
            mode: "manual",
            blocking: false,
          }),
        );
      } else {
        expect(plan.checks.some((check) => check.id === "connectivity")).toBe(
          false,
        );
      }
    }
  });
});
