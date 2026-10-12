import { expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runAttempt, tail } from "../src/exec/direct";
import { createTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/x");

function fakeBin(name: string, script: string): string {
  const dir = tmpDir();
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return dir;
}

async function setup(name: string, script: string) {
  const bin = fakeBin(name, script);
  const repo = tmpDir();
  const ctx = fakeCtx({ env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
  const task = createTask(ctx, { brief: { goal: "Do it", repo }, kind: null, requestedExecutor: null, timeoutS: 30 });
  return { ctx, task, repo };
}

test("codex: report comes from the -o last-message file; attempt recorded", async () => {
  const { ctx, task } = await setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "FINAL REPORT" > "$out"; echo noisy');
  let spawned = 0;
  const o = await runAttempt(ctx, s.providers.codex, task, (pid) => { spawned = pid; });
  expect(spawned).toBeGreaterThan(0);
  expect(o.exec.code).toBe(0);
  expect(o.report).toBe("FINAL REPORT");
  expect(o.attempt).toMatchObject({ executor: "codex", model: null, exitCode: 0, timedOut: false, limitHit: false });
  expect(await Bun.file(o.attempt.log).exists()).toBe(true);
});

test("cursor: report is the stdout tail; limit output marks limitHit", async () => {
  const { ctx, task } = await setup("cursor-agent", 'echo "You have hit your usage limit"; exit 1');
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.report).toContain("usage limit");
  expect(o.attempt.limitHit).toBe(true);
});

test("launcher error becomes a failed attempt instead of throwing", async () => {
  const { ctx, task } = await setup("x", "true");
  const o = await runAttempt(ctx, { ...s.providers.codex, id: "gemini" }, task);
  expect(o.exec.code).toBe(127);
  expect(o.report).toContain('no launcher for provider "gemini"');
  expect(o.attempt.exitCode).toBe(127);
});

test("tail keeps the last n characters", () => {
  expect(tail("abcdef", 3)).toBe("def");
  expect(tail("ab", 3)).toBe("ab");
});

test("executor launch sets its role while preserving the caller environment", async () => {
  const { ctx, task } = await setup("cursor-agent", 'printf "%s:%s" "$PACER_ROLE" "$CUSTOM_VALUE"');
  ctx.env.HOME = ctx.home;
  ctx.env.PACER_ROLE = "planner";
  ctx.env.CUSTOM_VALUE = "kept";
  expect((await runAttempt(ctx, s.providers.cursor, task)).report).toBe("executor:kept");
  expect(ctx.env.PACER_ROLE).toBe("planner");
});
