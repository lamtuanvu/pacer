// Test-only core wrapper: runs the TypeScript core given as arguments and replaces
// strategy.yaml with PACER_TEST_STRATEGY_EDIT just before the core receives the first
// account.list request or account-list bridge request. Native account.list has already
// made its own strategy read by then, so this is a fixed barrier between the two loads.
import { copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const replacement = process.env.PACER_TEST_STRATEGY_EDIT!;
const target = join(process.env.PACER_HOME!, "strategy.yaml");
const child = Bun.spawn(process.argv.slice(2), { stdin: "pipe", stdout: "inherit", stderr: "inherit", env: process.env });
process.on("SIGTERM", () => { child.kill("SIGTERM"); });

let edited = false, buffer = "";
const decoder = new TextDecoder();
const pass = (line: string) => {
  if (!edited && /"method":"(account\.list|_internal\.account-list\.parts)"/.test(line)) {
    copyFileSync(replacement, `${target}.next`);
    renameSync(`${target}.next`, target);
    edited = true;
  }
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
