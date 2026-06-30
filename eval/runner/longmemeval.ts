import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveBenchmarkAdapters, runBenchmarkAdapters } from "./adapters/index.js";
import type { BenchmarkAdapterSkip } from "./adapters/index.js";
import { loadLongMemEval, stratifySample } from "./load.js";
import { aggregate, scoreQuestion } from "./score.js";
import type { BenchmarkAdapterDescriptor, ScoreRow } from "./types.js";

interface CliOptions {
  data: string;
  adapters: string;
  k: string;
  limit?: string;
  stratify?: string;
  out: string;
}

function parse(): CliOptions {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: process.env.LONGMEMEVAL_PATH ?? "" },
      adapters: { type: "string", default: "grep,vector,agentmemory" },
      k: { type: "string", default: "5" },
      limit: { type: "string" },
      stratify: { type: "string" },
      out: { type: "string", default: "eval/reports/longmemeval" },
    },
  });
  return values as unknown as CliOptions;
}

async function main(): Promise<void> {
  const opts = parse();
  if (!opts.data) {
    console.error("--data <path/to/longmemeval_s.json> required (or LONGMEMEVAL_PATH env)");
    process.exit(2);
  }
  const k = Number(opts.k);
  if (!Number.isInteger(k) || k <= 0) {
    console.error(`--k must be a positive integer, got: ${opts.k}`);
    process.exit(2);
  }
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      console.error(`--limit must be a positive integer, got: ${opts.limit}`);
      process.exit(2);
    }
  }
  let perType: number | undefined;
  if (opts.stratify !== undefined) {
    perType = Number(opts.stratify);
    if (!Number.isInteger(perType) || perType <= 0) {
      console.error(`--stratify must be a positive integer, got: ${opts.stratify}`);
      process.exit(2);
    }
  }
  let adapterDescriptors: BenchmarkAdapterDescriptor[];
  try {
    adapterDescriptors = resolveBenchmarkAdapters(opts.adapters);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  const adapterNames = adapterDescriptors.map((descriptor) => descriptor.name);
  let questions = loadLongMemEval(resolve(opts.data), limit);
  if (perType) questions = stratifySample(questions, perType);
  console.log(
    `loaded ${questions.length} questions, adapters: ${adapterNames.join(",")}, k=${k}`,
  );

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  if (existsSync(ndjsonPath)) writeFileSync(ndjsonPath, "");
  mkdirSync(dirname(ndjsonPath), { recursive: true });

  const skipsPath = `${outDir}/skips.ndjson`;
  if (existsSync(skipsPath)) writeFileSync(skipsPath, "");

  const rows: ScoreRow[] = [];
  const skips: BenchmarkAdapterSkip[] = [];
  const summaryPath = `${outDir}/summary.json`;
  try {
    await runBenchmarkAdapters(adapterDescriptors, {
      onAdapterStart(descriptor) {
        console.log(`\n== ${descriptor.adapter.name} ==`);
      },
      onRows(_descriptor, adapterRows) {
        rows.push(...adapterRows);
      },
      onSkip(skip) {
        skips.push(skip);
        appendFileSync(skipsPath, JSON.stringify(skip) + "\n");
        console.log(`  ~ skipped ${skip.adapter}: ${skip.skip.message}`);
      },
      async evaluate(descriptor) {
        const adapter = descriptor.adapter;
        const adapterRows: ScoreRow[] = [];
        for (const q of questions) {
          const t0 = performance.now();
          const state = await adapter.init(q.haystack);
          try {
            const ranked = await adapter.query(q.question, state, k);
            const latencyMs = performance.now() - t0;
            const row = scoreQuestion(q, ranked, k, adapter.name, latencyMs);
            adapterRows.push(row);
            appendFileSync(ndjsonPath, JSON.stringify(row) + "\n");
            const mark = row.hit ? "+" : "-";
            console.log(
              `  ${mark} ${q.id} [${q.type}] R@${k}=${row.recallAtK.toFixed(2)} (${Math.round(latencyMs)}ms)`,
            );
          } finally {
            if (adapter.teardown) await adapter.teardown(state);
          }
        }
        return adapterRows;
      },
    });
  } finally {
    const agg = aggregate(rows);
    writeFileSync(summaryPath, JSON.stringify({ ...agg, skipped: skips }, null, 2));
    console.log("\n=== Summary ===");
    for (const [adapter, stats] of Object.entries(agg.byAdapter)) {
      console.log(
        `  ${adapter.padEnd(22)} P@${k}=${stats.p.toFixed(3)} R@${k}=${stats.r.toFixed(3)} hit=${stats.hit}/${stats.n} p50=${Math.round(stats.latencyP50)}ms`,
      );
    }
    for (const skip of skips) {
      console.log(`  ${skip.adapter.padEnd(22)} skipped: ${skip.skip.reason}`);
    }
    console.log(`\nwrote ${ndjsonPath}`);
    console.log(`wrote ${summaryPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
