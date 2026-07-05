import { defineConfig } from "vitest/config";

// Low-memory test config for constrained machines: a single persistent fork
// runs all files sequentially so vitest's default per-core worker pool (each
// loading the heavy optional ML deps) cannot exhaust RAM. Use via:
//   npx vitest run --config vitest.lowmem.config.ts --exclude test/integration.test.ts
export default defineConfig({
  test: {
    setupFiles: ["./test/setup-env.ts"],
    testTimeout: 15_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
