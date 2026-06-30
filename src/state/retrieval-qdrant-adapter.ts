import type { RetrievalBackendDescriptor } from "./retrieval-backends.js";

export type FetchLike = typeof fetch;

export type QdrantPoint = {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
};

export type QdrantSearchHit = {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
};

export type QdrantHealthResult = {
  reachable: boolean;
  status: number | null;
  detail: string;
};

export type QdrantAdapterOptions = {
  url: string;
  collection: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export type RetrievalRuntimeStore = {
  upsert: (points: QdrantPoint[]) => Promise<void>;
  searchByVector: (
    vector: number[],
    limit: number,
  ) => Promise<QdrantSearchHit[]>;
  deleteByIds: (ids: Array<string | number>) => Promise<void>;
  healthCheck: () => Promise<QdrantHealthResult>;
};

const DEFAULT_TIMEOUT_MS = 5000;

export class QdrantHttpError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "QdrantHttpError";
    this.status = status;
  }
}

export class QdrantRetrievalStore implements RetrievalRuntimeStore {
  readonly backend = "qdrant" as const;
  private readonly baseUrl: string;
  private readonly collection: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: QdrantAdapterOptions) {
    this.baseUrl = stripTrailingSlash(options.url);
    this.collection = options.collection;
    this.apiKey = options.apiKey;
    this.timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async upsert(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.request("PUT", `/collections/${encode(this.collection)}/points`, {
      points: points.map((point) => ({
        id: point.id,
        vector: point.vector,
        ...(point.payload ? { payload: point.payload } : {}),
      })),
    });
  }

  async searchByVector(
    vector: number[],
    limit: number,
  ): Promise<QdrantSearchHit[]> {
    const body = await this.request<{ result?: unknown }>(
      "POST",
      `/collections/${encode(this.collection)}/points/search`,
      {
        vector,
        limit,
        with_payload: true,
      },
    );

    const rows = Array.isArray(body?.result) ? body.result : [];
    const hits: QdrantSearchHit[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as {
        id?: unknown;
        score?: unknown;
        payload?: unknown;
      };
      if (
        (typeof record.id !== "string" && typeof record.id !== "number") ||
        typeof record.score !== "number"
      ) {
        continue;
      }
      hits.push({
        id: record.id,
        score: record.score,
        payload:
          record.payload && typeof record.payload === "object"
            ? (record.payload as Record<string, unknown>)
            : undefined,
      });
    }
    return hits;
  }

  async deleteByIds(ids: Array<string | number>): Promise<void> {
    if (ids.length === 0) return;
    await this.request(
      "POST",
      `/collections/${encode(this.collection)}/points/delete`,
      { points: ids },
    );
  }

  async healthCheck(): Promise<QdrantHealthResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        method: "GET",
        headers: this.headers(false),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        return {
          reachable: true,
          status: res.status,
          detail: "qdrant /healthz responded ok",
        };
      }
      return {
        reachable: false,
        status: res.status,
        detail: `qdrant /healthz returned ${res.status} ${res.statusText}`,
      };
    } catch (error) {
      return {
        reachable: false,
        status: null,
        detail: `qdrant health check failed: ${describeError(error)}`,
      };
    }
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["api-key"] = this.apiKey;
    return headers;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(true),
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new QdrantHttpError(
        `qdrant request to ${method} ${path} failed: ${describeError(error)}`,
        null,
      );
    }

    if (!res.ok) {
      throw new QdrantHttpError(
        `qdrant request to ${method} ${path} returned ${res.status} ${res.statusText}`,
        res.status,
      );
    }

    const text = await res.text();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new QdrantHttpError(
        `qdrant request to ${method} ${path} returned a non-JSON body`,
        res.status,
      );
    }
  }
}

export function createQdrantRetrievalStore(
  descriptor: RetrievalBackendDescriptor,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; apiKey?: string } = {},
): QdrantRetrievalStore | null {
  if (descriptor.backend !== "qdrant") return null;
  if (descriptor.connection.kind !== "http") return null;

  return new QdrantRetrievalStore({
    url: descriptor.connection.url,
    collection: descriptor.collection,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
