import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import * as limits from "../src/core/limits";
import * as runners from "../src/core/runners";
import { readBlocked } from "../src/executors/blocked";
import { readMarks } from "../src/usage/reactive";
import { fakeCtx } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/x");
const codeOf = (fn: () => unknown) => { try { fn(); return "no error"; } catch (e) { return (e as { code?: string }).code; } };

test("block refuses the planner and unknown ids", () => {
  const ctx = fakeCtx();
  for (const id of ["claude-code", "gemini"]) expect(codeOf(() => runners.block(ctx, id, {}, s))).toBe("unknown_executor");
  expect(readBlocked(ctx)).toEqual({});
});

test("block with a duration, then unblock", () => {
  const ctx = fakeCtx();
  runners.block(ctx, "codex", { for: "2h", reason: "busy" }, s);
  expect(readBlocked(ctx).codex).toEqual({ until: ctx.now + 7200, reason: "busy" });
  runners.unblock(ctx, "codex", s);
  expect(readBlocked(ctx).codex).toBeUndefined();
});

test("block refuses a malformed duration as invalid_input", () => {
  const ctx = fakeCtx();
  expect(codeOf(() => runners.block(ctx, "codex", { for: "soon" }, s))).toBe("invalid_input");
});

test("report marks the provider until the given time or its cooldown", () => {
  const ctx = fakeCtx();
  expect(limits.report(ctx, "codex", ctx.now + 60, s)).toEqual({ provider: "codex", exhaustedUntil: ctx.now + 60 });
  expect(readMarks(ctx).codex).toBe(ctx.now + 60);
  expect(limits.report(ctx, "cursor", undefined, s).exhaustedUntil).toBe(ctx.now + s.providers.cursor.cooldownS);
});

test("report refuses a non-numeric until and unknown providers", () => {
  const ctx = fakeCtx();
  expect(codeOf(() => limits.report(ctx, "codex", Number.NaN, s))).toBe("invalid_input");
  expect(codeOf(() => limits.report(ctx, "gemini", undefined, s))).toBe("unknown_executor");
});
