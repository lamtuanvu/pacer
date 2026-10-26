// Controlled subprocess negative controls, never a substitute for native evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2];
if (mode === "startup-delay") { await Bun.sleep(150); console.error("pacer-parity-ready"); }
if (mode === "startup-stall") await Bun.sleep(2000);
if (mode === "startup-error") { console.error("synthetic startup import failure"); process.exit(2); }
if (mode === "ready-timeout") console.error("pacer-parity-ready");
if (mode === "ready-noise") { console.error("pacer-parity-ready"); console.log("not-json"); }
for await (const line of console) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (mode === "timeout" || mode === "ready-timeout") continue;
  if (mode === "malformed") { console.log("{"); continue; }
  if (mode === "error" && request.method !== "hello") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid", data: { code: "invalid_input" } } }));
    continue;
  }
  if (mode === "hello-error") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unsupported protocol" } }));
    continue;
  }
  if (mode === "symlink-write") writeFileSync(join(process.env.PACER_HOME!, "alias.json"), "{\"corrupted\":true}");
  let result: unknown = { protocol: mode === "hello-wrong" ? "2.8.0" : "3.0.0" };
  const file = join(process.env.PACER_HOME!, "state.json");
  if (request.method === "write") {
    writeFileSync(file, JSON.stringify({ value: mode === "state" ? "broken" : request.params.value }));
    result = { value: mode === "result" ? "broken" : request.params.value, updatedAt: mode === "timestamp" ? "2026-01-02" : "2026-01-01" };
  }
  if (request.method === "read") result = { value: "kept", fixture: readFileSync(join(process.env.PACER_HOME!, "seed.json"), "utf8") };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: mode === "id" ? 999 : request.id, result }));
  if (mode === "pause-input" && request.method === "hello") await Bun.sleep(2000);
}

if (mode === "inherited-stdout") {
  Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 2000)"], { stdin: "ignore", stdout: "inherit", stderr: "ignore" }).unref();
}
