import { randomBytes } from "node:crypto";

const GITHUB_API = "https://api.github.com";
const DEFAULT_POLL_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;
const PER_PAGE = 50;
const MAX_PAGES = 10;
const MAX_BODY_PREVIEW = 4096;

const DISCUSSIONS_QUERY = `query($owner:String!,$name:String!,$first:Int!,$after:String){
  repository(owner:$owner,name:$name){
    discussions(first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{
        number title body url state:closed createdAt updatedAt
        author{ login }
        category{ name }
      }
    }
  }
}`;

function truncate(value, max = MAX_BODY_PREVIEW) {
  if (typeof value !== "string") return value;
  return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

export function parseRepo(repo) {
  const trimmed = asString(repo).trim().replace(/^https?:\/\/github\.com\//i, "");
  const cleaned = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `github-watcher: GITHUB_REPO must be "owner/repo" (got ${JSON.stringify(repo)})`,
    );
  }
  return { owner: parts[0], name: parts[1] };
}

export function mapIssue(issue, repo) {
  const isPull = Boolean(issue.pull_request);
  const type = isPull ? "github_pull_request" : "github_issue";
  const number = issue.number;
  const title = asString(issue.title);
  const body = truncate(asString(issue.body));
  const head = `${repo.owner}/${repo.name}#${number} ${title}`.trim();
  return {
    source: "github-watcher",
    type,
    dedupeKey: `${type}:${number}`,
    id: `${type}:${number}`,
    updatedAt: asString(issue.updated_at),
    content: body ? `${head}\n\n${body}` : head,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      kind: isPull ? "pull_request" : "issue",
      number,
      title,
      state: asString(issue.state),
      url: asString(issue.html_url),
      author: asString(issue.user?.login),
      labels: Array.isArray(issue.labels)
        ? issue.labels
            .map((l) => (typeof l === "string" ? l : asString(l?.name)))
            .filter(Boolean)
        : [],
      createdAt: asString(issue.created_at),
      updatedAt: asString(issue.updated_at),
      draft: isPull ? Boolean(issue.draft) : undefined,
    },
  };
}

export function mapDiscussion(node, repo) {
  const number = node.number;
  const title = asString(node.title);
  const body = truncate(asString(node.body));
  const head = `${repo.owner}/${repo.name} discussion #${number} ${title}`.trim();
  return {
    source: "github-watcher",
    type: "github_discussion",
    dedupeKey: `github_discussion:${number}`,
    id: `github_discussion:${number}`,
    updatedAt: asString(node.updatedAt),
    content: body ? `${head}\n\n${body}` : head,
    metadata: {
      repo: `${repo.owner}/${repo.name}`,
      kind: "discussion",
      number,
      title,
      state: node.state ? "closed" : "open",
      url: asString(node.url),
      author: asString(node.author?.login),
      category: asString(node.category?.name),
      createdAt: asString(node.createdAt),
      updatedAt: asString(node.updatedAt),
    },
  };
}

export class GitHubWatcher {
  constructor(config = {}) {
    this.repo = parseRepo(config.repo);
    this.token = config.token;
    this.baseUrl = (config.baseUrl || "http://localhost:3111").replace(/\/+$/, "");
    this.apiUrl = (config.apiUrl || GITHUB_API).replace(/\/+$/, "");
    this.secret = config.secret;
    this.pollIntervalMs = config.pollIntervalMs || DEFAULT_POLL_MS;
    this.project = config.project || `${this.repo.owner}/${this.repo.name}`;
    this.sessionId =
      config.sessionId ||
      `github-watcher-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.includeIssues = config.includeIssues !== false;
    this.includePulls = config.includePulls !== false;
    this.includeDiscussions = config.includeDiscussions !== false;
    this.logger = config.logger || console;
    this.seen = new Map();
    this.timer = null;
    this.running = false;
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;
  }

  githubHeaders() {
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": "agentmemory-github-watcher",
      "x-github-api-version": "2022-11-28",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  noteRateLimit(res) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (remaining !== null) this.rateLimitRemaining = Number(remaining);
    if (reset !== null) this.rateLimitReset = Number(reset) * 1000;
  }

  isRateLimited() {
    if (this.rateLimitRemaining !== null && this.rateLimitRemaining <= 0) {
      if (this.rateLimitReset && this.rateLimitReset > Date.now()) return true;
    }
    return false;
  }

  isDuplicate(item) {
    const key = item.dedupeKey || item.id;
    if (!key) return false;
    const prev = this.seen.get(key);
    if (prev !== undefined && prev === item.updatedAt) return true;
    this.seen.set(key, item.updatedAt);
    return false;
  }

  async githubFetch(path) {
    const url = path.startsWith("http") ? path : `${this.apiUrl}${path}`;
    let res;
    try {
      res = await fetch(url, {
        headers: this.githubHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn?.(`[github-watcher] fetch failed for ${path}: ${err?.message || err}`);
      return null;
    }
    this.noteRateLimit(res);
    if (res.status === 403 && this.rateLimitRemaining === 0) {
      this.logger.warn?.("[github-watcher] rate limited; backing off until reset");
      return null;
    }
    if (!res.ok) {
      this.logger.warn?.(
        `[github-watcher] GitHub ${res.status} for ${path}: ${await res
          .text()
          .catch(() => "")}`,
      );
      return null;
    }
    try {
      return await res.json();
    } catch (err) {
      this.logger.warn?.(`[github-watcher] bad JSON for ${path}: ${err?.message || err}`);
      return null;
    }
  }

  async fetchIssues() {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (this.isRateLimited()) break;
      const path =
        `/repos/${this.repo.owner}/${this.repo.name}/issues` +
        `?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`;
      const batch = await this.githubFetch(path);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const raw of batch) {
        try {
          const isPull = Boolean(raw?.pull_request);
          if (isPull && !this.includePulls) continue;
          if (!isPull && !this.includeIssues) continue;
          items.push(mapIssue(raw, this.repo));
        } catch (err) {
          this.logger.warn?.(
            `[github-watcher] skipped malformed issue: ${err?.message || err}`,
          );
        }
      }
      if (batch.length < PER_PAGE) break;
    }
    return items;
  }

  async fetchDiscussions() {
    const items = [];
    let after = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (this.isRateLimited()) break;
      let res;
      try {
        res = await fetch(`${this.apiUrl}/graphql`, {
          method: "POST",
          headers: { ...this.githubHeaders(), "content-type": "application/json" },
          body: JSON.stringify({
            query: DISCUSSIONS_QUERY,
            variables: {
              owner: this.repo.owner,
              name: this.repo.name,
              first: PER_PAGE,
              after,
            },
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        this.logger.warn?.(
          `[github-watcher] discussions fetch failed: ${err?.message || err}`,
        );
        break;
      }
      this.noteRateLimit(res);
      if (!res.ok) {
        this.logger.warn?.(`[github-watcher] discussions GraphQL ${res.status}`);
        break;
      }
      let json;
      try {
        json = await res.json();
      } catch {
        break;
      }
      const conn = json?.data?.repository?.discussions;
      const nodes = Array.isArray(conn?.nodes) ? conn.nodes : [];
      if (json?.errors?.length) {
        this.logger.warn?.(
          `[github-watcher] discussions GraphQL errors: ${json.errors
            .map((e) => e?.message)
            .filter(Boolean)
            .join("; ")}`,
        );
      }
      for (const node of nodes) {
        try {
          if (!node) continue;
          items.push(mapDiscussion(node, this.repo));
        } catch (err) {
          this.logger.warn?.(
            `[github-watcher] skipped malformed discussion: ${err?.message || err}`,
          );
        }
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return items;
  }

  async emit(item) {
    const headers = { "content-type": "application/json" };
    if (this.secret) headers.authorization = `Bearer ${this.secret}`;
    const payload = {
      hookType: "post_tool_use",
      sessionId: this.sessionId,
      project: this.project,
      cwd: `${this.repo.owner}/${this.repo.name}`,
      timestamp: new Date().toISOString(),
      data: item,
    };
    try {
      const res = await fetch(`${this.baseUrl}/agentmemory/observe`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn?.(
          `[github-watcher] observe ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
    } catch (err) {
      this.logger.warn?.(`[github-watcher] observe failed: ${err?.message || err}`);
    }
  }

  async poll() {
    const collected = [];
    if (this.includeIssues || this.includePulls) {
      try {
        collected.push(...(await this.fetchIssues()));
      } catch (err) {
        this.logger.warn?.(`[github-watcher] issue poll failed: ${err?.message || err}`);
      }
    }
    if (this.includeDiscussions) {
      try {
        collected.push(...(await this.fetchDiscussions()));
      } catch (err) {
        this.logger.warn?.(
          `[github-watcher] discussion poll failed: ${err?.message || err}`,
        );
      }
    }
    let emitted = 0;
    for (const item of collected) {
      try {
        if (this.isDuplicate(item)) continue;
        await this.emit(item);
        emitted++;
      } catch (err) {
        this.logger.warn?.(`[github-watcher] emit failed: ${err?.message || err}`);
      }
    }
    return emitted;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.poll()
        .catch((err) =>
          this.logger.warn?.(`[github-watcher] poll cycle failed: ${err?.message || err}`),
        )
        .finally(() => {
          if (!this.running) return;
          this.timer = setTimeout(tick, this.pollIntervalMs);
          this.timer.unref?.();
        });
    };
    tick();
    this.logger.info?.(
      `[github-watcher] polling ${this.repo.owner}/${this.repo.name} every ${this.pollIntervalMs}ms`,
    );
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function configFromEnv(env = process.env) {
  const pollSeconds = Number(env.GITHUB_POLL_INTERVAL || env.AGENTMEMORY_GITHUB_POLL || "");
  return {
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    baseUrl: env.AGENTMEMORY_URL,
    apiUrl: env.GITHUB_API_URL,
    secret: env.AGENTMEMORY_SECRET,
    project: env.AGENTMEMORY_PROJECT || null,
    sessionId: env.AGENTMEMORY_SESSION_ID || null,
    pollIntervalMs: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds * 1000 : 0,
    includeIssues: env.GITHUB_WATCH_ISSUES !== "0",
    includePulls: env.GITHUB_WATCH_PULLS !== "0",
    includeDiscussions: env.GITHUB_WATCH_DISCUSSIONS !== "0",
  };
}
