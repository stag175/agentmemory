import { join } from "node:path";
import { tmpdir } from "node:os";

const workerId =
  process.env["VITEST_POOL_ID"] ??
  process.env["VITEST_WORKER_ID"] ??
  "main";

process.env["AGENTMEMORY_LOCK_DIR"] ??= join(
  tmpdir(),
  "agentmemory-vitest-locks",
  `${process.pid}-${workerId}`,
);
process.env["AGENTMEMORY_DISABLE_FILE_LOCKS"] ??= "true";
