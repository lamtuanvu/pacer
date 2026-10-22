import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

test("private native bootstrap is consumed before a non-service command can run", async () => {
  const ctx = fakeCtx();
  ctx.env.PACER_INTERNAL_NATIVE_BOOTSTRAP = JSON.stringify({schema:1,argv:["/tmp/pacer","serve"],frontVersion:"0.8.0"});
  const result = await main(["--pacer-identity"], ctx);
  expect(result.code).toBe(2);
  expect(result.err).toContain("internal service");
  expect(ctx.env.PACER_INTERNAL_NATIVE_BOOTSTRAP).toBeUndefined();
});
test("malformed native bootstrap is removed even when validation fails", async () => {
  const ctx = fakeCtx();
  ctx.env.PACER_INTERNAL_NATIVE_BOOTSTRAP = "{";
  const result = await main(["--pacer-identity"], ctx);
  expect(result.code).toBe(2);
  expect(ctx.env.PACER_INTERNAL_NATIVE_BOOTSTRAP).toBeUndefined();
});
