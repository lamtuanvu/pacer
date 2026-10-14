import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { type Backend, directBackend, selectBackend } from "../src/exec/backend";
import { EXTRA_BACKENDS } from "../src/exec/backends-extra";
import type { AttemptOutcome } from "../src/exec/direct";
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
  const ctx = fakeCtx();
  const orca = fake("orca", async () => true);
  expect((await selectBackend(ctx, s, [orca])).id).toBe("orca");
  expect((await selectBackend(ctx, s, [fake("orca", async () => false)])).id).toBe("direct");
  expect((await selectBackend(ctx, s, [])).id).toBe("direct");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "direct" } }, s, [orca])).id).toBe("direct");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "orca" } }, s, [fake("orca", async () => false)])).id).toBe("orca");
  expect((await selectBackend({ ...ctx, env: { PACER_BACKEND: "nope" } }, s, [orca])).id).toBe("direct");
});

test("throwing available falls back to direct", async () => {
  const ctx = fakeCtx();
  const broken = fake("orca", async () => { throw new Error("orca down"); });
  expect(await selectBackend(ctx, s, [broken])).toBe(directBackend);
});

const status = (): Status => ({
  generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
  executors: { ranked: [], excluded: [] },
  providers: [{ id: "codex", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false } as ProviderStatus],
});

test("the runner records the backend and worktree and verifies in the worktree", async () => {
  const ctx = fakeCtx();
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

test("extra backend error finishes failed", async () => {
  const ctx = fakeCtx();
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
  const ctx = fakeCtx();
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
    for (const backend of ["orca", "auto", "direct"]) {
      test(`${agent} ${source} account selects backend under ${backend}`, async () => {
        const raw = {
          accounts: { plan: {kind: "claude", home: "~/.plan"}, team: {kind: agent === "codex" ? "codex" : "claude",
            ...(source === "pacer" ? {home: "~/.team"} : source === "orca" ? {orca_account: "team-id"} : {})} },
          planner: "claude-code#plan", routing: [{default: [`${agent}#team`]}], execution: {backend},
        };
        const strategy = validateStrategy(raw, "test");
        const ctx = fakeCtx();
        const orca = fake("orca", async () => backend !== "direct");
        const selected = await selectBackend(ctx, strategy, [orca], `${agent}#team`);
        expect(selected.id).toBe(source === "default" && backend !== "direct" ? "orca" : "direct");
        // An explicit backend override must also preserve the account restriction.
        ctx.env.PACER_BACKEND = "orca";
        expect((await selectBackend(ctx, strategy, [orca], `${agent}#team`)).id).toBe(source === "default" ? "orca" : "direct");
      });
    }
  }
}

for (const source of ["pacer", "orca"]) {
  test(`task runner keeps ${source} accounts away from Orca and logs direct reason`, async () => {
    const bin = tmpDir();
    writeFileSync(join(bin, "claude"), '#!/bin/sh\nprintf "%s" "$CLAUDE_CONFIG_DIR"\n');
    chmodSync(join(bin, "claude"), 0o755);
    const ctx = fakeCtx({env: {PATH: `${bin}:${process.env.PATH}`, PACER_BACKEND: "orca"}});
    ctx.env.ORCA_USER_DATA_PATH = tmpDir();
    const home = source === "pacer" ? join(ctx.home, ".team") : join(ctx.env.ORCA_USER_DATA_PATH, "claude-profiles", "team-id", "home");
    mkdirSync(home, {recursive: true});
    const raw = {
      accounts: {plan: {kind: "claude"}, team: {kind: "claude", usage: "unmetered",
        ...(source === "pacer" ? {home} : {orca_account: "team-id"})}},
      planner: "claude-code", routing: [{default: ["claude-code#team"]}], execution: {backend: "orca"},
    };
    await Bun.write(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
    const strategy = validateStrategy(raw, "test");
    const task = createTask(ctx, {brief: {goal: "g", repo: tmpDir()}, kind: null, requestedExecutor: null, timeoutS: 30});
    let orcaRuns = 0;
    const orca: Backend = {id: "orca", available: async () => true, runAttempt: async () => {orcaRuns++; throw Error("non-default account reached Orca");}};
    EXTRA_BACKENDS.unshift(orca);
    try {
      const result = await runTask(ctx, task.id, {
        loadStrategy: () => strategy,
        computeStatus: async () => ({...status(), providers: [{...status().providers[0], id: "claude-code#team"}]}),
        verifyRepo: async () => ({files: ""}),
      });
      expect(result.result).toMatchObject({status: "done", backend: "direct"});
      expect(result.result?.report).toContain(home);
      expect(orcaRuns).toBe(0);
      expect(readFileSync(result.attempts[0].log, "utf8")).toContain("direct backend: non-default account (Orca launch can't pre-approve folder trust)");
    } finally {
      EXTRA_BACKENDS.splice(EXTRA_BACKENDS.indexOf(orca), 1);
    }
  });
}
