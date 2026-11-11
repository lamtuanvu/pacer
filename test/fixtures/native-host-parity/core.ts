// Record only method names crossing the native-to-core channel, never parameters or keys.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../src/cli.ts"), ...process.argv.slice(2)],
  { stdin: "pipe", stdout: "inherit", stderr: "inherit", env: process.env });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (typeof request.method === "string") appendFileSync(process.env.PACER_TEST_METHOD_LOG!, request.method + "\n");
  child.stdin.write(line + "\n");
}
await child.stdin.end();
process.exit(await child.exited);
