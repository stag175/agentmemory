# Benchmark Adapter Descriptors

Default benchmark runs use only implemented adapters: `grep`, `vector`, and
`agentmemory`.

Competitor adapters are registered as stubbed, descriptor-only placeholders so
public scorecards can show what was requested without implying results were
measured. They resolve by name, but their adapters fail fast with
machine-readable skip metadata until a reproducible external runner is
supplied.

| Adapter | Status | Backend descriptor | Default | Missing optional executable/config |
|---|---|---|---:|---|
| `grep` | implemented | Tokenized substring match | yes | none |
| `vector` | implemented | OpenAI `text-embedding-3-small` + cosine | yes | `OPENAI_API_KEY` |
| `agentmemory` | implemented | Running agentmemory server, smart-search endpoint | yes | none |
| `mem0` | stubbed | Mem0 external memory service or SDK runner | no | `MEM0_ADAPTER_COMMAND`, `MEM0_API_KEY` |
| `letta` | stubbed | Letta external memory server or SDK runner | no | `LETTA_ADAPTER_COMMAND`, `LETTA_BASE_URL` |
| `zep-graphiti` | stubbed | Zep or Graphiti external graph-memory runner | no | `ZEP_GRAPHITI_ADAPTER_COMMAND`, `ZEP_API_KEY`, `GRAPHITI_BASE_URL` |
| `langmem` | stubbed | LangMem external SDK runner | no | `LANGMEM_ADAPTER_COMMAND`, `LANGMEM_STORE_URI` |
| `basic-memory` | stubbed | Basic Memory external local runner | no | `BASIC_MEMORY_ADAPTER_COMMAND`, `BASIC_MEMORY_HOME` |
| `openmemory` | stubbed | OpenMemory external service or local runner | no | `OPENMEMORY_ADAPTER_COMMAND`, `OPENMEMORY_BASE_URL` |
| `supermemory` | stubbed | Supermemory external memory API runner | no | `SUPERMEMORY_ADAPTER_COMMAND`, `SUPERMEMORY_API_KEY` |

When one of the descriptor-only names is passed to `--adapters`, resolution is
intentional and execution fails before scoring. That failure is part of the
public benchmark contract: unconfigured competitors are `not_run`, never
silent skips or fabricated baselines. Harnesses can read the thrown
`UnavailableAdapterError` as JSON:

```json
{
  "code": "BENCHMARK_ADAPTER_UNAVAILABLE",
  "skip": {
    "status": "skipped",
    "reason": "adapter_unavailable",
    "adapter": "mem0",
    "displayName": "Mem0",
    "missing": {
      "executableEnv": "MEM0_ADAPTER_COMMAND",
      "configEnv": ["MEM0_API_KEY"]
    },
    "installHint": "Provide MEM0_ADAPTER_COMMAND and the listed env vars before running mem0; this repo does not bundle or auto-install competitor SDKs.",
    "message": "mem0 adapter unavailable: Mem0 is descriptor-only and excluded from default benchmark runs. Missing optional executable/config MEM0_ADAPTER_COMMAND; optional config MEM0_API_KEY. Provide MEM0_ADAPTER_COMMAND and the listed env vars before running mem0; this repo does not bundle or auto-install competitor SDKs."
  }
}
```
