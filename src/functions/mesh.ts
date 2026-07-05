import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit } from "./audit.js";
import type {
  MeshPeer,
  Memory,
  Action,
  SemanticMemory,
  ProceduralMemory,
  MemoryRelation,
  GraphNode,
  GraphEdge,
} from "../types.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const MESH_ALLOWED_PROTOCOLS = new Set(["https:"]);
const MESH_REQUEST_TIMEOUT_MS = 30_000;
const MESH_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;

type MeshAddressResolver = (host: string) => Promise<Array<{ address: string }>>;
type MeshHttpResponse<T> = {
  ok: boolean;
  status: number;
  json: () => Promise<T>;
};
type MeshHttpRequester = <T>(
  peerUrl: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  },
  resolveHost: MeshAddressResolver,
) => Promise<MeshHttpResponse<T>>;

type ResolvedMeshUrl = {
  url: URL;
  addresses: string[];
};

async function defaultResolveHost(host: string): Promise<Array<{ address: string }>> {
  return lookup(host, { all: true });
}

function isPrivateIP(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip === "169.254.169.254") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd")) return true;
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    return isPrivateIP(v4);
  }
  return false;
}

async function resolveAllowedMeshUrl(
  urlStr: string,
  resolveHost: MeshAddressResolver = defaultResolveHost,
): Promise<ResolvedMeshUrl | null> {
  try {
    const parsed = new URL(urlStr);
    if (!MESH_ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hash || parsed.search) return null;
    const host = parsed.hostname.toLowerCase();

    if (host === "localhost") return null;
    if (isIP(host)) {
      if (isPrivateIP(host)) return null;
      return { url: parsed, addresses: [host] };
    }

    const resolved = await resolveHost(host);
    if (resolved.length === 0) return null;
    if (resolved.some((r) => isPrivateIP(r.address))) return null;

    return { url: parsed, addresses: resolved.map((r) => r.address) };
  } catch {
    return null;
  }
}

async function isAllowedUrl(
  urlStr: string,
  resolveHost: MeshAddressResolver = defaultResolveHost,
): Promise<boolean> {
  return (await resolveAllowedMeshUrl(urlStr, resolveHost)) !== null;
}

function endpointForPeer(peerUrl: URL, path: string): URL {
  const base = peerUrl.href.replace(/\/+$/, "");
  return new URL(`${base}${path}`);
}

function pinnedMeshRequest<T>(
  peerUrl: string,
  path: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  },
  resolveHost: MeshAddressResolver,
): Promise<MeshHttpResponse<T>> {
  return new Promise((resolveRequest, reject) => {
    resolveAllowedMeshUrl(peerUrl, resolveHost)
      .then((allowed) => {
        if (!allowed) {
          reject(new Error("peer URL blocked: HTTPS public address required"));
          return;
        }

        const endpoint = endpointForPeer(allowed.url, path);
        const address = allowed.addresses[0];
        if (!address) {
          reject(new Error("peer URL blocked: host resolution failed"));
          return;
        }

        const request = httpsRequest(
          {
            protocol: endpoint.protocol,
            hostname: address,
            servername: endpoint.hostname,
            port: endpoint.port || 443,
            method: init.method || "GET",
            path: `${endpoint.pathname}${endpoint.search}`,
            headers: {
              ...init.headers,
              Host: endpoint.host,
            },
            timeout: MESH_REQUEST_TIMEOUT_MS,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let total = 0;
            response.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > MESH_RESPONSE_MAX_BYTES) {
                request.destroy(new Error("mesh response too large"));
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf-8");
              resolveRequest({
                ok:
                  response.statusCode !== undefined &&
                  response.statusCode >= 200 &&
                  response.statusCode < 300,
                status: response.statusCode || 0,
                json: async () => JSON.parse(text || "{}") as T,
              });
            });
          },
        );

        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("mesh request timed out")));
        if (init.body !== undefined) request.write(init.body);
        request.end();
      })
      .catch(reject);
  });
}

const DEFAULT_SHARED_SCOPES = [
  "memories",
  "actions",
  "semantic",
  "procedural",
  "relations",
  "graph:nodes",
  "graph:edges",
];

interface MeshSyncPayload {
  memories?: Memory[];
  actions?: Action[];
  semantic?: SemanticMemory[];
  procedural?: ProceduralMemory[];
  relations?: MemoryRelation[];
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
}

async function lwwMergeList<T extends { id: string }>(
  kv: StateKV,
  scope: string,
  items: T[] | undefined,
  lockPrefix: string,
  tsField: "updatedAt" | "createdAt",
): Promise<number> {
  if (!items || !Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    if (!item.id || typeof item.id !== "string") continue;
    const ts = (item as Record<string, unknown>)[tsField];
    if (typeof ts !== "string" || Number.isNaN(new Date(ts).getTime())) continue;
    const wrote = await withKeyedLock(`${lockPrefix}:${item.id}`, async () => {
      const existing = await kv.get<T>(scope, item.id);
      if (!existing) {
        await kv.set(scope, item.id, item);
        return true;
      }
      const existingTs = (existing as Record<string, unknown>)[tsField] as string;
      if (new Date(ts) > new Date(existingTs)) {
        await kv.set(scope, item.id, item);
        return true;
      }
      return false;
    });
    if (wrote) count++;
  }
  return count;
}

function graphNodeTs(node: GraphNode): string {
  return node.updatedAt || node.createdAt;
}

async function lwwMergeGraphNodes(
  kv: StateKV,
  items: GraphNode[] | undefined,
): Promise<number> {
  if (!items || !Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    if (!item.id || typeof item.id !== "string") continue;
    const ts = graphNodeTs(item);
    if (!ts || Number.isNaN(new Date(ts).getTime())) continue;
    const wrote = await withKeyedLock(`mem:gnode:${item.id}`, async () => {
      const existing = await kv.get<GraphNode>(KV.graphNodes, item.id);
      if (!existing) {
        await kv.set(KV.graphNodes, item.id, item);
        return true;
      }
      if (new Date(ts) > new Date(graphNodeTs(existing))) {
        await kv.set(KV.graphNodes, item.id, item);
        return true;
      }
      return false;
    });
    if (wrote) count++;
  }
  return count;
}

export function registerMeshFunction(
  sdk: ISdk,
  kv: StateKV,
  meshAuthToken?: string,
  options: {
    resolveHost?: MeshAddressResolver;
    requestJson?: MeshHttpRequester;
  } = {},
): void {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const requestJson = options.requestJson ?? pinnedMeshRequest;

  sdk.registerFunction("mem::mesh-register",
    async (data: {
      url: string;
      name: string;
      sharedScopes?: string[];
      syncFilter?: { project?: string };
    }) => {
      if (!data || typeof data !== "object") {
        return { success: false, error: "payload required" };
      }
      if (!data.url || !data.name) {
        return { success: false, error: "url and name are required" };
      }

      if (!(await isAllowedUrl(data.url, resolveHost))) {
        return { success: false, error: "URL blocked: HTTPS public address required" };
      }

      const existing = await kv.list<MeshPeer>(KV.mesh);
      const duplicate = existing.find((p) => p.url === data.url);
      if (duplicate) {
        return { success: false, error: "peer already registered", peerId: duplicate.id };
      }

      const peer: MeshPeer = {
        id: generateId("peer"),
        url: data.url,
        name: data.name,
        status: "disconnected",
        sharedScopes: data.sharedScopes || DEFAULT_SHARED_SCOPES,
        syncFilter: data.syncFilter,
      };

      await kv.set(KV.mesh, peer.id, peer);
      await recordAudit(kv, "mesh_sync", "mem::mesh-register", [peer.id], {
        action: "mesh.register",
        peerId: peer.id,
        name: peer.name,
        url: peer.url,
        sharedScopes: peer.sharedScopes,
      });
      return { success: true, peer };
    },
  );

  sdk.registerFunction("mem::mesh-list", 
    async () => {
      const peers = await kv.list<MeshPeer>(KV.mesh);
      return { success: true, peers };
    },
  );

  sdk.registerFunction("mem::mesh-sync",
    async (data: { peerId?: string; scopes?: string[]; direction?: "push" | "pull" | "both" }) => {
      if (!meshAuthToken) {
        return {
          success: false,
          error: "mesh sync requires AGENTMEMORY_SECRET",
        };
      }
      if (!data || typeof data !== "object") {
        data = {};
      }

      const direction = data.direction || "both";
      let peers: MeshPeer[];

      if (data.peerId) {
        const peer = await kv.get<MeshPeer>(KV.mesh, data.peerId);
        if (!peer) return { success: false, error: "peer not found" };
        peers = [peer];
      } else {
        peers = await kv.list<MeshPeer>(KV.mesh);
      }

      const results: Array<{
        peerId: string;
        peerName: string;
        pushed: number;
        pulled: number;
        errors: string[];
      }> = [];

      for (const peer of peers) {
        const result = {
          peerId: peer.id,
          peerName: peer.name,
          pushed: 0,
          pulled: 0,
          errors: [] as string[],
        };

        peer.status = "syncing";
        await kv.set(KV.mesh, peer.id, peer);
        await recordAudit(kv, "mesh_sync", "mem::mesh-sync", [peer.id], {
          action: "mesh.sync.start",
          direction,
          scopes: data.scopes || peer.sharedScopes,
        });

        const scopes = data.scopes || peer.sharedScopes;

        try {
          if (!(await isAllowedUrl(peer.url, resolveHost))) {
            result.errors.push("peer URL blocked: HTTPS public address required");
            peer.status = "error";
            await kv.set(KV.mesh, peer.id, peer);
            await recordAudit(kv, "mesh_sync", "mem::mesh-sync", [peer.id], {
              action: "mesh.sync.error",
              error: "peer URL blocked: HTTPS public address required",
            });
            results.push(result);
            continue;
          }

          if (direction === "push" || direction === "both") {
            const pushData = await collectSyncData(kv, scopes, peer.lastSyncAt, peer.syncFilter);
            try {
              const response = await requestJson<{ accepted: number }>(peer.url, "/agentmemory/mesh/receive", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${meshAuthToken}`,
                },
                body: JSON.stringify(pushData),
              }, resolveHost);
              if (response.ok) {
                const body = await response.json();
                result.pushed = body.accepted || 0;
              } else {
                result.errors.push(`push failed: HTTP ${response.status}`);
              }
            } catch (err) {
              result.errors.push(`push failed: ${String(err)}`);
            }
          }

          if (direction === "pull" || direction === "both") {
            try {
              const response = await requestJson<{
                memories?: Memory[];
                actions?: Action[];
              }>(
                peer.url,
                `/agentmemory/mesh/export?since=${encodeURIComponent(peer.lastSyncAt || "")}`,
                {
                  headers: {
                    Authorization: `Bearer ${meshAuthToken}`,
                  },
                },
                resolveHost,
              );
              if (response.ok) {
                const pullData = await response.json();
                result.pulled = await applySyncData(kv, pullData, scopes);
              } else {
                result.errors.push(`pull failed: HTTP ${response.status}`);
              }
            } catch (err) {
              result.errors.push(`pull failed: ${String(err)}`);
            }
          }

          peer.status = result.errors.length > 0 ? "error" : "connected";
          if (result.errors.length === 0) {
            peer.lastSyncAt = new Date().toISOString();
          }
        } catch (err) {
          peer.status = "disconnected";
          result.errors.push(String(err));
        }

        await kv.set(KV.mesh, peer.id, peer);
        await recordAudit(kv, "mesh_sync", "mem::mesh-sync", [peer.id], {
          action: result.errors.length > 0 ? "mesh.sync.error" : "mesh.sync.complete",
          direction,
          scopes,
          pushed: result.pushed,
          pulled: result.pulled,
          errors: result.errors,
          lastSyncAt: peer.lastSyncAt,
        });
        results.push(result);
      }

      return { success: true, results };
    },
  );

  sdk.registerFunction("mem::mesh-receive",
    async (data: MeshSyncPayload) => {
      if (!data || typeof data !== "object") {
        return { success: false, error: "payload required" };
      }
      let accepted = 0;

      accepted += await lwwMergeList(kv, KV.memories, data.memories, "mem:memory", "updatedAt");
      accepted += await lwwMergeList(kv, KV.actions, data.actions, "mem:action", "updatedAt");
      accepted += await lwwMergeList(kv, KV.semantic, data.semantic, "mem:semantic", "updatedAt");
      accepted += await lwwMergeList(kv, KV.procedural, data.procedural, "mem:procedural", "updatedAt");
      if (data.relations && Array.isArray(data.relations)) {
        for (const rel of data.relations) {
          if (!rel.sourceId || !rel.targetId || !rel.type) continue;
          const relKey = `${rel.sourceId}:${rel.targetId}:${rel.type}`;
          await withKeyedLock(`mem:relation:${relKey}`, async () => {
            const existing = await kv.get<MemoryRelation>(KV.relations, relKey);
            if (!existing) {
              await kv.set(KV.relations, relKey, { ...rel, id: relKey });
              await recordAudit(kv, "mesh_sync", "mem::mesh-receive", [relKey], {
                action: "mesh.receive.relation",
                accepted: true,
              });
              accepted++;
            }
          });
        }
      }
      accepted += await lwwMergeGraphNodes(kv, data.graphNodes);
      accepted += await lwwMergeList(kv, KV.graphEdges, data.graphEdges, "mem:gedge", "createdAt");
      await recordAudit(kv, "mesh_sync", "mem::mesh-receive", [], {
        action: "mesh.receive",
        accepted,
      });

      return { success: true, accepted };
    },
  );

  sdk.registerFunction("mem::mesh-remove",
    async (data: { peerId: string }) => {
      if (!data || typeof data !== "object" || !data.peerId) {
        return { success: false, error: "peerId is required" };
      }
      await kv.delete(KV.mesh, data.peerId);
      await recordAudit(kv, "mesh_sync", "mem::mesh-remove", [data.peerId], {
        action: "mesh.remove",
      });
      return { success: true };
    },
  );
}

function deltaFilter<T>(
  items: T[],
  sinceTime: number,
  tsField: "updatedAt" | "createdAt",
): T[] {
  return items.filter(
    (item) => new Date((item as Record<string, unknown>)[tsField] as string).getTime() > sinceTime,
  );
}

async function collectSyncData(
  kv: StateKV,
  scopes: string[],
  since?: string,
  syncFilter?: { project?: string },
): Promise<MeshSyncPayload> {
  const result: MeshSyncPayload = {};
  const parsed = since ? new Date(since).getTime() : 0;
  const sinceTime = Number.isNaN(parsed) ? 0 : parsed;

  if (scopes.includes("memories")) {
    const all = await kv.list<Memory>(KV.memories);
    result.memories = deltaFilter(all, sinceTime, "updatedAt");
  }

  if (scopes.includes("actions")) {
    let all = await kv.list<Action>(KV.actions);
    if (syncFilter?.project) {
      all = all.filter((a) => a.project === syncFilter.project);
    }
    result.actions = deltaFilter(all, sinceTime, "updatedAt");
  }

  const projectScoped = !!syncFilter?.project;

  if (scopes.includes("semantic") && !projectScoped) {
    const all = await kv.list<SemanticMemory>(KV.semantic);
    result.semantic = deltaFilter(all, sinceTime, "updatedAt");
  }

  if (scopes.includes("procedural") && !projectScoped) {
    const all = await kv.list<ProceduralMemory>(KV.procedural);
    result.procedural = deltaFilter(all, sinceTime, "updatedAt");
  }

  if (scopes.includes("relations") && !projectScoped) {
    const all = await kv.list<MemoryRelation>(KV.relations);
    result.relations = deltaFilter(all, sinceTime, "createdAt");
  }

  if (scopes.includes("graph:nodes") && !projectScoped) {
    const all = await kv.list<GraphNode>(KV.graphNodes);
    result.graphNodes = all.filter(
      (n) => new Date(graphNodeTs(n)).getTime() > sinceTime,
    );
  }

  if (scopes.includes("graph:edges") && !projectScoped) {
    const all = await kv.list<GraphEdge>(KV.graphEdges);
    result.graphEdges = deltaFilter(all, sinceTime, "createdAt");
  }

  return result;
}

async function applySyncData(
  kv: StateKV,
  data: MeshSyncPayload,
  scopes: string[],
): Promise<number> {
  let applied = 0;

  if (scopes.includes("memories")) {
    applied += await lwwMergeList(kv, KV.memories, data.memories, "mem:memory", "updatedAt");
  }
  if (scopes.includes("actions")) {
    applied += await lwwMergeList(kv, KV.actions, data.actions, "mem:action", "updatedAt");
  }
  if (scopes.includes("semantic")) {
    applied += await lwwMergeList(kv, KV.semantic, data.semantic, "mem:semantic", "updatedAt");
  }
  if (scopes.includes("procedural")) {
    applied += await lwwMergeList(kv, KV.procedural, data.procedural, "mem:procedural", "updatedAt");
  }
  if (scopes.includes("relations") && data.relations) {
    for (const rel of data.relations) {
      if (!rel.sourceId || !rel.targetId || !rel.type) continue;
      const relKey = `${rel.sourceId}:${rel.targetId}:${rel.type}`;
      const wrote = await withKeyedLock(`mem:relation:${relKey}`, async () => {
        const existing = await kv.get<MemoryRelation>(KV.relations, relKey);
        if (!existing) {
          await kv.set(KV.relations, relKey, { ...rel, id: relKey });
          return true;
        }
        return false;
      });
      if (wrote) applied++;
    }
  }
  if (scopes.includes("graph:nodes")) {
    applied += await lwwMergeGraphNodes(kv, data.graphNodes);
  }
  if (scopes.includes("graph:edges")) {
    applied += await lwwMergeList(kv, KV.graphEdges, data.graphEdges, "mem:gedge", "createdAt");
  }

  return applied;
}
