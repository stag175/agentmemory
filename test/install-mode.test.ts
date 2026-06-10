import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AGENTMEMORY_PACKAGE_NAME,
  detectInstallMode,
  isNpxInvocation,
  readCwdPackageName,
  type InstallModeInputs,
} from "../src/cli/install-mode.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function inputs(overrides: Partial<InstallModeInputs> = {}): InstallModeInputs {
  return {
    cwdPackageName: null,
    argv1: "/usr/local/lib/node_modules/@agentmemory/agentmemory/dist/cli.mjs",
    npmLifecycleEvent: undefined,
    npmUserAgent: undefined,
    ...overrides,
  };
}

describe("isNpxInvocation", () => {
  it("detects npm_lifecycle_event=npx", () => {
    expect(isNpxInvocation(inputs({ npmLifecycleEvent: "npx" }))).toBe(true);
  });

  it("detects _npx cache paths in argv1", () => {
    const argv1 = "/Users/x/.npm/_npx/abc123/node_modules/.bin/agentmemory";
    expect(isNpxInvocation(inputs({ argv1 }))).toBe(true);
  });

  it("detects an npm user agent prefix", () => {
    expect(isNpxInvocation(inputs({ npmUserAgent: "npm/10.8.2 node/v22.0.0 darwin arm64" }))).toBe(true);
  });

  it("detects npm embedded mid user agent", () => {
    expect(isNpxInvocation(inputs({ npmUserAgent: "workspaces/false npm/10.8.2" }))).toBe(true);
  });

  it("flags pnpm user agents that embed npm/?", () => {
    expect(isNpxInvocation(inputs({ npmUserAgent: "pnpm/9.0.0 npm/? node/v22.0.0" }))).toBe(true);
  });

  it("returns false for a user agent without npm", () => {
    expect(isNpxInvocation(inputs({ npmUserAgent: "bun/1.2.0 node/v22.0.0 darwin arm64" }))).toBe(false);
  });

  it("returns false with no npx signals", () => {
    expect(isNpxInvocation(inputs())).toBe(false);
  });
});

describe("detectInstallMode", () => {
  it("local-dev when the cwd package.json names the agentmemory package", () => {
    const mode = detectInstallMode(inputs({ cwdPackageName: AGENTMEMORY_PACKAGE_NAME }));
    expect(mode).toBe("local-dev");
  });

  it("local-dev wins even when npx signals are present", () => {
    const mode = detectInstallMode(
      inputs({
        cwdPackageName: AGENTMEMORY_PACKAGE_NAME,
        npmLifecycleEvent: "npx",
        npmUserAgent: "npm/10.8.2 node/v22.0.0 darwin arm64",
      }),
    );
    expect(mode).toBe("local-dev");
  });

  it("npx when the cwd package is a foreign project and npx signals are present", () => {
    const mode = detectInstallMode(
      inputs({ cwdPackageName: "some-users-app", npmLifecycleEvent: "npx" }),
    );
    expect(mode).toBe("npx");
  });

  it("npx when the cwd has no package.json and npx signals are present", () => {
    const mode = detectInstallMode(
      inputs({ argv1: "/Users/x/.npm/_npx/abc123/node_modules/.bin/agentmemory" }),
    );
    expect(mode).toBe("npx");
  });

  it("global when the cwd package is a foreign project and no npx signals", () => {
    expect(detectInstallMode(inputs({ cwdPackageName: "some-users-app" }))).toBe("global");
  });

  it("global when the cwd has no package.json and no npx signals", () => {
    expect(detectInstallMode(inputs())).toBe("global");
  });
});

describe("readCwdPackageName", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agentmemory-install-mode-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns the package name when present", () => {
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(readCwdPackageName(sandbox)).toBe("my-app");
  });

  it("returns null when package.json is missing", () => {
    expect(readCwdPackageName(sandbox)).toBe(null);
  });

  it("returns null on malformed JSON", () => {
    writeFileSync(join(sandbox, "package.json"), "{not json");
    expect(readCwdPackageName(sandbox)).toBe(null);
  });

  it("returns null when name is not a string", () => {
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ name: 42 }));
    expect(readCwdPackageName(sandbox)).toBe(null);
  });

  it("returns null when the manifest is a JSON array", () => {
    writeFileSync(join(sandbox, "package.json"), "[]");
    expect(readCwdPackageName(sandbox)).toBe(null);
  });
});
