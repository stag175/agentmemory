import { cpSync, existsSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const bundledPackages = [
  {
    name: "iii-sdk",
    source: "vendor/iii-sdk-compat",
    destination: "node_modules/iii-sdk",
  },
  {
    name: "@opentelemetry/resources",
    source: "vendor/opentelemetry-resources-compat",
    destination: "node_modules/@opentelemetry/resources",
  },
  {
    name: "@opentelemetry/sdk-logs",
    source: "vendor/opentelemetry-sdk-logs-compat",
    destination: "node_modules/@opentelemetry/sdk-logs",
  },
];

function assertInsideRoot(path) {
  const absolute = resolve(ROOT, path);
  const relative = absolute.slice(ROOT.length);
  if (!absolute.startsWith(ROOT) || relative.includes("..")) {
    throw new Error(`Refusing path outside repository: ${path}`);
  }
  return absolute;
}

function copyPackage({ name, source, destination }) {
  const sourcePath = assertInsideRoot(source);
  const destinationPath = assertInsideRoot(destination);
  if (!existsSync(join(sourcePath, "package.json"))) {
    throw new Error(`Missing package.json for bundled dependency ${name}: ${sourcePath}`);
  }
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Bundled dependency source is not a directory: ${sourcePath}`);
  }

  rmSync(destinationPath, { recursive: true, force: true });
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
  });
  console.error(`prepared bundled dependency ${name}`);
}

for (const pkg of bundledPackages) {
  copyPackage(pkg);
}
