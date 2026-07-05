import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const gitCmd = process.platform === "win32" ? "git.exe" : "git";
const nodeCmd = process.execPath;
const cliArgs = new Set(process.argv.slice(2));
const allowDirty = /^(1|true|yes)$/i.test(
  process.env.AGENTMEMORY_PREFLIGHT_ALLOW_DIRTY ?? "",
);
const retrievalArenaEnabled =
  /^(1|true|yes)$/i.test(process.env.AGENTMEMORY_PREFLIGHT_RETRIEVAL_ARENA ?? "") ||
  cliArgs.has("--with-retrieval-arena") ||
  cliArgs.has("--benchmark");
const skipTempInstallSmoke =
  /^(1|true|yes)$/i.test(process.env.AGENTMEMORY_PREFLIGHT_SKIP_TEMP_INSTALL ?? "") ||
  cliArgs.has("--skip-temp-install-smoke");
const cleanTreeCommand = "git status --porcelain=v1 --untracked-files=all";
const maxDirtyEntries = 50;

const STEP_KEYS = [
  "versionLockstep",
  "distributionMetadata",
  "initialCleanTree",
  "build",
  "test",
  "docs",
  "packSmoke",
  "retrievalArena",
  "finalCleanTree",
];

const RELEASE_GATE_KEYS = [
  "distributionMetadata",
  "build",
  "test",
  "docs",
  "packSmoke",
  "redactionForget",
  "retrievalScope",
  "encryptionReadiness",
  "retrievalArena",
  "restMcpParity",
];

const OPTIONAL_RELEASE_GATE_KEYS = new Set([
  "encryptionReadiness",
  "retrievalArena",
]);
const PUBLISH_CREDENTIAL_MARKERS = [
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "SMITHERY_TOKEN",
  "SMITHERY_API_KEY",
  "HOMEBREW_GITHUB_API_TOKEN",
  "VSCE_PAT",
  "AZURE_DEVOPS_EXT_PAT",
];

const TARGETED_EVIDENCE = {
  redactionForget: [
    "test/memory-lifecycle.test.ts",
    "test/remember-forget-audit.test.ts",
  ],
  retrievalScope: [
    "test/smart-search.test.ts",
    "test/remember-project-scope.test.ts",
  ],
  restMcpParity: [
    "test/tool-count-consistency.test.ts",
    "test/mcp-standalone.test.ts",
  ],
};
const ENCRYPTION_READINESS_EVIDENCE = [
  "src/security/encryption.ts",
  "src/security/encryption-policy.ts",
  "src/state/encrypted-kv.ts",
  "src/state/encryption-runtime.ts",
  "src/functions/export-import.ts",
  "test/encryption.test.ts",
  "test/encryption-policy.test.ts",
  "test/encryption-runtime.test.ts",
  "test/export-import.test.ts",
];
const ENCRYPTION_READINESS_WARNING =
  "Encryption readiness still depends on running the targeted encryption/export tests in this checkout.";

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
}

function readText(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function step(status, label, details = {}) {
  return {
    status,
    label,
    optional: details.optional ?? false,
    evidence: details.evidence ?? [],
    failures: details.failures ?? [],
    blockers: details.blockers ?? [],
    warnings: details.warnings ?? [],
    exitCode: details.exitCode ?? null,
  };
}

function dirtyTreeRecord(stage, status, entries = [], allowed = false, error = null) {
  return {
    stage,
    status,
    allowed,
    command: cleanTreeCommand,
    entryCount: entries.length,
    entries: entries.slice(0, maxDirtyEntries),
    omittedEntryCount: Math.max(0, entries.length - maxDirtyEntries),
    error,
  };
}

export function createPreflightSummary(options = {}) {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const summary = {
    schemaVersion: 1,
    name: "agentmemory-release-preflight",
    status: "not_run",
    startedAt,
    finishedAt: null,
    allowDirty: options.allowDirty ?? allowDirty,
    dirtyTree: {
      initial: dirtyTreeRecord("initial", "not_checked"),
      final: dirtyTreeRecord("final", "not_checked"),
    },
    options: {
      retrievalArenaEnabled: options.retrievalArenaEnabled ?? retrievalArenaEnabled,
      tempInstallSmoke: options.tempInstallSmoke ?? !skipTempInstallSmoke,
    },
    steps: {},
    releaseGate: {},
  };
  for (const key of STEP_KEYS) {
    summary.steps[key] = step("not_run", key, {
      optional: OPTIONAL_RELEASE_GATE_KEYS.has(key),
    });
  }
  for (const key of RELEASE_GATE_KEYS) {
    summary.releaseGate[key] = step("not_run", key, {
      optional: OPTIONAL_RELEASE_GATE_KEYS.has(key),
    });
  }
  return summary;
}

export function parseGitStatus(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function applyCleanTreeResult(summary, stage, stepKey, entries) {
  const isDirty = entries.length > 0;
  summary.dirtyTree[stage] = dirtyTreeRecord(
    stage,
    isDirty ? "dirty" : "clean",
    entries,
    isDirty && summary.allowDirty,
  );

  if (!isDirty) {
    summary.steps[stepKey] = step("pass", `${stage} clean-tree check`, {
      evidence: [cleanTreeCommand],
    });
    return true;
  }

  if (summary.allowDirty) {
    const warning = `${entries.length} dirty git entr${entries.length === 1 ? "y" : "ies"} allowed by AGENTMEMORY_PREFLIGHT_ALLOW_DIRTY`;
    console.warn(
      `${stage} clean-tree check detected a dirty tree; continuing because AGENTMEMORY_PREFLIGHT_ALLOW_DIRTY is set.`,
    );
    for (const entry of entries.slice(0, maxDirtyEntries)) {
      console.warn(`  ${entry}`);
    }
    if (entries.length > maxDirtyEntries) {
      console.warn(`  ... ${entries.length - maxDirtyEntries} more`);
    }
    summary.steps[stepKey] = step("pass", `${stage} clean-tree check`, {
      evidence: [cleanTreeCommand, "AGENTMEMORY_PREFLIGHT_ALLOW_DIRTY"],
      warnings: [warning],
    });
    return true;
  }

  console.error(`Release preflight requires a clean git tree (${stage}).`);
  console.error(entries.join("\n"));
  summary.steps[stepKey] = step("fail", `${stage} clean-tree check`, {
    failures: entries,
    exitCode: 1,
  });
  return false;
}

export function blockSteps(summary, keys, reason) {
  for (const key of keys) {
    if (summary.steps[key]?.status === "not_run") {
      summary.steps[key] = step("blocked", key, {
        blockers: [reason],
        optional: Boolean(summary.steps[key]?.optional),
      });
    }
  }
}

export function deriveReleaseGate(summary, options = {}) {
  const root = options.root ?? ROOT;
  const fileExists = options.fileExists ?? existsSync;
  const releaseGate = {
    distributionMetadata: fromStep(
      summary.steps.distributionMetadata,
      "MCP registry metadata",
    ),
    build: fromStep(summary.steps.build, "npm run build"),
    test: fromStep(summary.steps.test, "npm test"),
    docs: fromStep(summary.steps.docs, "npm run skills:check"),
    packSmoke: fromStep(summary.steps.packSmoke, "npm pack --dry-run + temp install smoke"),
    redactionForget: targetedTestGate(
      summary.steps.test,
      TARGETED_EVIDENCE.redactionForget,
      root,
      fileExists,
    ),
    retrievalScope: targetedTestGate(
      summary.steps.test,
      TARGETED_EVIDENCE.retrievalScope,
      root,
      fileExists,
    ),
    encryptionReadiness: encryptionReadinessGate(root, fileExists),
    retrievalArena: fromOptionalStep(
      summary.steps.retrievalArena,
      "npm run bench:retrieval-smoke",
      "Retrieval Arena smoke is optional and skipped by default; run npm run bench:retrieval-smoke or npm run release:preflight:arena to include it.",
    ),
    restMcpParity: targetedTestGate(
      summary.steps.test,
      TARGETED_EVIDENCE.restMcpParity,
      root,
      fileExists,
    ),
  };
  summary.releaseGate = releaseGate;
  return releaseGate;
}

function fromStep(source, evidence) {
  if (!source || source.status === "not_run") {
    return step("not_run", evidence, {
      optional: Boolean(source?.optional),
      warnings: source?.warnings ?? [],
    });
  }
  if (source.status === "blocked") {
    return step("blocked", evidence, {
      blockers: source.blockers,
      optional: Boolean(source.optional),
      warnings: source.warnings,
    });
  }
  if (source.status === "fail") {
    return step("fail", evidence, {
      failures: source.failures,
      exitCode: source.exitCode,
      optional: Boolean(source.optional),
      warnings: source.warnings,
    });
  }
  return step("pass", evidence, {
    evidence: source.evidence.length > 0 ? source.evidence : [evidence],
    optional: Boolean(source.optional),
    warnings: source.warnings,
  });
}

function fromOptionalStep(source, evidence, skippedWarning) {
  if (!source || source.status === "not_run") {
    return step("not_run", evidence, {
      optional: true,
      warnings: [...new Set([skippedWarning, ...(source?.warnings ?? [])])],
    });
  }
  return fromStep({ ...source, optional: true }, evidence);
}

function targetedTestGate(testStep, evidenceFiles, root, fileExists) {
  const missing = evidenceFiles.filter((file) => !fileExists(join(root, file)));
  if (missing.length > 0) {
    return step("not_run", evidenceFiles.join(", "), {
      blockers: missing.map((file) => `missing ${file}`),
    });
  }
  if (!testStep || testStep.status === "not_run") {
    return step("not_run", evidenceFiles.join(", "));
  }
  if (testStep.status === "blocked") {
    return step("blocked", evidenceFiles.join(", "), {
      blockers: testStep.blockers,
    });
  }
  if (testStep.status === "fail") {
    return step("fail", evidenceFiles.join(", "), {
      evidence: ["npm test", ...evidenceFiles],
      failures: testStep.failures,
      exitCode: testStep.exitCode,
    });
  }
  return step("pass", evidenceFiles.join(", "), {
    evidence: ["npm test", ...evidenceFiles],
  });
}

function encryptionReadinessGate(root, fileExists) {
  const missing = ENCRYPTION_READINESS_EVIDENCE.filter(
    (file) => !fileExists(join(root, file)),
  );
  const present = ENCRYPTION_READINESS_EVIDENCE.filter(
    (file) => !missing.includes(file),
  );

  if (missing.length > 0) {
    return step("not_run", "encryption readiness evidence", {
      optional: true,
      evidence: present,
      blockers: missing.map((file) => `missing ${file}`),
      warnings: [ENCRYPTION_READINESS_WARNING],
    });
  }

  return step("pass", "encryption readiness evidence", {
    optional: true,
    evidence: ENCRYPTION_READINESS_EVIDENCE,
    warnings: [ENCRYPTION_READINESS_WARNING],
  });
}

function cmdArg(value) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function needsCmdShim(command, platform = process.platform) {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function run(label, command, args, opts = {}) {
  console.log(`\n==> ${label}`);
  const [spawnCommand, spawnArgs] =
    needsCmdShim(command)
      ? ["cmd.exe", ["/d", "/s", "/c", [command, ...args].map(cmdArg).join(" ")]]
      : [command, args];
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: opts.cwd ?? ROOT,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    return {
      ok: false,
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error.message,
    };
  }
  if (result.status !== 0) {
    if (opts.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    console.error(`${label} failed with exit code ${result.status}`);
    return {
      ok: false,
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  return {
    ok: true,
    status: 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertCleanTree(summary, stage, stepKey) {
  const result = run(
    `${stage} clean-tree check`,
    gitCmd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { capture: true },
  );
  if (!result.ok) {
    summary.dirtyTree[stage] = dirtyTreeRecord(
      stage,
      "unknown",
      [],
      false,
      result.stderr || "git status failed",
    );
    summary.steps[stepKey] = step("fail", `${stage} clean-tree check`, {
      failures: [result.stderr || "git status failed"],
      exitCode: result.status,
    });
    return false;
  }
  return applyCleanTreeResult(
    summary,
    stage,
    stepKey,
    parseGitStatus(result.stdout),
  );
}

function assertVersionLockstep(summary) {
  try {
    const pkg = readJson("package.json");
    const expected = pkg.version;
    const versionTs = readFileSync(join(ROOT, "src", "version.ts"), "utf8");
    const versionMatch = /VERSION\s*=\s*"([^"]+)"/.exec(versionTs);
    const actual = [
      ["src/version.ts", versionMatch?.[1]],
      ["plugin/plugin.json", readJson("plugin/plugin.json").version],
    ];
    for (const manifest of [
      "plugin/.claude-plugin/plugin.json",
      "plugin/.codex-plugin/plugin.json",
    ]) {
      if (existsSync(join(ROOT, manifest))) {
        actual.push([manifest, readJson(manifest).version]);
      }
    }

    const drift = actual.filter(([, value]) => value !== expected);
    if (drift.length > 0) {
      console.error(`Version lockstep failed; package.json is ${expected}.`);
      for (const [file, value] of drift) {
        console.error(`  ${file}: ${value ?? "<missing>"}`);
      }
      summary.steps.versionLockstep = step("fail", "version lockstep", {
        failures: drift.map(([file, value]) => `${file}: ${value ?? "<missing>"}`),
        exitCode: 1,
      });
      return false;
    }

    console.log(`version lockstep: ${expected}`);
    summary.steps.versionLockstep = step("pass", "version lockstep", {
      evidence: [`package.json version ${expected}`],
    });
    return true;
  } catch (error) {
    const message = `version lockstep check crashed: ${errorMessage(error)}`;
    console.error(message);
    summary.steps.versionLockstep = step("fail", "version lockstep", {
      failures: [message],
      exitCode: 1,
    });
    return false;
  }
}

export function validateDistributionMetadata() {
  const failures = [];
  const evidence = [];
  try {
    const rootPkg = readJson("package.json");
    const mcpPkg = readJson("packages/mcp/package.json");
    const server = readJson("server.json");
    const expectedName = "io.github.rohitg00/agentmemory";
    const expectedSchema =
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

    if (rootPkg.mcpName !== expectedName) {
      failures.push(`package.json mcpName is ${rootPkg.mcpName ?? "<missing>"}`);
    }
    if (mcpPkg.mcpName !== expectedName) {
      failures.push(
        `packages/mcp/package.json mcpName is ${mcpPkg.mcpName ?? "<missing>"}`,
      );
    }
    if (mcpPkg.version !== rootPkg.version) {
      failures.push(
        `packages/mcp/package.json version ${mcpPkg.version ?? "<missing>"} does not match package.json ${rootPkg.version}`,
      );
    }
    if (!Array.isArray(rootPkg.files) || !rootPkg.files.includes("server.json")) {
      failures.push('package.json files must include "server.json"');
    }
    if (!Array.isArray(rootPkg.files) || !rootPkg.files.includes("packaging/")) {
      failures.push('package.json files must include "packaging/"');
    }
    if (!Array.isArray(rootPkg.files) || !rootPkg.files.includes("smithery.yaml")) {
      failures.push('package.json files must include "smithery.yaml"');
    }
    if (server.$schema !== expectedSchema) {
      failures.push(`server.json $schema is ${server.$schema ?? "<missing>"}`);
    }
    if (server.name !== expectedName) {
      failures.push(`server.json name is ${server.name ?? "<missing>"}`);
    }
    if (server.version !== rootPkg.version) {
      failures.push(
        `server.json version ${server.version ?? "<missing>"} does not match package.json ${rootPkg.version}`,
      );
    }

    const packages = Array.isArray(server.packages) ? server.packages : [];
    const npmPackage = packages.find((pkg) => pkg?.identifier === "@agentmemory/mcp");
    if (!npmPackage) {
      failures.push("server.json packages must include @agentmemory/mcp");
    } else {
      if (npmPackage.registryType !== "npm") {
        failures.push("@agentmemory/mcp package registryType must be npm");
      }
      if (npmPackage.version !== mcpPkg.version) {
        failures.push(
          `@agentmemory/mcp server.json version ${npmPackage.version ?? "<missing>"} does not match packages/mcp ${mcpPkg.version}`,
        );
      }
      if (npmPackage.transport?.type !== "stdio") {
        failures.push("@agentmemory/mcp transport must be stdio");
      }
      const envNames = new Set(
        (Array.isArray(npmPackage.environmentVariables)
          ? npmPackage.environmentVariables
          : []
        ).map((item) => item?.name),
      );
      for (const required of ["AGENTMEMORY_URL", "AGENTMEMORY_SECRET"]) {
        if (!envNames.has(required)) {
          failures.push(`@agentmemory/mcp env is missing ${required}`);
        }
      }
      if (envNames.has("AGENTMEMORY_TOOLS")) {
        failures.push(
          "@agentmemory/mcp env must not include AGENTMEMORY_TOOLS; the shim ignores it",
        );
      }
    }

    evidence.push("server.json", "package.json", "packages/mcp/package.json");
    validateMcpbMetadata(rootPkg, failures, evidence);
    validateSmitheryMetadata(mcpPkg, failures, evidence);
    validateHomebrewMetadata(rootPkg, failures, evidence);
    validateVscodeExtensionMetadata(rootPkg, failures, evidence);
    validateBundledDependencyMetadata(rootPkg, failures, evidence);
  } catch (error) {
    failures.push(`distribution metadata check crashed: ${errorMessage(error)}`);
  }

  return { failures, evidence: [...new Set(evidence)] };
}

function assertDistributionMetadata(summary) {
  const { failures, evidence } = validateDistributionMetadata();

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    summary.steps.distributionMetadata = step("fail", "distribution metadata", {
      evidence,
      failures,
      exitCode: 1,
    });
    return false;
  }

  console.log("distribution metadata: MCP registry server.json");
  summary.steps.distributionMetadata = step("pass", "distribution metadata", {
    evidence,
  });
  return true;
}

function validateMcpbMetadata(rootPkg, failures, evidence) {
  const manifest = readJson("packaging/mcpb/manifest.json");
  const readme = readText("packaging/mcpb/README.md");
  evidence.push("packaging/mcpb/manifest.json", "packaging/mcpb/README.md");
  assertNoPublishCredentialMarkers("packaging/mcpb/manifest.json", JSON.stringify(manifest), failures);
  assertNoPublishCredentialMarkers("packaging/mcpb/README.md", readme, failures);

  if (manifest.manifest_version !== "0.3") {
    failures.push(`packaging/mcpb/manifest.json manifest_version is ${manifest.manifest_version ?? "<missing>"}`);
  }
  if (manifest.version !== rootPkg.version) {
    failures.push(
      `packaging/mcpb/manifest.json version ${manifest.version ?? "<missing>"} does not match package.json ${rootPkg.version}`,
    );
  }
  if (manifest.license !== rootPkg.license) {
    failures.push(`packaging/mcpb/manifest.json license is ${manifest.license ?? "<missing>"}`);
  }
  if (manifest.repository?.url !== rootPkg.repository?.url) {
    failures.push(
      `packaging/mcpb/manifest.json repository url is ${manifest.repository?.url ?? "<missing>"}`,
    );
  }
  if (manifest.server?.type !== "node") {
    failures.push(`packaging/mcpb/manifest.json server.type is ${manifest.server?.type ?? "<missing>"}`);
  }
  if (manifest.server?.entry_point !== "server/bin.mjs") {
    failures.push(
      `packaging/mcpb/manifest.json server.entry_point is ${manifest.server?.entry_point ?? "<missing>"}`,
    );
  }
  if (manifest.server?.mcp_config?.command !== "node") {
    failures.push(
      `packaging/mcpb/manifest.json server.mcp_config.command is ${manifest.server?.mcp_config?.command ?? "<missing>"}`,
    );
  }
  const args = Array.isArray(manifest.server?.mcp_config?.args)
    ? manifest.server.mcp_config.args
    : [];
  if (!args.includes("${__dirname}/server/bin.mjs")) {
    failures.push("packaging/mcpb/manifest.json must launch ${__dirname}/server/bin.mjs");
  }
  const env = manifest.server?.mcp_config?.env ?? {};
  if (env.AGENTMEMORY_URL !== "${user_config.agentmemory_url}") {
    failures.push("packaging/mcpb/manifest.json must map AGENTMEMORY_URL from user_config.agentmemory_url");
  }
  if (env.AGENTMEMORY_SECRET !== "${user_config.agentmemory_secret}") {
    failures.push("packaging/mcpb/manifest.json must map AGENTMEMORY_SECRET from user_config.agentmemory_secret");
  }
  if (manifest.tools_generated !== true) {
    failures.push("packaging/mcpb/manifest.json tools_generated must be true");
  }
  const platforms = new Set(
    Array.isArray(manifest.compatibility?.platforms)
      ? manifest.compatibility.platforms
      : [],
  );
  for (const platform of ["darwin", "linux", "win32"]) {
    if (!platforms.has(platform)) {
      failures.push(`packaging/mcpb/manifest.json compatibility.platforms is missing ${platform}`);
    }
  }
  if (manifest.compatibility?.runtimes?.node !== rootPkg.engines?.node) {
    failures.push(
      `packaging/mcpb/manifest.json node runtime ${manifest.compatibility?.runtimes?.node ?? "<missing>"} does not match package.json ${rootPkg.engines?.node}`,
    );
  }
  if (manifest.user_config?.agentmemory_url?.default !== "http://localhost:3111") {
    failures.push("packaging/mcpb/manifest.json agentmemory_url default must be http://localhost:3111");
  }
  if (manifest.user_config?.agentmemory_secret?.sensitive !== true) {
    failures.push("packaging/mcpb/manifest.json agentmemory_secret must be sensitive");
  }
  if (manifest.user_config?.agentmemory_secret?.required !== false) {
    failures.push("packaging/mcpb/manifest.json agentmemory_secret must be optional");
  }
  for (const required of [
    "not a finished `.mcpb` artifact",
    "bundle the production dependency tree",
    "Do not hand-write or publish a final `.mcpb`",
  ]) {
    if (!readme.includes(required)) {
      failures.push(`packaging/mcpb/README.md must mention: ${required}`);
    }
  }
}

function validateSmitheryMetadata(mcpPkg, failures, evidence) {
  const smithery = readText("smithery.yaml");
  evidence.push("smithery.yaml");
  assertNoPublishCredentialMarkers("smithery.yaml", smithery, failures);

  if (!smithery.includes("runtime: node")) {
    failures.push("smithery.yaml must declare runtime: node");
  }
  if (!smithery.includes("type: stdio")) {
    failures.push("smithery.yaml must declare stdio transport");
  }
  if (!smithery.includes('command: "npx"')) {
    failures.push('smithery.yaml must launch through command: "npx"');
  }
  if (!smithery.includes(`@agentmemory/mcp@${mcpPkg.version}`)) {
    failures.push(
      `smithery.yaml must pin @agentmemory/mcp@${mcpPkg.version}`,
    );
  }
  for (const required of [
    'args: ["-y", "@agentmemory/mcp@',
    "AGENTMEMORY_URL",
    "AGENTMEMORY_SECRET",
    "additionalProperties: false",
    "agentmemory_secret",
  ]) {
    if (!smithery.includes(required)) {
      failures.push(`smithery.yaml is missing ${required}`);
    }
  }
  if (smithery.includes("AGENTMEMORY_TOOLS")) {
    failures.push("smithery.yaml must not expose AGENTMEMORY_TOOLS; the shim ignores it");
  }
}

function validateHomebrewMetadata(rootPkg, failures, evidence) {
  const formula = readText("packaging/homebrew/agentmemory.rb.template");
  const readme = readText("packaging/homebrew/README.md");
  evidence.push("packaging/homebrew/agentmemory.rb.template", "packaging/homebrew/README.md");
  assertNoPublishCredentialMarkers("packaging/homebrew/agentmemory.rb.template", formula, failures);
  assertNoPublishCredentialMarkers("packaging/homebrew/README.md", readme, failures);

  for (const placeholder of [
    "__AGENTMEMORY_VERSION__",
    "__AGENTMEMORY_TARBALL_URL__",
    "__AGENTMEMORY_SHA256__",
  ]) {
    if (!formula.includes(placeholder)) {
      failures.push(`packaging/homebrew/agentmemory.rb.template is missing ${placeholder}`);
    }
    if (!readme.includes(placeholder)) {
      failures.push(`packaging/homebrew/README.md is missing ${placeholder}`);
    }
  }
  if (formula.includes(rootPkg.version)) {
    failures.push("packaging/homebrew/agentmemory.rb.template must keep the version placeholder until release");
  }
  if (/sha256\s+"[a-f0-9]{64}"/.test(formula)) {
    failures.push("packaging/homebrew/agentmemory.rb.template must not include a fabricated checksum");
  }
  if (!formula.includes('license "Apache-2.0"')) {
    failures.push("packaging/homebrew/agentmemory.rb.template must preserve the Apache-2.0 license");
  }
  if (!formula.includes('depends_on "node"')) {
    failures.push('packaging/homebrew/agentmemory.rb.template must depend_on "node"');
  }
  if (!formula.includes('shell_output("#{bin}/agentmemory --version")')) {
    failures.push("packaging/homebrew/agentmemory.rb.template must smoke test agentmemory --version");
  }

  const cliSymlinkTarget = "dist/cli.mjs";
  if (!formula.includes(`libexec/"${cliSymlinkTarget}"`)) {
    failures.push(
      `packaging/homebrew/agentmemory.rb.template must symlink libexec/"${cliSymlinkTarget}"`,
    );
  }
  // The formula symlinks libexec/"dist/cli.mjs", but dist/ is gitignored build
  // output. The tarball is only valid if it is the prebuilt npm-pack artifact
  // that actually ships dist/cli.mjs, so verify the package will ship it and
  // that the formula documents the prebuilt-artifact requirement.
  if (rootPkg.bin?.agentmemory !== cliSymlinkTarget) {
    failures.push(
      `package.json bin.agentmemory must be ${cliSymlinkTarget} so the Homebrew tarball ships it (is ${rootPkg.bin?.agentmemory ?? "<missing>"})`,
    );
  }
  if (!Array.isArray(rootPkg.files) || !rootPkg.files.includes("dist/")) {
    failures.push(
      'package.json files must include "dist/" so the npm-pack tarball ships dist/cli.mjs for Homebrew',
    );
  }
  if (!formula.includes("prebuilt artifact")) {
    failures.push(
      "packaging/homebrew/agentmemory.rb.template must document that the tarball is a prebuilt artifact shipping dist/cli.mjs",
    );
  }

  for (const required of [
    "not a live formula",
    "Do not publish this template with placeholder values",
    "do not invent a",
    "prebuilt artifact",
    "dist/cli.mjs",
  ]) {
    if (!readme.includes(required)) {
      failures.push(`packaging/homebrew/README.md must mention: ${required}`);
    }
  }
}

function validateVscodeExtensionMetadata(rootPkg, failures, evidence) {
  const pkg = readJson("packaging/vscode-extension/package.json");
  const extension = readText("packaging/vscode-extension/extension.js");
  const readme = readText("packaging/vscode-extension/README.md");
  evidence.push(
    "packaging/vscode-extension/package.json",
    "packaging/vscode-extension/extension.js",
    "packaging/vscode-extension/README.md",
  );
  assertNoPublishCredentialMarkers("packaging/vscode-extension/package.json", JSON.stringify(pkg), failures);
  assertNoPublishCredentialMarkers("packaging/vscode-extension/extension.js", extension, failures);
  assertNoPublishCredentialMarkers("packaging/vscode-extension/README.md", readme, failures);

  if (pkg.name !== "@agentmemory/vscode-extension") {
    failures.push(`packaging/vscode-extension/package.json name is ${pkg.name ?? "<missing>"}`);
  }
  if (pkg.version !== rootPkg.version) {
    failures.push(
      `packaging/vscode-extension/package.json version ${pkg.version ?? "<missing>"} does not match package.json ${rootPkg.version}`,
    );
  }
  if (pkg.license !== rootPkg.license) {
    failures.push(`packaging/vscode-extension/package.json license is ${pkg.license ?? "<missing>"}`);
  }
  if (pkg.type !== "module") {
    failures.push("packaging/vscode-extension/package.json type must be module");
  }
  if (pkg.main !== "./extension.js") {
    failures.push(`packaging/vscode-extension/package.json main is ${pkg.main ?? "<missing>"}`);
  }
  if (!pkg.engines?.vscode) {
    failures.push("packaging/vscode-extension/package.json must declare engines.vscode");
  }
  if (pkg.repository?.url !== rootPkg.repository?.url) {
    failures.push(
      `packaging/vscode-extension/package.json repository url is ${pkg.repository?.url ?? "<missing>"}`,
    );
  }
  if (pkg.repository?.directory !== "packaging/vscode-extension") {
    failures.push("packaging/vscode-extension/package.json repository.directory must be packaging/vscode-extension");
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("extension.js") || !pkg.files.includes("README.md")) {
    failures.push("packaging/vscode-extension/package.json files must include extension.js and README.md");
  }
  const activationCommands = new Set(
    (Array.isArray(pkg.activationEvents) ? pkg.activationEvents : [])
      .filter((event) => typeof event === "string" && event.startsWith("onCommand:"))
      .map((event) => event.slice("onCommand:".length)),
  );
  const contributedCommands = new Set(
    (Array.isArray(pkg.contributes?.commands) ? pkg.contributes.commands : [])
      .map((command) => command?.command)
      .filter(Boolean),
  );
  for (const command of [
    "agentmemory.status",
    "agentmemory.doctor",
    "agentmemory.connectRepair",
    "agentmemory.openViewer",
  ]) {
    if (!activationCommands.has(command)) {
      failures.push(`packaging/vscode-extension/package.json activationEvents is missing ${command}`);
    }
    if (!contributedCommands.has(command)) {
      failures.push(`packaging/vscode-extension/package.json contributes.commands is missing ${command}`);
    }
    if (!extension.includes(`id: "${command}"`)) {
      failures.push(`packaging/vscode-extension/extension.js commandDefinitions is missing ${command}`);
    }
  }
  if (pkg.contributes?.configuration?.properties?.["agentmemory.cliCommand"]?.default !== "agentmemory") {
    failures.push("packaging/vscode-extension/package.json agentmemory.cliCommand default must be agentmemory");
  }
  if (pkg.contributes?.configuration?.properties?.["agentmemory.viewerUrl"]?.default !== "http://localhost:3113") {
    failures.push("packaging/vscode-extension/package.json agentmemory.viewerUrl default must be http://localhost:3113");
  }
  for (const required of [
    "agentmemory doctor --dry-run",
    "agentmemory connect repair",
    "http://localhost:3113",
    "spawn",
  ]) {
    if (!readme.includes(required) && !extension.includes(required)) {
      failures.push(`VS Code packaging metadata must mention ${required}`);
    }
  }
}

function validateBundledDependencyMetadata(rootPkg, failures, evidence) {
  const expectedBundled = new Set([
    "iii-sdk",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-logs",
  ]);
  const bundled = new Set(rootPkg.bundledDependencies ?? rootPkg.bundleDependencies ?? []);
  for (const name of expectedBundled) {
    if (!bundled.has(name)) {
      failures.push(`package.json bundledDependencies must include ${name}`);
    }
  }

  const iiiSdk = readJson("vendor/iii-sdk-compat/package.json");
  evidence.push("vendor/iii-sdk-compat/package.json");
  const expectedTypes = [
    iiiSdk.exports?.["."]?.types,
    iiiSdk.exports?.["./stream"]?.types,
    iiiSdk.exports?.["./state"]?.types,
    iiiSdk.exports?.["./telemetry"]?.types,
  ];
  for (const typePath of expectedTypes) {
    if (typeof typePath !== "string") {
      failures.push("vendor/iii-sdk-compat/package.json exports must declare types");
      continue;
    }
    if (!existsSync(join(ROOT, "vendor/iii-sdk-compat", typePath))) {
      failures.push(`vendor/iii-sdk-compat missing exported type file ${typePath}`);
    }
  }
  if (iiiSdk.dependencies?.["@opentelemetry/resources"] !== "2.9.0") {
    failures.push("vendor/iii-sdk-compat must depend on @opentelemetry/resources 2.9.0");
  }
  if (iiiSdk.dependencies?.["@opentelemetry/sdk-logs"] !== "0.220.0") {
    failures.push("vendor/iii-sdk-compat must depend on @opentelemetry/sdk-logs 0.220.0");
  }
  if (iiiSdk.exports?.["./package.json"] !== "./package.json") {
    failures.push("vendor/iii-sdk-compat must export ./package.json for pack smoke verification");
  }
}

function assertNoPublishCredentialMarkers(file, contents, failures) {
  for (const marker of PUBLISH_CREDENTIAL_MARKERS) {
    if (contents.includes(marker)) {
      failures.push(`${file} must not require publish credential marker ${marker}`);
    }
  }
}

function runStep(summary, stepKey, label, command, args) {
  const result = run(label, command, args);
  if (!result.ok) {
    summary.steps[stepKey] = step("fail", label, {
      failures: [`${label} exited ${result.status}`],
      exitCode: result.status,
    });
    return false;
  }
  summary.steps[stepKey] = step("pass", label, {
    evidence: [[command, ...args].join(" ")],
  });
  return true;
}

export function parseNpmPackFilename(stdout) {
  const trimmed = stdout.trim();
  const candidates = [
    trimmed,
    trimmed.slice(trimmed.indexOf("["), trimmed.lastIndexOf("]") + 1),
  ].filter((candidate) => candidate.startsWith("[") && candidate.endsWith("]"));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && typeof parsed[0]?.filename === "string") {
        return parsed[0].filename;
      }
    } catch {
      // Keep trying: npm lifecycle output may wrap the JSON array.
    }
  }
  return null;
}

export function resolvePackTarballPath(filename, root = ROOT) {
  return isAbsolute(filename) ? filename : join(root, filename);
}

function runTempInstallSmoke(tarballPath) {
  const tempRoot = mkdtempSync(join(tmpdir(), "agentmemory-install-smoke-"));
  try {
    const localTarballPath = join(tempRoot, basename(tarballPath));
    copyFileSync(tarballPath, localTarballPath);
    const install = run(
      "temp install smoke",
      npmCmd,
      [
        "install",
        "--package-lock=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=dev",
        "--omit=optional",
        pathToFileURL(localTarballPath).href,
      ],
      { cwd: tempRoot },
    );
    if (!install.ok) return install;

    const dependencyTree = run(
      "temp install dependency tree smoke",
      npmCmd,
      [
        "ls",
        "@agentmemory/agentmemory",
        "iii-sdk",
        "@opentelemetry/sdk-logs",
        "@opentelemetry/resources",
        "@opentelemetry/otlp-transformer",
        "@opentelemetry/core",
        "@opentelemetry/sdk-metrics",
        "@opentelemetry/sdk-trace-base",
        "@opentelemetry/sdk-trace-node",
        "--all",
      ],
      { cwd: tempRoot },
    );
    if (!dependencyTree.ok) return dependencyTree;

    return run(
      "temp install import/bin smoke",
      nodeCmd,
      [
        "-e",
        [
          "const { createRequire } = require('module');",
          "const fs = require('fs');",
          "const path = require('path');",
          "const req = createRequire(path.join(process.cwd(), 'smoke.cjs'));",
          "const pkgPath = req.resolve('@agentmemory/agentmemory/package.json');",
          "const pkg = req(pkgPath);",
          "if (pkg.name !== '@agentmemory/agentmemory') throw new Error(`unexpected package ${pkg.name}`);",
          "const root = path.dirname(pkgPath);",
          "const mainRel = pkg.exports?.['.']?.import || pkg.main;",
          "const mainPath = path.join(root, mainRel);",
          "if (!fs.existsSync(mainPath)) throw new Error(`missing main ${mainRel}`);",
          "for (const bin of Object.values(pkg.bin || {})) {",
          "  const binPath = path.join(root, bin);",
          "  if (!fs.existsSync(binPath)) throw new Error(`missing bin ${bin}`);",
          "}",
          "const pkgReq = createRequire(mainPath);",
          "const sdkPkg = pkgReq('iii-sdk/package.json');",
          "const sdkRoot = path.dirname(pkgReq.resolve('iii-sdk/package.json'));",
          "for (const rel of [sdkPkg.exports['.'].types, sdkPkg.exports['./stream'].types, sdkPkg.exports['./state'].types, sdkPkg.exports['./telemetry'].types]) {",
          "  if (!fs.existsSync(path.join(sdkRoot, rel))) throw new Error(`missing iii-sdk type ${rel}`);",
          "}",
          "const sdk = pkgReq('iii-sdk');",
          "if (typeof sdk.registerWorker !== 'function') throw new Error('iii-sdk registerWorker missing');",
          "const logs = pkgReq('@opentelemetry/sdk-logs');",
          "const provider = new logs.LoggerProvider();",
          "if (typeof provider.addLogRecordProcessor !== 'function') throw new Error('sdk-logs compatibility missing addLogRecordProcessor');",
          "const resources = pkgReq('@opentelemetry/resources');",
          "if (typeof resources.resourceFromAttributes !== 'function') throw new Error('resources compatibility missing resourceFromAttributes');",
          "console.log(`${pkg.name}@${pkg.version} ${mainPath}`);",
        ].join(" "),
      ],
      { cwd: tempRoot },
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runPackSmoke(summary) {
  const dryRun = run("pack smoke dry-run", npmCmd, ["pack", "--dry-run"]);
  if (!dryRun.ok) {
    summary.steps.packSmoke = step("fail", "pack smoke", {
      failures: [`npm pack --dry-run exited ${dryRun.status}`],
      exitCode: dryRun.status,
    });
    return false;
  }

  if (!summary.options.tempInstallSmoke) {
    summary.steps.packSmoke = step("pass", "pack smoke", {
      evidence: ["npm pack --dry-run"],
      warnings: [
        "temp install smoke skipped by AGENTMEMORY_PREFLIGHT_SKIP_TEMP_INSTALL or --skip-temp-install-smoke",
      ],
    });
    return true;
  }

  let tarballPath = null;
  try {
    const pack = run("pack smoke tarball", npmCmd, ["pack", "--json"], {
      capture: true,
    });
    if (!pack.ok) {
      summary.steps.packSmoke = step("fail", "pack smoke", {
        evidence: ["npm pack --dry-run"],
        failures: [`npm pack --json exited ${pack.status}`],
        exitCode: pack.status,
      });
      return false;
    }

    const filename = parseNpmPackFilename(pack.stdout);
    if (!filename) {
      summary.steps.packSmoke = step("fail", "pack smoke", {
        evidence: ["npm pack --dry-run"],
        failures: ["npm pack --json did not return a tarball filename"],
        exitCode: 1,
      });
      return false;
    }

    tarballPath = resolvePackTarballPath(filename);
    const install = runTempInstallSmoke(tarballPath);
    if (!install.ok) {
      summary.steps.packSmoke = step("fail", "pack smoke", {
        evidence: ["npm pack --dry-run", "npm pack --json"],
        failures: [`temp install smoke exited ${install.status}`],
        exitCode: install.status,
      });
      return false;
    }

    summary.steps.packSmoke = step("pass", "pack smoke", {
      evidence: [
        "npm pack --dry-run",
        "npm pack --json",
        "npm install --omit=dev --omit=optional <packed tarball>",
        "npm ls @agentmemory/agentmemory iii-sdk @opentelemetry/*",
        "node import/bin smoke",
      ],
    });
    return true;
  } finally {
    if (tarballPath && existsSync(tarballPath)) {
      unlinkSync(tarballPath);
    }
  }
}

function runRetrievalArena(summary) {
  if (!summary.options.retrievalArenaEnabled) {
    summary.steps.retrievalArena = step("not_run", "retrieval arena smoke", {
      optional: true,
      warnings: [
        "optional Retrieval Arena skipped by default; run npm run bench:retrieval-smoke or npm run release:preflight:arena",
      ],
    });
    return true;
  }

  const result = run(
    "retrieval arena smoke",
    npmCmd,
    ["run", "bench:retrieval-smoke"],
  );
  if (!result.ok) {
    summary.steps.retrievalArena = step("fail", "retrieval arena smoke", {
      optional: true,
      failures: [`npm run bench:retrieval-smoke exited ${result.status}`],
      exitCode: result.status,
    });
    return false;
  }

  summary.steps.retrievalArena = step("pass", "retrieval arena smoke", {
    optional: true,
    evidence: ["npm run bench:retrieval-smoke"],
  });
  return true;
}

export function finish(summary, status, exitCode, options = {}) {
  summary.status = status;
  summary.finishedAt = new Date().toISOString();
  deriveReleaseGate(summary, options);

  // The release gate is the source of truth: a non-pass overall (fail, blocked,
  // or not_run from a missing targeted-evidence file) must never report success.
  const gateOverall = releaseGateOverallForPreflight(summary.releaseGate);
  if (summary.status === "pass" && gateOverall !== "pass") {
    summary.status = "fail";
    if (!exitCode) {
      exitCode = 1;
    }
  }

  printPreflightReport(summary);
  const json = JSON.stringify(summary);
  if (process.env.AGENTMEMORY_PREFLIGHT_SUMMARY_PATH) {
    writeFileSync(process.env.AGENTMEMORY_PREFLIGHT_SUMMARY_PATH, `${json}\n`);
  }
  console.log(`\nRELEASE_PREFLIGHT_SUMMARY_JSON=${json}`);
  if (summary.status === "pass") {
    console.log("\nrelease preflight: pass");
  } else if (status === "pass") {
    console.error(
      `\nrelease preflight: ${summary.status} (release gate overall is ${gateOverall})`,
    );
  }
  process.exitCode = exitCode;
  return exitCode;
}

export function printPreflightReport(summary) {
  console.log("\nrelease gate:");
  console.log(`  overall: ${releaseGateOverallForPreflight(summary.releaseGate)}`);
  for (const key of RELEASE_GATE_KEYS) {
    const item = summary.releaseGate[key];
    const optional = item.optional ? " optional" : "";
    console.log(`  ${key}: ${item.status}${optional} - ${item.label}`);
    for (const warning of item.warnings ?? []) {
      console.log(`    warning: ${warning}`);
    }
  }

  console.log("\ndirty tree:");
  for (const stage of ["initial", "final"]) {
    const record = summary.dirtyTree[stage];
    const allowed = record.allowed ? " allowed" : "";
    console.log(
      `  ${stage}: ${record.status}${allowed} (${record.entryCount} entries)`,
    );
  }
}

export function releaseGateOverallForPreflight(releaseGate) {
  const statuses = RELEASE_GATE_KEYS.flatMap((key) => {
    const item = releaseGate[key];
    if (!item) return [];
    if (item.optional && item.status === "not_run") return [];
    return [item.status];
  });
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("not_run")) return "not_run";
  return "pass";
}

export function main() {
  const summary = createPreflightSummary({ allowDirty });
  console.log("agentmemory release preflight");

  if (!assertVersionLockstep(summary)) {
    blockSteps(
      summary,
      [
        "initialCleanTree",
        "build",
        "test",
        "docs",
        "packSmoke",
        "retrievalArena",
        "finalCleanTree",
      ],
      "version lockstep failed",
    );
    return finish(summary, "fail", 1);
  }

  if (!assertDistributionMetadata(summary)) {
    blockSteps(
      summary,
      [
        "initialCleanTree",
        "build",
        "test",
        "docs",
        "packSmoke",
        "retrievalArena",
        "finalCleanTree",
      ],
      "distribution metadata failed",
    );
    return finish(summary, "fail", 1);
  }

  if (!assertCleanTree(summary, "initial", "initialCleanTree")) {
    blockSteps(
      summary,
      ["build", "test", "docs", "packSmoke", "retrievalArena", "finalCleanTree"],
      "initial clean-tree check failed",
    );
    return finish(summary, "fail", 1);
  }

  if (!runStep(summary, "build", "build", npmCmd, ["run", "build"])) {
    blockSteps(
      summary,
      ["test", "docs", "packSmoke", "retrievalArena", "finalCleanTree"],
      "build failed",
    );
    return finish(summary, "fail", summary.steps.build.exitCode ?? 1);
  }

  if (!runStep(summary, "test", "tests", npmCmd, ["test"])) {
    blockSteps(
      summary,
      ["docs", "packSmoke", "retrievalArena", "finalCleanTree"],
      "tests failed",
    );
    return finish(summary, "fail", summary.steps.test.exitCode ?? 1);
  }

  if (!runStep(summary, "docs", "skills check", npmCmd, ["run", "skills:check"])) {
    blockSteps(
      summary,
      ["packSmoke", "retrievalArena", "finalCleanTree"],
      "docs/skills check failed",
    );
    return finish(summary, "fail", summary.steps.docs.exitCode ?? 1);
  }

  if (!runPackSmoke(summary)) {
    blockSteps(summary, ["retrievalArena", "finalCleanTree"], "pack smoke failed");
    return finish(summary, "fail", summary.steps.packSmoke.exitCode ?? 1);
  }

  if (!runRetrievalArena(summary)) {
    blockSteps(summary, ["finalCleanTree"], "retrieval arena smoke failed");
    return finish(summary, "fail", summary.steps.retrievalArena.exitCode ?? 1);
  }

  if (!assertCleanTree(summary, "final", "finalCleanTree")) {
    return finish(summary, "fail", 1);
  }

  return finish(summary, "pass", 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
