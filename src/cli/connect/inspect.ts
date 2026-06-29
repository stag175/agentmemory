import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConnectAdapter,
  ConnectInspection,
  ConnectInspectionStatus,
} from "./types.js";
import { AGENTMEMORY_MCP_BLOCK } from "./util.js";

type JsonReadResult =
  | { kind: "missing" }
  | { kind: "invalid"; message: string }
  | { kind: "ok"; value: unknown };

type JsonMcpInspectionConfig = {
  name: string;
  displayName: string;
  detectDir: string;
  configPath: string;
  wrapperKey?: string;
  extraEntryFields?: Record<string, unknown>;
  windowsSafe?: boolean;
};

type JsonEntryInspectionConfig = {
  name: string;
  displayName: string;
  detectDir: string;
  configPath: string;
  wrapperKey: string;
  expectedEntry: Record<string, unknown>;
  expectedMutation: string;
  windowsSafe?: boolean;
};

type TextInspectionConfig = {
  name: string;
  displayName: string;
  detectDir: string;
  configPath: string;
  expectedText: string;
  staleMarker: string;
  expectedMutation: string;
  windowsSafe?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): JsonReadResult {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "ok", value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    return {
      kind: "invalid",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function entryReferencesAgentmemory(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const command = entry["command"];
  if (Array.isArray(command) && command.includes("@agentmemory/mcp")) {
    return true;
  }
  const args = Array.isArray(entry["args"]) ? entry["args"] : [];
  return args.includes("@agentmemory/mcp");
}

function result(
  config: {
    name: string;
    displayName: string;
    configPath?: string;
    expectedMutation: string;
    windowsSafe?: boolean;
  },
  status: ConnectInspectionStatus,
  repairSafe: boolean,
  reason: string,
): ConnectInspection {
  return {
    agent: config.name,
    displayName: config.displayName,
    status,
    ...(config.configPath !== undefined && { configPath: config.configPath }),
    expectedMutation: config.expectedMutation,
    windowsSafe: config.windowsSafe === true,
    repairSafe,
    reason,
  };
}

export function inspectJsonMcpAdapter(
  config: JsonMcpInspectionConfig,
): ConnectInspection {
  const wrapperKey = config.wrapperKey ?? "mcpServers";
  return inspectJsonEntry({
    name: config.name,
    displayName: config.displayName,
    detectDir: config.detectDir,
    configPath: config.configPath,
    wrapperKey,
    expectedEntry: {
      ...AGENTMEMORY_MCP_BLOCK,
      ...(config.extraEntryFields ?? {}),
    },
    expectedMutation: `add ${wrapperKey}.agentmemory to ${config.configPath}`,
    ...(config.windowsSafe !== undefined && { windowsSafe: config.windowsSafe }),
  });
}

export function inspectJsonEntry(
  config: JsonEntryInspectionConfig,
): ConnectInspection {
  if (!existsSync(config.detectDir)) {
    return result(
      config,
      "not-detected",
      false,
      `${config.displayName} config directory was not found.`,
    );
  }

  const parsed = readJson(config.configPath);
  if (parsed.kind === "missing") {
    return result(
      config,
      "missing",
      true,
      `${config.configPath} does not exist yet.`,
    );
  }
  if (parsed.kind === "invalid") {
    return result(
      config,
      "invalid-config",
      true,
      `${config.configPath} is not valid JSON: ${parsed.message}`,
    );
  }
  if (!isRecord(parsed.value)) {
    return result(
      config,
      "invalid-config",
      true,
      `${config.configPath} must contain a JSON object.`,
    );
  }

  const wrapper = parsed.value[config.wrapperKey];
  if (wrapper === undefined) {
    return result(
      config,
      "missing",
      true,
      `${config.wrapperKey}.agentmemory is not configured.`,
    );
  }
  if (!isRecord(wrapper)) {
    return result(
      config,
      "invalid-config",
      true,
      `${config.wrapperKey} must be a JSON object.`,
    );
  }

  const entry = wrapper["agentmemory"];
  if (entry === undefined) {
    return result(
      config,
      "missing",
      true,
      `${config.wrapperKey}.agentmemory is not configured.`,
    );
  }
  if (stable(entry) === stable(config.expectedEntry)) {
    return result(
      config,
      "healthy",
      true,
      `${config.wrapperKey}.agentmemory matches the expected agentmemory MCP block.`,
    );
  }
  const status = entryReferencesAgentmemory(entry) ? "stale" : "stale";
  return result(
    config,
    status,
    true,
    `${config.wrapperKey}.agentmemory exists but does not match the current expected block.`,
  );
}

export function inspectTextBlock(config: TextInspectionConfig): ConnectInspection {
  if (!existsSync(config.detectDir)) {
    return result(
      config,
      "not-detected",
      false,
      `${config.displayName} config directory was not found.`,
    );
  }
  if (!existsSync(config.configPath)) {
    return result(
      config,
      "missing",
      true,
      `${config.configPath} does not exist yet.`,
    );
  }

  const text = readFileSync(config.configPath, "utf-8");
  if (text.includes(config.expectedText)) {
    return result(
      config,
      "healthy",
      true,
      `${config.configPath} contains the expected agentmemory MCP block.`,
    );
  }
  if (text.includes(config.staleMarker)) {
    return result(
      config,
      "stale",
      true,
      `${config.configPath} contains an agentmemory block that differs from the current expected block.`,
    );
  }
  return result(
    config,
    "missing",
    true,
    `${config.configPath} does not contain agentmemory wiring.`,
  );
}

function inspectContinue(adapter: ConnectAdapter): ConnectInspection {
  const dir = join(homedir(), ".continue");
  const yamlPath = join(dir, "config.yaml");
  const jsonPath = join(dir, "config.json");
  const base = {
    name: adapter.name,
    displayName: adapter.displayName,
    configPath: existsSync(yamlPath) ? yamlPath : jsonPath,
    expectedMutation:
      existsSync(yamlPath)
        ? `manually merge agentmemory into ${yamlPath}`
        : `add mcpServers[agentmemory] to ${jsonPath} or create ${yamlPath}`,
    windowsSafe: false,
  };

  if (!existsSync(dir)) {
    return result(
      base,
      "not-detected",
      false,
      "Continue config directory was not found.",
    );
  }
  if (existsSync(yamlPath)) {
    const yaml = readFileSync(yamlPath, "utf-8");
    if (yaml.includes("@agentmemory/mcp")) {
      return result(
        base,
        "healthy",
        false,
        "Continue config.yaml already references @agentmemory/mcp; YAML repair remains manual.",
      );
    }
    return result(
      base,
      "manual-only",
      false,
      "Continue config.yaml exists; preserving YAML comments and anchors requires a manual merge.",
    );
  }
  if (!existsSync(jsonPath)) {
    return result(
      base,
      "missing",
      true,
      "Continue has no config.yaml or legacy config.json yet.",
    );
  }
  const parsed = readJson(jsonPath);
  if (parsed.kind === "invalid") {
    return result(base, "invalid-config", true, parsed.message);
  }
  if (parsed.kind !== "ok" || !isRecord(parsed.value)) {
    return result(base, "invalid-config", true, `${jsonPath} must contain a JSON object.`);
  }
  const servers = parsed.value["mcpServers"];
  if (!Array.isArray(servers)) {
    return result(base, "missing", true, "legacy config.json has no mcpServers list.");
  }
  const entry = servers.find(
    (candidate) => isRecord(candidate) && candidate["name"] === "agentmemory",
  );
  if (!entry) return result(base, "missing", true, "agentmemory is not in mcpServers.");
  if (entryReferencesAgentmemory(entry)) {
    return result(base, "healthy", true, "mcpServers[agentmemory] references @agentmemory/mcp.");
  }
  return result(base, "stale", true, "mcpServers[agentmemory] exists but points elsewhere.");
}

function inspectOpencode(adapter: ConnectAdapter): ConnectInspection {
  const dir = join(homedir(), ".config", "opencode");
  const configPath = join(dir, "opencode.json");
  const expectedEntry = {
    type: "local",
    command: ["npx", "-y", "@agentmemory/mcp"],
    enabled: true,
  };
  return inspectJsonEntry({
    name: adapter.name,
    displayName: adapter.displayName,
    detectDir: dir,
    configPath,
    wrapperKey: "mcp",
    expectedEntry,
    expectedMutation: `add mcp.agentmemory to ${configPath}`,
  });
}

function inspectManualAdapter(
  adapter: ConnectAdapter,
  configPath?: string,
): ConnectInspection {
  const detected = adapter.detect();
  return result(
    {
      name: adapter.name,
      displayName: adapter.displayName,
      ...(configPath !== undefined && { configPath }),
      expectedMutation: adapter.docs
        ? `manual install required; see ${adapter.docs}`
        : "manual install required",
    },
    detected ? "manual-only" : "not-detected",
    false,
    detected
      ? `${adapter.displayName} is detected, but this adapter does not have an automated repair path yet.`
      : `${adapter.displayName} was not detected on this machine.`,
  );
}

export function inspectAdapter(adapter: ConnectAdapter): ConnectInspection {
  if (adapter.inspect) return adapter.inspect();
  if (adapter.name === "continue") return inspectContinue(adapter);
  if (adapter.name === "opencode") return inspectOpencode(adapter);
  if (adapter.name === "hermes") {
    return inspectManualAdapter(adapter, join(homedir(), ".hermes", "config.yaml"));
  }
  if (adapter.name === "pi") {
    return inspectManualAdapter(
      adapter,
      join(homedir(), ".pi", "agent", "settings.json"),
    );
  }
  if (adapter.name === "openhuman") {
    return inspectManualAdapter(adapter, join(homedir(), ".openhuman"));
  }
  return inspectManualAdapter(adapter);
}

export function formatInspectionSummary(inspections: ConnectInspection[]): string {
  if (inspections.length === 0) return "  No adapters selected.";
  return inspections
    .map((inspection) => {
      const flags = [
        inspection.windowsSafe ? "windows-safe" : "windows-manual",
        inspection.repairSafe ? "repair-safe" : "manual-repair",
      ].join(", ");
      const target = inspection.configPath ? `\n     config: ${inspection.configPath}` : "";
      return `  ${inspection.agent}: ${inspection.status} (${flags})${target}\n     ${inspection.reason}\n     expected: ${inspection.expectedMutation}`;
    })
    .join("\n");
}
