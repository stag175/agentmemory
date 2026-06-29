import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf-8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

describe("distribution packaging templates", () => {
  it("ships packaging templates in the npm files allowlist", () => {
    const pkg = readJson<{ files: string[] }>("package.json");
    expect(pkg.files).toContain("packaging/");
    expect(pkg.files).toContain("smithery.yaml");
  });

  it("keeps the MCPB manifest aligned with package metadata and the MCP shim", () => {
    const pkg = readJson<{ version: string }>("package.json");
    const manifest = readJson<{
      manifest_version: string;
      name: string;
      version: string;
      server: { type: string; entry_point: string; mcp_config: { command: string; args: string[] } };
      tools_generated: boolean;
      user_config: Record<string, unknown>;
    }>("packaging/mcpb/manifest.json");

    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe("agentmemory");
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("server/bin.mjs");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toContain("${__dirname}/server/bin.mjs");
    expect(manifest.tools_generated).toBe(true);
    expect(manifest.user_config).toHaveProperty("agentmemory_url");
    expect(existsSync(join(ROOT, "packages/mcp/bin.mjs"))).toBe(true);
    expect(readText("packages/mcp/bin.mjs")).toContain(
      "@agentmemory/agentmemory/dist/standalone.mjs",
    );
  });

  it("ships Smithery metadata aligned to the MCP npm shim", () => {
    const mcpPkg = readJson<{ version: string }>("packages/mcp/package.json");
    const smithery = readText("smithery.yaml");

    expect(smithery).toContain("runtime: node");
    expect(smithery).toContain("type: stdio");
    expect(smithery).toContain(`@agentmemory/mcp@${mcpPkg.version}`);
    expect(smithery).toContain("AGENTMEMORY_URL");
    expect(smithery).toContain("AGENTMEMORY_SECRET");
    expect(smithery).toContain("additionalProperties: false");
    expect(smithery).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|SMITHERY_TOKEN|SMITHERY_API_KEY/);
  });

  it("documents that MCPB publishing requires a dependency-bundling build step", () => {
    const readme = readText("packaging/mcpb/README.md");
    expect(readme).toContain("not a finished `.mcpb` artifact");
    expect(readme).toContain("bundle the production dependency tree");
    expect(readme).toContain("Do not hand-write or publish a final `.mcpb`");
  });

  it("keeps the Homebrew formula as a placeholder template with no fake checksum", () => {
    const formula = readText("packaging/homebrew/agentmemory.rb.template");
    const readme = readText("packaging/homebrew/README.md");

    expect(formula).toContain('__AGENTMEMORY_TARBALL_URL__');
    expect(formula).toContain('__AGENTMEMORY_SHA256__');
    expect(formula).toContain('__AGENTMEMORY_VERSION__');
    expect(formula).not.toMatch(/sha256\s+"[a-f0-9]{64}"/);
    expect(readme).toContain("not a live formula");
    expect(readme).toContain("Do not publish this template with placeholder values");
    expect(`${formula}\n${readme}`).not.toMatch(/HOMEBREW_GITHUB_API_TOKEN/);
  });

  it("keeps the VS Code extension metadata aligned to package metadata", () => {
    const pkg = readJson<{ version: string; license: string; repository: { url: string } }>(
      "package.json",
    );
    const extensionPkg = readJson<{
      name: string;
      version: string;
      license: string;
      main: string;
      repository: { url: string; directory: string };
      activationEvents: string[];
      contributes: {
        commands: { command: string; title: string }[];
        configuration: { properties: Record<string, { default: string }> };
      };
      files: string[];
    }>("packaging/vscode-extension/package.json");

    expect(extensionPkg.name).toBe("@agentmemory/vscode-extension");
    expect(extensionPkg.version).toBe(pkg.version);
    expect(extensionPkg.license).toBe(pkg.license);
    expect(extensionPkg.main).toBe("./extension.js");
    expect(extensionPkg.repository).toEqual({
      type: "git",
      url: pkg.repository.url,
      directory: "packaging/vscode-extension",
    });
    expect(extensionPkg.files).toEqual(["extension.js", "README.md"]);
    expect(extensionPkg.activationEvents).toEqual(
      extensionPkg.contributes.commands.map((command) => `onCommand:${command.command}`),
    );
    expect(
      extensionPkg.contributes.configuration.properties["agentmemory.cliCommand"].default,
    ).toBe("agentmemory");
    expect(
      extensionPkg.contributes.configuration.properties["agentmemory.viewerUrl"].default,
    ).toBe("http://localhost:3113");
    expect(readText("packaging/vscode-extension/README.md")).toContain(
      "agentmemory doctor --dry-run",
    );
    expect(readText("packaging/vscode-extension/README.md")).not.toMatch(
      /VSCE_PAT|AZURE_DEVOPS_EXT_PAT/,
    );
  });

  it("documents packaging preflight in the README", () => {
    const readme = readText("README.md");

    expect(readme).toContain("Distribution packaging preflight");
    expect(readme).toContain("npm run release:preflight");
    expect(readme).toMatch(
      /does not require npm,\s+Smithery, Homebrew, or VS Code Marketplace publish\s+credentials/,
    );
  });
});
