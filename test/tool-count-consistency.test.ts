import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getAllTools, ESSENTIAL_TOOLS } from "../src/mcp/tools-registry.js";

const ROOT = join(import.meta.dirname, "..");
// Bumped 65 -> 74 when the MCP surface gained the governance/control-plane
// tools (memory_audit_chain, memory_audit_chain_verify,
// memory_sync_peer_set_status, memory_agent_event_prune) and the team memory
// proposal tools (memory_proposal_create/list/approve/reject/apply).
const EXPECTED_TOOL_COUNT = 74;

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

describe("Tool count consistency", () => {
  it("registry exposes the expected number of tools", () => {
    expect(getAllTools().length).toBe(EXPECTED_TOOL_COUNT);
  });

  it("cli help derives the tool counts from the registry", () => {
    const cli = readText("src/cli.ts");
    expect(cli).toContain("const ALL_TOOLS_COUNT = getAllTools().length;");
    expect(cli).toContain(
      "(default: all = ${ALL_TOOLS_COUNT} tools; core = ${CORE_TOOLS_COUNT} essentials)",
    );
    expect(cli).not.toMatch(/all\s*=\s*51 tools/);
  });

  it("core tool count derives from the registry", () => {
    const coreCount = getAllTools().filter((t) => ESSENTIAL_TOOLS.has(t.name)).length;
    expect(coreCount).toBe(ESSENTIAL_TOOLS.size);
    expect(coreCount).toBeGreaterThan(0);
  });

  it("README advertises the same tool count as the registry", () => {
    const activeSurfaces = [
      "README.md",
      "integrations/hermes/README.md",
      "integrations/openclaw/README.md",
      "assets/tags/stat-tools.svg",
      "assets/tags/light/stat-tools.svg",
      "assets/tags/section-mcp.svg",
      "assets/tags/light/section-mcp.svg",
    ];
    for (const path of activeSurfaces) {
      const content = readText(path);
      expect(content, path).toContain(String(EXPECTED_TOOL_COUNT));
      expect(content, path).not.toMatch(/(?:MCP[- ]|all )43(?:_tools| memory tools| MCP tools)?/);
    }
  });

  it("skill count claims match the plugin/skills directory", () => {
    const skillCount = readdirSync(join(ROOT, "plugin", "skills"), {
      withFileTypes: true,
    }).filter((e) => e.isDirectory() && e.name !== "_shared").length;
    expect(readText("src/cli/connect/index.ts")).toContain(`${skillCount} skills`);
    expect(readText("README.md")).toContain(`${skillCount} skills`);
    expect(readText("AGENTS.md")).toContain(`12 hooks, ${skillCount} skills`);
    expect(readText("plugin/plugin.json")).toContain(`${skillCount} skills`);
  });

  it("INSTALL_FOR_AGENTS.md names the real core tool set", () => {
    const names = [...ESSENTIAL_TOOLS].map((t) =>
      t.replace(/^memory_/, "").replace(/_/g, " "),
    );
    const sentence = `The ${names.length} core tools cover ${names
      .slice(0, -1)
      .join(", ")}, and ${names[names.length - 1]}.`;
    expect(readText("INSTALL_FOR_AGENTS.md")).toContain(sentence);
  });
});
