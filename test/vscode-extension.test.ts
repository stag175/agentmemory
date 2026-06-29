import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCliInvocation,
  commandDefinitions,
  commandIds,
  DEFAULT_CLI_COMMAND,
  DEFAULT_VIEWER_URL,
} from "../packaging/vscode-extension/extension.js";

const ROOT = join(import.meta.dirname, "..");

type ExtensionManifest = {
  name: string;
  displayName: string;
  version: string;
  type: string;
  main: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{ command: string; title: string; category: string }>;
    configuration: {
      properties: Record<string, { default?: string }>;
    };
  };
};

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf-8")) as T;
}

describe("VS Code extension package surface", () => {
  const manifest = readJson<ExtensionManifest>("packaging/vscode-extension/package.json");

  it("declares a minimal extension package without relying on the root manifest", () => {
    expect(manifest.name).toBe("@agentmemory/vscode-extension");
    expect(manifest.displayName).toBe("agentmemory");
    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./extension.js");
    expect(manifest.contributes.configuration.properties["agentmemory.cliCommand"].default).toBe(
      DEFAULT_CLI_COMMAND,
    );
    expect(manifest.contributes.configuration.properties["agentmemory.viewerUrl"].default).toBe(
      DEFAULT_VIEWER_URL,
    );
  });

  it("keeps contributed commands aligned with the extension entrypoint", () => {
    const contributedIds = manifest.contributes.commands.map((command) => command.command).sort();
    expect(contributedIds).toEqual([...commandIds].sort());
    expect(manifest.activationEvents.sort()).toEqual(
      commandIds.map((id) => `onCommand:${id}`).sort(),
    );
    expect(manifest.contributes.commands.every((command) => command.category === "Agentmemory")).toBe(
      true,
    );
  });

  it("maps the control-plane commands to the installed CLI surface", () => {
    const byId = new Map(commandDefinitions.map((command) => [command.id, command]));
    expect(byId.get("agentmemory.status")?.cliArgs).toEqual(["status"]);
    expect(byId.get("agentmemory.doctor")?.cliArgs).toEqual(["doctor", "--dry-run"]);
    expect(byId.get("agentmemory.connectRepair")?.cliArgs).toEqual(["connect", "repair"]);
    expect(byId.get("agentmemory.openViewer")?.kind).toBe("viewer");
  });

  it("builds Windows-aware CLI invocations without hardcoded absolute paths", () => {
    expect(buildCliInvocation(DEFAULT_CLI_COMMAND, ["status"], "linux", {})).toEqual({
      command: DEFAULT_CLI_COMMAND,
      args: ["status"],
    });

    expect(
      buildCliInvocation(DEFAULT_CLI_COMMAND, ["connect", "repair"], "win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "agentmemory connect repair"],
    });

    const pathInvocation = buildCliInvocation(
      "C:\\Program Files\\nodejs\\agentmemory.cmd",
      ["status"],
      "win32",
      { COMSPEC: "cmd.exe" },
    );
    expect(pathInvocation.command).toBe("cmd.exe");
    expect(pathInvocation.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Program Files\\nodejs\\agentmemory.cmd" status',
    ]);
  });

  it("rejects shell metacharacters in configured CLI command values", () => {
    expect(() => buildCliInvocation("agentmemory & calc", ["status"], "win32", {})).toThrow(
      /metacharacters/,
    );
  });
});
