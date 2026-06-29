import type { Adapter } from "../types.js";

interface UnavailableAdapterOptions {
  name: string;
  displayName: string;
  optionalExecutable?: string;
  optionalConfigEnv?: string[];
  setupHint: string;
}

export interface UnavailableAdapterSkipMetadata {
  status: "skipped";
  reason: "adapter_unavailable";
  adapter: string;
  displayName: string;
  missing: {
    executableEnv?: string;
    configEnv: string[];
  };
  installHint: string;
  message: string;
}

export class UnavailableAdapterError extends Error {
  readonly code = "BENCHMARK_ADAPTER_UNAVAILABLE";
  readonly skip: UnavailableAdapterSkipMetadata;

  constructor(skip: UnavailableAdapterSkipMetadata) {
    super(skip.message);
    this.name = "UnavailableAdapterError";
    this.skip = skip;
  }

  toJSON(): { code: string; skip: UnavailableAdapterSkipMetadata } {
    return { code: this.code, skip: this.skip };
  }
}

function formatMissing(options: UnavailableAdapterOptions): string {
  const missing: string[] = [];
  if (options.optionalExecutable) {
    missing.push(`optional executable/config ${options.optionalExecutable}`);
  }
  if (options.optionalConfigEnv?.length) {
    missing.push(`optional config ${options.optionalConfigEnv.join(", ")}`);
  }
  return missing.join("; ");
}

function createSkipMetadata(options: UnavailableAdapterOptions): UnavailableAdapterSkipMetadata {
  const missing = formatMissing(options);
  return {
    status: "skipped",
    reason: "adapter_unavailable",
    adapter: options.name,
    displayName: options.displayName,
    missing: {
      executableEnv: options.optionalExecutable,
      configEnv: options.optionalConfigEnv ?? [],
    },
    installHint: options.setupHint,
    message: `${options.name} adapter unavailable: ${options.displayName} is descriptor-only and excluded from default benchmark runs. Missing ${missing}. ${options.setupHint}`,
  };
}

export function createUnavailableAdapter(options: UnavailableAdapterOptions): Adapter<never> {
  return {
    name: options.name,
    async init() {
      throw new UnavailableAdapterError(createSkipMetadata(options));
    },
    async query() {
      throw new Error(`${options.name} adapter unavailable: init did not complete`);
    },
  };
}
