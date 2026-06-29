import { platform } from "node:os";
import type {
  ConnectAdapter,
  ConnectInspection,
  ConnectOptions,
  ConnectResult,
} from "./types.js";
import { createConnectRunMetadata, type ConnectRunMetadata } from "./util.js";

export type ConnectRepairPlanItem = {
  agent: string;
  displayName: string;
  status: ConnectInspection["status"];
  configPath?: string;
  action: "repair" | "skip";
  reason: string;
  force: boolean;
};

export type ConnectRepairOptions = {
  force: boolean;
  withHooks: boolean;
  isWindows?: boolean;
};

export type AppliedConnectRepairResult = {
  agent: string;
  action: "repair" | "skip";
  reason?: string;
  result?: ConnectResult;
};

export type ConnectRepairRunner = (
  adapter: ConnectAdapter,
  opts: ConnectOptions,
  run: ConnectRunMetadata,
) => Promise<ConnectResult>;

function repairForce(
  inspection: ConnectInspection,
  opts: ConnectRepairOptions,
): boolean {
  return (
    opts.force ||
    inspection.status === "stale" ||
    inspection.status === "invalid-config"
  );
}

export function buildConnectRepairPlan(
  inspections: ConnectInspection[],
  opts: ConnectRepairOptions,
): ConnectRepairPlanItem[] {
  const isWindows = opts.isWindows ?? platform() === "win32";
  return inspections.map((inspection) => {
    const base = {
      agent: inspection.agent,
      displayName: inspection.displayName,
      status: inspection.status,
      ...(inspection.configPath !== undefined && {
        configPath: inspection.configPath,
      }),
      force: repairForce(inspection, opts),
    };

    if (inspection.status === "not-detected") {
      return {
        ...base,
        action: "skip" as const,
        reason: "agent-not-detected",
      };
    }
    if (inspection.status === "manual-only") {
      return {
        ...base,
        action: "skip" as const,
        reason: "manual-only",
      };
    }
    if (inspection.status === "healthy" && !opts.force) {
      return {
        ...base,
        action: "skip" as const,
        reason: "already-healthy",
      };
    }
    if (!inspection.repairSafe) {
      return {
        ...base,
        action: "skip" as const,
        reason: "repair-not-safe",
      };
    }
    if (isWindows && !inspection.windowsSafe) {
      return {
        ...base,
        action: "skip" as const,
        reason: "windows-repair-not-enabled",
      };
    }
    return {
      ...base,
      action: "repair" as const,
      reason:
        inspection.status === "healthy"
          ? "force-refresh"
          : `repair-${inspection.status}`,
    };
  });
}

export async function applyConnectRepairPlan(
  plan: ConnectRepairPlanItem[],
  adapters: readonly ConnectAdapter[],
  opts: Pick<ConnectOptions, "dryRun" | "withHooks">,
  runner: ConnectRepairRunner,
  run: ConnectRunMetadata = createConnectRunMetadata(),
): Promise<AppliedConnectRepairResult[]> {
  const results: AppliedConnectRepairResult[] = [];
  for (const item of plan) {
    if (item.action === "skip") {
      results.push({
        agent: item.agent,
        action: "skip",
        reason: item.reason,
      });
      continue;
    }
    const adapter = adapters.find((candidate) => candidate.name === item.agent);
    if (!adapter) {
      results.push({
        agent: item.agent,
        action: "skip",
        reason: "adapter-not-found",
      });
      continue;
    }
    if (opts.dryRun) {
      results.push({
        agent: item.agent,
        action: "skip",
        reason: "dry-run",
      });
      continue;
    }
    const result = await runner(
      adapter,
      {
        dryRun: false,
        force: item.force,
        withHooks: opts.withHooks,
      },
      run,
    );
    results.push({ agent: item.agent, action: "repair", result });
  }
  return results;
}

export function formatConnectRepairPlan(plan: ConnectRepairPlanItem[]): string {
  if (plan.length === 0) return "  No adapters selected.";
  return plan
    .map((item, index) => {
      const target = item.configPath ? ` → ${item.configPath}` : "";
      if (item.action === "repair") {
        const force = item.force ? " with force" : "";
        return `  ${index + 1}. repair ${item.agent}${target}${force} (${item.reason})`;
      }
      return `  ${index + 1}. skip ${item.agent}${target} (${item.reason})`;
    })
    .join("\n");
}
