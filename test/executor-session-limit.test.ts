import { expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../src/core/errors";
import { sessionLimitOutcome, stopAtSessionLimit } from "../src/plugins/executor-production";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { createTask, updateTask } from "../src/tasks/store";
import type { RunRef } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";

const LIMIT = "Cursor Agent\n  Error: Weekly usage limit reached. It resets in 5 days.\n  rateLimitReason: prepaid_balance_exhausted\n";
const lease = new CoreError("plugin_timeout", "observation lease expired");

/** A live owned interactive Cursor run whose screen has been quiet for a minute. */
async function ownedRun(screen: string, o: {executor?: string; controller?: boolean} = {}) {
  const ctx = fakeCtx(), dir = tmpDir();
  // The run prints its own screen: the wrapper truncates stdout when it starts, so a screen
  // written from outside can be wiped after the fact.
  const started = startRun({dir, argv: ["sh", "-c", 'printf "%s" "$SCREEN"; exec sleep 30'], cwd: dir, env: {PATH: process.env.PATH, SCREEN: screen}});
  if ("error" in started) throw new Error(started.error);
  const printed = () => existsSync(join(dir, "stdout")) && readFileSync(join(dir, "stdout"), "utf8").includes(screen.trim());
  for (const end = Date.now() + 5000; !printed(); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error("the run never printed its screen");
  }
  writeFileSync(join(dir, "interactive.json"), "{}");
  if (o.controller) writeFileSync(join(dir, "session.state"), JSON.stringify({controller: "terminal"}));
  const quiet = Date.now() / 1000 - 60;
  utimesSync(join(dir, "stdout"), quiet, quiet);
  const task = createTask(ctx, {brief: {goal: "limit", repo: dir}, kind: null, requestedExecutor: null, timeoutS: 600});
  const run: RunRef = {dir, attempt: 1, executor: o.executor ?? "cursor", startedAt: quiet - 60, mode: "current", workdir: dir, logFile: join(dir, "log"), session: "interactive"};
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = run; t.executorProvider = "pacer-exec-direct"; });
  return {ctx, id: task.id, run, expected: {attempt: 1, dir, executor: run.executor}};
}

test("a lease renewal stops a quiet session that shows the provider's limit error", async () => {
  const {ctx, id, run, expected} = await ownedRun(LIMIT);
  await stopAtSessionLimit(ctx, id, lease, expected);
  expect(readRun(run.dir).exit).not.toBeNull();
}, 15_000);

test("other errors, other agents, plain screens and a person driving never stop the session", async () => {
  for (const [screen, error, o] of [
    [LIMIT, new CoreError("conflict", "x"), {}],
    [LIMIT, lease, {executor: "codex"}],
    ["Implemented rate limit handling; usage limit reached errors now return 429\n", lease, {}],
    [LIMIT, lease, {controller: true}],
  ] as const) {
    const {ctx, id, run, expected} = await ownedRun(screen, o);
    try {
      await stopAtSessionLimit(ctx, id, error, expected);
      expect(readRun(run.dir).alive).toBe(true);
    } finally { await stopRun(run.dir, {graceMs: 500}); }
  }
}, 30_000);

test("an ended session with the limit on screen is a limit outcome unless it reported a result", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), "{}");
  writeFileSync(join(dir, "stdout"), LIMIT);
  const out = {exec: {code: 143, timedOut: false}, report: "Interactive session exited without an explicit completion report"};
  expect(sessionLimitOutcome("cursor", dir, out)).toBe(true);
  expect(out.report).toContain("Usage limit reached:\nError: Weekly usage limit reached");
  expect(sessionLimitOutcome("cursor", dir, {exec: {code: 0, timedOut: false}, report: ""})).toBe(false);
  writeFileSync(join(dir, "report.json"), JSON.stringify({status: "failed", summary: "Tests failed", source: "agent", at: Date.now() / 1000}));
  expect(sessionLimitOutcome("cursor", dir, {exec: {code: 1, timedOut: false}, report: ""})).toBe(false);
});
