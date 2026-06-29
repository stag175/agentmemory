import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

type TextRequirement = {
  path: string;
  reason: string;
  contains?: string[];
  matches?: RegExp[];
  excludes?: RegExp[];
};

type JsonRequirement = {
  path: string;
  reason: string;
  check: (value: unknown) => string | null;
};

type AlternativeRequirement = {
  paths: string[];
  reason: string;
};

type RoadmapArea = {
  name: string;
  files?: TextRequirement[];
  json?: JsonRequirement[];
  alternatives?: AlternativeRequirement[];
};

function absolute(relativePath: string): string {
  return join(ROOT, relativePath);
}

function readText(relativePath: string): string {
  return readFileSync(absolute(relativePath), "utf-8");
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

function hasRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected);
}

function packageJsonHasFile(value: unknown, expected: string): string | null {
  if (!hasRecord(value) || !arrayIncludes(value.files, expected)) {
    return `package.json files must include ${expected}`;
  }
  return null;
}

const roadmapAreas: RoadmapArea[] = [
  {
    name: "Lifecycle APIs",
    files: [
      {
        path: "src/functions/memory-lifecycle.ts",
        reason: "Register the lifecycle worker functions.",
        contains: [
          "mem::memory-create",
          "mem::memory-inspect",
          "mem::memory-history",
          "mem::memory-update",
          "mem::memory-expire",
          "mem::memory-archive",
          "mem::memory-restore",
          "mem::memory-delete",
          "mem::memory-ledger",
          "mem::memory-review-queue",
        ],
      },
      {
        path: "src/cli/memory-lifecycle.ts",
        reason: "Expose lifecycle ledger and review queue commands through the CLI.",
        contains: ['path: "memory-ledger"', 'path: "memory-review-queue"'],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose lifecycle APIs through REST.",
        contains: [
          "/agentmemory/memory/create",
          "/agentmemory/memory/update",
          "/agentmemory/memory/delete",
          "/agentmemory/memory-ledger",
          "/agentmemory/memory-review-queue",
        ],
      },
      {
        path: "src/mcp/tools-registry.ts",
        reason: "Expose lifecycle APIs through MCP.",
        contains: [
          'name: "memory_create"',
          'name: "memory_inspect"',
          'name: "memory_history"',
          'name: "memory_update"',
          'name: "memory_expire"',
          'name: "memory_archive"',
          'name: "memory_restore"',
          'name: "memory_delete"',
        ],
      },
      {
        path: "test/memory-lifecycle.test.ts",
        reason: "Keep function-level lifecycle coverage.",
        contains: ["mem::memory-create", "mem::memory-review-queue"],
      },
      {
        path: "test/cli-memory-lifecycle.test.ts",
        reason: "Keep CLI lifecycle coverage.",
        contains: ["memory-ledger", "memory-review-queue"],
      },
    ],
  },
  {
    name: "Context router and search explain",
    files: [
      {
        path: "src/retrieval/context-router.ts",
        reason: "Keep deterministic query planning and context packing primitives.",
        contains: [
          "export function buildQueryPlan",
          "export function packContext",
          "selectedIds",
          "budgetReport",
        ],
      },
      {
        path: "src/functions/smart-search.ts",
        reason: "Return query plans and ranked evidence for search explain.",
        contains: ["queryPlan", "rankedEvidence", "buildQueryPlan"],
      },
      {
        path: "src/functions/context.ts",
        reason: "Return explain plans and budget reports for context routing.",
        contains: ["includeReport", "budgetReport", "queryPlan"],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose search explain over REST.",
        contains: ['function_id: "api::search-explain"', "/agentmemory/search/explain"],
      },
      {
        path: "src/mcp/tools-registry.ts",
        reason: "Expose search explain over MCP.",
        contains: ['name: "memory_search_explain"', "includeReport"],
      },
      {
        path: "test/retrieval-context-router.test.ts",
        reason: "Keep router packing coverage.",
        contains: ["searchMode", "budgetReport"],
      },
      {
        path: "test/context-router.test.ts",
        reason: "Keep function caller coverage for context explain output.",
        contains: ["queryPlan", "budgetReport"],
      },
      {
        path: "test/smart-search.test.ts",
        reason: "Keep search explain coverage.",
        contains: ["queryPlan plus rankedEvidence", "temporal query plan"],
      },
    ],
  },
  {
    name: "Agent events lineage",
    files: [
      {
        path: "src/functions/agent-events.ts",
        reason: "Persist and query the agent-event ledger.",
        contains: [
          "mem::agent-event-record",
          "mem::agent-event-list",
          "targetIds",
          "parentEventId",
          "correlationId",
        ],
      },
      {
        path: "src/hooks/_lineage.ts",
        reason: "Build lineage fields for TypeScript hook entrypoints.",
        contains: ["export function buildLineage", "eventFields", "sendAgentEvent"],
      },
      {
        path: "plugin/scripts/_lineage.mjs",
        reason: "Build lineage fields for bundled plugin hook scripts.",
        contains: ["export function buildLineage", "eventFields", "sendAgentEvent"],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose agent-event lineage through REST.",
        contains: ["/agentmemory/agent-events", "buildAgentEventInput", "targetIds"],
      },
      {
        path: "test/agent-events.test.ts",
        reason: "Keep ledger and API coverage for lineage filters.",
        contains: ["agent event lineage ledger", "correlationId", "parentEventId"],
      },
    ],
  },
  {
    name: "Write gate and redaction",
    files: [
      {
        path: "src/functions/write-gate.ts",
        reason: "Evaluate write quality, novelty, provenance, and sensitivity.",
        contains: ["export function evaluateWriteGate", "privacySummary", "sensitivityLabels"],
      },
      {
        path: "src/functions/privacy.ts",
        reason: "Detect and summarize redaction before persistence.",
        contains: ["redactionApplied", "summarizePrivacyScans"],
      },
      {
        path: "src/functions/remember.ts",
        reason: "Apply the write gate and quarantine redacted memories.",
        contains: ["requireGatePass", "write gate rejected memory", "quarantined"],
      },
      {
        path: "test/write-gate.test.ts",
        reason: "Keep write gate and redaction behavior covered.",
        contains: ["strict gate mode", "stores sensitive memories as quarantined"],
      },
    ],
  },
  {
    name: "Connect doctor and repair",
    files: [
      {
        path: "src/cli/connect/inspect.ts",
        reason: "Inspect host MCP wiring before repair.",
        contains: ["inspectAdapter", "repairSafe", "formatInspectionSummary"],
      },
      {
        path: "src/cli/connect/repair.ts",
        reason: "Plan and apply safe connect repairs.",
        contains: ["buildConnectRepairPlan", "applyConnectRepairPlan", "repair-not-safe"],
      },
      {
        path: "src/cli/connect/index.ts",
        reason: "Wire connect doctor and repair subcommands.",
        contains: ["runConnectDoctor", "runConnectRepair", "agentmemory connect repair"],
      },
      {
        path: "src/cli/doctor-diagnostics.ts",
        reason: "Keep the main doctor diagnostic catalog available.",
        contains: ["Diagnostic ids are stable", "fix", "check"],
      },
      {
        path: "test/cli-connect-repair.test.ts",
        reason: "Cover inspection and auto-repair planning.",
        contains: ["connect doctor inspection", "connect repair planning"],
      },
    ],
  },
  {
    name: "Install-method upgrade detection",
    files: [
      {
        path: "src/cli/install-method.ts",
        reason: "Classify package managers and cache installs before upgrading.",
        contains: [
          "classifyInstallMethod",
          "formatInstallMethod",
          "npx-cache",
          "mcpb",
          "homebrew",
          "pipx",
          "uv",
          "docker",
        ],
      },
      {
        path: "src/cli.ts",
        reason: "Use install-method classification in the upgrade command.",
        contains: ["classifyInstallMethod", "agentmemory upgrade", "Install source"],
      },
      {
        path: "test/cli-install-method.test.ts",
        reason: "Cover install-method classification and guidance.",
        contains: ["install method classification", "npx cache installs", "homebrew"],
      },
      {
        path: "README.md",
        reason: "Document upgrade behavior for non-source install methods.",
        contains: [
          "upgrade` first classifies how the CLI is running",
          "npx caches, plugin caches, MCPB, Homebrew, uv, pipx, Docker",
        ],
      },
    ],
  },
  {
    name: "server.json, MCPB, and Homebrew packaging",
    files: [
      {
        path: "server.json",
        reason: "Publish MCP registry metadata.",
        contains: [
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          "@agentmemory/mcp",
        ],
      },
      {
        path: "packaging/mcpb/manifest.json",
        reason: "Keep the MCPB template manifest.",
        contains: ['"manifest_version": "0.3"', '"entry_point": "server/bin.mjs"'],
      },
      {
        path: "packaging/mcpb/README.md",
        reason: "Document that MCPB requires dependency bundling before publishing.",
        contains: ["not a finished `.mcpb` artifact", "bundle the production dependency tree"],
      },
      {
        path: "packaging/homebrew/agentmemory.rb.template",
        reason: "Keep a formula template without fake checksums.",
        contains: [
          "__AGENTMEMORY_VERSION__",
          "__AGENTMEMORY_TARBALL_URL__",
          "__AGENTMEMORY_SHA256__",
        ],
        excludes: [/sha256\s+"[a-f0-9]{64}"/],
      },
      {
        path: "test/distribution-packaging.test.ts",
        reason: "Keep packaging metadata coverage.",
        contains: ["MCPB manifest", "Homebrew formula"],
      },
    ],
    json: [
      {
        path: "package.json",
        reason: "Ensure npm publishes registry and packaging artifacts.",
        check: (value) =>
          packageJsonHasFile(value, "server.json") ?? packageJsonHasFile(value, "packaging/"),
      },
      {
        path: "server.json",
        reason: "Ensure server.json points at the MCP shim package.",
        check: (value) => {
          if (!hasRecord(value)) return "server.json must be a JSON object";
          if (value.name !== "io.github.rohitg00/agentmemory") {
            return "server.json name must be io.github.rohitg00/agentmemory";
          }
          const packages = value.packages;
          if (!Array.isArray(packages)) return "server.json packages must be an array";
          const npmPackage = packages.find(
            (entry) =>
              hasRecord(entry) &&
              entry.registryType === "npm" &&
              entry.identifier === "@agentmemory/mcp",
          );
          return npmPackage ? null : "server.json must include npm package @agentmemory/mcp";
        },
      },
      {
        path: "packaging/mcpb/manifest.json",
        reason: "Ensure MCPB template launches the bundled server.",
        check: (value) => {
          if (!hasRecord(value)) return "MCPB manifest must be a JSON object";
          const server = value.server;
          if (!hasRecord(server)) return "MCPB manifest server must be an object";
          return server.entry_point === "server/bin.mjs"
            ? null
            : "MCPB manifest server.entry_point must be server/bin.mjs";
        },
      },
    ],
  },
  {
    name: "SOC2 evidence pack",
    files: [
      {
        path: "src/functions/compliance-evidence.ts",
        reason: "Build SOC2 evidence from memories, audit, rules, team policy, and release gates.",
        contains: [
          "mem::compliance-evidence",
          "access-posture",
          "lifecycle-hygiene",
          "audit-trail",
          "rules-provenance",
          "release-readiness",
        ],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose SOC2 evidence through REST.",
        contains: ["api::compliance-soc2-evidence", "/agentmemory/compliance/soc2-evidence"],
      },
      {
        path: "test/compliance-evidence.test.ts",
        reason: "Cover sanitized SOC2 evidence output.",
        contains: ["sanitized SOC2 evidence pack", "releaseGateEvidence"],
      },
      {
        path: "test/compliance-evidence-api.test.ts",
        reason: "Cover SOC2 REST payload whitelisting.",
        contains: ["whitelists SOC2 evidence payload fields"],
      },
    ],
  },
  {
    name: "Smithery catalog artifact",
    alternatives: [
      {
        paths: ["smithery.yaml", "smithery.json", ".smithery/server.json"],
        reason:
          "Add a Smithery manifest or catalog entry. server.json/MCP registry coverage is checked separately.",
      },
    ],
  },
  {
    name: "VS Code control plane",
    files: [
      {
        path: "src/cli/connect/cline.ts",
        reason: "Support the VS Code-hosted Cline MCP surface.",
        contains: ["VS Code users", "Cline Settings", "MCP Servers"],
      },
      {
        path: "src/cli/connect/copilot-cli.ts",
        reason: "Support GitHub Copilot CLI MCP wiring for the same editor ecosystem.",
        contains: ["GitHub Copilot CLI", "mcp-config.json", "mcpServers.agentmemory"],
      },
      {
        path: "src/functions/rules-resolver.ts",
        reason: "Resolve VS Code-adjacent agent rule files.",
        contains: [".clinerules", "cline-rules"],
      },
      {
        path: "test/connect-new-agents.test.ts",
        reason: "Cover Cline and other agent connect adapters.",
        contains: ["connect: Cline", "knownAgents includes"],
      },
      {
        path: "README.md",
        reason: "Document VS Code extension setup.",
        contains: ["VS Code extension users", "Cline Settings"],
      },
    ],
  },
  {
    name: "Memory proposals",
    files: [
      {
        path: "src/functions/sketches.ts",
        reason: "Stage, promote, discard, and garbage-collect memory/action proposals.",
        contains: [
          "mem::sketch-create",
          "mem::sketch-add",
          "mem::sketch-promote",
          "mem::sketch-discard",
          "mem::sketch-gc",
        ],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose proposal sketch operations through REST.",
        contains: [
          "/agentmemory/sketches",
          "/agentmemory/sketches/add",
          "/agentmemory/sketches/promote",
          "/agentmemory/sketches/discard",
        ],
      },
      {
        path: "src/mcp/tools-registry.ts",
        reason: "Expose proposal sketch operations through MCP.",
        contains: ['name: "memory_sketch_create"', 'name: "memory_sketch_promote"'],
      },
      {
        path: "test/sketches.test.ts",
        reason: "Cover proposal sketch lifecycle behavior.",
        contains: ["mem::sketch-create", "mem::sketch-promote", "mem::sketch-discard"],
      },
    ],
  },
  {
    name: "Sync control plane",
    files: [
      {
        path: "src/functions/mesh.ts",
        reason: "Implement peer registration, sync, receive, export, and remove.",
        contains: [
          "mem::mesh-register",
          "mem::mesh-sync",
          "mem::mesh-receive",
          "mem::mesh-remove",
          "DEFAULT_SHARED_SCOPES",
        ],
      },
      {
        path: "src/triggers/api.ts",
        reason: "Expose mesh sync control endpoints.",
        contains: [
          "/agentmemory/mesh/peers",
          "/agentmemory/mesh/sync",
          "/agentmemory/mesh/receive",
          "/agentmemory/mesh/export",
        ],
      },
      {
        path: "src/types.ts",
        reason: "Type mesh peers and sync filters.",
        contains: ["export interface MeshPeer", "syncFilter", "sharedScopes"],
      },
      {
        path: "test/mesh.test.ts",
        reason: "Cover mesh sync control behavior.",
        contains: ["mesh-register", "mesh-sync", "mesh-receive"],
      },
      {
        path: "README.md",
        reason: "Document mesh sync security requirements.",
        contains: ["memory_mesh_sync", "mesh sync endpoints require `AGENTMEMORY_SECRET`"],
      },
    ],
  },
  {
    name: "Global community retrieval",
    files: [
      {
        path: "docs/recipes/pairings.md",
        reason: "Document community retrieval pairings and question routing.",
        contains: [
          "codegraph",
          "Understand Anything",
          "Graphify",
          "Cross-project benchmark idea",
          "eval/runner/adapters/",
        ],
      },
      {
        path: "src/functions/graph-retrieval.ts",
        reason: "Keep graph retrieval primitives for broader context retrieval.",
        contains: ["GraphRetrieval", "searchByEntities", "expandFromChunks"],
      },
      {
        path: "benchmark/retrieval-arena-smoke.ts",
        reason: "Keep local retrieval arena smoke coverage.",
        contains: ["agentmemory-retrieval-arena-smoke", "HybridSearch"],
      },
      {
        path: "README.md",
        reason: "Surface community retrieval pairings from the main docs.",
        contains: [
          "Pairs with [codegraph]",
          "Understand Anything",
          "Graphify",
          "Recipes + question-routing table",
        ],
      },
    ],
  },
  {
    name: "Benchmark competitor adapters",
    files: [
      {
        path: "eval/runner/adapters/index.ts",
        reason: "Register benchmark adapters in one shared registry.",
        contains: ['name: "grep"', 'name: "vector"', 'name: "agentmemory"'],
      },
      {
        path: "eval/runner/adapters/grep.ts",
        reason: "Keep the no-network grep baseline adapter.",
        contains: ['name: "grep"', "query(q"],
      },
      {
        path: "eval/runner/adapters/vector.ts",
        reason: "Keep the vector baseline adapter.",
        contains: ['name: "vector"', "text-embedding-3-small"],
      },
      {
        path: "eval/runner/adapters/agentmemory.ts",
        reason: "Keep the agentmemory benchmark adapter.",
        contains: ["export const agentmemoryAdapter", 'name: "agentmemory-hybrid"', "/agentmemory/smart-search"],
      },
      {
        path: "test/eval-adapters.test.ts",
        reason: "Cover benchmark adapter registry behavior.",
        contains: ['["grep", "vector", "agentmemory"]', "unknown adapter"],
      },
      {
        path: "eval/README.md",
        reason: "Document the adapter contract for future competitors.",
        contains: ["Writing a new adapter", "grep", "vector", "agentmemory"],
      },
    ],
  },
];

function collectTextGaps(area: RoadmapArea, requirement: TextRequirement): string[] {
  const gaps: string[] = [];
  if (!existsSync(absolute(requirement.path))) {
    return [
      `${area.name}: add or restore ${requirement.path}. ${requirement.reason}`,
    ];
  }
  const text = readText(requirement.path);
  for (const needle of requirement.contains ?? []) {
    if (!text.includes(needle)) {
      gaps.push(
        `${area.name}: update ${requirement.path} to include ${JSON.stringify(needle)}. ${requirement.reason}`,
      );
    }
  }
  for (const pattern of requirement.matches ?? []) {
    if (!pattern.test(text)) {
      gaps.push(
        `${area.name}: update ${requirement.path} to match ${pattern}. ${requirement.reason}`,
      );
    }
  }
  for (const pattern of requirement.excludes ?? []) {
    if (pattern.test(text)) {
      gaps.push(
        `${area.name}: update ${requirement.path} to remove ${pattern}. ${requirement.reason}`,
      );
    }
  }
  return gaps;
}

function collectJsonGap(area: RoadmapArea, requirement: JsonRequirement): string | null {
  if (!existsSync(absolute(requirement.path))) {
    return `${area.name}: add or restore ${requirement.path}. ${requirement.reason}`;
  }
  let parsed: unknown;
  try {
    parsed = readJson(requirement.path);
  } catch (error) {
    return `${area.name}: fix JSON in ${requirement.path}: ${
      error instanceof Error ? error.message : String(error)
    }. ${requirement.reason}`;
  }
  const failure = requirement.check(parsed);
  return failure
    ? `${area.name}: update ${requirement.path}: ${failure}. ${requirement.reason}`
    : null;
}

function collectAlternativeGap(
  area: RoadmapArea,
  requirement: AlternativeRequirement,
): string | null {
  if (requirement.paths.some((path) => existsSync(absolute(path)))) return null;
  return `${area.name}: add one of ${requirement.paths.join(", ")}. ${requirement.reason}`;
}

function collectRoadmapGaps(): string[] {
  const gaps: string[] = [];
  for (const area of roadmapAreas) {
    for (const requirement of area.files ?? []) {
      gaps.push(...collectTextGaps(area, requirement));
    }
    for (const requirement of area.json ?? []) {
      const gap = collectJsonGap(area, requirement);
      if (gap) gaps.push(gap);
    }
    for (const requirement of area.alternatives ?? []) {
      const gap = collectAlternativeGap(area, requirement);
      if (gap) gaps.push(gap);
    }
  }
  return gaps;
}

describe("roadmap gap smoke", () => {
  it("keeps branch roadmap artifacts present with actionable gap messages", () => {
    const gaps = collectRoadmapGaps();
    if (gaps.length > 0) {
      throw new Error(
        `Roadmap artifact gaps (${gaps.length}):\n${gaps
          .map((gap, index) => `${index + 1}. ${gap}`)
          .join("\n")}`,
      );
    }
  });
});
