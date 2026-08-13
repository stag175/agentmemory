import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliverHookRequests,
  hookDeliveryTimeoutMs,
} from "../src/hooks/_delivery.js";
import { getHookOutboxStatus } from "../src/hooks/outbox-status.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("durable hook delivery", () => {
  it("retains failed sends, records diagnostics, retries, and never spools auth secrets", async () => {
    const outbox = await mkdtemp(join(tmpdir(), "agentmemory-hook-outbox-"));
    process.env["AGENTMEMORY_HOOK_OUTBOX_DIR"] = outbox;
    process.env["AGENTMEMORY_HOOK_RETRY_BASE_MS"] = "1";
    let status = 503;
    const receivedIds: string[] = [];
    const server = createServer((req, res) => {
      receivedIds.push(String(req.headers["x-agentmemory-delivery-id"]));
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    try {
      const first = await deliverHookRequests({
        restUrl: `http://127.0.0.1:${address.port}`,
        secret: "never-write-this-secret",
        requests: [{ path: "/agentmemory/observe", body: { value: "safe" } }],
      });
      expect(first.failed).toBe(1);
      let visible = await getHookOutboxStatus();
      expect(visible.pending).toBe(1);
      expect(visible.failureRecords).toBe(1);
      const serialized = await Promise.all(
        (await readdir(outbox)).map((name) => readFile(join(outbox, name), "utf8")),
      );
      expect(serialized.join("\n")).not.toContain("never-write-this-secret");

      await new Promise((resolve) => setTimeout(resolve, 5));
      status = 204;
      const second = await deliverHookRequests({
        restUrl: `http://127.0.0.1:${address.port}`,
        secret: "never-write-this-secret",
        requests: [{ path: "/agentmemory/observe", body: { value: "next" } }],
      });
      expect(second.delivered).toBe(2);
      visible = await getHookOutboxStatus();
      expect(visible.pending).toBe(0);
      expect(new Set(receivedIds).size).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(outbox, { recursive: true, force: true });
    }
  });

  it("never permits a delivery timeout below 30 seconds", () => {
    process.env["AGENTMEMORY_HOOK_DELIVERY_TIMEOUT_MS"] = "250";
    expect(hookDeliveryTimeoutMs()).toBe(30_000);
  });
});
