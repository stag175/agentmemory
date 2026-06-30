import { describe, expect, it, vi } from "vitest";
import {
  createRetrievalBackendAdapter,
  evaluateRetrievalBackendAvailability,
  resolveRetrievalBackendConfig,
  SUPPORTED_RETRIEVAL_BACKENDS,
} from "../src/state/retrieval-backends.js";
import {
  QdrantHttpError,
  QdrantRetrievalStore,
} from "../src/state/retrieval-qdrant-adapter.js";

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

  it("reports backends with no runtime adapter as reserved, never available", () => {
    const reserved = [
      {
        backend: "lancedb",
        env: {
          AGENTMEMORY_RETRIEVAL_BACKEND: "lancedb",
          AGENTMEMORY_LANCEDB_PATH: "./data/lancedb",
        },
        requiresNetwork: false,
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

    for (const { backend, env, requiresNetwork } of reserved) {
      const result = createRetrievalBackendAdapter(env);

      expect(result.ok, backend).toBe(true);
      expect(result.adapter.backend, backend).toBe(backend);
      expect(result.adapter.availability.status, backend).not.toBe("available");
      expect(result.adapter.availability, backend).toMatchObject({
        status: "reserved",
        explicitConfigRequired: true,
        explicitlyConfigured: true,
        runtimeImplemented: false,
      });
      // No runtime store is built for a backend that has no implementation.
      expect(result.adapter.store, backend).toBeNull();
      expect(result.adapter.connectsDuringFactory, backend).toBe(false);
      expect(result.adapter.capabilities.requiresNetwork, backend).toBe(
        requiresNetwork,
      );

      const plan = result.adapter.planHealthCheck();
      // Config parsed cleanly, so the config check passes even though the
      // backend is reserved.
      expect(plan.checks[0], backend).toMatchObject({
        id: "config",
        status: "pass",
        mode: "static",
      });
      expect(plan.nextSteps.join(" "), backend).toContain("reserved");
    }
  });

  it("treats configured qdrant as reserved until a health check runs", () => {
    const result = createRetrievalBackendAdapter({
      AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
      QDRANT_URL: "http://127.0.0.1:6333",
    });

    expect(result.ok).toBe(true);
    expect(result.adapter.backend).toBe("qdrant");
    expect(result.adapter.availability.status).toBe("reserved");
    expect(result.adapter.availability).toMatchObject({
      status: "reserved",
      explicitConfigRequired: true,
      explicitlyConfigured: true,
      runtimeImplemented: true,
      healthChecked: false,
    });
    // qdrant has a real runtime store even before the probe runs.
    expect(result.adapter.store).not.toBeNull();
    expect(result.adapter.connectsDuringFactory).toBe(false);

    const plan = result.adapter.planHealthCheck();
    expect(plan.checks[0]).toMatchObject({ id: "config", status: "pass" });
    expect(plan.checks).toContainEqual(
      expect.objectContaining({ id: "connectivity", status: "not-run" }),
    );
  });
});

describe("evaluateRetrievalBackendAvailability", () => {
  it("marks qdrant available only when the health check passes", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toBe("http://127.0.0.1:6333/healthz");
      return new Response("healthz check passed", { status: 200 });
    }) as unknown as typeof fetch;

    const evaluation = await evaluateRetrievalBackendAvailability({
      env: {
        AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
        QDRANT_URL: "http://127.0.0.1:6333",
      },
      fetchImpl,
    });

    expect(evaluation.adapter.backend).toBe("qdrant");
    expect(evaluation.health?.reachable).toBe(true);
    expect(evaluation.availability).toMatchObject({
      status: "available",
      runtimeImplemented: true,
      healthChecked: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps qdrant unavailable when the health check fails", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("service unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }) as unknown as typeof fetch;

    const evaluation = await evaluateRetrievalBackendAvailability({
      env: {
        AGENTMEMORY_RETRIEVAL_BACKEND: "qdrant",
        QDRANT_URL: "http://127.0.0.1:6333",
      },
      fetchImpl,
    });

    expect(evaluation.health?.reachable).toBe(false);
    expect(evaluation.availability.status).toBe("unavailable");
    expect(evaluation.availability.healthChecked).toBe(true);
    expect(evaluation.availability.reason).toContain("503");
  });

  it("never probes a reserved backend with no runtime adapter", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));

    const evaluation = await evaluateRetrievalBackendAvailability({
      env: {
        AGENTMEMORY_RETRIEVAL_BACKEND: "weaviate",
        WEAVIATE_URL: "http://127.0.0.1:8080",
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(evaluation.availability.status).toBe("reserved");
    expect(evaluation.health).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("QdrantRetrievalStore", () => {
  it("upserts points via PUT to the collection points endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ result: { status: "ok" } }), {
          status: 200,
        });
      },
    ) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333/",
      collection: "agentmemory",
      apiKey: "secret-key",
      fetchImpl,
    });

    await store.upsert([
      { id: "obs-1", vector: [0.1, 0.2], payload: { sessionId: "s1" } },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://127.0.0.1:6333/collections/agentmemory/points",
    );
    expect(calls[0].init.method).toBe("PUT");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.points[0]).toMatchObject({
      id: "obs-1",
      vector: [0.1, 0.2],
      payload: { sessionId: "s1" },
    });
  });

  it("searches by vector via POST and maps hits", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response(
          JSON.stringify({
            result: [
              { id: "obs-7", score: 0.91, payload: { sessionId: "s9" } },
              { id: "obs-8", score: 0.42 },
            ],
          }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333",
      collection: "memories",
      fetchImpl,
    });

    const hits = await store.searchByVector([0.5, 0.5], 5);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "http://127.0.0.1:6333/collections/memories/points/search",
    );
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toMatchObject({ vector: [0.5, 0.5], limit: 5, with_payload: true });
    expect(hits).toEqual([
      { id: "obs-7", score: 0.91, payload: { sessionId: "s9" } },
      { id: "obs-8", score: 0.42, payload: undefined },
    ]);
  });

  it("deletes points by id via POST", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init: init ?? {} };
        return new Response(JSON.stringify({ result: { status: "ok" } }), {
          status: 200,
        });
      },
    ) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333",
      collection: "agentmemory",
      fetchImpl,
    });

    await store.deleteByIds(["obs-1", "obs-2"]);

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(
      "http://127.0.0.1:6333/collections/agentmemory/points/delete",
    );
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({ points: ["obs-1", "obs-2"] });
  });

  it("reports a reachable health check on 200", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333",
      collection: "agentmemory",
      fetchImpl,
    });

    const health = await store.healthCheck();
    expect(health.reachable).toBe(true);
    expect(health.status).toBe(200);
  });

  it("reports an unreachable health check when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333",
      collection: "agentmemory",
      fetchImpl,
    });

    const health = await store.healthCheck();
    expect(health.reachable).toBe(false);
    expect(health.status).toBeNull();
    expect(health.detail).toContain("connection refused");
  });

  it("raises a QdrantHttpError on non-2xx data operations", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("nope", { status: 500, statusText: "Server Error" }),
    ) as unknown as typeof fetch;

    const store = new QdrantRetrievalStore({
      url: "http://127.0.0.1:6333",
      collection: "agentmemory",
      fetchImpl,
    });

    await expect(store.upsert([{ id: "x", vector: [1] }])).rejects.toThrow(
      QdrantHttpError,
    );
  });
});
