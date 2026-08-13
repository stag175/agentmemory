import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadViewerSandbox() {
  const rendered = renderViewerDocument();
  expect(rendered.found).toBe(true);
  if (!rendered.found) throw new Error("viewer document not found");

  const scriptMatch = rendered.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  expect(scriptMatch).not.toBeNull();
  if (!scriptMatch) throw new Error("viewer script not found");

  const elements = new Map<string, any>();
  const createMockElement = (id = "") => {
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    return {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      checked: false,
      dataset: {},
      style: {},
      listeners,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
      },
      addEventListener: (type: string, handler: (event?: unknown) => void) => {
        const current = listeners.get(type) || [];
        current.push(handler);
        listeners.set(type, current);
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: unknown) => {
        attributes.set(name, String(value));
      },
      // Added in #313 — switchTab toggles aria-selected via removeAttribute
      // on the non-active tab buttons. The mock previously only had
      // get/setAttribute, so the new hash-routing path threw TypeError.
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
      querySelectorAll: () => [],
    };
  };
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };

  const tabs = [
    "dashboard",
    "graph",
    "memories",
    "timeline",
    "sessions",
    "lessons",
    "actions",
    "crystals",
    "audit",
    "activity",
    "profile",
    "replay",
  ];
  const tabButtons = tabs.map((tab) => ({ ...createMockElement(), dataset: { tab } }));
  const views = tabs.map((tab) => ({ ...createMockElement(`view-${tab}`), id: `view-${tab}` }));
  const checkboxes = [createMockElement(), createMockElement()].map((el) => ({ ...el, checked: false }));
  const querySelectorAll = (selector: string) => {
    if (selector === ".tab-bar button") return tabButtons;
    if (selector === ".view") return views;
    if (selector === 'input[type="checkbox"]') return checkboxes;
    return [];
  };

  const document = {
    documentElement: { dataset: {} },
    createElement: () => {
      let text = "";
      return {
        set textContent(value: unknown) {
          text = String(value ?? "");
        },
        get innerHTML() {
          return htmlEscape(text);
        },
      };
    },
    getElementById: getElement,
    querySelectorAll,
    addEventListener: () => {},
  };

  const sandbox: Record<string, any> = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document,
    window: {
      location: {
        search: "",
        port: "3113",
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3113",
        origin: "http://localhost:3113",
      },
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
    },
    // Stubbed in #313 — the viewer now calls history.replaceState
    // inside updateTabRoute → switchTab to drive the hash-route surface.
    // The vm sandbox is otherwise zero-globals so the call would
    // throw ReferenceError. No-op is fine for the rendering tests.
    history: { replaceState: () => {}, pushState: () => {} },
    location: {
      hash: "",
      pathname: "/",
      search: "",
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: (() => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      };
    })(),
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function WebSocket() {},
    navigator: { userAgent: "vitest" },
    Element: function Element() {},
    alert: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    URLSearchParams,
    Date,
    Math,
    Promise,
    JSON,
    Array,
    Object,
    String,
    Number,
    parseInt,
    encodeURIComponent,
  };

  const scriptWithoutAutoStart = scriptMatch[1].replace(
    /\n\s*loadTab\('dashboard'\);\n\s*connectWs\(\);\n\s*startDashboardAutoRefresh\(\);\s*$/,
    "\n",
  );

  vm.createContext(sandbox);
  vm.runInContext(scriptWithoutAutoStart, sandbox);

  return { sandbox, getElement };
}

describe("viewer session rendering", () => {
  it("attaches the saved viewer bearer to API calls", async () => {
    const { sandbox } = loadViewerSandbox();
    const requests: Array<{ url: string; opts: { headers?: Record<string, string> } }> = [];
    sandbox.sessionStorage.setItem("agentmemory-viewer-token", "viewer-secret");
    sandbox.fetch = async (url: string, opts: { headers?: Record<string, string> }) => {
      requests.push({ url, opts });
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await sandbox.apiGet("health");

    expect(requests).toHaveLength(1);
    expect(requests[0].opts.headers?.Authorization).toBe("Bearer viewer-secret");
  });

  it("shows where to find AGENTMEMORY_SECRET after a viewer auth failure", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

    await sandbox.apiGet("health");

    const prompt = getElement("viewer-auth");
    expect(prompt.classList.contains("open")).toBe(true);
    expect(prompt.innerHTML).toContain("AGENTMEMORY_SECRET");
    expect(prompt.innerHTML).toContain("unlock viewer API access");
    expect(prompt.innerHTML).not.toContain("fly logs");
    expect(prompt.innerHTML).not.toContain("/data/.hmac");
  });

  it("does not throw when dashboard sessions are missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessionsAvailable: true,
      sessions: [{ status: "active", observationCount: 3, startedAt: "2026-05-13T12:00:00Z" }],
      memoriesAvailable: true,
      memories: [],
      graphStats: null,
      recentEventsAvailable: true,
      recentEvents: [],
      lessons: [],
      crystals: [],
    };

    expect(() => sandbox.renderDashboard()).not.toThrow();
    expect(getElement("view-dashboard").innerHTML).toContain("Unknown session");
  });

  it("shows onboarding only when every primary persisted source is successfully empty", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const baseline = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessionsAvailable: true,
      sessions: [],
      memoriesAvailable: true,
      memories: [],
      graphStats: { totalNodes: 0, totalEdges: 0 },
      recentEventsAvailable: true,
      recentEvents: [],
      lessons: [],
      crystals: [],
    };

    sandbox.state.dashboard = { ...baseline };
    sandbox.renderDashboard();
    expect(getElement("view-dashboard").innerHTML).toContain("First run");

    sandbox.state.dashboard = { ...baseline, memories: [{ id: "mem_1" }] };
    sandbox.renderDashboard();
    expect(getElement("view-dashboard").innerHTML).not.toContain("First run");

    sandbox.state.dashboard = { ...baseline, recentEvents: [{ id: "event_1" }] };
    sandbox.renderDashboard();
    expect(getElement("view-dashboard").innerHTML).not.toContain("First run");
  });

  it("preserves the last-known session count when refresh data is unavailable", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessionsAvailable: false,
      sessions: [{ id: "ses_1", project: "billing", status: "completed", observationCount: 2, startedAt: "2026-05-13T12:00:00Z" }],
      memoriesAvailable: true,
      memories: [],
      graphStats: null,
      recentEventsAvailable: true,
      recentEvents: [],
      lessons: [],
      crystals: [],
    };

    sandbox.renderDashboard();
    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Session data temporarily unavailable");
    expect(html).toContain("last known · unavailable");
    expect(html).not.toContain("First run");
  });

  it("does not throw when timeline and sessions tabs receive sessions missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const sessions = [{ status: "active", observationCount: 1, startedAt: "2026-05-13T12:00:00Z" }];

    expect(() => sandbox.renderTimelineToolbar(sessions)).not.toThrow();
    expect(getElement("view-timeline").innerHTML).toContain("Unknown session");

    sandbox.state.sessions.items = sessions;
    expect(() => sandbox.renderSessions()).not.toThrow();
    expect(getElement("view-sessions").innerHTML).toContain("Unknown session");

    const tabButtons = sandbox.document.querySelectorAll(".tab-bar button");
    expect(tabButtons.length).toBeGreaterThan(0);
    expect(() => sandbox.switchTab("sessions")).not.toThrow();
    expect(tabButtons.some((button: any) => button.classList.contains("active"))).toBe(true);
  });

  it("loads dashboard activity from agent events and exposes truthful LLM queue state", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const requests: string[] = [];
    const responses: Record<string, unknown> = {
      health: {
        status: "healthy",
        health: {},
        functionMetrics: [
          {
            functionId: "mem::compress",
            totalCalls: 4,
            successCount: 3,
            failureCount: 1,
            avgLatencyMs: 2_500,
            maxLatencyMs: 7_500,
            avgQualityScore: 0,
            lastCallAt: "2026-08-13T17:00:00.000Z",
            lastSuccessAt: "2026-08-13T16:59:00.000Z",
          },
        ],
      },
      "sessions?agentId=*": {
        sessions: [
          {
            id: "session-live",
            project: "current-project",
            status: "active",
            observationCount: 4,
            startedAt: "2026-08-13T10:00:00.000Z",
            updatedAt: "2026-08-13T17:00:00.000Z",
          },
        ],
      },
      "memories?latest=true&limit=500&agentId=*": { memories: [] },
      "graph/stats": { totalNodes: 1, totalEdges: 0 },
      "agent-events?limit=10": {
        events: [
          {
            id: "event-1",
            type: "observation_recorded",
            timestamp: "2026-08-13T17:00:00.000Z",
            functionId: "mem::observe",
            metadata: {
              toolName: "Read",
              hookType: "post_tool_use",
              compression: "llm",
            },
          },
          {
            id: "event-2",
            type: "tool_failed",
            timestamp: "2026-08-13T16:59:30.000Z",
            functionId: "tool:Bash",
          },
        ],
      },
      semantic: { facts: [] },
      procedural: { procedures: [] },
      relations: { relations: [] },
      lessons: { lessons: [] },
      crystals: { crystals: [] },
      "llm-status": {
        enabled: true,
        reason: "auto_compress_enabled",
        waiting: 2,
        inFlight: 1,
        retrying: 1,
        failed: 3,
        succeeded: 8,
        rawOrphans: 0,
        oldestAge: 75,
        throughputPerMinute: 3.6,
        lastSuccess: "2026-08-13T16:59:00.000Z",
        provider: "openai-compatible",
        model: "local-model",
      },
    };
    sandbox.fetch = async (url: string) => {
      const path = url.split("/agentmemory/")[1];
      requests.push(path);
      return { ok: true, json: async () => responses[path] ?? {} };
    };

    await sandbox.loadDashboard();

    expect(requests).toContain("agent-events?limit=10");
    expect(requests).toContain("llm-status");
    expect(requests).not.toContain("audit?limit=5");
    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Observation captured");
    expect(html).toContain("Read · post tool use · LLM enrichment requested");
    expect(html).toContain("Tool failed");
    expect(html).toContain("LLM Jobs");
    expect(html).toContain("openai-compatible · local-model");
    expect(html).toContain("Live durable queue state");
    expect(html).toContain("Enrichment: Enabled");
    expect(html).toContain("3.6/min");
    expect(html).toContain("raw orphans 0");
    expect(html).toContain("Max Latency");
    expect(html).toContain("7500 ms");
    expect(html).toContain("Last Call");
  });

  it("falls back to LLM function metrics without inventing zero queue counts", () => {
    const { sandbox } = loadViewerSandbox();
    const jobs = sandbox.normalizeLlmJobs(null, [
      {
        functionId: "mem::compress",
        successCount: 7,
        failureCount: 2,
        lastCallAt: "2026-08-13T17:00:00.000Z",
        lastSuccessAt: "2026-08-13T16:59:00.000Z",
        lastFailureAt: "2026-08-13T16:58:00.000Z",
      },
    ]);

    expect(jobs.queueAvailable).toBe(false);
    expect(jobs.queued).toBeNull();
    expect(jobs.running).toBeNull();
    expect(jobs.retrying).toBeNull();
    expect(jobs.completed).toBe(7);
    expect(jobs.failed).toBe(2);
    expect(jobs.lastSuccessAt).toBe("2026-08-13T16:59:00.000Z");

    const html = sandbox.renderLlmJobsCard(null, [
      { functionId: "mem::compress", successCount: 7, failureCount: 2 },
    ]);
    expect(html).toContain("Queue status unavailable");
    expect(html).toContain("completed/failed inferred from function metrics");
    expect(html).toMatch(/<div class="label">Queued<\/div><div class="value">&mdash;<\/div>/);
    expect(html).not.toContain("HTTP");

    const unavailable = sandbox.normalizeLlmJobs(null, []);
    expect(unavailable.completed).toBeNull();
    expect(unavailable.failed).toBeNull();
    const unavailableHtml = sandbox.renderLlmJobsCard(null, []);
    expect(unavailableHtml).toMatch(/<div class="label">Completed<\/div><div class="value">&mdash;<\/div>/);
    expect(unavailableHtml).toMatch(/<div class="label">Failed<\/div><div class="value">&mdash;<\/div>/);
  });

  it("orders sessions by latest activity and labels updated time", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const sessions = [
      {
        id: "new-start-old-activity",
        project: "started-later",
        status: "completed",
        observationCount: 1,
        startedAt: "2026-08-13T15:00:00.000Z",
        updatedAt: "2026-08-13T15:01:00.000Z",
      },
      {
        id: "old-start-new-activity",
        project: "active-now",
        status: "active",
        observationCount: 2,
        startedAt: "2026-08-13T10:00:00.000Z",
        updatedAt: "2026-08-13T17:00:00.000Z",
      },
    ];
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {}, functionMetrics: [] },
      sessionsAvailable: true,
      sessions,
      memoriesAvailable: true,
      memories: [],
      graphStats: { totalNodes: 1, totalEdges: 0 },
      recentEventsAvailable: true,
      recentEvents: [],
      llmStatus: null,
      lessons: [],
      crystals: [],
    };

    sandbox.renderDashboard();
    const dashboardHtml = getElement("view-dashboard").innerHTML;
    expect(dashboardHtml).toContain("<th>Activity</th>");
    expect(dashboardHtml.indexOf("active-now")).toBeLessThan(
      dashboardHtml.indexOf("started-later"),
    );

    sandbox.state.sessions.items = sessions;
    sandbox.renderSessions();
    const sessionsHtml = getElement("view-sessions").innerHTML;
    expect(sessionsHtml.indexOf("active-now")).toBeLessThan(
      sessionsHtml.indexOf("started-later"),
    );
    expect(sessionsHtml).toContain("Updated");
    expect(sessionsHtml).toContain("Started");

    sandbox.renderTimelineToolbar(sessions);
    const timelineHtml = getElement("view-timeline").innerHTML;
    expect(timelineHtml.indexOf("active-now")).toBeLessThan(
      timelineHtml.indexOf("started-later"),
    );
  });

  it("loads twenty recent session histories by updatedAt and deduplicates observations", async () => {
    const { sandbox } = loadViewerSandbox();
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      id: `session-${index}`,
      project: `project-${index}`,
      status: "completed",
      startedAt: `2026-08-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      updatedAt: `2026-08-${String(index + 10).padStart(2, "0")}T17:00:00.000Z`,
    }));
    const paths: string[] = [];
    sandbox.apiGet = async (path: string) => {
      paths.push(path);
      if (path === "sessions?agentId=*") return { sessions };
      const id = new URLSearchParams(path.split("?")[1]).get("sessionId");
      if (id === "session-7") {
        return {
          observations: [
            { id: "shared", sessionId: id, timestamp: "2026-08-17T17:00:00.000Z", hookType: "post_tool_use", toolName: "Read" },
            { id: "shared", sessionId: id, timestamp: "2026-08-17T17:00:00.000Z", type: "file_read", narrative: "Compressed result" },
          ],
        };
      }
      return { observations: [{ id: `obs-${id}`, sessionId: id, timestamp: "2026-08-13T17:00:00.000Z" }] };
    };

    await sandbox.loadActivity();

    const observationPaths = paths.filter((path) => path.startsWith("observations?"));
    expect(observationPaths).toHaveLength(8);
    expect(observationPaths[0]).toContain("sessionId=session-7");
    expect(observationPaths.every((path) => path.endsWith("&agentId=*"))).toBe(true);
    expect(sandbox.state.activity.observations).toHaveLength(8);
    expect(sandbox.state.activity.observations.find((o: any) => o.id === "shared").narrative).toBe(
      "Compressed result",
    );
  });

  it("replaces a streamed raw observation with its compressed form instead of duplicating it", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.activeTab = "activity";
    sandbox.state.activity.observations = [
      {
        id: "obs-1",
        sessionId: "session-1",
        timestamp: "2026-08-13T17:00:00.000Z",
        hookType: "post_tool_use",
        toolName: "Read",
        enrichmentStatus: "queued",
      },
    ];

    sandbox.routeWsMessage({
      observation: {
        id: "obs-1",
        sessionId: "session-1",
        timestamp: "2026-08-13T17:00:00.000Z",
        type: "file_read",
        narrative: "Read the active configuration",
        enrichmentStatus: "succeeded",
      },
    });
    sandbox.routeWsMessage({
      observation: {
        id: "obs-1",
        sessionId: "session-1",
        timestamp: "2026-08-13T17:00:00.000Z",
        hookType: "post_tool_use",
        toolName: "Read",
        enrichmentStatus: "queued",
      },
    });

    expect(sandbox.state.activity.observations).toHaveLength(1);
    expect(sandbox.state.activity.observations[0]).toMatchObject({
      id: "obs-1",
      narrative: "Read the active configuration",
      enrichmentStatus: "succeeded",
    });
  });
});
