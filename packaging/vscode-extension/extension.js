import { spawn } from "node:child_process";

export const DEFAULT_CLI_COMMAND = "agentmemory";
export const DEFAULT_VIEWER_URL = "http://localhost:3113";

export const commandDefinitions = Object.freeze([
  {
    id: "agentmemory.status",
    label: "Status",
    kind: "cli",
    cliArgs: Object.freeze(["status"]),
  },
  {
    id: "agentmemory.doctor",
    label: "Doctor",
    kind: "cli",
    cliArgs: Object.freeze(["doctor", "--dry-run"]),
  },
  {
    id: "agentmemory.connectRepair",
    label: "Connect Repair",
    kind: "cli",
    cliArgs: Object.freeze(["connect", "repair"]),
  },
  {
    id: "agentmemory.openViewer",
    label: "Open Local Viewer",
    kind: "viewer",
  },
]);

export const commandIds = Object.freeze(commandDefinitions.map((command) => command.id));

const WINDOWS_META_CHARS = /[&|<>^%!"]/;
const UNQUOTED_WINDOWS_TOKEN = /^[A-Za-z0-9_.:/\\@+-]+$/;

export async function activate(context) {
  const vscode = await import("vscode");
  const disposables = commandDefinitions.map((definition) =>
    vscode.commands.registerCommand(definition.id, async () => {
      if (definition.kind === "viewer") {
        await openViewer(vscode);
        return;
      }
      await runAgentmemoryCommand(vscode, definition);
    }),
  );
  context.subscriptions.push(...disposables);
}

export function deactivate() {}

export function validateCliCommand(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return DEFAULT_CLI_COMMAND;
  if (WINDOWS_META_CHARS.test(trimmed) || /[\r\n]/.test(trimmed)) {
    throw new Error("agentmemory.cliCommand must be a command or path without shell metacharacters");
  }
  return trimmed;
}

export function buildCliInvocation(
  cliCommand,
  cliArgs,
  platform = process.platform,
  env = process.env,
) {
  const command = validateCliCommand(cliCommand);
  const args = [...cliArgs];
  if (platform === "win32") {
    const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", toWindowsCommandLine([command, ...args])],
    };
  }
  return { command, args };
}

export function resolveViewerUrl(vscode, env = process.env) {
  const envUrl = String(env.AGENTMEMORY_VIEWER_URL || "").trim();
  if (envUrl) return trimTrailingSlashes(envUrl);
  const configured = vscode.workspace
    .getConfiguration("agentmemory")
    .get("viewerUrl", DEFAULT_VIEWER_URL);
  return trimTrailingSlashes(configured || DEFAULT_VIEWER_URL);
}

export async function openViewer(vscode) {
  const url = resolveViewerUrl(vscode);
  let uri;
  try {
    uri = vscode.Uri.parse(url);
    if (uri.scheme !== "http" && uri.scheme !== "https") {
      throw new Error("Viewer URL must use http or https");
    }
  } catch (err) {
    await vscode.window.showErrorMessage(
      err instanceof Error ? err.message : `Invalid viewer URL: ${url}`,
    );
    return;
  }
  await vscode.env.openExternal(uri);
}

export async function runAgentmemoryCommand(vscode, definition) {
  const output = vscode.window.createOutputChannel("agentmemory");
  output.show(true);

  let invocation;
  let displayCommand;
  try {
    const cliCommand = validateCliCommand(
      vscode.workspace.getConfiguration("agentmemory").get("cliCommand", DEFAULT_CLI_COMMAND),
    );
    invocation = buildCliInvocation(cliCommand, definition.cliArgs);
    displayCommand = formatDisplayCommand(cliCommand, definition.cliArgs);
  } catch (err) {
    await vscode.window.showErrorMessage(
      err instanceof Error ? err.message : "Invalid agentmemory CLI command",
    );
    return;
  }

  output.appendLine(`$ ${displayCommand}`);

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  await new Promise((resolve) => {
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => output.append(String(chunk)));
    child.stderr?.on("data", (chunk) => output.append(String(chunk)));
    child.on("error", async (err) => {
      output.appendLine(`\n${err.message}`);
      await vscode.window.showErrorMessage(`agentmemory ${definition.label} failed: ${err.message}`);
      resolve(undefined);
    });
    child.on("close", async (code) => {
      if (code === 0) {
        output.appendLine(`\nagentmemory ${definition.label} completed.`);
      } else {
        output.appendLine(`\nagentmemory ${definition.label} exited with code ${code ?? "unknown"}.`);
        await vscode.window.showErrorMessage(
          `agentmemory ${definition.label} exited with code ${code ?? "unknown"}`,
        );
      }
      resolve(undefined);
    });
  });
}

function toWindowsCommandLine(parts) {
  return parts.map(quoteWindowsToken).join(" ");
}

function quoteWindowsToken(part) {
  const value = String(part);
  if (WINDOWS_META_CHARS.test(value) || /[\r\n]/.test(value)) {
    throw new Error("agentmemory command arguments must not contain shell metacharacters");
  }
  if (UNQUOTED_WINDOWS_TOKEN.test(value)) return value;
  return `"${value}"`;
}

function trimTrailingSlashes(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function formatDisplayCommand(command, args) {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}
