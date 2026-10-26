import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";

test("limits.refresh returns per-account outcomes and rejects unknown accounts", async () => {
  const ctx = fakeCtx({ now: 1_800_000_000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {usage: reactive}\n");
  const all = await callOp(ctx, "limits.refresh", {}) as { accounts: { account: string; outcome: string }[] };
  expect(all.accounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ account: "claude-code", outcome: "unchanged" }),
    expect.objectContaining({ account: "cursor", outcome: "unsupported" }),
  ]));
  expect(await callOp(ctx, "limits.refresh", { account: "cursor" })).toMatchObject({ accounts: [{ account: "cursor", outcome: "unsupported" }] });
  expect(callOp(ctx, "limits.refresh", { account: "missing" })).rejects.toMatchObject({ code: "invalid_input" });
});
