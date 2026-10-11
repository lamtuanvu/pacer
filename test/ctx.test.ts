import { expect, test } from "bun:test";
import { defaultRun, makeCtx } from "../src/ctx";

test("makeCtx honours PACER_HOME and HOME from env", () => {
  const c = makeCtx({ env: { HOME: "/h", PACER_HOME: "/p" } });
  expect(c.home).toBe("/h");
  expect(c.pacerHome).toBe("/p");
  expect(makeCtx({ env: { HOME: "/h" } }).pacerHome).toBe("/h/.pacer");
});

test("defaultRun captures output and reports a missing binary as code 127 instead of throwing", async () => {
  const ok = await defaultRun(["sh", "-c", "echo hi; echo err >&2; exit 3"], 5000);
  expect(ok).toEqual({ code: 3, stdout: "hi\n", stderr: "err\n" });
  const missing = await defaultRun(["definitely-not-a-binary-pacer"], 5000);
  expect(missing.code).toBe(127);
});
