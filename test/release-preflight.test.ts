import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");

describe("release preflight", () => {
  it("is wired as the release gate script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");

    expect(pkg.scripts["release:preflight"]).toBe(
      "node scripts/release-preflight.mjs",
    );
    expect(pkg.scripts["release:preflight:arena"]).toBe(
      "node scripts/release-preflight.mjs --with-retrieval-arena",
    );
    expect(pkg.scripts["bench:retrieval-smoke"]).toBe(
      "node --import tsx benchmark/retrieval-arena-smoke.ts",
    );
    expect(existsSync(scriptPath)).toBe(true);

    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("assertVersionLockstep(summary)");
    expect(script).toContain("assertDistributionMetadata(summary)");
    expect(script).toContain("validateDistributionMetadata");
    expect(script).toContain("assertCleanTree");
    expect(script).toContain('"build"');
    expect(script).toContain('"tests"');
    expect(script).toContain('"skills check"');
    expect(script).toContain('"pack smoke"');
    expect(script).toContain("temp install smoke");
    expect(script).toContain("temp install dependency tree smoke");
    expect(script).toContain("npm ls @agentmemory/agentmemory iii-sdk @opentelemetry/*");
    expect(script).toContain("iii-sdk registerWorker missing");
    expect(script).toContain("missing iii-sdk type");
    expect(script).toContain("sdk-logs compatibility missing addLogRecordProcessor");
    expect(script).toContain("AGENTMEMORY_PREFLIGHT_SKIP_TEMP_INSTALL");
    expect(script).toContain("AGENTMEMORY_PREFLIGHT_RETRIEVAL_ARENA");
    expect(script).toContain("--with-retrieval-arena");
    expect(script).toContain("RELEASE_PREFLIGHT_SUMMARY_JSON");
    expect(script).toContain("AGENTMEMORY_PREFLIGHT_SUMMARY_PATH");
    expect(script).toContain("version lockstep check crashed");
    expect(script).toContain("encryptionReadiness");
    expect(script).toContain("targeted encryption/export tests");
    expect(script).toContain("packaging/mcpb/manifest.json");
    expect(script).toContain("packaging/homebrew/agentmemory.rb.template");
    expect(script).toContain("packaging/vscode-extension/package.json");
    expect(script).toContain("smithery.yaml");
  });

  it("keeps the build asset copy cross-platform", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    expect(pkg.scripts.build).toContain("node scripts/copy-build-assets.mjs");
    expect(pkg.scripts.build).not.toContain("cp ");
    expect(pkg.scripts.build).not.toContain("mkdir -p");
    expect(existsSync(join(ROOT, "scripts", "copy-build-assets.mjs"))).toBe(true);
  });

  it("derives blocked release-gate checks after an earlier failure", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
    });

    summary.steps.build = {
      status: "fail",
      label: "build",
      evidence: [],
      failures: ["build exited 1"],
      blockers: [],
      exitCode: 1,
    };
    preflight.blockSteps(
      summary,
      ["test", "docs", "packSmoke", "retrievalArena", "finalCleanTree"],
      "build failed",
    );

    const releaseGate = preflight.deriveReleaseGate(summary, { root: ROOT });

    expect(releaseGate.build.status).toBe("fail");
    expect(releaseGate.distributionMetadata.status).toBe("not_run");
    expect(releaseGate.test.status).toBe("blocked");
    expect(releaseGate.docs.status).toBe("blocked");
    expect(releaseGate.packSmoke.status).toBe("blocked");
    expect(releaseGate.redactionForget.status).toBe("blocked");
    expect(releaseGate.retrievalScope.status).toBe("blocked");
    expect(releaseGate.retrievalArena.status).toBe("blocked");
    expect(releaseGate.retrievalArena.optional).toBe(true);
    expect(releaseGate.restMcpParity.status).toBe("blocked");
    expect(releaseGate.encryptionReadiness.status).toBe("pass");
    expect(releaseGate.encryptionReadiness.optional).toBe(true);
  });

  it("keeps targeted quality lanes not_run when evidence files are absent", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
    });
    summary.steps.test = {
      status: "pass",
      label: "tests",
      evidence: ["npm test"],
      failures: [],
      blockers: [],
      exitCode: null,
    };

    const releaseGate = preflight.deriveReleaseGate(summary, {
      root: ROOT,
      fileExists: () => false,
    });

    expect(releaseGate.redactionForget.status).toBe("not_run");
    expect(releaseGate.retrievalScope.status).toBe("not_run");
    expect(releaseGate.retrievalArena.status).toBe("not_run");
    expect(releaseGate.retrievalArena.optional).toBe(true);
    expect(releaseGate.retrievalArena.warnings[0]).toContain(
      "Retrieval Arena smoke is optional",
    );
    expect(releaseGate.restMcpParity.status).toBe("not_run");
    expect(releaseGate.encryptionReadiness.status).toBe("not_run");
    expect(releaseGate.encryptionReadiness.optional).toBe(true);
    expect(releaseGate.encryptionReadiness.warnings[0]).toContain(
      "targeted encryption/export tests",
    );
  });

  it("does not make skipped optional Retrieval Arena block a complete default gate", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
      retrievalArenaEnabled: false,
    });
    for (const key of [
      "distributionMetadata",
      "build",
      "test",
      "docs",
      "packSmoke",
    ]) {
      summary.steps[key] = {
        status: "pass",
        label: key,
        optional: false,
        evidence: [key],
        failures: [],
        blockers: [],
        warnings: [],
        exitCode: null,
      };
    }

    const releaseGate = preflight.deriveReleaseGate(summary, {
      root: ROOT,
      fileExists: () => true,
    });

    expect(releaseGate.retrievalArena.status).toBe("not_run");
    expect(releaseGate.retrievalArena.optional).toBe(true);
    expect(releaseGate.encryptionReadiness.status).toBe("pass");
    expect(releaseGate.encryptionReadiness.optional).toBe(true);
    expect(releaseGate.encryptionReadiness.evidence).toEqual([
      "src/security/encryption.ts",
      "src/security/encryption-policy.ts",
      "src/state/encrypted-kv.ts",
      "src/state/encryption-runtime.ts",
      "src/functions/export-import.ts",
      "test/encryption.test.ts",
      "test/encryption-policy.test.ts",
      "test/encryption-runtime.test.ts",
      "test/export-import.test.ts",
    ]);
    expect(releaseGate.encryptionReadiness.warnings).toEqual([
      "Encryption readiness still depends on running the targeted encryption/export tests in this checkout.",
    ]);
    expect(preflight.releaseGateOverallForPreflight(releaseGate)).toBe("pass");
  });

  it("prints the non-gating encryption readiness warning in the release report", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
      retrievalArenaEnabled: false,
    });
    for (const key of [
      "distributionMetadata",
      "build",
      "test",
      "docs",
      "packSmoke",
    ]) {
      summary.steps[key] = {
        status: "pass",
        label: key,
        optional: false,
        evidence: [key],
        failures: [],
        blockers: [],
        warnings: [],
        exitCode: null,
      };
    }
    preflight.deriveReleaseGate(summary, {
      root: ROOT,
      fileExists: () => true,
    });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    };
    try {
      preflight.printPreflightReport(summary);
    } finally {
      console.log = originalLog;
    }

    expect(lines).toContain(
      "  encryptionReadiness: pass optional - encryption readiness evidence",
    );
    expect(lines).toContain(
      "    warning: Encryption readiness still depends on running the targeted encryption/export tests in this checkout.",
    );
  });

  it("validates MCP registry distribution metadata before release", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const mcpPkg = JSON.parse(
      readFileSync(join(ROOT, "packages", "mcp", "package.json"), "utf8"),
    );
    const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));

    expect(pkg.mcpName).toBe("io.github.rohitg00/agentmemory");
    expect(mcpPkg.mcpName).toBe(pkg.mcpName);
    expect(pkg.files).toContain("server.json");
    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);

    const npmPackage = server.packages.find(
      (entry: { identifier?: string }) => entry.identifier === "@agentmemory/mcp",
    );
    expect(npmPackage).toBeTruthy();
    expect(npmPackage.registryType).toBe("npm");
    expect(npmPackage.version).toBe(mcpPkg.version);
    expect(npmPackage.transport).toEqual({ type: "stdio" });
    expect(
      npmPackage.environmentVariables.map((item: { name: string }) => item.name),
    ).toEqual(["AGENTMEMORY_URL", "AGENTMEMORY_SECRET"]);
  });

  it("validates all distribution packaging metadata without publish credentials", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const result = preflight.validateDistributionMetadata();

    expect(result.failures).toEqual([]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        "server.json",
        "package.json",
        "packages/mcp/package.json",
        "packaging/mcpb/manifest.json",
        "packaging/mcpb/README.md",
        "smithery.yaml",
        "packaging/homebrew/agentmemory.rb.template",
        "packaging/homebrew/README.md",
        "packaging/vscode-extension/package.json",
        "packaging/vscode-extension/extension.js",
        "packaging/vscode-extension/README.md",
        "vendor/iii-sdk-compat/package.json",
      ]),
    );

    const iiiSdk = JSON.parse(
      readFileSync(join(ROOT, "vendor", "iii-sdk-compat", "package.json"), "utf8"),
    );
    for (const typePath of [
      iiiSdk.exports["."].types,
      iiiSdk.exports["./stream"].types,
      iiiSdk.exports["./state"].types,
      iiiSdk.exports["./telemetry"].types,
    ]) {
      expect(existsSync(join(ROOT, "vendor", "iii-sdk-compat", typePath))).toBe(
        true,
      );
    }

    const script = readFileSync(scriptPath, "utf8");
    expect(script).not.toMatch(
      /process\.env\.(NPM_TOKEN|NODE_AUTH_TOKEN|SMITHERY_TOKEN|SMITHERY_API_KEY|HOMEBREW_GITHUB_API_TOKEN|VSCE_PAT|AZURE_DEVOPS_EXT_PAT)/,
    );
  });

  it("parses npm pack json output for temp install smoke", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);

    expect(
      preflight.parseNpmPackFilename(
        JSON.stringify([{ filename: "agentmemory-agentmemory-0.9.27.tgz" }]),
      ),
    ).toBe("agentmemory-agentmemory-0.9.27.tgz");
    expect(
      preflight.parseNpmPackFilename(
        [
          "> @agentmemory/agentmemory@0.9.28 prepack",
          "> node scripts/prepare-bundled-deps.mjs",
          JSON.stringify([{ filename: "agentmemory-agentmemory-0.9.28.tgz" }]),
        ].join("\n"),
      ),
    ).toBe("agentmemory-agentmemory-0.9.28.tgz");
    expect(preflight.parseNpmPackFilename("not json")).toBeNull();
  });

  it("resolves npm pack tarball filenames without double-joining absolutes", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const relative = "agentmemory-agentmemory-0.9.27.tgz";
    const absolute = join(ROOT, relative);

    expect(preflight.resolvePackTarballPath(relative, ROOT)).toBe(absolute);
    expect(preflight.resolvePackTarballPath(absolute, ROOT)).toBe(absolute);
    expect(readFileSync(scriptPath, "utf8")).toContain("pathToFileURL(localTarballPath).href");
  });

  it("uses the Windows cmd shim only for batch command wrappers", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);

    expect(preflight.needsCmdShim("npm.cmd", "win32")).toBe(true);
    expect(preflight.needsCmdShim("npm", "linux")).toBe(false);
    expect(preflight.needsCmdShim("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(preflight.needsCmdShim("git.exe", "win32")).toBe(false);
  });

  it("fails the success path when a targeted-evidence file is missing", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
      retrievalArenaEnabled: false,
    });
    for (const key of [
      "versionLockstep",
      "distributionMetadata",
      "initialCleanTree",
      "build",
      "test",
      "docs",
      "packSmoke",
      "finalCleanTree",
    ]) {
      summary.steps[key] = {
        status: "pass",
        label: key,
        optional: false,
        evidence: [key],
        failures: [],
        blockers: [],
        warnings: [],
        exitCode: null,
      };
    }

    const missingTargeted = "remember-forget-audit.test.ts";
    const fileExists = (path: string) =>
      !path.replace(/\\/g, "/").endsWith(missingTargeted);

    const previousExitCode = process.exitCode;
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    let returnedExit: number | undefined;
    try {
      returnedExit = preflight.finish(summary, "pass", 0, {
        root: ROOT,
        fileExists,
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    // A missing targeted-evidence file leaves the gate not_run, which must not
    // report success: status flips to fail and the process exits non-zero.
    expect(summary.releaseGate.redactionForget.status).toBe("not_run");
    expect(
      preflight.releaseGateOverallForPreflight(summary.releaseGate),
    ).toBe("not_run");
    expect(summary.status).toBe("fail");
    expect(returnedExit).not.toBe(0);
    expect(process.exitCode).not.toBe(0);

    process.exitCode = previousExitCode;
  });

  it("keeps a passing gate exiting zero through finish", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);
    const summary = preflight.createPreflightSummary({
      allowDirty: false,
      startedAt: "2026-06-28T00:00:00.000Z",
      retrievalArenaEnabled: false,
    });
    for (const key of [
      "versionLockstep",
      "distributionMetadata",
      "initialCleanTree",
      "build",
      "test",
      "docs",
      "packSmoke",
      "finalCleanTree",
    ]) {
      summary.steps[key] = {
        status: "pass",
        label: key,
        optional: false,
        evidence: [key],
        failures: [],
        blockers: [],
        warnings: [],
        exitCode: null,
      };
    }

    const previousExitCode = process.exitCode;
    const originalLog = console.log;
    console.log = () => {};
    let returnedExit: number | undefined;
    try {
      returnedExit = preflight.finish(summary, "pass", 0, {
        root: ROOT,
        fileExists: () => true,
      });
    } finally {
      console.log = originalLog;
    }

    expect(preflight.releaseGateOverallForPreflight(summary.releaseGate)).toBe(
      "pass",
    );
    expect(summary.status).toBe("pass");
    expect(returnedExit).toBe(0);

    process.exitCode = previousExitCode;
  });

  it("asserts the Homebrew formula ships dist/cli.mjs from a prebuilt tarball", async () => {
    const scriptPath = join(ROOT, "scripts", "release-preflight.mjs");
    const preflight = await import(pathToFileURL(scriptPath).href);

    const result = preflight.validateDistributionMetadata();
    expect(result.failures).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    // The formula symlinks libexec/"dist/cli.mjs"; the npm-pack tarball must
    // actually ship that path (dist/ is gitignored, so a source tarball would
    // not contain it).
    expect(pkg.bin.agentmemory).toBe("dist/cli.mjs");
    expect(pkg.files).toContain("dist/");

    const formula = readFileSync(
      join(ROOT, "packaging", "homebrew", "agentmemory.rb.template"),
      "utf8",
    );
    const readme = readFileSync(
      join(ROOT, "packaging", "homebrew", "README.md"),
      "utf8",
    );
    expect(formula).toContain('libexec/"dist/cli.mjs"');
    expect(formula).toContain("prebuilt artifact");
    expect(readme).toContain("prebuilt artifact");
    expect(readme).toContain("dist/cli.mjs");
  });
});
