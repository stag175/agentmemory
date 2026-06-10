import { join, resolve } from "node:path";

export function agentmemoryHome(home: string): string {
  return join(home, ".agentmemory");
}

export function runtimeConfigPath(home: string): string {
  return join(agentmemoryHome(home), "iii-config.runtime.yaml");
}

export function isBundledConfig(configPath: string, packageDir: string): boolean {
  const resolved = resolve(configPath);
  return (
    resolved === resolve(join(packageDir, "iii-config.yaml")) ||
    resolved === resolve(join(packageDir, "..", "iii-config.yaml"))
  );
}

export function resolveEngineCwd(
  configPath: string,
  invocationCwd: string,
  home: string,
): string {
  if (resolve(configPath) === resolve(join(invocationCwd, "iii-config.yaml"))) {
    return invocationCwd;
  }
  return agentmemoryHome(home);
}

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function rewriteBundledConfig(
  raw: string,
  home: string,
  nodeBin: string,
  workerEntry: string,
): string {
  const dataDir = join(agentmemoryHome(home), "data");
  return raw
    .replace(
      "file_path: ./data/state_store.db",
      `file_path: ${yamlSingleQuote(join(dataDir, "state_store.db"))}`,
    )
    .replace(
      "file_path: ./data/stream_store",
      `file_path: ${yamlSingleQuote(join(dataDir, "stream_store"))}`,
    )
    .replace("- src/**/*.ts", `- ${yamlSingleQuote(workerEntry)}`)
    .replace(
      "- node dist/index.mjs",
      `- ${yamlSingleQuote(`"${nodeBin}" "${workerEntry}"`)}`,
    );
}

export interface DataMigration {
  from: string;
  to: string;
}

export function legacyDataMigrations(invocationCwd: string, home: string): DataMigration[] {
  const dataDir = join(agentmemoryHome(home), "data");
  return [
    {
      from: join(invocationCwd, "data", "state_store.db"),
      to: join(dataDir, "state_store.db"),
    },
    {
      from: join(invocationCwd, "data", "stream_store"),
      to: join(dataDir, "stream_store"),
    },
  ];
}
