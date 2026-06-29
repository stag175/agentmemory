import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveBenchmarkAdapters } from "./adapters/index.js";
import { aggregate, scoreQuestion } from "./score.js";
import type { BenchmarkAdapterDescriptor, Question, ScoreRow, Session } from "./types.js";

interface CliOptions {
  data: string;
  adapters: string;
  k: string;
  out: string;
}

function parse(): CliOptions {
  const { values } = parseArgs({
    options: {
      data: { type: "string", default: "eval/data/coding-agent-life-v1" },
      adapters: { type: "string", default: "grep,vector,agentmemory" },
      k: { type: "string", default: "5" },
      out: { type: "string", default: "eval/reports/coding-life" },
    },
  });
  return values as unknown as CliOptions;
}

async function main(): Promise<void> {
  const opts = parse();
  const k = Number(opts.k);
  if (!Number.isInteger(k) || k <= 0) {
    console.error(`--k must be a positive integer, got: ${opts.k}`);
    process.exit(2);
  }
  const sessions = JSON.parse(
    readFileSync(resolve(opts.data, "sessions.json"), "utf8"),
  ) as Session[];
  const queriesRaw = JSON.parse(
    readFileSync(resolve(opts.data, "queries.json"), "utf8"),
  ) as Array<Omit<Question, "haystack">>;
  const questions: Question[] = queriesRaw.map((q) => ({ ...q, haystack: sessions }));
  let adapterDescriptors: BenchmarkAdapterDescriptor[];
  try {
    adapterDescriptors = resolveBenchmarkAdapters(opts.adapters);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
  const adapterNames = adapterDescriptors.map((descriptor) => descriptor.name);
  console.log(
    `loaded ${sessions.length} sessions, ${questions.length} queries, adapters: ${adapterNames.join(",")}, k=${k}`,
  );

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = `${outDir}/scores.ndjson`;
  if (existsSync(ndjsonPath)) writeFileSync(ndjsonPath, "");

  const rows: ScoreRow[] = [];
  for (const descriptor of adapterDescriptors) {
    const adapter = descriptor.adapter;
    console.log(`\n== ${adapter.name} ==`);
    const state = await adapter.init(sessions);
    try {
      for (const q of questions) {
        const t0 = performance.now();
        const ranked = await adapter.query(q.question, state, k);
        const latencyMs = performance.now() - t0;
        const row = scoreQuestion(q, ranked, k, adapter.name, latencyMs);
        rows.push(row);
        appendFileSync(ndjsonPath, JSON.stringify(row) + "\n");
        const mark = row.hit ? "+" : "-";
        console.log(
          `  ${mark} ${q.id} [${q.type}] R@${k}=${row.recallAtK.toFixed(2)} (${Math.round(latencyMs)}ms)`,
        );
      }
    } finally {
      if (adapter.teardown) await adapter.teardown(state);
    }
  }

  const agg = aggregate(rows);
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(agg, null, 2));
  console.log("\n=== Summary ===");
  for (const [adapter, stats] of Object.entries(agg.byAdapter)) {
    console.log(
      `  ${adapter.padEnd(22)} P@${k}=${stats.p.toFixed(3)} R@${k}=${stats.r.toFixed(3)} hit=${stats.hit}/${stats.n} p50=${Math.round(stats.latencyP50)}ms`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
