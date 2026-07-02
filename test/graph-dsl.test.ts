import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseGraphDsl,
  executeGraphDsl,
  GraphDslParseError,
} from "../src/functions/graph-dsl.js";
import { registerGraphFunction } from "../src/functions/graph.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type {
  GraphNode,
  GraphEdge,
  GraphDslResult,
  GraphSnapshot,
} from "../src/types.js";

function N(
  id: string,
  type: GraphNode["type"],
  name: string,
  properties: Record<string, unknown> = {},
  aliases?: string[],
): GraphNode {
  return {
    id,
    type,
    name,
    properties,
    sourceObservationIds: [],
    createdAt: "2026-07-01T00:00:00Z",
    ...(aliases ? { aliases } : {}),
  };
}

function E(
  id: string,
  type: GraphEdge["type"],
  sourceNodeId: string,
  targetNodeId: string,
  weight = 0.5,
): GraphEdge {
  return {
    id,
    type,
    sourceNodeId,
    targetNodeId,
    weight,
    sourceObservationIds: [],
    createdAt: "2026-07-01T00:00:00Z",
  };
}

// Shared fixture:
//   file:index --uses(0.9)--> function:main --uses(0.8)--> library:express
//   file:index --imports(0.6)--> library:express
//   function:helper --uses(0.4)--> library:express
//   error:TypeError --caused_by(0.7)--> function:main
const NODES = [
  N("f1", "file", "src/index.ts", { path: "src/index.ts" }),
  N("fn1", "function", "main", { lang: "typescript" }, ["entrypoint"]),
  N("fn2", "function", "helper"),
  N("lib1", "library", "express"),
  N("err1", "error", "TypeError"),
];
const EDGES = [
  E("e1", "uses", "f1", "fn1", 0.9),
  E("e2", "uses", "fn1", "lib1", 0.8),
  E("e3", "uses", "fn2", "lib1", 0.4),
  E("e4", "caused_by", "err1", "fn1", 0.7),
  E("e5", "imports", "f1", "lib1", 0.6),
];

function run(query: string, limit = 100) {
  return executeGraphDsl(parseGraphDsl(query), NODES, EDGES, { limit });
}

describe("Graph DSL parser", () => {
  it("parses a full query", () => {
    const q = parseGraphDsl(
      'MATCH (a:file "index")-[e:uses]->(b:function) WHERE e.weight >= 0.5 AND b.name ~ "MAIN" RETURN paths LIMIT 10',
    );
    expect(q.nodes).toHaveLength(2);
    expect(q.nodes[0]).toMatchObject({
      variable: "a",
      type: "file",
      nameContains: "index",
    });
    expect(q.edges[0]).toMatchObject({
      variable: "e",
      type: "uses",
      direction: "right",
      minHops: 1,
      maxHops: 1,
    });
    expect(q.where).toHaveLength(2);
    expect(q.returns).toEqual({ kind: "paths" });
    expect(q.limit).toBe(10);
  });

  it("parses left and undirected edges", () => {
    const left = parseGraphDsl("MATCH (a)<-[:uses]-(b)");
    expect(left.edges[0].direction).toBe("left");
    const any = parseGraphDsl("MATCH (a)-[:uses]-(b)");
    expect(any.edges[0].direction).toBe("any");
  });

  it("parses variable-length hop forms", () => {
    expect(parseGraphDsl("MATCH (a)-[*]->(b)").edges[0]).toMatchObject({
      minHops: 1,
      maxHops: 3,
    });
    expect(parseGraphDsl("MATCH (a)-[*2]->(b)").edges[0]).toMatchObject({
      minHops: 2,
      maxHops: 2,
    });
    expect(parseGraphDsl("MATCH (a)-[*..4]->(b)").edges[0]).toMatchObject({
      minHops: 1,
      maxHops: 4,
    });
    expect(parseGraphDsl("MATCH (a)-[:uses*2..4]->(b)").edges[0]).toMatchObject(
      { type: "uses", minHops: 2, maxHops: 4 },
    );
  });

  it("parses RETURN variants", () => {
    expect(parseGraphDsl("MATCH (a) RETURN nodes").returns).toEqual({
      kind: "nodes",
    });
    expect(parseGraphDsl("MATCH (a) RETURN edges").returns).toEqual({
      kind: "edges",
    });
    expect(parseGraphDsl("MATCH (a)-[]->(b) RETURN a, b").returns).toEqual({
      kind: "vars",
      vars: ["a", "b"],
    });
  });

  const parseErrorCases: Array<[string, string, RegExp]> = [
    ["missing MATCH", '(a)-[]->(b)', /must start with MATCH/],
    ["unterminated string", 'MATCH (a "oops)', /Unterminated string/],
    ["zero min hops", "MATCH (a)-[*0..2]->(b)", /at least 1/],
    ["inverted hop range", "MATCH (a)-[*3..2]->(b)", /Maximum hops must be >=/],
    ["hop cap", "MATCH (a)-[*1..9]->(b)", /capped at 5/],
    [
      "edge var with var hops",
      "MATCH (a)-[e:uses*1..2]->(b)",
      /cannot be combined with variable-length/,
    ],
    ["double arrow", "MATCH (a)<-[:uses]->(b)", /cannot point both ways/],
    ["unknown WHERE var", "MATCH (a) WHERE b.name = \"x\"", /Unknown variable 'b'/],
    ["unknown RETURN var", "MATCH (a) RETURN q", /Unknown variable 'q'/],
    ["bad LIMIT", "MATCH (a) LIMIT x", /positive integer/],
    ["numeric op on string", 'MATCH (a) WHERE a.name > "x"', /requires a numeric/],
    ["tilde on number", "MATCH (a) WHERE a.name ~ 3", /requires a string/],
    [
      "edge var bad field",
      'MATCH (a)-[e:uses]->(b) WHERE e.name = "x"',
      /supports the fields/,
    ],
    ["trailing garbage", "MATCH (a) RETURN nodes extra", /Unexpected trailing|Unknown variable/],
  ];
  for (const [label, query, pattern] of parseErrorCases) {
    it(`rejects ${label}`, () => {
      expect(() => parseGraphDsl(query)).toThrowError(pattern);
      try {
        parseGraphDsl(query);
      } catch (err) {
        expect(err).toBeInstanceOf(GraphDslParseError);
        expect((err as GraphDslParseError).position).toBeGreaterThanOrEqual(0);
      }
    });
  }

  it("rejects oversized queries", () => {
    const big = `MATCH (a "${"x".repeat(2100)}")`;
    expect(() => parseGraphDsl(big)).toThrowError(/exceeds 2000 characters/);
  });
});

describe("Graph DSL evaluator", () => {
  it("matches a single-hop typed pattern", () => {
    const { matches } = run("MATCH (a:file)-[:uses]->(b:function)");
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings).toEqual({ a: "f1", b: "fn1" });
    expect(matches[0].edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("matches a two-hop chain", () => {
    const { matches } = run(
      "MATCH (a:file)-[:uses]->(b:function)-[:uses]->(c:library)",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings).toEqual({ a: "f1", b: "fn1", c: "lib1" });
    expect(matches[0].nodes.map((n) => n.id)).toEqual(["f1", "fn1", "lib1"]);
  });

  it("respects edge direction", () => {
    const right = run("MATCH (a:library)-[:uses]->(b:function)");
    expect(right.matches).toHaveLength(0);
    const left = run("MATCH (a:function)<-[:uses]-(b:file)");
    expect(left.matches).toHaveLength(1);
    expect(left.matches[0].bindings).toEqual({ a: "fn1", b: "f1" });
  });

  it("matches undirected edges both ways", () => {
    const { matches } = run("MATCH (a:function)-[:caused_by]-(b:error)");
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings).toEqual({ a: "fn1", b: "err1" });
  });

  it("finds both direct and transitive paths with variable hops", () => {
    const { matches } = run("MATCH (a:file)-[*1..2]->(c:library)");
    const hopCounts = matches.map((m) => m.edges.length).sort();
    expect(hopCounts).toEqual([1, 2]);
    for (const m of matches) {
      expect(m.bindings).toMatchObject({ a: "f1", c: "lib1" });
    }
  });

  it("filters on edge weight via WHERE", () => {
    const { matches } = run(
      "MATCH (a:function)-[e:uses]->(b:library) WHERE e.weight >= 0.5",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings.a).toBe("fn1");
  });

  it("matches names case-insensitively with ~ and pattern literals", () => {
    const literal = run('MATCH (a:function "MAIN")');
    expect(literal.matches).toHaveLength(1);
    expect(literal.matches[0].bindings.a).toBe("fn1");
    const where = run('MATCH (a:function) WHERE a.name ~ "AIN"');
    expect(where.matches).toHaveLength(1);
  });

  it("matches aliases in node pattern literals", () => {
    const { matches } = run('MATCH (a "entrypoint")');
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings.a).toBe("fn1");
  });

  it("reads properties with bare and prefixed field paths", () => {
    const bare = run('MATCH (a:file) WHERE a.path = "src/index.ts"');
    expect(bare.matches).toHaveLength(1);
    const prefixed = run(
      'MATCH (a:file) WHERE a.properties.path = "src/index.ts"',
    );
    expect(prefixed.matches).toHaveLength(1);
    const miss = run('MATCH (a:file) WHERE a.nope = "x"');
    expect(miss.matches).toHaveLength(0);
  });

  it("truncates at the match limit", () => {
    const { matches, truncated } = run("MATCH (a)-[]->(b)", 2);
    expect(matches).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it("does not report truncation when the limit exactly fits all matches", () => {
    // 5 directed single-hop matches exist; limit 5 is a complete
    // result, not a truncated one.
    const { matches, truncated } = run("MATCH (a)-[]->(b)", 5);
    expect(matches).toHaveLength(5);
    expect(truncated).toBe(false);
  });

  it("matches a self-loop exactly once regardless of direction", () => {
    const nodes = [N("r", "concept", "recursion")];
    const edges = [E("rr", "related_to", "r", "r", 0.9)];
    for (const q of [
      "MATCH (x)-[:related_to]-(x)",
      "MATCH (x)-[:related_to]->(x)",
      "MATCH (x)<-[:related_to]-(x)",
    ]) {
      const { matches } = executeGraphDsl(parseGraphDsl(q), nodes, edges, {
        limit: 10,
      });
      expect(matches, q).toHaveLength(1);
      expect(matches[0].edges.map((e) => e.id), q).toEqual(["rr"]);
    }
  });

  it("prunes doomed seed bindings without changing results", () => {
    // Same answer as the unpruned path — a WHERE condition on the
    // seed variable filters seeds up front.
    const { matches, visits } = run(
      'MATCH (a:function)-[:uses]->(b:library) WHERE a.name = "main"',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].bindings.a).toBe("fn1");
    expect(visits).toBeLessThan(10);
  });

  it("closes cycles only through re-bound variables", () => {
    const nodes = [N("a", "concept", "A"), N("b", "concept", "B")];
    const edges = [
      E("ab", "related_to", "a", "b", 0.9),
      E("ba", "related_to", "b", "a", 0.9),
    ];
    // Explicit cycle: (x)->(y)->(x) re-binds x, so the path may close.
    const cycle = executeGraphDsl(
      parseGraphDsl("MATCH (x)-[:related_to]->(y)-[:related_to]->(x)"),
      nodes,
      edges,
      { limit: 10 },
    );
    expect(cycle.matches).toHaveLength(2); // seeded from a and from b
    // Anonymous tail: simple-path rule forbids landing back on a visited
    // node, so no three-node chain exists in a two-node graph.
    const simple = executeGraphDsl(
      parseGraphDsl("MATCH (x)-[:related_to]->(y)-[:related_to]->(z)"),
      nodes,
      edges,
      { limit: 10 },
    );
    expect(simple.matches).toHaveLength(0);
  });

  it("never reuses an edge inside one match", () => {
    const nodes = [N("a", "concept", "A"), N("b", "concept", "B")];
    const edges = [E("ab", "related_to", "a", "b", 0.9)];
    const { matches } = executeGraphDsl(
      parseGraphDsl("MATCH (x)-[:related_to*1..3]-(y)"),
      nodes,
      edges,
      { limit: 10 },
    );
    // One undirected edge yields exactly one single-hop match per seed —
    // it can never be walked back and forth.
    expect(matches.every((m) => m.edges.length === 1)).toBe(true);
    expect(matches).toHaveLength(2);
  });

  it("orders matches by average edge weight", () => {
    const { matches } = run("MATCH (a:function)-[:uses]->(b:library)");
    expect(matches.map((m) => m.bindings.a)).toEqual(["fn1", "fn2"]);
    expect(matches[0].avgWeight).toBeGreaterThan(matches[1].avgWeight);
  });

  it("stops at the visit budget and reports exhaustion", () => {
    const exec = executeGraphDsl(
      parseGraphDsl("MATCH (a)-[*1..3]-(b)"),
      NODES,
      EDGES,
      { limit: 1000, maxVisits: 5 },
    );
    expect(exec.budgetExhausted).toBe(true);
    expect(exec.truncated).toBe(true);
  });

  it("supports single-node queries", () => {
    const { matches } = run("MATCH (a:function)");
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.edges.length === 0)).toBe(true);
    expect(matches.every((m) => m.avgWeight === 1)).toBe(true);
  });
});

// Registration-level coverage: mem::graph-dsl through the shared mock
// sdk/kv harness (test/helpers/mocks.ts).
const mockProvider = {
  name: "test",
  compress: vi.fn().mockResolvedValue(""),
  summarize: vi.fn(),
};

async function seededHarness() {
  const sdk = mockSdk();
  const kv = mockKV();
  registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  for (const n of NODES) await kv.set(KV.graphNodes, n.id, n);
  for (const e of EDGES) await kv.set(KV.graphEdges, e.id, e);
  return { sdk, kv };
}

describe("mem::graph-dsl registration", () => {
  it("executes a query end to end", async () => {
    const { sdk } = await seededHarness();
    const result = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a:file)-[:uses]->(b:function) RETURN nodes",
    })) as GraphDslResult;
    expect(result.success).toBe(true);
    expect(result.nodes?.map((n) => n.id).sort()).toEqual(["f1", "fn1"]);
    expect(result.totalMatches).toBe(1);
  });

  it("returns parseError envelopes for bad queries", async () => {
    const { sdk } = await seededHarness();
    const result = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a-[]->(b)",
    })) as GraphDslResult;
    expect(result.success).toBe(false);
    expect(result.parseError).toBe(true);
    expect(typeof result.position).toBe("number");
    const empty = (await sdk.trigger("mem::graph-dsl", {
      query: "   ",
    })) as GraphDslResult;
    expect(empty.success).toBe(false);
    expect(empty.parseError).toBe(true);
  });

  it("prefers the query LIMIT clause over the payload limit", async () => {
    const { sdk } = await seededHarness();
    const result = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a)-[]->(b) LIMIT 1",
      limit: 50,
    })) as GraphDslResult;
    expect(result.limit).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("filters stale nodes and edges from evaluation", async () => {
    const { sdk, kv } = await seededHarness();
    await kv.set(KV.graphNodes, "fn1", { ...NODES[1], stale: true });
    const result = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a:file)-[:uses]->(b:function)",
    })) as GraphDslResult;
    expect(result.totalMatches).toBe(0);
  });

  it("falls back to the snapshot when enumeration fails", async () => {
    // Same rejecting-kv seam graph.test.ts uses for the #814 catch
    // path: kv.list rejects immediately, driving the fallback without
    // waiting out the real enumeration budget.
    const sdk = mockSdk();
    const kv = mockKV();
    const snapshot: GraphSnapshot = {
      version: 1,
      topNodes: [NODES[0], NODES[1]],
      topEdges: [EDGES[0]],
      topDegrees: { f1: 1, fn1: 1 },
      stats: {
        totalNodes: 2,
        totalEdges: 1,
        nodesByType: { file: 1, function: 1 },
        edgesByType: { uses: 1 },
      },
      updatedAt: "2026-07-01T00:00:00Z",
      dirty: false,
    };
    await kv.set(KV.graphSnapshot, "current", snapshot);
    const rejectingKv = {
      ...kv,
      list: () => Promise.reject(new Error("state adapter down")),
    };
    registerGraphFunction(
      sdk as never,
      rejectingKv as never,
      mockProvider as never,
    );
    const result = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a:file)-[:uses]->(b:function)",
    })) as GraphDslResult;
    expect(result.success).toBe(true);
    expect(result.warning).toMatch(/snapshot/i);
    expect(result.warning).toMatch(/state adapter down/);
    expect(result.totalMatches).toBe(1);
  });

  it("keeps the RETURN shape on the degraded no-snapshot path", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    const rejectingKv = {
      ...kv,
      list: () => Promise.reject(new Error("state adapter down")),
    };
    registerGraphFunction(
      sdk as never,
      rejectingKv as never,
      mockProvider as never,
    );
    const paths = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a)",
    })) as GraphDslResult;
    expect(paths.success).toBe(true);
    expect(paths.matches).toEqual([]);
    expect(paths.warning).toMatch(/no snapshot/i);
    // RETURN nodes must come back with a `nodes` field even degraded,
    // so `result.nodes.length` never throws on the documented shape.
    const nodes = (await sdk.trigger("mem::graph-dsl", {
      query: "MATCH (a) RETURN nodes",
    })) as GraphDslResult;
    expect(nodes.success).toBe(true);
    expect(nodes.nodes).toEqual([]);
    expect(nodes.matches).toBeUndefined();
  });

  it("shapes RETURN a, b to bound variables only", async () => {
    const { sdk } = await seededHarness();
    const result = (await sdk.trigger("mem::graph-dsl", {
      query:
        "MATCH (a:file)-[:uses]->(b:function)-[e:uses]->(c:library) RETURN a, e",
    })) as GraphDslResult;
    expect(result.success).toBe(true);
    expect(result.matches).toHaveLength(1);
    const m = result.matches![0];
    expect(m.nodes.map((n) => n.id)).toEqual(["f1"]);
    expect(m.edges.map((e) => e.id)).toEqual(["e2"]);
    expect(Object.keys(m.bindings).sort()).toEqual(["a", "e"]);
  });
});

describe("POST /agentmemory/graph/dsl REST wiring", () => {
  // api::graph-dsl checks GRAPH_EXTRACTION_ENABLED up front (unlike
  // its siblings, which infer it from a trigger failure), so the happy
  // paths need the flag on. getMergedEnv() reads process.env live.
  beforeEach(() => {
    process.env.GRAPH_EXTRACTION_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.GRAPH_EXTRACTION_ENABLED;
  });

  it("registers the route", () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const routes = sdk.registerTrigger.mock.calls.map(
      ([trigger]: [{ config?: { api_path?: string; http_method?: string } }]) => ({
        path: trigger.config?.api_path,
        method: trigger.config?.http_method,
      }),
    );
    expect(routes).toContainEqual({
      path: "/agentmemory/graph/dsl",
      method: "POST",
    });
  });

  it("whitelists body fields and returns 200 for a valid query", async () => {
    const sdk = mockSdk();
    let payload: Record<string, unknown> | undefined;
    sdk.registerFunction("mem::graph-dsl", async (input) => {
      payload = input as Record<string, unknown>;
      return { success: true, matches: [], totalMatches: 0 };
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const response = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: { query: "MATCH (a)", limit: 5, ignored: "drop" },
    })) as { status_code: number };
    expect(response.status_code).toBe(200);
    expect(payload).toEqual({ query: "MATCH (a)", limit: 5 });
  });

  it("rejects missing queries and parse errors with 400", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
    registerApiTriggers(sdk as never, kv as never, undefined);
    const missing = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: {},
    })) as { status_code: number; body: { parseError?: boolean } };
    expect(missing.status_code).toBe(400);
    expect(missing.body.parseError).toBe(true);
    const bad = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: { query: "NOT A QUERY" },
    })) as { status_code: number; body: { parseError?: boolean; position?: number } };
    expect(bad.status_code).toBe(400);
    expect(bad.body.parseError).toBe(true);
    expect(typeof bad.body.position).toBe("number");
  });

  it("returns the graph-disabled envelope when extraction is off", async () => {
    // The endpoint checks the flag before triggering, so a disabled
    // graph gets the actionable 503 envelope rather than a runtime
    // error being mislabeled as "flag off".
    delete process.env.GRAPH_EXTRACTION_ENABLED;
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const response = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: { query: "MATCH (a)" },
    })) as { status_code: number; body: { flag?: string } };
    expect(response.status_code).toBe(503);
    expect(response.body.flag).toBe("GRAPH_EXTRACTION_ENABLED");
  });

  it("returns 500 with the message when the handler fails at runtime", async () => {
    const sdk = mockSdk();
    sdk.registerFunction("mem::graph-dsl", async () => {
      throw new Error("kv exploded");
    });
    registerApiTriggers(sdk as never, mockKV() as never, undefined);
    const response = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: { query: "MATCH (a)" },
    })) as { status_code: number; body: { error?: string; flag?: string } };
    expect(response.status_code).toBe(500);
    expect(response.body.error).toBe("kv exploded");
    expect(response.body.flag).toBeUndefined();
  });

  it("requires the bearer secret when one is configured", async () => {
    const sdk = mockSdk();
    registerApiTriggers(sdk as never, mockKV() as never, "s3cret");
    const denied = (await sdk.trigger("api::graph-dsl", {
      headers: {},
      body: { query: "MATCH (a)" },
    })) as { status_code: number };
    expect(denied.status_code).toBe(401);
  });
});
