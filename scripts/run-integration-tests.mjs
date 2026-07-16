import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PATH = join(ROOT, "dist", "index.mjs");
const VITEST_PATH = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const COMPOSE_PATH = join(ROOT, "docker-compose.yml");
const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
const configuredUrl = process.env.AGENTMEMORY_URL?.replace(/\/+$/, "");
const baseUrl = configuredUrl || "http://127.0.0.1:3111";
const composeProject = `agentmemory-integration-${process.pid}`;
const composeArgs = ["compose", "-p", composeProject, "-f", COMPOSE_PATH];

let worker = null;
let testProcess = null;
let tempHome = null;
let composeStarted = false;
let cleanupPromise = null;

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    timeout: options.timeout,
    windowsHide: true,
  });
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    testProcess = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      testProcess = null;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function isHealthy(url) {
  try {
    const response = await fetch(`${url}/agentmemory/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(url)) return;
    if (worker?.exitCode !== null) {
      throw new Error(`agentmemory worker exited before health was ready (code ${worker.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`agentmemory did not become healthy at ${url} within ${timeoutMs / 1000}s`);
}

async function stopProcess(child, timeoutMs) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), timeoutMs)),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await stopProcess(testProcess, 2_000);
    await stopProcess(worker, 8_000);
    if (composeStarted) {
      runSync(dockerCmd, [...composeArgs, "down", "--volumes", "--remove-orphans"]);
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}

async function runLiveSuite(env) {
  return run(process.execPath, [VITEST_PATH, "run", "test/integration.test.ts"], env);
}

async function main() {
  if (await isHealthy(baseUrl)) {
    console.log(`Using the running agentmemory service at ${baseUrl}`);
    return runLiveSuite(process.env);
  }

  if (configuredUrl) {
    throw new Error(
      `AGENTMEMORY_URL is set to ${configuredUrl}, but its health endpoint is unavailable. Refusing to start a different local service.`,
    );
  }
  if (!existsSync(WORKER_PATH)) {
    throw new Error("dist/index.mjs is missing. Run npm run build before the integration suite.");
  }
  if (!existsSync(VITEST_PATH)) {
    throw new Error("Vitest is not installed. Run npm install before the integration suite.");
  }

  tempHome = mkdtempSync(join(tmpdir(), "agentmemory-integration-"));
  const env = {
    ...process.env,
    AGENTMEMORY_HOME: tempHome,
    AGENTMEMORY_SECRET: process.env.AGENTMEMORY_SECRET || `integration-${randomUUID()}`,
    AGENTMEMORY_SUPPRESS_COST_WARNING: "1",
    AGENTMEMORY_URL: baseUrl,
    CI: "1",
    HOME: tempHome,
    USERPROFILE: tempHome,
  };

  console.log(`Starting isolated integration stack (${composeProject})`);
  const compose = runSync(dockerCmd, [...composeArgs, "up", "-d"], { env });
  if (compose.status !== 0) {
    throw new Error(`docker compose up failed with exit code ${compose.status ?? "unknown"}`);
  }
  composeStarted = true;

  worker = spawn(process.execPath, [WORKER_PATH], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  await waitForHealth(baseUrl, 60_000);
  console.log(`agentmemory is healthy at ${baseUrl}`);
  return runLiveSuite(env);
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    cleanup().finally(() => process.exit(exitCode));
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(cleanup);
