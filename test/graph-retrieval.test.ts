import { describe, expect, it } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import { KV } from "../src/state/schema.js";
import type { GraphEdge, GraphNode } from "../src/types.js";

function mockKV(nodes: GraphNode[], edges: GraphEdge[] = []) {
  return {
    list: async <T>(scope: string): Promise<T[]> => {
      if (scope === KV.graphNodes) return nodes as T[];
      if (scope === KV.graphEdges) return edges as T[];
      return [];
    },
  };
}

describe("GraphRetrieval", () => {
  it("does not let disallowed graph hits consume maxResults", async () => {
    const nodes: GraphNode[] = [
      {
        id: "node_blocked",
        type: "concept",
        name: "auth blocked",
        properties: {},
        sourceObservationIds: ["obs_blocked"],
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "node_allowed",
        type: "concept",
        name: "auth allowed",
        properties: {},
        sourceObservationIds: ["obs_allowed"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const retrieval = new GraphRetrieval(mockKV(nodes) as never);

    const results = await retrieval.searchByEntities(
      ["auth"],
      0,
      1,
      (obsId) => obsId === "obs_allowed",
    );

    expect(results).toHaveLength(1);
    expect(results[0].obsId).toBe("obs_allowed");
  });
});
