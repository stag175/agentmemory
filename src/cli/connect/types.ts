export type ConnectOptions = {
  dryRun: boolean;
  force: boolean;
  /**
   * When true, the Codex adapter additionally writes a global
   * `~/.codex/hooks.json` block referencing absolute paths to bundled hook
   * scripts. Workaround for openai/codex#16430, which prevents plugin-local
   * hooks from dispatching on Codex Desktop. No-op for other adapters.
   */
  withHooks?: boolean;
};

export type ConnectInspectionStatus =
  | "not-detected"
  | "missing"
  | "healthy"
  | "stale"
  | "invalid-config"
  | "manual-only";

export type ConnectInspection = {
  agent: string;
  displayName: string;
  status: ConnectInspectionStatus;
  configPath?: string;
  expectedMutation: string;
  windowsSafe: boolean;
  repairSafe: boolean;
  reason: string;
};

export type ConnectTargetMutation = {
  target: string;
  backupPath?: string;
  label?: string;
  previousExists?: boolean;
};

export type ConnectAdapter = {
  name: string;
  displayName: string;
  docs?: string;
  /**
   * One-line explanation of which protocol this adapter wires (REST hooks vs
   * MCP) and why. Printed above the install summary so users see — before
   * any config mutation — that REST is the primary surface and MCP is the
   * opt-in bridge for MCP-only clients.
   */
  protocolNote?: string;
  /**
   * Integration style, used by onboarding to group agents. "native" =
   * ships a first-party plugin / lifecycle hooks; "mcp" = wires the MCP
   * server only. Declared on the adapter so the picker never needs a
   * separate hardcoded list (#872). Defaults to "mcp" when omitted.
   */
  category?: "native" | "mcp";
  detect(): boolean;
  inspect?(): ConnectInspection;
  install(opts: ConnectOptions): Promise<ConnectResult>;
};

export type ConnectManifestAction = "created" | "updated" | "already-wired";
export type ConnectRollbackAction = "restore-backup" | "remove-created-target" | "none";

export type ConnectManifestEntry = {
  agent?: string;
  displayName?: string;
  target: string;
  backupPath?: string;
  timestamp?: string;
  runId?: string;
  action?: ConnectManifestAction;
  rollback?: ConnectRollbackAction;
  label?: string;
  symlink?: boolean;
  metadata?: {
    force?: boolean;
    withHooks?: boolean;
    previousExists?: boolean;
    resultKind?: ConnectResult["kind"];
  } & Record<string, unknown>;
  rolledBackAt?: string;
  rollbackStatus?: "restored" | "removed" | "skipped" | "failed";
};

export type ConnectManifest = {
  version?: number;
  updatedAt?: string;
  installed: ConnectManifestEntry[];
  history?: ConnectManifestEntry[];
};

export type ConnectResult =
  | {
      kind: "installed";
      mutatedPath?: string;
      backupPath?: string;
      targets?: ConnectTargetMutation[];
    }
  | { kind: "already-wired"; mutatedPath?: string }
  | { kind: "stub"; reason: string }
  | { kind: "skipped"; reason: string };
