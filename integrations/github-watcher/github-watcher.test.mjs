import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GitHubWatcher,
  configFromEnv,
  parseRepo,
  mapIssue,
  mapDiscussion,
} from "./watcher.mjs";

const REPO = { owner: "acme", name: "widgets" };

function ghResponse(payload, { status = 200, headers = {} } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headerMap.has(k.toLowerCase()) ? headerMap.get(k.toLowerCase()) : null) },
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

function issueFixture(over = {}) {
  return {
    number: 1,
    title: "Login is broken",
    body: "Steps to reproduce: click login.",
    state: "open",
    html_url: "https://github.com/acme/widgets/issues/1",
    user: { login: "octocat" },
    labels: [{ name: "bug" }],
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
    ...over,
  };
}

function prFixture(over = {}) {
  return {
    number: 2,
    title: "Fix login",
    body: "This patches the login flow.",
    state: "open",
    draft: false,
    html_url: "https://github.com/acme/widgets/pull/2",
    user: { login: "hubber" },
    labels: [],
    pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/2" },
    created_at: "2026-06-03T00:00:00Z",
    updated_at: "2026-06-04T00:00:00Z",
    ...over,
  };
}

function discussionNode(over = {}) {
  return {
    number: 7,
    title: "Roadmap ideas",
    body: "What should we build next?",
    url: "https://github.com/acme/widgets/discussions/7",
    state: false,
    createdAt: "2026-06-05T00:00:00Z",
    updatedAt: "2026-06-06T00:00:00Z",
    author: { login: "thinker" },
    category: { name: "Ideas" },
    ...over,
  };
}

describe("mapping to the observe wire format", () => {
  it("maps an issue to a github_issue observation payload", () => {
    const obs = mapIssue(issueFixture(), REPO);
    expect(obs.source).toBe("github-watcher");
    expect(obs.type).toBe("github_issue");
    expect(obs.id).toBe("github_issue:1");
    expect(obs.updatedAt).toBe("2026-06-02T00:00:00Z");
    expect(obs.content).toContain("acme/widgets#1 Login is broken");
    expect(obs.content).toContain("Steps to reproduce");
    expect(obs.metadata.kind).toBe("issue");
    expect(obs.metadata.number).toBe(1);
    expect(obs.metadata.state).toBe("open");
    expect(obs.metadata.author).toBe("octocat");
    expect(obs.metadata.labels).toEqual(["bug"]);
    expect(obs.metadata.url).toBe("https://github.com/acme/widgets/issues/1");
  });

  it("maps a pull request (issue with pull_request) to a github_pull_request observation", () => {
    const obs = mapIssue(prFixture(), REPO);
    expect(obs.type).toBe("github_pull_request");
    expect(obs.id).toBe("github_pull_request:2");
    expect(obs.metadata.kind).toBe("pull_request");
    expect(obs.metadata.draft).toBe(false);
  });

  it("maps a discussion node to a github_discussion observation", () => {
    const obs = mapDiscussion(discussionNode(), REPO);
    expect(obs.source).toBe("github-watcher");
    expect(obs.type).toBe("github_discussion");
    expect(obs.id).toBe("github_discussion:7");
    expect(obs.updatedAt).toBe("2026-06-06T00:00:00Z");
    expect(obs.content).toContain("discussion #7 Roadmap ideas");
    expect(obs.metadata.kind).toBe("discussion");
    expect(obs.metadata.category).toBe("Ideas");
    expect(obs.metadata.state).toBe("open");
  });
});

describe("GitHubWatcher.poll", () => {
  const originalFetch = globalThis.fetch;
  let captured;
  let logger;

  function installFetch({ issues = [], discussions = [], rateRemaining = "5000" } = {}) {
    captured = [];
    (globalThis).fetch = vi.fn(async (url, init) => {
      const u = url.toString();
      if (u.includes("/agentmemory/observe")) {
        captured.push(JSON.parse(init.body));
        return ghResponse({}, { status: 200 });
      }
      if (u.includes("/graphql")) {
        return ghResponse(
          {
            data: {
              repository: {
                discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: discussions },
              },
            },
          },
          { headers: { "x-ratelimit-remaining": rateRemaining } },
        );
      }
      if (u.includes("/issues")) {
        return ghResponse(issues, { headers: { "x-ratelimit-remaining": rateRemaining } });
      }
      return ghResponse({}, { status: 404 });
    });
  }

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeWatcher(over = {}) {
    return new GitHubWatcher({
      repo: "acme/widgets",
      token: "ghp_test",
      baseUrl: "http://localhost:3111",
      logger,
      ...over,
    });
  }

  it("emits issues, PRs, and discussions as observe payloads with the shared wire shape", async () => {
    installFetch({ issues: [issueFixture(), prFixture()], discussions: [discussionNode()] });
    const w = makeWatcher();
    const emitted = await w.poll();

    expect(emitted).toBe(3);
    expect(captured).toHaveLength(3);

    for (const body of captured) {
      expect(body.hookType).toBe("post_tool_use");
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId.length).toBeGreaterThan(0);
      expect(body.project).toBe("acme/widgets");
      expect(typeof body.cwd).toBe("string");
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.data.source).toBe("github-watcher");
    }

    const types = captured.map((b) => b.data.type).sort();
    expect(types).toEqual(["github_discussion", "github_issue", "github_pull_request"]);
  });

  it("dedupes by id + updatedAt across polls and re-emits only when updatedAt changes", async () => {
    installFetch({ issues: [issueFixture()], discussions: [] });
    const w = makeWatcher({ includeDiscussions: false });

    expect(await w.poll()).toBe(1);
    // Second poll, same id and same updatedAt -> deduped.
    expect(await w.poll()).toBe(0);

    // Now the same issue is updated (new updatedAt) -> re-emitted.
    installFetch({ issues: [issueFixture({ updated_at: "2026-06-09T00:00:00Z" })], discussions: [] });
    // Reuse the watcher's seen map by swapping fetch only.
    expect(await w.poll()).toBe(1);
  });

  it("does not abort the batch when a single item is malformed", async () => {
    const good = issueFixture({ number: 10, updated_at: "2026-06-10T00:00:00Z" });
    const malformed = null; // missing entirely; mapping must not crash the loop
    const alsoGood = issueFixture({ number: 11, updated_at: "2026-06-11T00:00:00Z" });
    installFetch({ issues: [good, malformed, alsoGood], discussions: [] });
    const w = makeWatcher({ includeDiscussions: false });

    const emitted = await w.poll();
    expect(emitted).toBe(2);
    const numbers = captured.map((b) => b.data.metadata.number).sort();
    expect(numbers).toEqual([10, 11]);
  });

  it("backs off when the GitHub rate limit is exhausted", async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    captured = [];
    (globalThis).fetch = vi.fn(async (url, init) => {
      const u = url.toString();
      if (u.includes("/agentmemory/observe")) {
        captured.push(JSON.parse(init.body));
        return ghResponse({}, { status: 200 });
      }
      return ghResponse([], {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(future) },
      });
    });
    const w = makeWatcher({ includeDiscussions: false });
    await w.poll();
    expect(w.isRateLimited()).toBe(true);
    expect(captured).toHaveLength(0);
  });
});

describe("parseRepo", () => {
  it("parses owner/repo and strips github URL + .git suffix", () => {
    expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepo("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      name: "widgets",
    });
  });

  it("throws on a malformed repo string", () => {
    expect(() => parseRepo("not-a-repo")).toThrow(/owner\/repo/);
  });
});

describe("configFromEnv", () => {
  it("reads GitHub and agentmemory env vars", () => {
    const cfg = configFromEnv({
      GITHUB_REPO: "acme/widgets",
      GITHUB_TOKEN: "ghp_x",
      GITHUB_POLL_INTERVAL: "30",
      AGENTMEMORY_URL: "http://localhost:3111",
      AGENTMEMORY_SECRET: "tok",
      AGENTMEMORY_PROJECT: "demo",
      GITHUB_WATCH_DISCUSSIONS: "0",
    });
    expect(cfg.repo).toBe("acme/widgets");
    expect(cfg.token).toBe("ghp_x");
    expect(cfg.pollIntervalMs).toBe(30000);
    expect(cfg.baseUrl).toBe("http://localhost:3111");
    expect(cfg.secret).toBe("tok");
    expect(cfg.project).toBe("demo");
    expect(cfg.includeDiscussions).toBe(false);
    expect(cfg.includeIssues).toBe(true);
  });

  it("defaults the poll interval to 0 when unset (watcher applies its own default)", () => {
    const cfg = configFromEnv({});
    expect(cfg.pollIntervalMs).toBe(0);
    expect(cfg.includeIssues).toBe(true);
  });
});
