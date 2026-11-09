import { expect, test } from "bun:test";
import { join } from "node:path";

test("perf:tick reports a failure with a nonzero exit", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/perf/pump-tick.ts"), "not-a-number"], { stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain("settled task count");
});
