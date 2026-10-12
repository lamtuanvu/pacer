import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { orcaStatus, renderOrcaStatus } from "../src/exec/orca/status";
import { updateOrcaState } from "../src/exec/orca/state";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";
import { fail, fakeRun, ok, raw } from "./fixtures/orca/fake";

const O = (...a: string[]) => ["orca", ...a];
const COORD = "term_1ddadcbd-780e-4951-b184-c51193ff39c6";
const RUN = "run_9d54b4f3810a";

function writeStrategy(ctx: Ctx, extra = "") {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n${extra}`);
}
function seed(ctx: Ctx) {
  updateOrcaState(ctx, (s) => {
    s.coordinator = COORD;
    s.run = RUN;
    s.workers.ctx_df599d4e7101 = {
      dispatchId: "ctx_df599d4e7101", taskId: "t-20261011-150000-ab12", executor: "cursor",
      worktree: "~/worktrees/pacer-exec-t2", terminal: "term_563674c8-c109-455e-a291-35acf015d00c", startedAt: 1,
    };
  });
}

test("ready runtime: coordinator, run and live workers are shown", async () => {
  const f = fakeRun([
    [O("status"), ok("status-ready.json")],
    [O("terminal", "show"), ok("terminal-show-live.json")],
    [O("orchestration", "run-show"), ok("run-show.json")],
    [O("orchestration", "worker-show"), ok("worker-show-ready.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  writeStrategy(ctx, "execution:\n  backend: orca\n  worktree: current\n");
  seed(ctx);
  const r = await orcaStatus(ctx);
  expect(r.runtime).toEqual({ ready: true, detail: "ready", version: "1.4.224" });
  expect(r.coordinator).toEqual({ handle: COORD, live: true });
  expect(r.run).toEqual({ id: RUN, found: true });
  expect(r.workers[0].state).toBe("ready");
  const text = renderOrcaStatus(r);
  expect(text).toContain("orca runtime: ready (Orca 1.4.224)");
  expect(text).toContain("execution: backend orca, worktree current, base branch (the repo's current branch)");
  expect(text).toContain(`coordinator: ${COORD} (live)`);
  expect(text).toContain(`run: ${RUN}\n`);
  expect(text).toMatch(/ctx_df599d4e7101 {2}t-20261011-150000-ab12 {2}cursor +ready +~\/worktrees\/pacer-exec-t2/);
  expect(f.count(O("terminal", "create"))).toBe(0);
  expect(f.count(O("orchestration", "run-create"))).toBe(0);
});

test("runtime down: nothing else is queried", async () => {
  const f = fakeRun([[O("status"), ok("status-down.json")]]);
  const ctx = fakeCtx({ run: f.run });
  writeStrategy(ctx);
  seed(ctx);
  const r = await orcaStatus(ctx);
  expect(r.runtime).toEqual({ ready: false, detail: "not_running (unreachable)", version: null });
  expect(f.calls).toHaveLength(1);
  const text = renderOrcaStatus(r);
  expect(text).toContain("orca runtime: not ready (not_running (unreachable))");
  expect(text).toContain(`coordinator: ${COORD} (not checked)`);
  expect(text).toContain(`run: ${RUN} (not checked)`);
  expect(text).toContain("execution: backend auto, worktree child-of-current");
});

test("orca not installed; no state yet; no strategy", async () => {
  const ctx = fakeCtx({ run: fakeRun([[O("status"), raw("", 127, "not found")]]).run });
  const r = await orcaStatus(ctx);
  expect(r.runtime.detail).toBe("not_installed: not found");
  expect(r.execution.ok).toBe(false);
  const text = renderOrcaStatus(r);
  expect(text).toContain("coordinator: none yet (created on the first Orca task)");
  expect(text).toContain("run: none yet");
  expect(text).toContain("workers: none");
  expect(text).toContain("no strategy found");
});

test("stale coordinator, missing run and missing worker are reported, not repaired", async () => {
  const f = fakeRun([
    [O("status"), ok("status-ready.json")],
    [O("terminal", "show"), fail("terminal-show-stale.json")],
    [O("orchestration", "run-show"), fail("run-show-missing.json")],
    [O("orchestration", "worker-show"), fail("worker-show-missing.json")],
  ]);
  const ctx = fakeCtx({ run: f.run });
  writeStrategy(ctx, "execution:\n  backend: sideways\n");
  seed(ctx);
  const text = renderOrcaStatus(await orcaStatus(ctx));
  expect(text).toContain(`coordinator: ${COORD} (gone; a new one is created on the next Orca task)`);
  expect(text).toContain(`run: ${RUN} (not found; a new one is created on the next Orca task)`);
  expect(text).toContain("dispatch_not_found");
  expect(text).toContain('execution.backend must be one of auto, orca, direct (got "sideways")');
  expect(f.count(O("terminal", "create"))).toBe(0);
});

test("CLI: pacer orca status [--json], usage error, listed in help", async () => {
  const ctx = fakeCtx({ run: fakeRun([[O("status"), ok("status-ready.json")]]).run });
  writeStrategy(ctx);
  const json = await main(["orca", "status", "--json"], ctx);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.out).runtime.ready).toBe(true);
  const text = await main(["orca", "status"], ctx);
  expect(text.out).toContain("orca runtime: ready");
  const bad = await main(["orca"], ctx);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("usage: pacer orca status [--json]");
  expect((await main(["help"], ctx)).out).toContain("orca status [--json]");
});
