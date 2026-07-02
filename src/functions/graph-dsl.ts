import type { GraphNode, GraphEdge, GraphDslMatch } from "../types.js";

// Q3 2026 roadmap: "Knowledge graph query language — small DSL on top
// of /agentmemory/graph for multi-hop questions."
//
// Cypher-inspired and deliberately tiny: one linear MATCH pattern,
// an optional WHERE conjunction, an optional RETURN shape, and an
// optional LIMIT.
//
//   MATCH (a:file "index")-[:uses]->(b:function)-[e:uses]->(c:library)
//   WHERE e.weight >= 0.5 AND c.name ~ "express"
//   RETURN paths LIMIT 20
//
// Grammar (informal):
//   query   := MATCH node (edge node)* [WHERE cond (AND cond)*]
//              [RETURN returns] [LIMIT int]
//   node    := "(" [var] [":" type] [string] ")"
//   edge    := "-[" body "]->" | "<-[" body "]-" | "-[" body "]-"
//   body    := [var] [":" type] ["*" [int] [".." int]]
//   cond    := var "." field {"." field} op (string | number)
//   op      := "=" | "!=" | "~" | ">" | "<" | ">=" | "<="
//   returns := "paths" | "nodes" | "edges" | var ("," var)*
//
// Semantics:
//   - A string literal inside a node pattern is a case-insensitive
//     substring match against the node name and aliases.
//   - "~" is case-insensitive substring; "=" / "!=" compare exactly
//     (case-sensitive); > < >= <= are numeric. Conditions on missing
//     fields never match.
//   - Node fields: name, type, id; any other single field reads
//     node.properties[field] ("properties.key" also works). Edge
//     fields: type, weight, id.
//   - Re-using a node variable joins on the same node — that is how
//     cycles are expressed. Matched paths are otherwise simple: no
//     repeated node, never a repeated edge.
//   - An edge variable cannot be combined with variable-length hops.
//   - Matches are ordered by average edge weight (desc), then hop
//     count (asc), then discovery order.
//
// The module is pure and dependency-free: parseGraphDsl / executeGraphDsl
// never touch the kv store, which keeps them unit-testable without the
// iii runtime. Data loading (enumeration budget, snapshot fallback)
// lives with the mem::graph-dsl registration in graph.ts.

// Hand-rolled tokenizer + backtracking matcher — no eval, no RegExp
// built from user input (substring matching only), so a hostile query
// cannot inject code or trigger ReDoS. Work is bounded by maxVisits.
export const MAX_DSL_QUERY_LENGTH = 2000;
const MAX_PATTERN_SEGMENTS = 8;
const MAX_VAR_HOPS = 5;
const DEFAULT_VAR_HOPS_MAX = 3;
const DEFAULT_MAX_VISITS = 100_000;

export class GraphDslParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(message);
    this.name = "GraphDslParseError";
  }
}

export interface NodePattern {
  variable?: string;
  type?: string;
  nameContains?: string;
  pos: number;
}

export type EdgeDirection = "right" | "left" | "any";

export interface EdgePattern {
  variable?: string;
  type?: string;
  direction: EdgeDirection;
  minHops: number;
  maxHops: number;
  pos: number;
}

export interface WhereCond {
  variable: string;
  fields: string[];
  op: "=" | "!=" | "~" | ">" | "<" | ">=" | "<=";
  value: string | number;
  pos: number;
}

export type ReturnSpec =
  | { kind: "paths" }
  | { kind: "nodes" }
  | { kind: "edges" }
  | { kind: "vars"; vars: string[] };

export interface GraphDslQuery {
  nodes: NodePattern[];
  edges: EdgePattern[];
  where: WhereCond[];
  returns: ReturnSpec;
  limit?: number;
}

interface Token {
  kind: "ident" | "string" | "number" | "punct" | "eof";
  text: string;
  value?: number;
  pos: number;
}

function describeToken(t: Token): string {
  return t.kind === "eof" ? "end of query" : `'${t.text}'`;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i++;
      let out = "";
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === "\\" && i + 1 < input.length) {
          out += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        out += c;
        i++;
      }
      if (!closed) {
        throw new GraphDslParseError("Unterminated string literal", start);
      }
      tokens.push({ kind: "string", text: out, pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++;
      tokens.push({ kind: "ident", text: input.slice(start, i), pos: start });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < input.length && /[0-9]/.test(input[i])) i++;
      // Only consume "." as a decimal point when a digit follows, so
      // the ".." range operator in hop specs survives tokenization.
      if (input[i] === "." && /[0-9]/.test(input[i + 1] ?? "")) {
        i++;
        while (i < input.length && /[0-9]/.test(input[i])) i++;
      }
      const text = input.slice(start, i);
      tokens.push({ kind: "number", text, value: parseFloat(text), pos: start });
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "!=" || two === ">=" || two === "<=" || two === "..") {
      tokens.push({ kind: "punct", text: two, pos: i });
      i += 2;
      continue;
    }
    if ("()[]:.,*<>=~-".includes(ch)) {
      tokens.push({ kind: "punct", text: ch, pos: i });
      i++;
      continue;
    }
    throw new GraphDslParseError(`Unexpected character '${ch}'`, i);
  }
  tokens.push({ kind: "eof", text: "", pos: input.length });
  return tokens;
}

const EDGE_FIELDS = new Set(["type", "weight", "id"]);

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  private isPunct(text: string): boolean {
    const t = this.peek();
    return t.kind === "punct" && t.text === text;
  }

  private eatPunct(text: string): boolean {
    if (this.isPunct(text)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(text: string): void {
    if (!this.eatPunct(text)) {
      const t = this.peek();
      throw new GraphDslParseError(
        `Expected '${text}' but found ${describeToken(t)}`,
        t.pos,
      );
    }
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.kind === "ident" && t.text.toUpperCase() === word;
  }

  private eatKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.pos++;
      return true;
    }
    return false;
  }

  parse(): GraphDslQuery {
    if (!this.eatKeyword("MATCH")) {
      throw new GraphDslParseError(
        "Query must start with MATCH",
        this.peek().pos,
      );
    }
    const nodes: NodePattern[] = [this.parseNodePattern()];
    const edges: EdgePattern[] = [];
    while (this.isPunct("-") || this.isPunct("<")) {
      if (edges.length >= MAX_PATTERN_SEGMENTS) {
        throw new GraphDslParseError(
          `Pattern exceeds the maximum of ${MAX_PATTERN_SEGMENTS} hops`,
          this.peek().pos,
        );
      }
      edges.push(this.parseEdgePattern());
      nodes.push(this.parseNodePattern());
    }
    const where: WhereCond[] = [];
    if (this.eatKeyword("WHERE")) {
      do {
        where.push(this.parseCond());
      } while (this.eatKeyword("AND"));
    }
    let returns: ReturnSpec = { kind: "paths" };
    if (this.eatKeyword("RETURN")) {
      returns = this.parseReturns();
    }
    let limit: number | undefined;
    if (this.eatKeyword("LIMIT")) {
      const t = this.next();
      if (
        t.kind !== "number" ||
        !Number.isInteger(t.value ?? NaN) ||
        (t.value ?? 0) < 1
      ) {
        throw new GraphDslParseError("LIMIT expects a positive integer", t.pos);
      }
      limit = t.value;
    }
    const tail = this.peek();
    if (tail.kind !== "eof") {
      throw new GraphDslParseError(
        `Unexpected trailing input at ${describeToken(tail)}`,
        tail.pos,
      );
    }
    const query: GraphDslQuery = { nodes, edges, where, returns, limit };
    this.validate(query);
    return query;
  }

  private parseNodePattern(): NodePattern {
    const start = this.peek();
    this.expectPunct("(");
    const pattern: NodePattern = { pos: start.pos };
    if (this.peek().kind === "ident") {
      pattern.variable = this.next().text;
    }
    if (this.eatPunct(":")) {
      const ty = this.next();
      if (ty.kind !== "ident") {
        throw new GraphDslParseError("Expected a node type after ':'", ty.pos);
      }
      pattern.type = ty.text.toLowerCase();
    }
    if (this.peek().kind === "string") {
      pattern.nameContains = this.next().text.toLowerCase();
    }
    this.expectPunct(")");
    return pattern;
  }

  private parseEdgePattern(): EdgePattern {
    const start = this.peek();
    let leftArrow = false;
    if (this.eatPunct("<")) {
      this.expectPunct("-");
      leftArrow = true;
    } else {
      this.expectPunct("-");
    }
    this.expectPunct("[");
    const pattern: EdgePattern = {
      direction: "any",
      minHops: 1,
      maxHops: 1,
      pos: start.pos,
    };
    if (this.peek().kind === "ident") {
      pattern.variable = this.next().text;
    }
    if (this.eatPunct(":")) {
      const ty = this.next();
      if (ty.kind !== "ident") {
        throw new GraphDslParseError("Expected an edge type after ':'", ty.pos);
      }
      pattern.type = ty.text.toLowerCase();
    }
    if (this.eatPunct("*")) {
      if (pattern.variable) {
        throw new GraphDslParseError(
          "An edge variable cannot be combined with variable-length hops",
          start.pos,
        );
      }
      let min = 1;
      let max = DEFAULT_VAR_HOPS_MAX;
      if (this.peek().kind === "number") {
        const n = this.next();
        if (!Number.isInteger(n.value ?? NaN)) {
          throw new GraphDslParseError("Hop counts must be integers", n.pos);
        }
        min = n.value!;
        max = n.value!;
      }
      if (this.eatPunct("..")) {
        const m = this.next();
        if (m.kind !== "number" || !Number.isInteger(m.value ?? NaN)) {
          throw new GraphDslParseError(
            "Expected an integer hop count after '..'",
            m.pos,
          );
        }
        max = m.value!;
      }
      if (min < 1) {
        throw new GraphDslParseError(
          "Minimum hops must be at least 1",
          start.pos,
        );
      }
      if (max < min) {
        throw new GraphDslParseError(
          "Maximum hops must be >= minimum hops",
          start.pos,
        );
      }
      if (max > MAX_VAR_HOPS) {
        throw new GraphDslParseError(
          `Maximum hops is capped at ${MAX_VAR_HOPS}`,
          start.pos,
        );
      }
      pattern.minHops = min;
      pattern.maxHops = max;
    }
    this.expectPunct("]");
    this.expectPunct("-");
    if (leftArrow) {
      if (this.isPunct(">")) {
        throw new GraphDslParseError(
          "An edge cannot point both ways",
          this.peek().pos,
        );
      }
      pattern.direction = "left";
    } else if (this.eatPunct(">")) {
      pattern.direction = "right";
    } else {
      pattern.direction = "any";
    }
    return pattern;
  }

  private parseCond(): WhereCond {
    const v = this.next();
    if (v.kind !== "ident") {
      throw new GraphDslParseError(
        "Expected a variable name in WHERE",
        v.pos,
      );
    }
    this.expectPunct(".");
    const fields: string[] = [];
    do {
      const f = this.next();
      if (f.kind !== "ident") {
        throw new GraphDslParseError("Expected a field name after '.'", f.pos);
      }
      fields.push(f.text);
    } while (this.eatPunct("."));
    const opTok = this.next();
    const ops = ["=", "!=", "~", ">", "<", ">=", "<="] as const;
    if (
      opTok.kind !== "punct" ||
      !(ops as readonly string[]).includes(opTok.text)
    ) {
      throw new GraphDslParseError(
        `Expected a comparison operator, found ${describeToken(opTok)}`,
        opTok.pos,
      );
    }
    const op = opTok.text as WhereCond["op"];
    const valTok = this.next();
    let value: string | number;
    if (valTok.kind === "string") {
      value = valTok.text;
    } else if (valTok.kind === "number") {
      value = valTok.value!;
    } else {
      throw new GraphDslParseError(
        "Expected a string or number literal",
        valTok.pos,
      );
    }
    if (
      (op === ">" || op === "<" || op === ">=" || op === "<=") &&
      typeof value !== "number"
    ) {
      throw new GraphDslParseError(
        `Operator '${op}' requires a numeric value`,
        valTok.pos,
      );
    }
    if (op === "~" && typeof value !== "string") {
      throw new GraphDslParseError(
        "Operator '~' requires a string value",
        valTok.pos,
      );
    }
    return { variable: v.text, fields, op, value, pos: v.pos };
  }

  private parseReturns(): ReturnSpec {
    const first = this.next();
    if (first.kind !== "ident") {
      throw new GraphDslParseError(
        "RETURN expects 'paths', 'nodes', 'edges', or variable names",
        first.pos,
      );
    }
    const vars = [first.text];
    while (this.eatPunct(",")) {
      const t = this.next();
      if (t.kind !== "ident") {
        throw new GraphDslParseError(
          "Expected a variable name after ','",
          t.pos,
        );
      }
      vars.push(t.text);
    }
    if (vars.length === 1) {
      const kw = vars[0].toLowerCase();
      if (kw === "paths" || kw === "nodes" || kw === "edges") {
        return { kind: kw };
      }
    }
    return { kind: "vars", vars };
  }

  private validate(q: GraphDslQuery): void {
    const nodeVars = new Set<string>();
    const edgeVars = new Set<string>();
    for (const n of q.nodes) {
      if (n.variable) nodeVars.add(n.variable);
    }
    for (const e of q.edges) {
      if (!e.variable) continue;
      if (edgeVars.has(e.variable) || nodeVars.has(e.variable)) {
        throw new GraphDslParseError(
          `Duplicate variable '${e.variable}'`,
          e.pos,
        );
      }
      edgeVars.add(e.variable);
    }
    for (const c of q.where) {
      const isNode = nodeVars.has(c.variable);
      const isEdge = edgeVars.has(c.variable);
      if (!isNode && !isEdge) {
        throw new GraphDslParseError(
          `Unknown variable '${c.variable}' in WHERE`,
          c.pos,
        );
      }
      if (isEdge) {
        if (c.fields.length !== 1 || !EDGE_FIELDS.has(c.fields[0])) {
          throw new GraphDslParseError(
            `Edge variable '${c.variable}' supports the fields: type, weight, id`,
            c.pos,
          );
        }
      } else if (
        c.fields.length > 2 ||
        (c.fields.length === 2 && c.fields[0] !== "properties")
      ) {
        throw new GraphDslParseError(
          `Node field must be name, type, id, a property key, or properties.<key>`,
          c.pos,
        );
      }
    }
    if (q.returns.kind === "vars") {
      for (const v of q.returns.vars) {
        if (!nodeVars.has(v) && !edgeVars.has(v)) {
          throw new GraphDslParseError(
            `Unknown variable '${v}' in RETURN`,
            0,
          );
        }
      }
    }
  }
}

export function parseGraphDsl(query: string): GraphDslQuery {
  if (query.length > MAX_DSL_QUERY_LENGTH) {
    throw new GraphDslParseError(
      `Query exceeds ${MAX_DSL_QUERY_LENGTH} characters`,
      MAX_DSL_QUERY_LENGTH,
    );
  }
  return new Parser(tokenize(query)).parse();
}

export interface GraphDslExecOptions {
  // Maximum matches to collect (the search stops once reached).
  limit: number;
  // Safety valve on total traversal work across all seeds.
  maxVisits?: number;
}

export interface GraphDslExecution {
  matches: GraphDslMatch[];
  truncated: boolean;
  visits: number;
  budgetExhausted: boolean;
}

interface Adjacent {
  edge: GraphEdge;
  out: boolean;
}

function nodeMatchesPattern(p: NodePattern, n: GraphNode): boolean {
  if (p.type && n.type.toLowerCase() !== p.type) return false;
  if (p.nameContains) {
    const needle = p.nameContains;
    if (
      !n.name.toLowerCase().includes(needle) &&
      !(n.aliases ?? []).some((a) => a.toLowerCase().includes(needle))
    ) {
      return false;
    }
  }
  return true;
}

function resolveField(
  cond: WhereCond,
  bindings: Record<string, string>,
  nodesById: Map<string, GraphNode>,
  edgesById: Map<string, GraphEdge>,
): unknown {
  const id = bindings[cond.variable];
  if (id === undefined) return undefined;
  const node = nodesById.get(id);
  if (node) {
    if (cond.fields.length === 2) {
      // Validated at parse time: fields[0] === "properties".
      return node.properties?.[cond.fields[1]];
    }
    const f = cond.fields[0];
    if (f === "name") return node.name;
    if (f === "type") return node.type;
    if (f === "id") return node.id;
    return node.properties?.[f];
  }
  const edge = edgesById.get(id);
  if (edge) {
    const f = cond.fields[0];
    if (f === "type") return edge.type;
    if (f === "weight") return edge.weight;
    if (f === "id") return edge.id;
  }
  return undefined;
}

function condHolds(cond: WhereCond, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  switch (cond.op) {
    case "=":
      return typeof cond.value === "number"
        ? Number(value) === cond.value
        : String(value) === cond.value;
    case "!=":
      return typeof cond.value === "number"
        ? Number(value) !== cond.value
        : String(value) !== cond.value;
    case "~":
      return String(value)
        .toLowerCase()
        .includes((cond.value as string).toLowerCase());
    default: {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      const v = cond.value as number;
      if (cond.op === ">") return n > v;
      if (cond.op === "<") return n < v;
      if (cond.op === ">=") return n >= v;
      return n <= v;
    }
  }
}

// Backtracking matcher over the pattern chain. Paths are simple (no
// repeated node or edge) except when a node pattern re-uses a bound
// variable, which closes a cycle onto exactly that node. Work across
// all seeds is bounded by maxVisits.
export function executeGraphDsl(
  query: GraphDslQuery,
  allNodes: GraphNode[],
  allEdges: GraphEdge[],
  opts: GraphDslExecOptions,
): GraphDslExecution {
  const limit = Math.max(1, opts.limit);
  const maxVisits = opts.maxVisits ?? DEFAULT_MAX_VISITS;

  const nodesById = new Map<string, GraphNode>();
  for (const n of allNodes) nodesById.set(n.id, n);
  const edgesById = new Map<string, GraphEdge>();
  const adjacency = new Map<string, Adjacent[]>();
  for (const e of allEdges) {
    if (!nodesById.has(e.sourceNodeId) || !nodesById.has(e.targetNodeId)) {
      continue; // dangling edge — endpoint was evicted or never written
    }
    edgesById.set(e.id, e);
    if (!adjacency.has(e.sourceNodeId)) adjacency.set(e.sourceNodeId, []);
    if (!adjacency.has(e.targetNodeId)) adjacency.set(e.targetNodeId, []);
    adjacency.get(e.sourceNodeId)!.push({ edge: e, out: true });
    adjacency.get(e.targetNodeId)!.push({ edge: e, out: false });
  }

  interface InternalMatch extends GraphDslMatch {
    hops: number;
  }

  const matches: InternalMatch[] = [];
  let visits = 0;
  let budgetExhausted = false;

  const whereHolds = (bindings: Record<string, string>): boolean =>
    query.where.every((c) =>
      condHolds(c, resolveField(c, bindings, nodesById, edgesById)),
    );

  const bindNode = (
    p: NodePattern,
    n: GraphNode,
    bindings: Record<string, string>,
  ): Record<string, string> | null => {
    if (!p.variable) return bindings;
    const existing = bindings[p.variable];
    if (existing !== undefined) {
      return existing === n.id ? bindings : null;
    }
    return { ...bindings, [p.variable]: n.id };
  };

  const record = (
    pathNodes: GraphNode[],
    pathEdges: GraphEdge[],
    bindings: Record<string, string>,
  ): boolean => {
    const weights = pathEdges.map((e) => e.weight);
    const avgWeight =
      weights.length > 0
        ? weights.reduce((a, b) => a + b, 0) / weights.length
        : 1;
    matches.push({
      nodes: pathNodes,
      edges: pathEdges,
      bindings,
      avgWeight,
      hops: pathEdges.length,
    });
    return matches.length < limit;
  };

  // Returns false when the search should stop entirely (limit reached
  // or visit budget exhausted).
  const matchSegment = (
    segIdx: number,
    currentId: string,
    bindings: Record<string, string>,
    pathNodes: GraphNode[],
    pathEdges: GraphEdge[],
    nodeSet: Set<string>,
    edgeSet: Set<string>,
  ): boolean => {
    if (segIdx === query.edges.length) {
      if (whereHolds(bindings)) {
        return record(pathNodes, pathEdges, bindings);
      }
      return true;
    }
    const ep = query.edges[segIdx];
    const np = query.nodes[segIdx + 1];

    const step = (
      fromId: string,
      hopsDone: number,
      hopNodes: GraphNode[],
      hopEdges: GraphEdge[],
      hopNodeSet: Set<string>,
      hopEdgeSet: Set<string>,
    ): boolean => {
      if (hopsDone >= ep.maxHops) return true;
      const neighbors = adjacency.get(fromId) ?? [];
      for (const { edge, out } of neighbors) {
        if (++visits > maxVisits) {
          budgetExhausted = true;
          return false;
        }
        if (ep.direction === "right" && !out) continue;
        if (ep.direction === "left" && out) continue;
        if (ep.type && edge.type.toLowerCase() !== ep.type) continue;
        if (hopEdgeSet.has(edge.id)) continue;
        const nextId = out ? edge.targetNodeId : edge.sourceNodeId;
        const nextNode = nodesById.get(nextId);
        if (!nextNode) continue;
        const hops = hopsDone + 1;
        const revisiting = hopNodeSet.has(nextId);

        // Close the segment on nextNode when enough hops are done and
        // the node pattern matches. A revisit is allowed only when the
        // pattern's variable is already bound to exactly this node
        // (explicit cycle close); anonymous / fresh-var patterns keep
        // paths simple.
        if (hops >= ep.minHops && nodeMatchesPattern(np, nextNode)) {
          const joinsBack =
            np.variable !== undefined && bindings[np.variable] === nextId;
          if (!revisiting || joinsBack) {
            const bound = bindNode(np, nextNode, bindings);
            if (bound !== null) {
              const withEdgeVar = ep.variable
                ? { ...bound, [ep.variable]: edge.id }
                : bound;
              const nextNodes = revisiting
                ? [...hopNodes]
                : [...hopNodes, nextNode];
              const nextNodeSet = revisiting
                ? hopNodeSet
                : new Set(hopNodeSet).add(nextId);
              if (
                !matchSegment(
                  segIdx + 1,
                  nextId,
                  withEdgeVar,
                  nextNodes,
                  [...hopEdges, edge],
                  nextNodeSet,
                  new Set(hopEdgeSet).add(edge.id),
                )
              ) {
                return false;
              }
            }
          }
        }

        // Keep expanding through nextNode as an anonymous intermediate
        // (variable-length hops only; single-hop segments have
        // maxHops === 1 so this branch never fires for them).
        if (hops < ep.maxHops && !revisiting) {
          if (
            !step(
              nextId,
              hops,
              [...hopNodes, nextNode],
              [...hopEdges, edge],
              new Set(hopNodeSet).add(nextId),
              new Set(hopEdgeSet).add(edge.id),
            )
          ) {
            return false;
          }
        }
      }
      return true;
    };

    return step(currentId, 0, pathNodes, pathEdges, nodeSet, edgeSet);
  };

  for (const seed of allNodes) {
    if (++visits > maxVisits) {
      budgetExhausted = true;
      break;
    }
    if (!nodeMatchesPattern(query.nodes[0], seed)) continue;
    const bound = bindNode(query.nodes[0], seed, {});
    if (bound === null) continue;
    if (
      !matchSegment(
        0,
        seed.id,
        bound,
        [seed],
        [],
        new Set([seed.id]),
        new Set(),
      )
    ) {
      break;
    }
  }

  matches.sort(
    (a, b) => b.avgWeight - a.avgWeight || a.hops - b.hops,
  );

  return {
    matches: matches.map(({ hops: _hops, ...m }) => m),
    truncated: budgetExhausted || matches.length >= limit,
    visits,
    budgetExhausted,
  };
}
