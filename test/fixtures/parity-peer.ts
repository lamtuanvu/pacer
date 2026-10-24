// Controlled subprocess negative controls, never a substitute for native evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.argv[2];
for await (const line of console) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (mode === "timeout") continue;
  if (mode === "malformed") { console.log("{"); continue; }
  if (mode === "error" && request.method !== "hello") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "invalid", data: { code: "invalid_input" } } }));
    continue;
  }
  let result: unknown = { protocol: 3 };
  const file = join(process.env.PACER_HOME!, "state.json");
  if (request.method === "write") {
    writeFileSync(file, JSON.stringify({ value: mode === "state" ? "broken" : request.params.value }));
    result = { value: mode === "result" ? "broken" : request.params.value, updatedAt: mode === "timestamp" ? "2026-01-02" : "2026-01-01" };
  }
  if (request.method === "read") result = { value: "kept", fixture: readFileSync(join(process.env.PACER_HOME!, "seed.json"), "utf8") };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: mode === "id" ? 999 : request.id, result }));
}
