import { withLoginIndicators } from "./helpers";
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { type Backend, directBackend, selectBackend } from "../src/exec/backend";
import { EXTRA_BACKENDS } from "../src/exec/backends-extra";
import type { AttemptOutcome } from "../src/exec/direct";
import { readAttemptUsage } from "../src/tokens/store";
import { runTask } from "../src/tasks/runner";
import { createTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
const ok: AttemptOutcome = {
  exec: { code: 0, stdout: "r", stderr: "", timedOut: false }, report: "r",
  attempt: { executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" },
};
const fake = (id: string, available: () => Promise<boolean>, out: AttemptOutcome | Error = ok): Backend => ({
  id, available,
  runAttempt: async () => { if (out instanceof Error) throw out; return out; },
});

test("selectBackend: first available extra wins, else direct; PACER_BACKEND forces", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const extra = fake("extra", async () => true);
  expect((await selectBackend(ctx, s, [extra])).id).toBe("extra");
  expect((await selectBackend(ctx, s, [fake("extra", async () => false)])).id).toBe("direct");
  expect((await selectBackend(ctx, s, [])).id).toBe("direct");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "direct" } }, s, [extra])).id).toBe("direct");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "extra" } }, s, [fake("extra", async () => false)])).id).toBe("extra");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "nope" } }, s, [extra])).id).toBe("direct");
});

test("throwing available falls back to direct", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const broken = fake("orca", async () => { throw new Error("orca down"); });
  expect(await selectBackend(ctx, s, [broken])).toBe(directBackend);
});

const status = (): Status => ({
  generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true,
  executors: { ranked: [], excluded: [] },
  providers: [{ id: "codex", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false } as ProviderStatus],
});

test("the runner records the backend and worktree and verifies in the worktree", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const t = createTask(ctx, { brief: { goal: "g", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const verified: string[] = [];
  const r = await runTask(ctx, t.id, {
    loadStrategy: () => s,
    computeStatus: async () => status(),
    runAttempt: async () => ({ ...ok, backend: "orca", worktree: "/wt/task" }),
    verifyRepo: async (repo) => { verified.push(repo); return { files: "x" }; },
  });
  expect(verified).toEqual(["/wt/task"]);
  expect(r.result).toMatchObject({ status: "done", backend: "orca", worktree: "/wt/task" });
});

test("the runner stores each attempt's tokens with the attempt and in the usage index", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const t = createTask(ctx, { brief: { goal: "g", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const log = join(tmpDir(), "attempt.log");
  writeFileSync(log, "$ codex exec -\n--- stdout\ndone\ntokens used\n1,234\n\n--- exit 0\n");
  const r = await runTask(ctx, t.id, {
    loadStrategy: () => s, computeStatus: async () => status(),
    runAttempt: async () => ({ ...ok, attempt: { ...ok.attempt, log } }),
    verifyRepo: async () => ({ files: "" }),
  });
  expect(r.attempts[0]!.tokens).toMatchObject({ coverage: "partial", total: 1234, selfReported: true });
  expect(readAttemptUsage(ctx, t.id).get(1)).toMatchObject({ coverage: "partial", total: 1234 });
});

test("extra backend error finishes failed", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const t = createTask(ctx, { brief: { goal: "g", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const r = await runTask(ctx, t.id, {
    loadStrategy: () => s,
    computeStatus: async () => status(),
    runAttempt: async () => { throw new Error("orca worker failed to start"); },
    verifyRepo: async () => ({ files: "" }),
  });
  expect(r.result).toMatchObject({ status: "failed", executor: "codex" });
  expect(r.result?.report).toContain("orca worker failed to start");
});

test("a throwing selected extra backend is recorded", async () => {
  const ctx = withLoginIndicators(fakeCtx());
  const t = createTask(ctx, { brief: { goal: "g", repo: "/repo" }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const backend = fake("throwing-extra", async () => true, new Error("worker startup failed"));
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: unmetered }\n");
  EXTRA_BACKENDS.unshift(backend);
  try {
    const r = await runTask(ctx, t.id);
    expect(r.result).toMatchObject({ status: "failed", executor: "codex", backend: "throwing-extra" });
    expect(r.result?.report).toContain("worker startup failed");
  } finally {
    EXTRA_BACKENDS.splice(EXTRA_BACKENDS.indexOf(backend), 1);
  }
});


for (const agent of ["claude-code", "codex"]) {
  for (const source of ["default", "pacer", "orca"]) {
    test(`${agent} ${source} can select Orca when ready`, async () => {
      const raw = {accounts: {plan: {kind: "claude", home: "~/.plan"}, team: {kind: agent === "codex" ? "codex" : "claude",
        ...(source === "pacer" ? {home: "~/.team"} : source === "orca" ? {orca_account: "team-id"} : {})}},
        planner: "claude-code#plan", routing: [{default: [`${agent}#team`]}], execution: {backend: "orca"}};
      const strategy = validateStrategy(raw, "test");
      const ctx = withLoginIndicators(fakeCtx());
      const orca = fake("orca", async () => true);
      expect((await selectBackend(ctx, strategy, [orca], `${agent}#team`)).id).toBe("orca");
      ctx.env.PACER_BACKEND = "orca";
      expect((await selectBackend(ctx, strategy, [orca], `${agent}#team`)).id).toBe("orca");
    });
  }
}

test("connection and unsupported agents remain direct", async () => {
  const strategy = validateStrategy({planner: "claude-code", accounts: {plan: {kind: "claude"}, endpoint: {kind: "endpoint", usage: "unmetered", connection: {api: "openai-compatible", base_url: "https://example.test/v1", key: "none", models: [{id: "m", context: 128000, output: 16000, tools: true}]}}},
    routing: [{default: ["opencode#endpoint"]}], execution: {backend: "orca"}}, "test");
  const ctx = fakeCtx({env: {PACER_BACKEND: "orca"}});
  const orca = fake("orca", async () => true);
  const cursor = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, cursor: {}}}, "test");
  expect((await selectBackend(ctx, cursor, [orca], "cursor")).id).toBe("direct");
  expect((await selectBackend(ctx, strategy, [orca], "opencode#endpoint")).id).toBe("direct");
});

test("interactive runners use direct", async () => {
  const strategy = validateStrategy({planner: "codex", accounts: {main: {kind: "codex"}}, runners: {codex: {session: "interactive"}}}, "/x");
  const ctx = fakeCtx({env: {PACER_BACKEND: "orca"}});
  expect((await selectBackend(ctx, strategy, [fake("orca", async () => true)], "codex")).id).toBe("direct");
});

test("forced Orca falls back when unavailable", async () => {
  const ctx = fakeCtx({env: {PACER_BACKEND: "orca"}});
  expect((await selectBackend(ctx, s, [fake("orca", async () => false)], "codex")).id).toBe("direct");
});
