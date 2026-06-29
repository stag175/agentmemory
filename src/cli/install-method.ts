import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  realpathSync as defaultRealpathSync,
} from "node:fs";
import { dirname, join, normalize, parse, resolve, sep } from "node:path";

export const AGENTMEMORY_PACKAGE_NAME = "@agentmemory/agentmemory";

export type InstallMethodKind =
  | "source-checkout"
  | "global-npm"
  | "npx-cache"
  | "codex-plugin-cache"
  | "claude-plugin-cache"
  | "mcpb"
  | "homebrew"
  | "uv"
  | "pipx"
  | "docker"
  | "unknown";

export type UpgradePlanKind = "source" | "global-npm" | "guidance" | "noop";

export interface InstallMethod {
  kind: InstallMethodKind;
  label: string;
  packageRoot?: string;
  plan: UpgradePlanKind;
  guidance: string[];
}

export interface InstallMethodFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  realpathSync(path: string): string;
}

export interface InstallMethodInput {
  cwd: string;
  cliDir: string;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  execPath?: string;
  platform?: NodeJS.Platform;
  fs?: Partial<InstallMethodFs>;
}

interface PackageJson {
  name?: unknown;
}

const defaultFs: InstallMethodFs = {
  existsSync: defaultExistsSync,
  readFileSync: defaultReadFileSync,
  realpathSync: defaultRealpathSync,
};

export function classifyInstallMethod(input: InstallMethodInput): InstallMethod {
  const fs = { ...defaultFs, ...(input.fs ?? {}) };
  const env = input.env ?? {};
  const cwd = realpathOrNormalize(input.cwd, fs);
  const cliDir = realpathOrNormalize(input.cliDir, fs);
  const runtimeRoot = findNearestPackageRoot(cliDir, fs);
  const cwdRoot = findNearestPackageRoot(cwd, fs);
  const packageRoot = cwdRoot ?? runtimeRoot;
  const runtimeTrace = buildTrace([cliDir, runtimeRoot, input.execPath, ...(input.argv ?? [])]);

  const cwdSourceRoot = cwdRoot && isAgentmemorySourceCheckout(cwdRoot, fs) ? cwdRoot : undefined;
  if (cwdSourceRoot) {
    return sourceInstall(cwdSourceRoot);
  }

  if (
    hasPathFragment(runtimeTrace, [".codex", "plugins", "cache"]) ||
    hasSegment(runtimeTrace, ".codex-plugin")
  ) {
    return guidanceInstall(
      "codex-plugin-cache",
      "Codex plugin cache",
      [
        "This command is running from Codex's plugin cache, which agentmemory should not mutate in place.",
        "Upgrade from Codex instead: refresh/reinstall the agentmemory plugin, then restart Codex.",
      ],
      runtimeRoot,
    );
  }

  if (
    hasPathFragment(runtimeTrace, [".claude", "plugins"]) ||
    hasSegment(runtimeTrace, ".claude-plugin")
  ) {
    return guidanceInstall(
      "claude-plugin-cache",
      "Claude plugin cache",
      [
        "This command is running from Claude Code's plugin cache, which agentmemory should not mutate in place.",
        "Upgrade from Claude Code instead: /plugin uninstall agentmemory@agentmemory && /plugin install agentmemory@agentmemory, then restart the session.",
      ],
      runtimeRoot,
    );
  }

  if (hasSegment(runtimeTrace, "_npx")) {
    return guidanceInstall("npx-cache", "npx cache", [
      "This command is running from npm's npx cache, which is disposable and should not be edited.",
      "Re-run with the latest package: npx -y @agentmemory/agentmemory@latest doctor",
    ], runtimeRoot);
  }

  if (runtimeRoot && isAgentmemorySourceCheckout(runtimeRoot, fs)) {
    return sourceInstall(runtimeRoot);
  }

  if (hasSegment(runtimeTrace, ".mcpb") || hasSegment(runtimeTrace, "mcpb")) {
    return managerGuidance(
      "mcpb",
      "MCPB-managed install",
      "Upgrade through the MCPB package manager that installed agentmemory.",
      runtimeRoot,
    );
  }

  if (hasSegment(runtimeTrace, "cellar")) {
    return managerGuidance(
      "homebrew",
      "Homebrew install",
      "Upgrade with Homebrew, for example: brew upgrade agentmemory",
      runtimeRoot,
    );
  }

  if (
    hasPathFragment(runtimeTrace, ["pipx", "venvs"]) ||
    hasPathFragment(runtimeTrace, [".local", "pipx"])
  ) {
    return managerGuidance(
      "pipx",
      "pipx-managed install",
      "Upgrade with pipx, for example: pipx upgrade agentmemory",
      runtimeRoot,
    );
  }

  if (
    hasPathFragment(runtimeTrace, ["uv", "tools"]) ||
    hasPathFragment(runtimeTrace, [".local", "share", "uv"])
  ) {
    return managerGuidance(
      "uv",
      "uv-managed install",
      "Upgrade with uv's tool manager, for example: uv tool upgrade agentmemory",
      runtimeRoot,
    );
  }

  if (isGlobalNpmInstall(runtimeRoot, runtimeTrace, env)) {
    return {
      kind: "global-npm",
      label: "global npm install",
      packageRoot: runtimeRoot,
      plan: "global-npm",
      guidance: [
        "Upgrade the global npm package with: npm install -g @agentmemory/agentmemory@latest",
      ],
    };
  }

  if (isDocker(env, fs)) {
    return managerGuidance(
      "docker",
      "Docker/container install",
      "Pull and restart the container image that provides agentmemory.",
      runtimeRoot,
    );
  }

  return {
    kind: "unknown",
    label: "unknown install source",
    packageRoot,
    plan: "noop",
    guidance: [
      "Could not identify how this agentmemory command was installed, so upgrade will not mutate files.",
      "Install or upgrade explicitly with: npm install -g @agentmemory/agentmemory@latest",
    ],
  };
}

export function formatInstallMethod(method: InstallMethod): string {
  const root = method.packageRoot ? ` (${method.packageRoot})` : "";
  return `${method.label}${root}`;
}

function sourceInstall(packageRoot: string): InstallMethod {
  return {
    kind: "source-checkout",
    label: "source checkout",
    packageRoot,
    plan: "source",
    guidance: ["Upgrade this source checkout by refreshing dependencies and rebuilding it."],
  };
}

function guidanceInstall(
  kind: InstallMethodKind,
  label: string,
  guidance: string[],
  packageRoot?: string,
): InstallMethod {
  return { kind, label, packageRoot, plan: "guidance", guidance };
}

function managerGuidance(
  kind: InstallMethodKind,
  label: string,
  guidance: string,
  packageRoot?: string,
): InstallMethod {
  return guidanceInstall(kind, label, [
    guidance,
    "agentmemory upgrade will not mutate package-manager or plugin cache directories directly.",
  ], packageRoot);
}

function findNearestPackageRoot(start: string, fs: InstallMethodFs): string | undefined {
  let current = resolve(start);
  const root = parse(current).root;

  while (true) {
    const packageJson = join(current, "package.json");
    if (fs.existsSync(packageJson) && readPackageName(packageJson, fs) === AGENTMEMORY_PACKAGE_NAME) {
      return current;
    }
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function isAgentmemorySourceCheckout(root: string, fs: InstallMethodFs): boolean {
  return (
    readPackageName(join(root, "package.json"), fs) === AGENTMEMORY_PACKAGE_NAME &&
    fs.existsSync(join(root, "src", "cli.ts")) &&
    fs.existsSync(join(root, "tsconfig.json"))
  );
}

function readPackageName(path: string, fs: InstallMethodFs): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path, "utf-8")) as PackageJson;
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function isGlobalNpmInstall(
  packageRoot: string | undefined,
  trace: string,
  env: Record<string, string | undefined>,
): packageRoot is string {
  if (!packageRoot || !hasPathFragment(trace, ["node_modules", "@agentmemory", "agentmemory"])) {
    return false;
  }
  if (env["npm_config_global"] === "true") return true;

  const prefix = env["npm_config_prefix"];
  if (prefix && normalizeForMatch(packageRoot).startsWith(normalizeForMatch(prefix))) {
    return true;
  }

  return (
    hasPathFragment(trace, ["lib", "node_modules", "@agentmemory", "agentmemory"]) ||
    hasPathFragment(trace, ["npm", "node_modules", "@agentmemory", "agentmemory"]) ||
    hasPathFragment(trace, ["nodejs", "node_modules", "@agentmemory", "agentmemory"])
  );
}

function isDocker(env: Record<string, string | undefined>, fs: InstallMethodFs): boolean {
  return (
    env["AGENTMEMORY_DOCKER"] === "1" ||
    env["DOCKER_CONTAINER"] === "1" ||
    env["KUBERNETES_SERVICE_HOST"] !== undefined ||
    fs.existsSync("/.dockerenv")
  );
}

function realpathOrNormalize(path: string, fs: InstallMethodFs): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return normalize(path);
  }
}

function buildTrace(paths: Array<string | undefined>): string {
  return paths.filter((path): path is string => !!path).map(normalizeForMatch).join("\n");
}

function hasPathFragment(trace: string, parts: string[]): boolean {
  return trace.includes(parts.map(escapeSegment).join("/"));
}

function hasSegment(trace: string, segment: string): boolean {
  return trace.split(/[/:]+/).includes(segment.toLowerCase());
}

function normalizeForMatch(path: string): string {
  return normalize(path).replaceAll(sep, "/").toLowerCase();
}

function escapeSegment(segment: string): string {
  return segment.toLowerCase();
}
