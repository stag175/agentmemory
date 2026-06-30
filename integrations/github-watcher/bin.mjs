#!/usr/bin/env node
import { GitHubWatcher, configFromEnv } from "./watcher.mjs";

const cliArgs = process.argv.slice(2);
const envCfg = configFromEnv(process.env);

const repo = cliArgs.length > 0 ? cliArgs[0] : envCfg.repo;
if (!repo) {
  process.stderr.write(
    "agentmemory-github-watcher: no repository to watch.\n" +
      "Usage: agentmemory-github-watcher <owner/repo>\n" +
      "Or set GITHUB_REPO=owner/repo\n" +
      "Requires GITHUB_TOKEN for authenticated polling.\n",
  );
  process.exit(2);
}

if (!envCfg.token) {
  process.stderr.write(
    "[github-watcher] warning: GITHUB_TOKEN is not set; unauthenticated requests are heavily rate limited.\n",
  );
}

const watcher = new GitHubWatcher({ ...envCfg, repo });
watcher.start();
process.stderr.write(
  `[github-watcher] emitting to ${envCfg.baseUrl || "http://localhost:3111"}\n`,
);

const shutdown = () => {
  watcher.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
