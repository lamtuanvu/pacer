// Record only method names crossing the native-to-core channel, never parameters or keys.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { CORE_SECRETS_ENV, readCoreSecrets } from "../../../src/core-secrets";

const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../src/cli.ts"), ...process.argv.slice(2)],
  { stdin: "pipe", stdout: "inherit", stderr: "inherit", env: process.env });
// The door's secrets frame precedes the JSON-RPC lines; hand it on to the real Core unchanged.
if (process.env[CORE_SECRETS_ENV]) {
  const body = JSON.stringify(readCoreSecrets());
  child.stdin.write(`pacer-core-secrets/1 ${Buffer.byteLength(body)}\n${body}`);
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (typeof request.method === "string") appendFileSync(process.env.PACER_TEST_METHOD_LOG!, request.method + "\n");
  child.stdin.write(line + "\n");
}
await child.stdin.end();
process.exit(await child.exited);
