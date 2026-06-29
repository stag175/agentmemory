export const SUPPORTED_RETRIEVAL_BACKENDS = [
  "sqlite",
  "lancedb",
  "qdrant",
  "weaviate",
  "chroma",
] as const;

export type RetrievalBackendKind =
  (typeof SUPPORTED_RETRIEVAL_BACKENDS)[number];

export type RetrievalBackendConnection =
  | {
      kind: "none";
    }
  | {
      kind: "local-path";
      path: string;
    }
  | {
      kind: "http";
      url: string;
      apiKeyRequired: boolean;
      apiKeyConfigured: boolean;
      apiKeyEnvVar?: string;
    };

export type RetrievalBackendDescriptor = {
  backend: RetrievalBackendKind;
  requestedBackend: string;
  explicit: boolean;
  enabled: boolean;
  collection: string;
  requiresExternalService: boolean;
  connectsDuringValidation: false;
  connection: RetrievalBackendConnection;
  migrationSafetyNotes: string[];
  warnings: string[];
};

export type InvalidRetrievalBackendDescriptor = {
  backend: "invalid";
  requestedBackend: string;
  explicit: true;
  enabled: false;
  collection: string;
  requiresExternalService: false;
  connectsDuringValidation: false;
  connection: { kind: "none" };
  migrationSafetyNotes: string[];
  warnings: string[];
};

export type RetrievalBackendConfigResult =
  | {
      ok: true;
      descriptor: RetrievalBackendDescriptor;
      errors: [];
    }
  | {
      ok: false;
      descriptor: RetrievalBackendDescriptor | InvalidRetrievalBackendDescriptor;
      errors: string[];
    };

export type RetrievalBackendAvailabilityStatus =
  | "available"
  | "unavailable"
  | "invalid";

export type RetrievalBackendAvailability = {
  status: RetrievalBackendAvailabilityStatus;
  reason: string;
  explicitConfigRequired: boolean;
  explicitlyConfigured: boolean;
};

export type RetrievalBackendHealthCheck = {
  id: string;
  status: "pass" | "fail" | "not-run";
  mode: "static" | "manual";
  blocking: boolean;
  summary: string;
};

export type RetrievalBackendHealthPlan = {
  backend: RetrievalBackendKind | "invalid";
  collection: string;
  availability: RetrievalBackendAvailability;
  networkFreeByDefault: true;
  dependencyFreeByDefault: true;
  connectsDuringFactory: false;
  checks: RetrievalBackendHealthCheck[];
  nextSteps: string[];
};

export type RetrievalBackendCapabilities = {
  local: boolean;
  requiresVendorClient: boolean;
  requiresNetwork: boolean;
  derivedIndex: boolean;
};

export interface RetrievalBackendAdapter {
  backend: RetrievalBackendKind;
  descriptor: RetrievalBackendDescriptor;
  availability: RetrievalBackendAvailability;
  capabilities: RetrievalBackendCapabilities;
  connectsDuringFactory: false;
  planHealthCheck: () => RetrievalBackendHealthPlan;
}

export interface InvalidRetrievalBackendAdapter {
  backend: "invalid";
  descriptor: InvalidRetrievalBackendDescriptor;
  availability: RetrievalBackendAvailability;
  capabilities: RetrievalBackendCapabilities;
  connectsDuringFactory: false;
  planHealthCheck: () => RetrievalBackendHealthPlan;
}

export type RetrievalBackendAdapterResult =
  | {
      ok: true;
      adapter: RetrievalBackendAdapter;
      errors: [];
    }
  | {
      ok: false;
      adapter: RetrievalBackendAdapter | InvalidRetrievalBackendAdapter;
      errors: string[];
    };

type EnvMap = Record<string, string | undefined>;

type EnvValue = {
  value: string;
  key: string;
};

const DEFAULT_COLLECTION = "agentmemory";

const BACKEND_ENV_KEYS = [
  "AGENTMEMORY_RETRIEVAL_BACKEND",
  "RETRIEVAL_BACKEND",
] as const;

const COLLECTION_ENV_KEYS = [
  "AGENTMEMORY_RETRIEVAL_COLLECTION",
  "AGENTMEMORY_VECTOR_COLLECTION",
] as const;

const PATH_ENV_KEYS = {
  sqlite: ["AGENTMEMORY_SQLITE_PATH", "AGENTMEMORY_RETRIEVAL_PATH"],
  lancedb: ["AGENTMEMORY_LANCEDB_PATH", "LANCEDB_PATH", "AGENTMEMORY_RETRIEVAL_PATH"],
} as const;

const URL_ENV_KEYS = {
  qdrant: ["QDRANT_URL", "AGENTMEMORY_QDRANT_URL", "AGENTMEMORY_RETRIEVAL_URL"],
  weaviate: [
    "WEAVIATE_URL",
    "AGENTMEMORY_WEAVIATE_URL",
    "AGENTMEMORY_RETRIEVAL_URL",
  ],
  chroma: ["CHROMA_URL", "AGENTMEMORY_CHROMA_URL", "AGENTMEMORY_RETRIEVAL_URL"],
} as const;

const API_KEY_ENV_KEYS = {
  qdrant: ["QDRANT_API_KEY", "AGENTMEMORY_QDRANT_API_KEY", "AGENTMEMORY_RETRIEVAL_API_KEY"],
  weaviate: [
    "WEAVIATE_API_KEY",
    "AGENTMEMORY_WEAVIATE_API_KEY",
    "AGENTMEMORY_RETRIEVAL_API_KEY",
  ],
  chroma: [
    "CHROMA_API_KEY",
    "CHROMA_AUTH_TOKEN",
    "AGENTMEMORY_CHROMA_API_KEY",
    "AGENTMEMORY_RETRIEVAL_API_KEY",
  ],
} as const;

const API_KEY_REQUIRED_ENV_KEYS = {
  qdrant: ["QDRANT_API_KEY_REQUIRED", "AGENTMEMORY_QDRANT_API_KEY_REQUIRED"],
  weaviate: ["WEAVIATE_API_KEY_REQUIRED", "AGENTMEMORY_WEAVIATE_API_KEY_REQUIRED"],
  chroma: [
    "CHROMA_API_KEY_REQUIRED",
    "CHROMA_AUTH_TOKEN_REQUIRED",
    "AGENTMEMORY_CHROMA_API_KEY_REQUIRED",
  ],
} as const;

const BACKEND_CAPABILITIES: Record<
  RetrievalBackendKind | "invalid",
  RetrievalBackendCapabilities
> = {
  sqlite: {
    local: true,
    requiresVendorClient: false,
    requiresNetwork: false,
    derivedIndex: false,
  },
  lancedb: {
    local: true,
    requiresVendorClient: true,
    requiresNetwork: false,
    derivedIndex: true,
  },
  qdrant: {
    local: false,
    requiresVendorClient: true,
    requiresNetwork: true,
    derivedIndex: true,
  },
  weaviate: {
    local: false,
    requiresVendorClient: true,
    requiresNetwork: true,
    derivedIndex: true,
  },
  chroma: {
    local: false,
    requiresVendorClient: true,
    requiresNetwork: true,
    derivedIndex: true,
  },
  invalid: {
    local: false,
    requiresVendorClient: false,
    requiresNetwork: false,
    derivedIndex: false,
  },
};

export function resolveRetrievalBackendConfig(
  env: EnvMap = process.env,
): RetrievalBackendConfigResult {
  const backendSelection = readBackend(env);
  const collection =
    readFirst(env, COLLECTION_ENV_KEYS)?.value.trim() || DEFAULT_COLLECTION;

  if (backendSelection.backend === "invalid") {
    return {
      ok: false,
      descriptor: {
        backend: "invalid",
        requestedBackend: backendSelection.requestedBackend,
        explicit: true,
        enabled: false,
        collection,
        requiresExternalService: false,
        connectsDuringValidation: false,
        connection: { kind: "none" },
        migrationSafetyNotes: migrationSafetyNotes("invalid"),
        warnings: [],
      },
      errors: [
        `Unsupported retrieval backend '${backendSelection.requestedBackend}'. Supported backends: ${SUPPORTED_RETRIEVAL_BACKENDS.join(", ")}.`,
      ],
    };
  }

  if (backendSelection.backend === "sqlite") {
    return resolveSqlite(env, backendSelection, collection);
  }

  if (backendSelection.backend === "lancedb") {
    return resolveLanceDb(env, backendSelection, collection);
  }

  if (isHttpBackendKind(backendSelection.backend)) {
    return resolveHttpBackend(
      env,
      {
        backend: backendSelection.backend,
        requestedBackend: backendSelection.requestedBackend,
        explicit: backendSelection.explicit,
      },
      collection,
    );
  }

  return {
    ok: false,
    descriptor: {
      backend: "invalid",
      requestedBackend: backendSelection.requestedBackend,
      explicit: true,
      enabled: false,
      collection,
      requiresExternalService: false,
      connectsDuringValidation: false,
      connection: { kind: "none" },
      migrationSafetyNotes: migrationSafetyNotes("invalid"),
      warnings: [],
    },
    errors: [
      `Unsupported retrieval backend '${backendSelection.requestedBackend}'. Supported backends: ${SUPPORTED_RETRIEVAL_BACKENDS.join(", ")}.`,
    ],
  };
}

export function createRetrievalBackendAdapter(
  env: EnvMap = process.env,
): RetrievalBackendAdapterResult {
  const config = resolveRetrievalBackendConfig(env);
  const adapter = buildAdapter(config.descriptor, config.errors);

  if (config.ok) {
    return { ok: true, adapter: adapter as RetrievalBackendAdapter, errors: [] };
  }

  return { ok: false, adapter, errors: config.errors };
}

export function createRetrievalBackendHealthPlan(
  descriptor: RetrievalBackendDescriptor | InvalidRetrievalBackendDescriptor,
  errors: readonly string[] = [],
): RetrievalBackendHealthPlan {
  const availability = describeAvailability(descriptor, errors);
  const capabilities = BACKEND_CAPABILITIES[descriptor.backend];
  const checks: RetrievalBackendHealthCheck[] = [
    {
      id: "config",
      status: availability.status === "available" ? "pass" : "fail",
      mode: "static",
      blocking: availability.status !== "available",
      summary: availability.reason,
    },
  ];

  if (descriptor.backend !== "invalid") {
    checks.push({
      id: "dependency",
      status: capabilities.requiresVendorClient ? "not-run" : "pass",
      mode: capabilities.requiresVendorClient ? "manual" : "static",
      blocking: false,
      summary: capabilities.requiresVendorClient
        ? `${descriptor.backend} vendor client availability is intentionally not checked by the config factory.`
        : "No retrieval vendor client is required for the default sqlite boundary.",
    });
  }

  if (capabilities.requiresNetwork) {
    checks.push({
      id: "connectivity",
      status: "not-run",
      mode: "manual",
      blocking: false,
      summary: `${descriptor.backend} connectivity requires an explicit caller-owned health probe; the factory never opens network connections.`,
    });
  }

  if (capabilities.derivedIndex) {
    checks.push({
      id: "migration",
      status: "not-run",
      mode: "manual",
      blocking: false,
      summary:
        "Derived retrieval indexes require explicit backfill, dimension validation, and read-cutover planning.",
    });
  }

  return {
    backend: descriptor.backend,
    collection: descriptor.collection,
    availability,
    networkFreeByDefault: true,
    dependencyFreeByDefault: true,
    connectsDuringFactory: false,
    checks,
    nextSteps: nextHealthSteps(descriptor, availability, errors),
  };
}

function resolveSqlite(
  env: EnvMap,
  selection: ValidBackendSelection,
  collection: string,
): RetrievalBackendConfigResult {
  const path = readFirst(env, PATH_ENV_KEYS.sqlite);
  const validPath = path && isValidPath(path.value) ? path : null;
  const errors = path && !isValidPath(path.value)
    ? [`sqlite retrieval backend path from ${path.key} must be a non-empty path without null bytes.`]
    : [];
  const descriptor = buildDescriptor({
    backend: "sqlite",
    requestedBackend: selection.requestedBackend,
    explicit: selection.explicit,
    enabled: errors.length === 0,
    collection,
    requiresExternalService: false,
    connection: validPath
      ? { kind: "local-path", path: validPath.value.trim() }
      : { kind: "none" },
    warnings: [],
  });

  return result(descriptor, errors);
}

function resolveLanceDb(
  env: EnvMap,
  selection: ValidBackendSelection,
  collection: string,
): RetrievalBackendConfigResult {
  const path = readFirst(env, PATH_ENV_KEYS.lancedb);
  const errors: string[] = [];
  if (!path) {
    errors.push(
      "lancedb retrieval backend requires AGENTMEMORY_LANCEDB_PATH, LANCEDB_PATH, or AGENTMEMORY_RETRIEVAL_PATH.",
    );
  } else if (!isValidPath(path.value)) {
    errors.push(
      `lancedb retrieval backend path from ${path.key} must be a non-empty path without null bytes.`,
    );
  }

  const descriptor = buildDescriptor({
    backend: "lancedb",
    requestedBackend: selection.requestedBackend,
    explicit: selection.explicit,
    enabled: errors.length === 0,
    collection,
    requiresExternalService: false,
    connection: path && isValidPath(path.value)
      ? { kind: "local-path", path: path.value.trim() }
      : { kind: "none" },
    warnings: [],
  });

  return result(descriptor, errors);
}

function resolveHttpBackend(
  env: EnvMap,
  selection: ValidBackendSelection & { backend: "qdrant" | "weaviate" | "chroma" },
  collection: string,
): RetrievalBackendConfigResult {
  const url = readFirst(env, URL_ENV_KEYS[selection.backend]);
  const errors: string[] = [];
  const parsedUrl = url ? parseHttpUrl(url.value) : null;

  if (!url) {
    errors.push(
      `${selection.backend} retrieval backend requires ${URL_ENV_KEYS[selection.backend].join(" or ")}.`,
    );
  } else if (!parsedUrl) {
    errors.push(
      `${selection.backend} retrieval backend URL from ${url.key} must be an absolute http:// or https:// URL.`,
    );
  }

  const apiKey = readFirst(env, API_KEY_ENV_KEYS[selection.backend]);
  const apiKeyRequired = isApiKeyRequired(env, selection.backend, parsedUrl);
  if (apiKeyRequired.required && !apiKey) {
    errors.push(
      `${selection.backend} retrieval backend requires an API key because ${apiKeyRequired.reason}; set ${API_KEY_ENV_KEYS[selection.backend].join(" or ")}.`,
    );
  }

  const descriptor = buildDescriptor({
    backend: selection.backend,
    requestedBackend: selection.requestedBackend,
    explicit: selection.explicit,
    enabled: errors.length === 0,
    collection,
    requiresExternalService: true,
    connection: parsedUrl
      ? {
          kind: "http",
          url: parsedUrl,
          apiKeyRequired: apiKeyRequired.required,
          apiKeyConfigured: Boolean(apiKey),
          apiKeyEnvVar: apiKey?.key,
        }
      : { kind: "none" },
    warnings: apiKey && !apiKeyRequired.required
      ? [`${apiKey.key} is configured but not required by the current ${selection.backend} URL/flags.`]
      : [],
  });

  return result(descriptor, errors);
}

type ValidBackendSelection = {
  backend: RetrievalBackendKind;
  requestedBackend: string;
  explicit: boolean;
};

type BackendSelection =
  | ValidBackendSelection
  | {
      backend: "invalid";
      requestedBackend: string;
      explicit: true;
    };

function readBackend(env: EnvMap): BackendSelection {
  const selected = readFirst(env, BACKEND_ENV_KEYS);
  if (!selected) {
    return { backend: "sqlite", requestedBackend: "sqlite", explicit: false };
  }

  const requestedBackend = selected.value.trim();
  const normalized = normalizeBackendName(requestedBackend);
  if (normalized) {
    return {
      backend: normalized,
      requestedBackend,
      explicit: true,
    };
  }

  return { backend: "invalid", requestedBackend, explicit: true };
}

function normalizeBackendName(value: string): RetrievalBackendKind | null {
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || normalized === "default" || normalized === "state-module") {
    return "sqlite";
  }
  if (normalized === "sqlite") return "sqlite";
  if (normalized === "lance" || normalized === "lance-db" || normalized === "lancedb") {
    return "lancedb";
  }
  if (normalized === "qdrant") return "qdrant";
  if (normalized === "weaviate") return "weaviate";
  if (normalized === "chroma" || normalized === "chromadb") return "chroma";
  return null;
}

function isHttpBackendKind(
  backend: RetrievalBackendKind,
): backend is "qdrant" | "weaviate" | "chroma" {
  return backend === "qdrant" || backend === "weaviate" || backend === "chroma";
}

function readFirst(env: EnvMap, keys: readonly string[]): EnvValue | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { key, value };
    }
  }
  return null;
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isValidPath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.includes("\0");
}

function isApiKeyRequired(
  env: EnvMap,
  backend: "qdrant" | "weaviate" | "chroma",
  url: string | null,
): { required: boolean; reason: string } {
  if (isTruthy(readFirst(env, ["AGENTMEMORY_RETRIEVAL_API_KEY_REQUIRED"])?.value)) {
    return {
      required: true,
      reason: "AGENTMEMORY_RETRIEVAL_API_KEY_REQUIRED is enabled",
    };
  }

  const backendFlag = readFirst(env, API_KEY_REQUIRED_ENV_KEYS[backend]);
  if (backendFlag && isTruthy(backendFlag.value)) {
    return {
      required: true,
      reason: `${backendFlag.key} is enabled`,
    };
  }

  if (url && isCloudUrl(backend, url)) {
    return {
      required: true,
      reason: `${backend} cloud URLs require API key authentication`,
    };
  }

  return { required: false, reason: "not required" };
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on", "enabled", "required"].includes(
    value.trim().toLowerCase(),
  );
}

function isCloudUrl(
  backend: "qdrant" | "weaviate" | "chroma",
  url: string,
): boolean {
  const host = new URL(url).hostname.toLowerCase();
  if (backend === "qdrant") return host.endsWith(".cloud.qdrant.io");
  if (backend === "weaviate") return host.endsWith(".weaviate.cloud");
  return host === "api.trychroma.com" || host.endsWith(".trychroma.com");
}

function buildDescriptor(
  input: Omit<
    RetrievalBackendDescriptor,
    "connectsDuringValidation" | "migrationSafetyNotes"
  >,
): RetrievalBackendDescriptor {
  return {
    ...input,
    connectsDuringValidation: false,
    migrationSafetyNotes: migrationSafetyNotes(input.backend),
  };
}

function migrationSafetyNotes(
  backend: RetrievalBackendKind | "invalid",
): string[] {
  if (backend === "sqlite") {
    return [
      "sqlite is the default local retrieval backend; no adapter migration is implied.",
      "Validation never opens the iii-engine StateModule SQLite database.",
    ];
  }

  if (backend === "invalid") {
    return [
      "Unsupported backend names fail closed instead of falling back to sqlite.",
      "No migration or connectivity checks are attempted for invalid selections.",
    ];
  }

  const notes = [
    "This config layer only validates adapter settings; it never imports vendor clients or opens network connections.",
    "Keep iii-engine StateModule SQLite as the source of truth until an explicit backfill, dimension check, and read cutover have completed.",
  ];

  if (backend === "lancedb") {
    return [
      ...notes,
      "Treat the LanceDB path as a derived local vector index and back it up before any destructive rebuild.",
    ];
  }

  return [
    ...notes,
    "Treat remote collections as derived indexes; use dual-write or an offline reindex before switching reads.",
    "Confirm embedding model, vector dimension, collection name, and tenant/auth settings before any production migration.",
  ];
}

function result(
  descriptor: RetrievalBackendDescriptor,
  errors: string[],
): RetrievalBackendConfigResult {
  if (errors.length === 0) {
    return { ok: true, descriptor, errors: [] };
  }

  return {
    ok: false,
    descriptor: { ...descriptor, enabled: false },
    errors,
  };
}

function buildAdapter(
  descriptor: RetrievalBackendDescriptor | InvalidRetrievalBackendDescriptor,
  errors: readonly string[],
): RetrievalBackendAdapter | InvalidRetrievalBackendAdapter {
  const availability = describeAvailability(descriptor, errors);
  const capabilities = BACKEND_CAPABILITIES[descriptor.backend];

  if (descriptor.backend === "invalid") {
    return {
      backend: "invalid",
      descriptor,
      availability,
      capabilities,
      connectsDuringFactory: false,
      planHealthCheck: () => createRetrievalBackendHealthPlan(descriptor, errors),
    };
  }

  return {
    backend: descriptor.backend,
    descriptor,
    availability,
    capabilities,
    connectsDuringFactory: false,
    planHealthCheck: () => createRetrievalBackendHealthPlan(descriptor, errors),
  };
}

function describeAvailability(
  descriptor: RetrievalBackendDescriptor | InvalidRetrievalBackendDescriptor,
  errors: readonly string[],
): RetrievalBackendAvailability {
  if (descriptor.backend === "invalid") {
    return {
      status: "invalid",
      reason: errors[0] || "Unsupported retrieval backend.",
      explicitConfigRequired: true,
      explicitlyConfigured: descriptor.explicit,
    };
  }

  const explicitConfigRequired = descriptor.backend !== "sqlite";
  const explicitlyConfigured =
    descriptor.explicit && descriptor.connection.kind !== "none";

  if (!descriptor.enabled) {
    return {
      status: "unavailable",
      reason:
        errors[0] ||
        `${descriptor.backend} retrieval backend is not available with the current configuration.`,
      explicitConfigRequired,
      explicitlyConfigured,
    };
  }

  if (explicitConfigRequired && !explicitlyConfigured) {
    return {
      status: "unavailable",
      reason: `${descriptor.backend} retrieval backend requires explicit adapter configuration before it can be used.`,
      explicitConfigRequired,
      explicitlyConfigured,
    };
  }

  return {
    status: "available",
    reason:
      descriptor.backend === "sqlite"
        ? "sqlite retrieval uses the iii-engine StateModule boundary without opening a database during factory creation."
        : `${descriptor.backend} retrieval adapter is configured; runtime health checks remain explicit and caller-owned.`,
    explicitConfigRequired,
    explicitlyConfigured,
  };
}

function nextHealthSteps(
  descriptor: RetrievalBackendDescriptor | InvalidRetrievalBackendDescriptor,
  availability: RetrievalBackendAvailability,
  errors: readonly string[],
): string[] {
  if (descriptor.backend === "invalid") {
    return [
      errors[0] || "Choose a supported retrieval backend.",
      `Supported backends: ${SUPPORTED_RETRIEVAL_BACKENDS.join(", ")}.`,
    ];
  }

  if (availability.status !== "available") {
    return errors.length > 0
      ? [...errors]
      : [`Configure ${descriptor.backend} before selecting it as the retrieval backend.`];
  }

  if (descriptor.backend === "sqlite") {
    return [
      "Keep iii-engine StateModule SQLite as the canonical state boundary.",
    ];
  }

  if (descriptor.backend === "lancedb") {
    return [
      "Install and wire a LanceDB adapter behind this boundary before enabling reads.",
      "Run an explicit local path and schema health check outside the config factory.",
    ];
  }

  return [
    `Install and wire a ${descriptor.backend} adapter behind this boundary before enabling reads.`,
    "Run an explicit network health probe only from caller-owned operational code.",
    "Verify embedding model, vector dimension, collection, and auth settings before read cutover.",
  ];
}
