# Framework adapter descriptors

Framework runtimes are different from host agents. `agentmemory connect <agent>`
mutates a local agent config file, but OpenAI Agents, AutoGen, CrewAI,
LangGraph, and similar runtimes live inside user applications. The safe default
is descriptor-only setup guidance: no project files are rewritten and no vendor
client is imported by agentmemory.

Use the helper:

```bash
agentmemory connect frameworks
agentmemory connect frameworks langgraph
agentmemory connect frameworks --json
```

The descriptor registry lives in `src/cli/connect/frameworks.ts`.

## Supported descriptors

| Name | Runtime | Primary setup surface |
| --- | --- | --- |
| `openai-agents` | OpenAI Agents SDK | REST lifecycle hooks |
| `autogen` | Microsoft AutoGen | MCP tools or REST lifecycle hooks |
| `crewai` | CrewAI | MCP/custom tool plus REST capture |
| `langgraph` | LangGraph | REST node hooks, optional MCP tools |
| `pydantic-ai` | Pydantic AI | Typed dependency/tool using REST |
| `semantic-kernel` | Semantic Kernel | Kernel function or MCP tool |
| `llamaindex-workflows` | LlamaIndex Workflows | REST workflow hooks |
| `mastra` | Mastra | MCP/custom tool plus REST capture |

## Integration shape

Start the daemon first:

```bash
agentmemory
```

Set runtime env:

```bash
AGENTMEMORY_URL=http://localhost:3111
# AGENTMEMORY_SECRET=only-if-configured
```

Use the framework's own short-term memory, checkpointing, or workflow state for
in-run behavior. Use agentmemory for durable facts and cross-session recall:

- Call `/agentmemory/context` before a run, graph entry, or retrieval-heavy node
  when the app wants recalled project context.
- Call `/agentmemory/remember` or `/agentmemory/observe` after durable user,
  tool, handoff, task, or workflow events.
- Call `/agentmemory/agent-events` with framework-native ids such as run,
  thread, team, task, node, tool-call, or checkpoint ids.
- Use the MCP bridge only when the framework should expose memory tools directly
  to an agent.

These descriptors are intentionally metadata and setup helpers, not automatic
installers. A future framework-specific package can consume the same descriptor
names without changing the host-agent adapter registry.
