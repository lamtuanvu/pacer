import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import { type Backend, directBackend, selectBackend } from "../src/exec/backend";
import type { AttemptOutcome } from "../src/exec/direct";
import { runTask } from "../src/tasks/runner";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

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
