// Unit tests for the doctor v2 diagnostic catalog.
//
// We exercise the data structure (every entry has check/fix/message),
// the pure parseEnvFile / realProviderKeys helpers, and the dry-run plan
// formatting. The full interactive prompt loop lives in src/cli.ts and is
// driven by clack — exercising it would require a TTY and is out of scope.

import { describe, it, expect } from "vitest";
import {
  buildDiagnoseCliPlan,
  buildDiagnostics,
  buildVersionsReport,
  DIAGNOSE_CLI_HELP,
  DIAGNOSTIC_IDS,
  dryRunPlan,
  extractReleaseGateReport,
  formatDiagnoseJson,
  formatDiagnoseText,
  formatVersionsReport,
  parseEnvFile,
  placeholderProviderKeys,
  releaseGateExitCode,
  realProviderKeys,
  type DoctorContext,
  type DoctorEffects,
} from "../src/cli/doctor-diagnostics.js";

function stubCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    baseUrl: "http://localhost:3111",
    viewerUrl: "http://localhost:3113",
    envPath: "/tmp/test/.agentmemory/.env",
    pidfilePath: "/tmp/test/.agentmemory/iii.pid",
    enginePath: "/tmp/test/.agentmemory/engine-state.json",
    pinnedVersion: "0.11.2",
    ...overrides,
  };
}

function stubEffects(overrides: Partial<DoctorEffects> = {}): DoctorEffects {
  return {
    envFileExists: () => true,
    readEnvFile: () => ({ ANTHROPIC_API_KEY: "sk-ant-real-key-value" }),
    pidfileExists: () => false,
    pidfilePidIsAlive: () => null,
    findIiiBinary: () => "/Users/test/.local/bin/iii",
    localBinIiiPath: () => "/Users/test/.local/bin/iii",
    iiiBinaryVersion: () => "0.11.2",
    viewerReachable: async () => true,
    runInit: async () => ({ ok: true, message: "wrote .env" }),
    openEditor: async () => ({ ok: true, message: "saved" }),
    runIiiInstaller: async () => ({ ok: true, message: "installed" }),
    runStop: async () => ({ ok: true, message: "stopped" }),
    runStart: async () => ({ ok: true, message: "started" }),
    clearEnginePidAndState: () => {},
    ...overrides,
  };
}

describe("doctor v2 diagnostic catalog", () => {
  it("exports a stable list of diagnostic ids", () => {
    expect(DIAGNOSTIC_IDS).toContain("env-missing");
    expect(DIAGNOSTIC_IDS).toContain("no-llm-provider-key");
    expect(DIAGNOSTIC_IDS).toContain("engine-version-mismatch");
    expect(DIAGNOSTIC_IDS).toContain("viewer-unreachable");
    expect(DIAGNOSTIC_IDS).toContain("stale-pidfile");
    expect(DIAGNOSTIC_IDS).toContain("env-placeholder-keys");
    expect(DIAGNOSTIC_IDS).toContain("iii-on-path-not-local-bin");
  });

  it("every diagnostic has check, fix, message, and fixPreview", () => {
    const diagnostics = buildDiagnostics(stubEffects());
    expect(diagnostics.length).toBe(DIAGNOSTIC_IDS.length);
    for (const d of diagnostics) {
      expect(d.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(d.message.length).toBeGreaterThan(0);
      expect(d.fixPreview.length).toBeGreaterThan(0);
      expect(d.moreInfo.length).toBeGreaterThan(0);
      expect(typeof d.check).toBe("function");
      expect(typeof d.fix).toBe("function");
    }
  });

  it("diagnostic ids are unique", () => {
    const diagnostics = buildDiagnostics(stubEffects());
    const ids = diagnostics.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("env-missing fails when env file is absent", async () => {
    const diagnostics = buildDiagnostics(stubEffects({ envFileExists: () => false }));
    const envCheck = diagnostics.find((d) => d.id === "env-missing")!;
    const status = await envCheck.check(stubCtx());
    expect(status.ok).toBe(false);
  });

  it("env-missing passes when env file exists", async () => {
    const diagnostics = buildDiagnostics(stubEffects({ envFileExists: () => true }));
    const envCheck = diagnostics.find((d) => d.id === "env-missing")!;
    const status = await envCheck.check(stubCtx());
    expect(status.ok).toBe(true);
  });

  it("no-llm-provider-key fails when env has only placeholders", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({
        envFileExists: () => true,
        readEnvFile: () => ({ ANTHROPIC_API_KEY: "your-key-here" }),
      }),
    );
    const check = diagnostics.find((d) => d.id === "no-llm-provider-key")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
  });

  it("no-llm-provider-key passes when one real key is set", async () => {
    const diagnostics = buildDiagnostics(stubEffects());
    const check = diagnostics.find((d) => d.id === "no-llm-provider-key")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(true);
  });

  it("engine-version-mismatch fails when iii reports the wrong version", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({ iiiBinaryVersion: () => "0.99.99" }),
    );
    const check = diagnostics.find((d) => d.id === "engine-version-mismatch")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
    expect(status.detail).toContain("0.99.99");
    expect(status.detail).toContain("0.11.2");
  });

  it("engine-version-mismatch passes when iii matches pinned version", async () => {
    const diagnostics = buildDiagnostics(stubEffects());
    const check = diagnostics.find((d) => d.id === "engine-version-mismatch")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(true);
  });

  it("viewer-unreachable fails when viewer probe returns false", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({ viewerReachable: async () => false }),
    );
    const check = diagnostics.find((d) => d.id === "viewer-unreachable")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
  });

  it("stale-pidfile passes when no pidfile exists", async () => {
    const diagnostics = buildDiagnostics(stubEffects({ pidfileExists: () => false }));
    const check = diagnostics.find((d) => d.id === "stale-pidfile")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(true);
  });

  it("stale-pidfile fails when pidfile points at a dead pid", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({ pidfileExists: () => true, pidfilePidIsAlive: () => false }),
    );
    const check = diagnostics.find((d) => d.id === "stale-pidfile")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
    expect(status.detail).toBe("pid is gone");
  });

  it("env-placeholder-keys detects sk-ant-... placeholder", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({
        envFileExists: () => true,
        readEnvFile: () => ({ ANTHROPIC_API_KEY: "sk-ant-..." }),
      }),
    );
    const check = diagnostics.find((d) => d.id === "env-placeholder-keys")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
    expect(status.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("iii-on-path-not-local-bin warns when iii lives in another location", async () => {
    const diagnostics = buildDiagnostics(
      stubEffects({
        findIiiBinary: () => "/opt/homebrew/bin/iii",
        localBinIiiPath: () => "/Users/test/.local/bin/iii",
      }),
    );
    const check = diagnostics.find((d) => d.id === "iii-on-path-not-local-bin")!;
    const status = await check.check(stubCtx());
    expect(status.ok).toBe(false);
    expect(check.manualOnly).toBe(true);
  });

  it("dryRunPlan lists each failing diagnostic with the fix preview", () => {
    const diagnostics = buildDiagnostics(stubEffects());
    const results = diagnostics.map((d) => ({
      diagnostic: d,
      status: { ok: false, detail: "stub fail" },
    }));
    const lines = dryRunPlan(stubCtx(), results);
    expect(lines.some((l) => l.includes("env-missing"))).toBe(true);
    expect(lines.some((l) => l.includes("would fix:"))).toBe(true);
  });

  it("dryRunPlan reports all-passing state", () => {
    const diagnostics = buildDiagnostics(stubEffects());
    const results = diagnostics.map((d) => ({
      diagnostic: d,
      status: { ok: true },
    }));
    const lines = dryRunPlan(stubCtx(), results);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("All checks passing");
  });
});

describe("parseEnvFile", () => {
  it("strips comments and blank lines", () => {
    const env = parseEnvFile("# a comment\n\nFOO=bar\nBAZ=qux\n");
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips surrounding quotes", () => {
    const env = parseEnvFile(`A="hello"\nB='world'\nC=plain\n`);
    expect(env).toEqual({ A: "hello", B: "world", C: "plain" });
  });
});

describe("realProviderKeys / placeholderProviderKeys", () => {
  it("returns real keys only", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-real-value",
      OPENAI_API_KEY: "sk-...",
      GEMINI_API_KEY: "",
      OPENROUTER_API_KEY: "your-key-here",
    };
    expect(realProviderKeys(env)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(placeholderProviderKeys(env)).toContain("OPENAI_API_KEY");
    expect(placeholderProviderKeys(env)).toContain("OPENROUTER_API_KEY");
    expect(placeholderProviderKeys(env)).not.toContain("GEMINI_API_KEY");
  });

  it("treats xxx-style placeholders as fake", () => {
    expect(placeholderProviderKeys({ ANTHROPIC_API_KEY: "xxxx-xxxx" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });
});

describe("diagnose CLI release-gate helpers", () => {
  it("documents and parses the security diagnostics category", () => {
    expect(DIAGNOSE_CLI_HELP).toContain(
      "agentmemory diagnose --categories security",
    );
    expect(DIAGNOSE_CLI_HELP).toContain("security.encryption");

    const plan = buildDiagnoseCliPlan(["--categories", "security", "--json"]);

    expect(plan.json).toBe(true);
    expect(plan.releaseGate).toBe(false);
    expect(plan.payload.categories).toEqual(["security"]);
  });

  it("builds the diagnostics payload from release-gate flags", () => {
    const plan = buildDiagnoseCliPlan([
      "--release-gate",
      "--json",
      "--categories",
      "memories,actions",
      "--build",
      "pass",
      "--build-evidence",
      "npm run build",
      "--test",
      "blocked",
      "--test-blocker",
      "CI unavailable",
    ]);

    expect(plan.releaseGate).toBe(true);
    expect(plan.json).toBe(true);
    expect(plan.payload.categories).toEqual(["memories", "actions"]);
    expect(plan.payload.releaseGateEvidence?.build).toEqual({
      status: "pass",
      evidence: ["npm run build"],
    });
    expect(plan.payload.releaseGateEvidence?.test).toEqual({
      status: "blocked",
      blockers: ["CI unavailable"],
    });
  });

  it("rejects partial release-gate evidence without a status", () => {
    expect(() =>
      buildDiagnoseCliPlan(["--release-gate", "--build-evidence", "npm run build"]),
    ).toThrow("--build status is required");
  });

  it("formats security diagnostics in text and preserves JSON encryption details", () => {
    const result = {
      success: true,
      summary: { pass: 0, warn: 0, fail: 1, fixable: 0 },
      checks: [
        {
          name: "encryption-readiness",
          category: "security",
          status: "fail",
          message:
            "Encryption readiness is fail; cryptography implemented=true, storage wired=false. Missing: storage.encryptionWired.",
          fixable: false,
        },
      ],
      releaseGate: {
        overall: "not_run",
        summary: { pass: 0, fail: 0, blocked: 0, not_run: 7 },
        blockingFindings: [],
      },
      security: {
        encryption: {
          status: "fail",
          cryptography: { implemented: true, storageWired: false },
          missingFields: ["storage.encryptionWired"],
        },
      },
    };

    const text = formatDiagnoseText(result, false);

    expect(text).toContain("Diagnostics: pass=0, warn=0, fail=1, fixable=0");
    expect(text).toContain("Security:");
    expect(text).toContain("encryption-readiness [fail]");
    expect(text).toContain("storage wired=false");
    expect(JSON.parse(formatDiagnoseJson(result, false)).security.encryption.status).toBe(
      "fail",
    );
  });

  it("formats release-gate JSON and returns a failing gate exit code", () => {
    const result = {
      success: true,
      summary: { pass: 4, warn: 0, fail: 0, fixable: 0 },
      releaseGate: {
        overall: "blocked",
        summary: { pass: 1, fail: 0, blocked: 1, not_run: 5 },
        blockingFindings: [
          {
            key: "test",
            status: "blocked",
            message: "No test evidence was provided",
            evidence: [],
            failures: [],
            blockers: ["missing npm test evidence"],
            nextAction: "Run npm test.",
          },
        ],
      },
    };

    expect(JSON.parse(formatDiagnoseJson(result, true)).overall).toBe("blocked");
    expect(formatDiagnoseText(result, true)).toContain("Release gate: blocked");
    expect(formatDiagnoseText(result, true)).toContain("missing npm test evidence");
    expect(releaseGateExitCode(extractReleaseGateReport(result))).toBe(1);
  });

  it("keeps diagnostic security failures visible in release-gate text and JSON", () => {
    const result = {
      success: true,
      summary: { pass: 0, warn: 0, fail: 1, fixable: 0 },
      checks: [
        {
          name: "encryption-readiness",
          category: "security",
          status: "fail",
          message: "Encryption readiness is fail; storage wired=false.",
          fixable: false,
        },
      ],
      releaseGate: {
        overall: "pass",
        summary: { pass: 7, fail: 0, blocked: 0, not_run: 0 },
        checks: {
          build: {
            status: "pass",
            message: "Build evidence accepted",
          },
        },
        blockingFindings: [],
      },
    };

    const text = formatDiagnoseText(result, true);
    const json = JSON.parse(formatDiagnoseJson(result, true));

    expect(text).toContain("Release gate: pass");
    expect(text).toContain("Blocking findings: none");
    expect(text).toContain("Security:");
    expect(text).toContain("encryption-readiness [fail]");
    expect(json.overall).toBe("pass");
    expect(json.diagnosticFindings).toEqual([
      {
        name: "encryption-readiness",
        category: "security",
        status: "fail",
        message: "Encryption readiness is fail; storage wired=false.",
        fixable: false,
      },
    ]);
  });

  it("derives release-gate findings from checks when blockingFindings is empty", () => {
    const result = {
      success: true,
      releaseGate: {
        overall: "fail",
        summary: { pass: 6, fail: 1, blocked: 0, not_run: 0 },
        checks: {
          restMcpParity: {
            status: "fail",
            message: "REST/MCP parity evidence failed",
            failures: ["tool count mismatch"],
            blockers: [],
            nextAction: "Run parity tests.",
          },
        },
        blockingFindings: [],
      },
    };

    const text = formatDiagnoseText(result, true);

    expect(text).toContain("Blocking findings:");
    expect(text).toContain("restMcpParity [fail]: REST/MCP parity evidence failed");
    expect(text).toContain("failures: tool count mismatch");
  });

  it("returns a passing gate exit code only for pass", () => {
    const result = { releaseGate: { overall: "pass" } };
    expect(releaseGateExitCode(extractReleaseGateReport(result))).toBe(0);
  });

  it("reports release-gate JSON as unavailable when an older daemon omits it", () => {
    const result = {
      success: true,
      summary: { pass: 1, warn: 0, fail: 0, fixable: 0 },
    };

    expect(JSON.parse(formatDiagnoseJson(result, true))).toEqual({
      success: false,
      error: "releaseGate unavailable in diagnostics response",
    });
    expect(releaseGateExitCode(extractReleaseGateReport(result))).toBe(1);
  });
});

describe("versions CLI helpers", () => {
  it("builds a safe local report when the REST daemon is unreachable", () => {
    const report = buildVersionsReport({
      agentmemoryVersion: "0.9.27",
      nodeVersion: "v24.0.0",
      platform: "win32",
      arch: "x64",
      baseUrl: "http://localhost:3111",
      pinnedIiiVersion: "0.11.2",
      iiiVersionOverridden: false,
      allToolsCount: 65,
      coreToolsCount: 8,
      restError: "fetch failed",
    });

    expect(report.rest.reachable).toBe(false);
    expect(formatVersionsReport(report, false)).toContain("unreachable");
    expect(JSON.parse(formatVersionsReport(report, true)).agentmemoryVersion).toBe(
      "0.9.27",
    );
  });
});
