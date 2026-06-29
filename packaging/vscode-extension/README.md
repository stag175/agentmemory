# agentmemory VS Code Extension

This package is the roadmap slice for a VS Code control plane over an installed `agentmemory` CLI and a local daemon.

## Commands

- `Agentmemory: Status` runs `agentmemory status`.
- `Agentmemory: Doctor` runs `agentmemory doctor --dry-run` so diagnostics are visible without starting an interactive fixer.
- `Agentmemory: Connect Repair` runs `agentmemory connect repair`.
- `Agentmemory: Open Local Viewer` opens the configured viewer URL, defaulting to `http://localhost:3113`.

## Configuration

- `agentmemory.cliCommand`: command name for the installed CLI. The default is `agentmemory` and expects it to be on `PATH`.
- `agentmemory.viewerUrl`: local viewer URL. `AGENTMEMORY_VIEWER_URL` takes precedence when set.

The extension uses Node's `spawn` API and fixed argument arrays. On Windows it routes through `ComSpec` or `cmd.exe` so PATH-installed `.cmd` shims resolve without hardcoded absolute paths.
