# @agentmemory/github-watcher

GitHub connector for agentmemory. Polls a repository's issues, pull requests, and discussions and emits an observation to the running agentmemory server every time an item is created or updated.

Part of the data-source-connectors effort tracked in issue #62.

## Install

```bash
npm install -g @agentmemory/github-watcher
```

Or run without installing:

```bash
npx @agentmemory/github-watcher owner/repo
```

> `@agentmemory/github-watcher` ships to npm with the next agentmemory
> release (it is wired into the publish workflow). Until it appears on
> the registry, run it straight from a checkout:
> `node integrations/github-watcher/bin.mjs owner/repo`.

## Usage

```bash
# CLI arg wins over env.
GITHUB_TOKEN=ghp_... agentmemory-github-watcher rohitg00/agentmemory

# Or set env once in your shell.
export GITHUB_REPO=rohitg00/agentmemory
export GITHUB_TOKEN=ghp_...
export AGENTMEMORY_URL=http://localhost:3111
export AGENTMEMORY_SECRET=...   # only if the server requires auth
agentmemory-github-watcher
```

Every new or updated issue, pull request, and discussion becomes a `post_tool_use` observation whose `data.source` is `github-watcher` and `data.type` is `github_issue`, `github_pull_request`, or `github_discussion`. The first 4 KB of each item body is included in `data.content` so retrieval can match by substring; longer bodies are truncated. Items are deduped by `id` + `updatedAt`, so a steady poll only re-emits an item when it actually changes.

Session id and project are required by the observe endpoint — set them via env, or the watcher generates a per-process `github-watcher-<ts>-<rand>` session id and uses `owner/repo` as the project.

Requires Node.js **>=20 LTS** (global `fetch` and `AbortSignal.timeout`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GITHUB_REPO` | — | Repository to watch, as `owner/repo` |
| `GITHUB_TOKEN` | — | GitHub token; strongly recommended (unauthenticated requests are rate limited and discussions need a token) |
| `GITHUB_POLL_INTERVAL` | `60` | Poll interval in seconds |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base (set for GitHub Enterprise) |
| `GITHUB_WATCH_ISSUES` | `1` | `0` to skip issues |
| `GITHUB_WATCH_PULLS` | `1` | `0` to skip pull requests |
| `GITHUB_WATCH_DISCUSSIONS` | `1` | `0` to skip discussions |
| `AGENTMEMORY_URL` | `http://localhost:3111` | agentmemory server URL |
| `AGENTMEMORY_SECRET` | — | Bearer token, required if the server has `AGENTMEMORY_SECRET` set |
| `AGENTMEMORY_PROJECT` | — | Optional project label attached to each observation |
| `AGENTMEMORY_SESSION_ID` | — | Optional session id to attribute observations to |

## Wire format

Each observation matches the shared `/agentmemory/observe` payload used by the filesystem connector:

```jsonc
{
  "hookType": "post_tool_use",
  "sessionId": "github-watcher-...",
  "project": "owner/repo",
  "cwd": "owner/repo",
  "timestamp": "2026-06-29T00:00:00.000Z",
  "data": {
    "source": "github-watcher",
    "type": "github_issue",
    "id": "github_issue:123",
    "updatedAt": "2026-06-29T00:00:00Z",
    "content": "owner/repo#123 Title\n\nBody preview...",
    "metadata": {
      "repo": "owner/repo",
      "kind": "issue",
      "number": 123,
      "title": "Title",
      "state": "open",
      "url": "https://github.com/owner/repo/issues/123",
      "author": "octocat",
      "labels": ["bug"]
    }
  }
}
```

## Notes

- Uses Node's built-in `fetch` with `AbortSignal.timeout`. No native deps.
- Issues and pull requests are read from the REST API (`GET /repos/{owner}/{repo}/issues?state=all&sort=updated`); the issues endpoint returns PRs too, distinguished by the `pull_request` field. Discussions are read from the GraphQL API and require a token.
- Pagination follows `per_page` pages up to a safety cap; the loop stops early once a short page is returned.
- Rate-limit headers (`x-ratelimit-remaining` / `x-ratelimit-reset`) are honored — when exhausted the watcher backs off until the reset time instead of hammering the API.
- A single malformed item is logged and skipped; it never aborts the batch or crashes the poll loop.
- The process must keep running. Use a process manager (`launchd`, `systemd`, `pm2`) to supervise it.
- This connector is intentionally one-way: it writes observations and never reads the agentmemory store.
