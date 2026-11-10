// Test-only core wrapper: runs the TypeScript core given as arguments and passes its stdin through.
// PACER_TEST_CORE_LOG appends every line the core receives. PACER_TEST_STRATEGY_EDIT replaces
// strategy.yaml just before the core receives the first account.list request or account-list
// bridge request; native account.list has already made its own strategy read by then, so this is
// a fixed barrier between the two loads.
import { appendFileSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { spawnPinned } from "../port-isolation";

const replacement = process.env.PACER_TEST_STRATEGY_EDIT;
const log = process.env.PACER_TEST_CORE_LOG;
const target = join(process.env.PACER_HOME!, "strategy.yaml");
const child = spawnPinned(process.argv.slice(2), { stdin: "pipe", stdout: "inherit", stderr: "inherit", env: process.env });
process.on("SIGTERM", () => { child.kill("SIGTERM"); });

let edited = !replacement, buffer = "";
const decoder = new TextDecoder();
const pass = (line: string) => {
  if (!edited && /"method":"(account\.list|_internal\.account-list\.parts)"/.test(line)) {
    copyFileSync(replacement!, `${target}.next`);
    renameSync(`${target}.next`, target);
    edited = true;
  }
  if (log) appendFileSync(log, line);
  child.stdin.write(line);
  child.stdin.flush();
};
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    pass(buffer.slice(0, end + 1));
    buffer = buffer.slice(end + 1);
  }
}
if (buffer) pass(buffer);
child.stdin.end();
process.exit(await child.exited);
