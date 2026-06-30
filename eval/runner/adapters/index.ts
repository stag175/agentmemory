import { agentmemoryAdapter } from "./agentmemory.js";
import { COMPETITOR_ADAPTERS } from "./competitors.js";
import { grepAdapter } from "./grep.js";
import { vectorAdapter } from "./vector.js";
import { UnavailableAdapterError } from "./unavailable.js";
import type { UnavailableAdapterSkipMetadata } from "./unavailable.js";
import type { Adapter, BenchmarkAdapterDescriptor, ScoreRow } from "../types.js";

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
  return BENCHMARK_ADAPTERS.filter((descriptor) => descriptor.defaultEnabled === true).map(
    (descriptor) => descriptor.name,
  );
}

export function knownBenchmarkAdapters(): string[] {
  return BENCHMARK_ADAPTERS.map((descriptor) => descriptor.name);
}

export function isAdapterAvailable(descriptor: BenchmarkAdapterDescriptor): boolean {
  return descriptor.availability?.status !== "unavailable";
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

export interface BenchmarkAdapterSkip {
  adapter: string;
  skip: UnavailableAdapterSkipMetadata;
}

export interface BenchmarkRunResult {
  rows: ScoreRow[];
  skips: BenchmarkAdapterSkip[];
}

export interface RunBenchmarkAdaptersOptions {
  /**
   * Produces the score rows for one available adapter. The callback owns calling
   * `descriptor.adapter.init(...)` so that runners which init once and runners
   * which init per question share the same skip-on-unavailable handling: if init
   * throws an {@link UnavailableAdapterError}, the descriptor is recorded as a
   * skip and the run continues with the next descriptor.
   */
  evaluate: (descriptor: BenchmarkAdapterDescriptor) => Promise<ScoreRow[]>;
  /** Invoked once per descriptor before {@link RunBenchmarkAdaptersOptions.evaluate}. */
  onAdapterStart?: (descriptor: BenchmarkAdapterDescriptor) => void;
  /**
   * Invoked with each available adapter's rows as soon as it finishes. Lets a
   * runner persist partial results so a later unexpected failure cannot discard
   * adapters that already completed.
   */
  onRows?: (descriptor: BenchmarkAdapterDescriptor, rows: ScoreRow[]) => void;
  /** Invoked when a descriptor is skipped because its adapter is unavailable. */
  onSkip?: (skip: BenchmarkAdapterSkip) => void;
}

/**
 * Iterates the resolved descriptors, delegating per-adapter scoring to `evaluate`.
 * Unavailable adapters surface an {@link UnavailableAdapterError} from `init`; that
 * is captured as a skip entry instead of bubbling to `process.exit(1)`, so a mix of
 * available and unavailable adapters still produces partial results.
 */
export async function runBenchmarkAdapters(
  descriptors: BenchmarkAdapterDescriptor[],
  options: RunBenchmarkAdaptersOptions,
): Promise<BenchmarkRunResult> {
  const rows: ScoreRow[] = [];
  const skips: BenchmarkAdapterSkip[] = [];
  for (const descriptor of descriptors) {
    options.onAdapterStart?.(descriptor);
    if (!isAdapterAvailable(descriptor)) {
      const skip = await probeUnavailableSkip(descriptor);
      if (skip) {
        skips.push(skip);
        options.onSkip?.(skip);
        continue;
      }
    }
    try {
      const adapterRows = await options.evaluate(descriptor);
      rows.push(...adapterRows);
      options.onRows?.(descriptor, adapterRows);
    } catch (err) {
      if (err instanceof UnavailableAdapterError) {
        const skip: BenchmarkAdapterSkip = { adapter: descriptor.name, skip: err.skip };
        skips.push(skip);
        options.onSkip?.(skip);
        continue;
      }
      throw err;
    }
  }
  return { rows, skips };
}

async function probeUnavailableSkip(
  descriptor: BenchmarkAdapterDescriptor,
): Promise<BenchmarkAdapterSkip | null> {
  try {
    await descriptor.adapter.init([]);
  } catch (err) {
    if (err instanceof UnavailableAdapterError) {
      return { adapter: descriptor.name, skip: err.skip };
    }
  }
  return null;
}
