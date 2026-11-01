import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDelegateBrief, validateInput } from "../src/tasks/api";
import { queueCapacity } from "../src/tasks/capacity";
import { validateStrategy } from "../src/config/strategy";
import { queueStrategy } from "./queue-helpers";
import { fakeCtx } from "./helpers";

interface Golden {
  id: string;
  raw: Record<string, unknown>;
  brief?: Record<string, unknown>;
  input?: Record<string, unknown>;
  error?: string;
}
const goldens = JSON.parse(readFileSync(new URL("./fixtures/task-admission/brief-goldens.json", import.meta.url), "utf8")) as Golden[];
const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "test");

for (const golden of goldens) test(`delegate brief golden: ${golden.id}`, () => {
  const ctx = fakeCtx();
  const raw = { ...golden.raw, repo: golden.raw.repo === "$REPO" ? ctx.home : golden.raw.repo };
  if (golden.error) {
    expect(() => parseDelegateBrief(raw, ctx.home)).toThrow(golden.error);
    return;
  }
  const parsed = parseDelegateBrief(raw, ctx.home);
  expect(JSON.parse(JSON.stringify(parsed.brief))).toEqual({ ...golden.brief, repo: ctx.home });
  for (const [key, value] of Object.entries(golden.input ?? {})) expect(parsed).toHaveProperty(key, value);
  expect(validateInput(strategy, parsed)).toEqual([]);
});

test("brief parser accepts default repository without copying internal admission fields", () => {
  const ctx = fakeCtx();
  const parsed = parseDelegateBrief({ goal: "work", admissionLease: "untrusted", workGrant: "untrusted" }, ctx.home);
  expect(parsed.brief.repo).toBe(ctx.home);
  expect(parsed).not.toHaveProperty("admissionLease");
  expect(parsed).not.toHaveProperty("workGrant");
});

test("queue capacity goldens preserve executor-slot isolation", () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/task-admission/capacity-goldens.json", import.meta.url), "utf8")) as Array<{
    id: string;
    executor: string;
    use: { byExecutor: Record<string, number>; byHost: Record<string, number>; local: number };
    expected: NonNullable<ReturnType<typeof queueCapacity>> | null;
  }>;
  for (const row of cases) {
    expect(queueCapacity(queueStrategy(true), row.executor, row.use) ?? null).toEqual(row.expected);
  }
});
