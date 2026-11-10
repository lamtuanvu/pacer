import { backgroundWorkerEntryURL } from "../../src/serve/worker-location";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compiled-run smoke probe (built by test/compiled-workers.test.ts): ensures the
// background worker entrypoint resolves inside a `bun build --compile` binary.
// In a compiled binary import.meta.url is /$bunfs/root/<entry>; the worker is
// embedded at ./serve/background-worker.ts because it is a compile entrypoint.
const home = mkdtempSync(join(tmpdir(), "pacer-bg-probe-"));
const worker = new Worker(backgroundWorkerEntryURL(import.meta.url).href, { type: "module" });
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  if (Date.now() > deadline) { console.error("WORKER_TIMEOUT"); process.exit(1); }
}, 500);
worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
  const d = event.data ?? {};
  if (d.type === "heartbeat") {
    console.log("WORKER_HEARTBEAT_OK");
    clearInterval(timer);
    worker.terminate();
    process.exit(0);
  }
  if (d.type === "failed") {
    console.error(`WORKER_FAILED ${String(d.reason ?? "")}`);
    process.exit(1);
  }
};
worker.onerror = (event) => { console.error(`WORKER_ERROR ${event.message}`); process.exit(1); };
worker.postMessage({ type: "init", pacerHome: home, env: {}, selfCommand: ["bun", "run"], pumpMs: 0, heartbeatMs: 1000 });