import type { BenchmarkAdapterDescriptor } from "../types.js";
import { createUnavailableAdapter } from "./unavailable.js";

interface CompetitorDescriptorInput {
  name: string;
  displayName: string;
  backend: string;
  requiresApiKey: boolean;
  apiKeyEnv?: string;
  optionalExecutable: string;
  optionalConfigEnv: string[];
}

function competitorDescriptor(input: CompetitorDescriptorInput): BenchmarkAdapterDescriptor {
  const setupHint =
    `Provide ${input.optionalExecutable} and the listed env vars before running ${input.name}; this repo does not bundle or auto-install competitor SDKs.`;
  return {
    name: input.name,
    backend: input.backend,
    requiresApiKey: input.requiresApiKey,
    apiKeyEnv: input.apiKeyEnv,
    defaultEnabled: false,
    availability: {
      status: "unavailable",
      reason: "External competitor runner is not bundled; descriptor is present for honest scorecard accounting.",
      optionalExecutable: input.optionalExecutable,
      optionalConfigEnv: input.optionalConfigEnv,
    },
    adapter: createUnavailableAdapter({
      name: input.name,
      displayName: input.displayName,
      optionalExecutable: input.optionalExecutable,
      optionalConfigEnv: input.optionalConfigEnv,
      setupHint,
    }),
  };
}

export const COMPETITOR_ADAPTERS = [
  competitorDescriptor({
    name: "mem0",
    displayName: "Mem0",
    backend: "Mem0 external memory service or SDK runner",
    requiresApiKey: true,
    apiKeyEnv: "MEM0_API_KEY",
    optionalExecutable: "MEM0_ADAPTER_COMMAND",
    optionalConfigEnv: ["MEM0_API_KEY"],
  }),
  competitorDescriptor({
    name: "letta",
    displayName: "Letta",
    backend: "Letta external memory server or SDK runner",
    requiresApiKey: false,
    optionalExecutable: "LETTA_ADAPTER_COMMAND",
    optionalConfigEnv: ["LETTA_BASE_URL"],
  }),
  competitorDescriptor({
    name: "zep-graphiti",
    displayName: "Zep/Graphiti",
    backend: "Zep or Graphiti external graph-memory runner",
    requiresApiKey: true,
    apiKeyEnv: "ZEP_API_KEY",
    optionalExecutable: "ZEP_GRAPHITI_ADAPTER_COMMAND",
    optionalConfigEnv: ["ZEP_API_KEY", "GRAPHITI_BASE_URL"],
  }),
  competitorDescriptor({
    name: "langmem",
    displayName: "LangMem",
    backend: "LangMem external SDK runner",
    requiresApiKey: false,
    optionalExecutable: "LANGMEM_ADAPTER_COMMAND",
    optionalConfigEnv: ["LANGMEM_STORE_URI"],
  }),
  competitorDescriptor({
    name: "basic-memory",
    displayName: "Basic Memory",
    backend: "Basic Memory external local runner",
    requiresApiKey: false,
    optionalExecutable: "BASIC_MEMORY_ADAPTER_COMMAND",
    optionalConfigEnv: ["BASIC_MEMORY_HOME"],
  }),
  competitorDescriptor({
    name: "openmemory",
    displayName: "OpenMemory",
    backend: "OpenMemory external service or local runner",
    requiresApiKey: false,
    optionalExecutable: "OPENMEMORY_ADAPTER_COMMAND",
    optionalConfigEnv: ["OPENMEMORY_BASE_URL"],
  }),
  competitorDescriptor({
    name: "supermemory",
    displayName: "Supermemory",
    backend: "Supermemory external memory API runner",
    requiresApiKey: true,
    apiKeyEnv: "SUPERMEMORY_API_KEY",
    optionalExecutable: "SUPERMEMORY_ADAPTER_COMMAND",
    optionalConfigEnv: ["SUPERMEMORY_API_KEY"],
  }),
] satisfies BenchmarkAdapterDescriptor[];
