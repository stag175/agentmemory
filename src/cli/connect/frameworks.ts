export type FrameworkAdapterSurface = "rest" | "mcp" | "hooks";

export type FrameworkAdapterDescriptor = {
  name: string;
  displayName: string;
  language: "python" | "typescript" | "multi";
  packageHints: readonly string[];
  docsUrl: string;
  status: "descriptor-only";
  surfaces: readonly FrameworkAdapterSurface[];
  setup: readonly string[];
  env: readonly string[];
  notes: readonly string[];
  aliases?: readonly string[];
};

const COMMON_ENV = [
  "AGENTMEMORY_URL=http://localhost:3111",
  "AGENTMEMORY_SECRET= only when the daemon requires Authorization",
];

export const FRAMEWORK_ADAPTERS = [
  {
    name: "openai-agents",
    displayName: "OpenAI Agents SDK",
    language: "python",
    packageHints: ["openai-agents"],
    docsUrl: "https://openai.github.io/openai-agents-python/",
    status: "descriptor-only",
    surfaces: ["rest", "hooks"],
    setup: [
      "Start agentmemory before the app boots.",
      "Wrap each Runner invocation with /agentmemory/session/start and /agentmemory/agent-events.",
      "Call /agentmemory/context before a run when the app wants retrieved memory in the prompt.",
      "Call /agentmemory/remember or /agentmemory/observe after durable user, tool, or handoff events.",
    ],
    env: [...COMMON_ENV, "OPENAI_API_KEY for the framework's model calls"],
    notes: [
      "Use the framework's own session memory for short-turn transcript state.",
      "Use agentmemory for cross-session facts, decisions, handoffs, and project context.",
    ],
    aliases: ["openai", "agents-sdk", "openai-agents-sdk"],
  },
  {
    name: "autogen",
    displayName: "Microsoft AutoGen",
    language: "python",
    packageHints: ["autogen-agentchat", "autogen-core", "autogen-ext[mcp]"],
    docsUrl: "https://microsoft.github.io/autogen/",
    status: "descriptor-only",
    surfaces: ["rest", "mcp"],
    setup: [
      "Start agentmemory before the AutoGen team starts.",
      "Use the MCP bridge when the team should call memory tools directly.",
      "Use REST hooks around team/task lifecycle when the app owns capture and recall policy.",
      "Record team, agent, task, and message ids through /agentmemory/agent-events.",
    ],
    env: [...COMMON_ENV, "AGENTMEMORY_TOOLS=core when the tool list must stay small"],
    notes: [
      "AutoGen can consume MCP tools through its extension package.",
      "REST capture is still preferred for automatic lineage because it can preserve team and task ids.",
    ],
    aliases: ["microsoft-autogen", "autogen-agentchat"],
  },
  {
    name: "crewai",
    displayName: "CrewAI",
    language: "python",
    packageHints: ["crewai", "crewai-tools"],
    docsUrl: "https://docs.crewai.com/",
    status: "descriptor-only",
    surfaces: ["rest", "mcp"],
    setup: [
      "Start agentmemory before the crew kicks off.",
      "Expose memory recall as a CrewAI tool through MCP or a tiny REST-backed custom tool.",
      "Capture crew kickoff, task completion, and handoff summaries through /agentmemory/agent-events.",
      "Persist durable outcomes with /agentmemory/remember after the crew finishes.",
    ],
    env: COMMON_ENV,
    notes: [
      "Keep CrewAI task-local context inside CrewAI.",
      "Use agentmemory for durable memory shared across crews, projects, and coding agents.",
    ],
    aliases: ["crew-ai", "crew"],
  },
  {
    name: "langgraph",
    displayName: "LangGraph",
    language: "python",
    packageHints: ["langgraph", "langchain-mcp-adapters"],
    docsUrl: "https://docs.langchain.com/oss/python/langgraph/overview",
    status: "descriptor-only",
    surfaces: ["rest", "mcp", "hooks"],
    setup: [
      "Start agentmemory before graph invocation.",
      "Read /agentmemory/context at graph entry or at selected node boundaries.",
      "Write /agentmemory/remember at graph exit for durable conclusions.",
      "Emit node, thread, checkpoint, and human-review ids through /agentmemory/agent-events.",
    ],
    env: [...COMMON_ENV, "AGENTMEMORY_PROJECT_NAME for multi-graph services"],
    notes: [
      "Keep LangGraph checkpointing as the source of truth for resumable graph state.",
      "Use agentmemory as long-term cross-thread recall, not as a checkpoint replacement.",
    ],
    aliases: ["lang-chain-graph", "langchain-graph"],
  },
  {
    name: "pydantic-ai",
    displayName: "Pydantic AI",
    language: "python",
    packageHints: ["pydantic-ai"],
    docsUrl: "https://pydantic.dev/docs/ai/",
    status: "descriptor-only",
    surfaces: ["rest", "mcp"],
    setup: [
      "Start agentmemory before the app creates agents.",
      "Model recall as a typed dependency or tool that calls /agentmemory/context.",
      "Record tool, run, and validation outcomes through /agentmemory/agent-events.",
      "Save durable facts with /agentmemory/remember after successful runs.",
    ],
    env: COMMON_ENV,
    notes: [
      "Keep Pydantic validation and retries inside the framework.",
      "Use agentmemory for memory that must survive process restarts and cross-agent handoff.",
    ],
    aliases: ["pydanticai"],
  },
  {
    name: "semantic-kernel",
    displayName: "Semantic Kernel",
    language: "multi",
    packageHints: ["semantic-kernel", "Microsoft.SemanticKernel"],
    docsUrl: "https://learn.microsoft.com/en-us/semantic-kernel/",
    status: "descriptor-only",
    surfaces: ["rest", "mcp"],
    setup: [
      "Start agentmemory before the kernel is built.",
      "Expose recall and save as Kernel functions or MCP tools.",
      "Capture planner, plugin, and agent ids through /agentmemory/agent-events.",
      "Use /agentmemory/remember for durable decisions and /agentmemory/context for prompt-time recall.",
    ],
    env: COMMON_ENV,
    notes: [
      "Keep Semantic Kernel planners and plugin orchestration in Semantic Kernel.",
      "Use agentmemory as a local cross-agent memory backend.",
    ],
    aliases: ["sk"],
  },
  {
    name: "llamaindex-workflows",
    displayName: "LlamaIndex Workflows",
    language: "python",
    packageHints: ["llama-index-workflows", "llama-index-core"],
    docsUrl: "https://developers.llamaindex.ai/python/llamaagents/workflows/",
    status: "descriptor-only",
    surfaces: ["rest", "hooks"],
    setup: [
      "Start agentmemory before workflow execution.",
      "Call /agentmemory/context at workflow start or before retrieval-heavy steps.",
      "Emit workflow, step, and event ids through /agentmemory/agent-events.",
      "Save durable synthesis outputs through /agentmemory/remember.",
    ],
    env: COMMON_ENV,
    notes: [
      "Keep LlamaIndex workflow events in the workflow runtime.",
      "Use agentmemory for recall that should outlive one workflow execution.",
    ],
    aliases: ["llamaindex", "llama-index", "llama-index-workflows"],
  },
  {
    name: "mastra",
    displayName: "Mastra",
    language: "typescript",
    packageHints: ["mastra"],
    docsUrl: "https://mastra.ai/",
    status: "descriptor-only",
    surfaces: ["rest", "mcp"],
    setup: [
      "Start agentmemory before the Mastra server or app boots.",
      "Expose recall as an MCP tool or a REST-backed tool in the agent's toolset.",
      "Emit agent, workflow, run, and tool ids through /agentmemory/agent-events.",
      "Save durable user and workflow facts through /agentmemory/remember.",
    ],
    env: COMMON_ENV,
    notes: [
      "Keep Mastra's built-in memory and workflow state for app-local behavior.",
      "Use agentmemory for local-first memory shared with coding agents and other runtimes.",
    ],
  },
] satisfies readonly FrameworkAdapterDescriptor[];

const FRAMEWORKS_BY_NAME = new Map<string, FrameworkAdapterDescriptor>();

for (const descriptor of FRAMEWORK_ADAPTERS) {
  FRAMEWORKS_BY_NAME.set(descriptor.name, descriptor);
  for (const alias of descriptor.aliases ?? []) {
    FRAMEWORKS_BY_NAME.set(alias, descriptor);
  }
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `  - ${item}`).join("\n");
}

export function knownFrameworkAdapters(): string[] {
  return FRAMEWORK_ADAPTERS.map((descriptor) => descriptor.name);
}

export function resolveFrameworkAdapter(
  name: string,
): FrameworkAdapterDescriptor | null {
  return FRAMEWORKS_BY_NAME.get(name.trim().toLowerCase()) ?? null;
}

export function formatFrameworkAdapterList(): string {
  const lines = [
    "Framework runtime helpers are descriptor-only. They do not mutate project files.",
    "",
    "Available framework adapters:",
    ...FRAMEWORK_ADAPTERS.map(
      (descriptor) =>
        `  - ${descriptor.name}: ${descriptor.displayName} (${descriptor.language}; ${descriptor.surfaces.join(", ")})`,
    ),
    "",
    "Show one setup helper with:",
    "  agentmemory connect frameworks <name>",
  ];
  return lines.join("\n");
}

export function formatFrameworkSetup(name: string): string | null {
  const descriptor = resolveFrameworkAdapter(name);
  if (!descriptor) return null;

  return [
    `${descriptor.displayName} (${descriptor.name})`,
    "",
    `Status: ${descriptor.status}`,
    `Language: ${descriptor.language}`,
    `Packages: ${descriptor.packageHints.join(", ")}`,
    `Surfaces: ${descriptor.surfaces.join(", ")}`,
    `Docs: ${descriptor.docsUrl}`,
    "",
    "Setup helper:",
    bullets(descriptor.setup),
    "",
    "Environment:",
    bullets(descriptor.env),
    "",
    "Notes:",
    bullets(descriptor.notes),
    "",
    "No files are changed by this helper.",
  ].join("\n");
}
