import { startHealthListener } from "../../src/serve/health-listener";
const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("backend") });
const listener = startHealthListener(backend.port!, 0, process.argv.includes("stale") ? 600 : undefined);
console.log(JSON.stringify({ port: listener.port }));
setTimeout(() => {
  console.log("blocking");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  console.log("unblocked");
}, 100);
process.on("SIGTERM", () => { listener.stop(); backend.stop(true); process.exit(0); });
