import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Q3 2026 roadmap: per-tool-call capture in the Hermes provider
// (parity with the OpenClaw plugin surface). Drives the Python plugin
// the same way integration-plaintext-http.test.ts does: load the
// module with importlib, stub its network functions, assert on the
// recorded /observe payloads.

const PRELUDE = String.raw`
import importlib.util
import os
import re

spec = importlib.util.spec_from_file_location("agentmemory_hermes", "integrations/hermes/__init__.py")
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

for key in ("AGENTMEMORY_SECRET", "AGENTMEMORY_REQUIRE_HTTPS"):
    os.environ.pop(key, None)

fg_calls = []
bg_calls = []

def record_fg(base, path, body=None, method="POST", secret=""):
    fg_calls.append((path, body))
    return None

def record_bg(base, path, body=None):
    bg_calls.append((path, body))

mod._api = record_fg
mod._api_bg = record_bg

provider = mod.AgentMemoryProvider()
provider.initialize("ses_test", cwd="/tmp/project")
`;

function runPython(script: string, home: string) {
  return spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

describe("Hermes per-tool-call capture (on_post_tool_use)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentmemory-hermes-tool-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("posts a per-tool observe payload in the background", () => {
    const script =
      PRELUDE +
      String.raw`
# initialize() posts session/start in the foreground with the
# telemetry stamping the native hooks use.
assert fg_calls and fg_calls[0][0] == "session/start", fg_calls
assert fg_calls[0][1]["sessionId"] == "ses_test", fg_calls
assert fg_calls[0][1]["captureSource"] == "automatic_hook", fg_calls
assert fg_calls[0][1]["hookType"] == "session_start", fg_calls

provider.on_post_tool_use("Bash", {"command": "ls"}, "file1\nfile2")
assert len(bg_calls) == 1, bg_calls
path, body = bg_calls[0]
assert path == "observe", path
assert body["hookType"] == "post_tool_use", body
assert body["sessionId"] == "ses_test", body
assert body["project"] == "/tmp/project", body
assert body["cwd"] == "/tmp/project", body
assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", body["timestamp"]), body["timestamp"]
data = body["data"]
assert data["tool_name"] == "Bash", data
assert data["tool_name"] != "conversation", data
assert data["tool_input"] == {"command": "ls"}, data
assert data["tool_output"] == "file1\nfile2", data

# Routed through the background poster, never the foreground one.
assert all(p != "observe" for p, _ in fg_calls), fg_calls

# session_id kwarg override wins over the initialized session.
provider.on_post_tool_use("Read", "x", "y", session_id="ses_override")
assert bg_calls[1][1]["sessionId"] == "ses_override", bg_calls[1]

# Empty tool name falls back to "unknown".
provider.on_post_tool_use("", "in", "out")
assert bg_calls[2][1]["data"]["tool_name"] == "unknown", bg_calls[2]
`;
    const result = runPython(script, home);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("truncates long strings and coerces non-string tool fields", () => {
    const script =
      PRELUDE +
      String.raw`
marker = "\n[...truncated]"
provider.on_post_tool_use("Bash", "a" * 3000, "b" * 10000)
data = bg_calls[0][1]["data"]
assert len(data["tool_input"]) == 2000 + len(marker), len(data["tool_input"])
assert data["tool_input"].endswith("[...truncated]"), data["tool_input"][-30:]
assert len(data["tool_output"]) == 8000 + len(marker), len(data["tool_output"])
assert data["tool_output"].endswith("[...truncated]"), data["tool_output"][-30:]

# Structured values pass through untouched; None -> "", numbers -> str.
provider.on_post_tool_use("T", ["x", "y"], None)
assert bg_calls[1][1]["data"]["tool_input"] == ["x", "y"], bg_calls[1]
assert bg_calls[1][1]["data"]["tool_output"] == "", bg_calls[1]
provider.on_post_tool_use("T", None, 42)
assert bg_calls[2][1]["data"]["tool_input"] == "", bg_calls[2]
assert bg_calls[2][1]["data"]["tool_output"] == "42", bg_calls[2]
`;
    const result = runPython(script, home);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("keeps sync_turn and on_session_end behavior unchanged", () => {
    const script =
      PRELUDE +
      String.raw`
provider.sync_turn("hi", "there")
path, body = bg_calls[-1]
assert path == "observe", path
assert body["hookType"] == "post_tool_use", body
assert body["data"]["tool_name"] == "conversation", body
assert body["data"]["tool_input"] == "hi", body
assert body["data"]["tool_output"] == "there", body

provider.on_session_end([])
path, body = fg_calls[-1]
assert path == "session/end", path
assert body["sessionId"] == "ses_test", body
assert body["captureSource"] == "automatic_hook", body
assert body["hookType"] == "session_end", body
`;
    const result = runPython(script, home);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
