/**
 * Test core for the Rust front doors (`PACER_CORE_ARGV`): the real `serve --internal` HTTP server and `api --stdio`
 * handler. Every HTTP path and stdio method that reaches Core is appended to `<PACER_HOME>/core-calls.log`, never
 * parameters or keys, so a test can tell the host effects bridge from a forwarded operation.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { runStdio } from "../../src/api/stdio";
import { makeCtx } from "../../src/ctx";
import { startServer } from "../../src/serve/http";

const ctx = makeCtx();
const fresh = () => ({ ...ctx, now: Date.now() / 1000 });
const record = (call: string) => appendFileSync(join(ctx.pacerHome, "core-calls.log"), `${call}\n`);

async function* methods() {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try { const { method } = JSON.parse(line); if (typeof method === "string") record(method); } catch {}
    yield line;
  }
}

const [command, flag] = process.argv.slice(2);
if (command === "serve" && flag === "--internal") {
  const token = ctx.env.PACER_INTERNAL_TOKEN!;
  delete ctx.env.PACER_INTERNAL_TOKEN;
  const core = startServer(fresh, { internal: { token } });
  const logged = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST") record(url.pathname);
      url.host = `127.0.0.1:${core.port}`;
      const headers = new Headers(req.headers);
      headers.set("host", url.host);
      return fetch(url, { method: req.method, headers, body: req.body, redirect: "manual" });
    },
  });
  process.stdout.write(`${JSON.stringify({ internal: { port: logged.port } })}\n`);
  writeFileSync(join(ctx.pacerHome, "core-ready"), String(process.pid));
  process.stdin.once("end", () => { logged.stop(true); void core.stop().finally(() => process.exit(0)); });
  process.stdin.resume();
} else if (command === "api" && flag === "--stdio") {
  const nativeConfigKey = ctx.env.PACER_NATIVE_CONFIG_SYNC_KEY;
  delete ctx.env.PACER_NATIVE_CONFIG_SYNC_KEY;
  await runStdio(fresh, methods(), line => { process.stdout.write(line); }, { nativeConfigKey });
  process.exit(0);
} else {
  process.exit(2);
}
