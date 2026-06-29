import { agentmemoryAdapter } from "./agentmemory.js";
import { COMPETITOR_ADAPTERS } from "./competitors.js";
import { grepAdapter } from "./grep.js";
import { vectorAdapter } from "./vector.js";
import type { Adapter, BenchmarkAdapterDescriptor } from "../types.js";

const DEFAULT_BENCHMARK_ADAPTERS = ["grep", "vector", "agentmemory"];

export const BENCHMARK_ADAPTERS = [
  {
    name: "grep",
    backend: "Tokenized substring match",
    requiresApiKey: false,
    defaultEnabled: true,
    availability: { status: "available" },
    adapter: grepAdapter as unknown as Adapter,
  },
  {
    name: "vector",
    backend: "OpenAI text-embedding-3-small + cosine",
    requiresApiKey: true,
    apiKeyEnv: "OPENAI_API_KEY",
    defaultEnabled: true,
    availability: { status: "available" },
    adapter: vectorAdapter as unknown as Adapter,
  },
  {
    name: "agentmemory",
    backend: "Running agentmemory server, smart-search endpoint",
    requiresApiKey: false,
    defaultEnabled: true,
    availability: { status: "available" },
    adapter: agentmemoryAdapter as unknown as Adapter,
  },
  ...COMPETITOR_ADAPTERS,
] satisfies BenchmarkAdapterDescriptor[];

const ADAPTERS_BY_NAME = new Map(BENCHMARK_ADAPTERS.map((descriptor) => [
  descriptor.name,
  descriptor,
]));

export function defaultBenchmarkAdapters(): string[] {
  return DEFAULT_BENCHMARK_ADAPTERS.slice();
}

export function knownBenchmarkAdapters(): string[] {
  return BENCHMARK_ADAPTERS.map((descriptor) => descriptor.name);
}

export function resolveBenchmarkAdapters(
  input: string | string[] = defaultBenchmarkAdapters(),
): BenchmarkAdapterDescriptor[] {
  const names = (Array.isArray(input) ? input : input.split(","))
    .map((name) => name.trim())
    .filter(Boolean);

  return names.map((name) => {
    const descriptor = ADAPTERS_BY_NAME.get(name);
    if (!descriptor) {
      throw new Error(`unknown adapter: ${name}. options: ${knownBenchmarkAdapters().join(",")}`);
    }
    return descriptor;
  });
}
