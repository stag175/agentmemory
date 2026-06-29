#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyIfPresent(from, toDir) {
  const source = join(ROOT, from);
  if (!existsSync(source)) return;
  mkdirSync(join(ROOT, toDir), { recursive: true });
  copyFileSync(source, join(ROOT, toDir, from.split(/[\\/]/).pop()));
}

for (const file of [
  "iii-config.yaml",
  "iii-config.docker.yaml",
  "docker-compose.yml",
  ".env.example",
]) {
  copyIfPresent(file, "dist");
}

copyIfPresent("src/viewer/index.html", "dist/viewer");
copyIfPresent("src/viewer/favicon.svg", "dist/viewer");
