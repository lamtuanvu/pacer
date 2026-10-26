import { expect, test } from "bun:test";
import { execProcess } from "../src/exec/process";

test("JSON-RPC request keeps stdin open until the matching response arrives", async () => {
  const child = [
    "let sawEnd = false;",
    "process.stdin.on('end', () => { sawEnd = true; process.exit(0); });",
    "process.stdin.once('data', () => setTimeout(() => process.stdout.write(JSON.stringify({id: 2, result: {open: !sawEnd}}) + '\\n'), 10));",
    "process.stdin.resume();",
  ].join("\n");
  const result = await execProcess({ argv: [process.execPath, "-e", child], cwd: process.cwd(), env: process.env,
    stdin: '{"id":2}\n', stdinUntilResponseId: 2, timeoutMs: 2_000, maxStdoutBytes: 1024 });
  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(JSON.parse(result.stdout.trim()).result.open).toBe(true);
});
