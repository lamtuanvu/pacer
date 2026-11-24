/**
 * Logging loopback OpenAI stub for CT-11 debugging: append every request line
 * (method, url, authorization, body) to a file so I can confirm the sandbox
 * service actually reaches the loopback port.
 *
 * Run directly on a fixed port: `bun test/plugin-parity/logging-stub.ts --port 8901 --log=/tmp/stub-c4.log`.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const logFile = process.argv.find((a) => a.startsWith("--log="))?.slice("--log=".length) ?? "/tmp/stub-c4.log";
const server = Bun.serve({
  port: Number(process.argv[process.argv.indexOf("--port") + 1]),
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    const auth = req.headers.get("authorization") ?? "";
    appendFileSync(logFile, `REQ ${req.method} ${url.pathname} auth=${JSON.stringify(auth)}\nbody=${text}\n`);
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    return new Response('{"choices":[{"message":{"content":"hello-from-stub"}}]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});
writeFileSync(logFile, `listening on ${server.port}\n`);
console.log(`logging stub on ${server.port}`);
Bun.sleep(Number.MAX_SAFE_INTEGER).then(() => {});