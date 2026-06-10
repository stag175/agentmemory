import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTMEMORY_PACKAGE_NAME = "@agentmemory/agentmemory";

export type InstallMode = "local-dev" | "npx" | "global";

export interface NpxSignals {
  argv1: string;
  npmLifecycleEvent: string | undefined;
  npmUserAgent: string | undefined;
}

export interface InstallModeInputs extends NpxSignals {
  cwdPackageName: string | null;
}

export function isNpxInvocation(signals: NpxSignals): boolean {
  if (signals.npmLifecycleEvent === "npx") return true;
  if (signals.argv1.includes("_npx")) return true;
  const ua = signals.npmUserAgent ?? "";
  if (ua.startsWith("npm/") || ua.includes(" npm/")) return true;
  return false;
}

export function detectInstallMode(inputs: InstallModeInputs): InstallMode {
  if (inputs.cwdPackageName === AGENTMEMORY_PACKAGE_NAME) return "local-dev";
  if (isNpxInvocation(inputs)) return "npx";
  return "global";
}

export function readCwdPackageName(cwd: string): string | null {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const name = parsed["name"];
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}
