// Step code must reach the run branch and the PR (B8, B9, N1, N2, N3, N6). Real
// git, the real engine and tick, and the real review op: no step row is written by
// hand and no verdict is recorded around the engine, so the ordering is covered.
import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import * as tasks from "../src/core/tasks";
import { CoreError } from "../src/core/errors";
import { gitInfo } from "../src/core/git";
import { buildPrompt } from "../src/exec/prompt";
import { renderTurnPrompt } from "../src/messaging/turns";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord, TaskState } from "../src/tasks/types";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { evalCondition, parseCondition } from "../src/workflow/condition";
import { mergeTaskOnAccept } from "../src/workflow/branch";
import {
  answerGenerateApproval, answerHumanStep, awaitTerminalSettle, chooseWorkflow, recordStepResult,
  retryFailedStep, startRun, stopRun, type EngineDeps,
} from "../src/workflow/engine";
import { submitGraph } from "../src/workflow/generate";
import { parseWorkflow } from "../src/workflow/parse";
import { publishRun } from "../src/workflow/publish";
import type { WorkflowDef } from "../src/workflow/schema";
import { addDefinition, getRun, stepsOfRun, workflowDatabase, type StepRow } from "../src/workflow/store";
import { advanceRuns } from "../src/workflow/tick";
import { wakeCauseStillOpen, stepWakeRef } from "../src/workflow/wakeups";
import type { Ctx } from "../src/types";

const WORKFLOWS = join(import.meta.dir, "..", "plugins", "pacer-dev");

function world() {
  const home = tmpDir();
  const bin = tmpDir();
  const ghLog = join(bin, "gh.log");
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/bin/sh
echo "$@" >> "${ghLog}"
if [ "$1 $2" = "pr list" ]; then echo '[]'; else cat >/dev/null; echo "https://github.com/acme/widget/pull/7"; fi
`);
  chmodSync(gh, 0o755);
  const ctx = fakeCtx({ run: realRun, home, pacerHome: join(home, ".pacer"), now: Math.floor(Date.now() / 1000), which: name => name === "gh" ? gh : "/usr/bin/fake" });
  workflowDatabase(ctx);
  const repo = gitRepo();
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const remote = tmpDir();
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "main");

  const inputs: DelegateInput[] = [];
  const byRequest = new Map<string, string>();
  const delegate: EngineDeps["delegate"] = async (c, input) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(c, prior)!;
    inputs.push(input);
    const task = createTask(c, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.requestId) byRequest.set(input.requestId, task.id);
    return task;
  };
  const deps: EngineDeps = {
    delegate,
    stopTask: (c, id) => { updateTask(c, id, t => { t.state = "stopped"; }); },
  };
  const tick = async () => {
    ctx.now += 6;
    await advanceRuns(ctx, () => 4242, deps, { skipDefaultPacing: true, pacingMode: "normal" });
  };

  /** The executor's own checkout, cut from the brief's base as a runner would. */
  const checkout = async (taskId: string) => {
    const task = readTask(ctx, taskId)!;
    if (task.worktree) return task.worktree;
    const info = await gitInfo(ctx.run, repo);
    if ("error" in info) throw new Error(info.error);
    const base = git(repo, "rev-parse", task.brief.base ?? "main");
    const made = await createTaskWorktree(ctx, info, taskId, base);
    if ("error" in made) throw new Error(made.error);
    updateTask(ctx, taskId, t => { t.state = "running"; t.worktree = made.path; t.baseSha = base; });
    return made.path;
  };
  const commit = async (taskId: string, file: string, body = file) => {
    const path = await checkout(taskId);
    writeFileSync(join(path, file), body);
    git(path, "add", file);
    git(path, "commit", "-q", "-m", `add ${file}`);
    return path;
  };
  const finish = (taskId: string, state: TaskState = "done") => updateTask(ctx, taskId, t => {
    t.state = state;
    t.result = { status: state as "done", executor: "codex", model: null, files: "", report: "", backend: "direct", ...(t.worktree ? { worktree: t.worktree } : {}) };
  });
  /** A whole executor attempt: optional commit, report, settle, tick. */
  const execute = async (taskId: string, o: { file?: string; body?: string; result?: unknown } = {}) => {
    await checkout(taskId);
    if (o.file) await commit(taskId, o.file, o.body);
    recordStepResult(ctx, taskId, o.result ?? { summary: "ok" });
    finish(taskId);
    await tick();
  };
  const step = (runId: string, stepId: string, branch?: string): StepRow => {
    const rows = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId && (branch === undefined || s.branch === branch));
    const row = rows[rows.length - 1];
    if (!row) throw new Error(`no step ${stepId} in ${runId}: ${stepsOfRun(ctx, runId).map(s => s.stepId)}`);
    return row;
  };
  const accept = async (taskId: string) => {
    const result = await tasks.review(ctx, taskId, { verdict: "accept" });
    await tick();
    return result;
  };
  const branchFile = (branch: string, file: string) => {
    const r = Bun.spawnSync(["git", "-C", repo, "show", `${branch}:${file}`]);
    return r.exitCode === 0 ? r.stdout.toString() : null;
  };
  const install = (def: WorkflowDef, prompts?: Record<string, string>) =>
    addDefinition(ctx, def, JSON.stringify(def), { prompts: prompts ?? {} });
  const bundled = (file: string) => {
    const source = readFileSync(join(WORKFLOWS, "workflows", file), "utf8");
    const { def, errors } = parseWorkflow(source);
    expect(errors).toEqual([]);
    const prompts = Object.fromEntries(readdirSync(join(WORKFLOWS, "prompts"))
      .filter(f => f.endsWith(".md")).map(f => [`prompts/${f}`, readFileSync(join(WORKFLOWS, "prompts", f), "utf8")]));
    addDefinition(ctx, def!, source, { prompts });
    return def!;
  };
  return { ctx, repo, remote, ghLog, git, inputs, deps, tick, checkout, commit, finish, execute, step, accept, branchFile, install, bundled };
}

const chain: WorkflowDef = {
  id: "t/code", version: 1, entry: "impl",
  steps: {
    impl: { type: "agent", kind: "feature", prompt: "Implement" },
    look: { type: "agent", role: "reviewer", prompt: "Review" },
    more: { type: "agent", kind: "docs", prompt: "Docs" },
    done: { type: "end" },
  },
  edges: [{ from: "impl", to: "look" }, { from: "look", to: "more" }, { from: "more", to: "done" }],
};

async function startChain(w: ReturnType<typeof world>, def = chain) {
  w.install(def);
  return startRun(w.ctx, { workflow: def.id, repo: w.repo, brief: "b" }, undefined, w.deps);
}

test("a code step waits for review; dependents start only after the merge, from a tip that holds the commit", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  expect(w.inputs[0]!.brief.commitWork).toBe(true);
  await w.execute(impl, { file: "a.txt" });

  expect(w.step(run.id, "impl").status).toBe("waiting");
  expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
  expect(w.inputs).toHaveLength(1);
  const ref = stepWakeRef(run.id, "impl", 1);
  expect(wakeCauseStillOpen(w.ctx, run.id, "review_due", ref)).toBe(true);
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${impl}`)!;
  expect(item.actions.map(a => a.label)).toEqual(["Accept", "Reject"]);
  // Further ticks neither advance nor settle the step.
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("waiting");

  // The person's button is the real op.
  await callOp(w.ctx, item.actions[0]!.op, item.actions[0]!.params, { spawnRunner: () => 4242 });
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("done");
  expect(wakeCauseStillOpen(w.ctx, run.id, "review_due", ref)).toBe(false);
  expect(deriveWorkflowAttention(w.ctx).some(i => i.id === `run_review:${impl}`)).toBe(false);

  // The reviewer (not a code step) starts from the run branch tip.
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(w.inputs).toHaveLength(2);
  expect(w.inputs[1]).toMatchObject({ worktree: "new", brief: { base: branch } });
  expect(w.inputs[1]!.brief.commitWork).toBeUndefined();
  const look = w.step(run.id, "look").taskId!;
  const lookTree = await w.checkout(look);
  expect(readFileSync(join(lookTree, "a.txt"), "utf8")).toBe("a.txt");
  await w.execute(look);
  expect(w.step(run.id, "look").status).toBe("done");

  const more = w.step(run.id, "more").taskId!;
  expect(readFileSync(join(await w.checkout(more), "a.txt"), "utf8")).toBe("a.txt");
  await w.execute(more, { file: "docs.md" });
  expect(getRun(w.ctx, run.id)!.status).not.toBe("done");
  await w.accept(more);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  await awaitTerminalSettle(run.id);
  expect(w.branchFile(branch, "a.txt")).toBe("a.txt");
  expect(w.branchFile(branch, "docs.md")).toBe("docs.md");
});

test("a delegation that races another task change is made again instead of failing the run", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "a.txt" });
  const real = w.deps.delegate;
  const race = () => Promise.reject(new CoreError("conflict", "Policy context changed"));
  let failures = 2;
  w.deps.delegate = (c, input, spawn) => failures-- > 0 ? race() : real(c, input, spawn);
  await w.accept(impl);
  expect(w.step(run.id, "look").taskId).toBeTruthy();

  // One that outlives the retries leaves the row for the tick, and the run live.
  const look = w.step(run.id, "look").taskId!;
  w.deps.delegate = race;
  await w.execute(look);
  expect(getRun(w.ctx, run.id)!.status).not.toBe("failed");
  expect(w.step(run.id, "more")).toMatchObject({ status: "running" });
  expect(w.step(run.id, "more").taskId).toBeUndefined();
  w.deps.delegate = real;
  w.ctx.now += 120;
  await w.tick();
  expect(w.step(run.id, "more").taskId).toBeTruthy();
});

test("a verdict that lands before the engine saw the settlement advances once", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.commit(impl, "a.txt");
  recordStepResult(w.ctx, impl, { summary: "ok" });
  w.finish(impl);
  await tasks.review(w.ctx, impl, { verdict: "accept" });
  expect(w.step(run.id, "impl").status).toBe("running");
  await w.tick();
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("done");
  expect(w.inputs).toHaveLength(2);
});

test("an accept recorded without a merge is merged before the edges fire", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "a.txt" });
  updateTask(w.ctx, impl, t => { t.review = { accepted: true, kind: null, note: null, at: w.ctx.now }; });
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("done");
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "a.txt")).toBe("a.txt");
});

test("reject fails the step; the retry starts from the run branch tip and does not see rejected code", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "bad.txt" });
  await tasks.review(w.ctx, impl, { verdict: "reject" });
  await w.tick();
  expect(w.step(run.id, "impl")).toMatchObject({ status: "failed", error: "review rejected" });
  expect(workflowDatabase(w.ctx).query("SELECT ref FROM workflow_wakeups WHERE cause = 'step_failed'").all())
    .toEqual([{ ref: stepWakeRef(run.id, "impl", 1) }]);
  expect(w.inputs).toHaveLength(1);
  await retryFailedStep(w.ctx, { runId: run.id, stepId: "impl" }, undefined, w.deps);
  const again = w.step(run.id, "impl").taskId!;
  expect(again).not.toBe(impl);
  await w.execute(again, { file: "good.txt" });
  await w.accept(again);
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(w.branchFile(branch, "good.txt")).toBe("good.txt");
  expect(w.branchFile(branch, "bad.txt")).toBeNull();
  // The rejected work is not lost: its branch stays.
  expect(w.branchFile(`pacer/${impl}`, "bad.txt")).toBe("bad.txt");
});

test("uncommitted work is refused at step.result and at accept, never dropped", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  const tree = await w.commit(impl, "a.txt");
  const executor: Ctx = { ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: impl } };

  writeFileSync(join(tree, "a.txt"), "edited, not committed");
  await expect(callOp(executor, "step.result", { result: { summary: "ok" } }))
    .rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/uncommitted changes/) });
  expect(w.step(run.id, "impl").result).toBeUndefined();
  w.git(tree, "commit", "-qam", "edit");
  writeFileSync(join(tree, "forgotten.txt"), "never added");
  await callOp(executor, "step.result", { result: { summary: "ok" } });
  w.finish(impl);
  await w.tick();

  const refused = { code: "invalid_input", message: expect.stringMatching(/uncommitted changes in the task worktree/) };
  await expect(tasks.review(w.ctx, impl, { verdict: "accept" })).rejects.toMatchObject(refused);
  expect(readTask(w.ctx, impl)!.review).toBeUndefined();
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("waiting");

  // Commits left off the task branch are refused too.
  w.git(tree, "checkout", "-q", "-b", "side");
  w.git(tree, "add", "forgotten.txt");
  w.git(tree, "commit", "-qm", "side work");
  await expect(tasks.review(w.ctx, impl, { verdict: "accept" }))
    .rejects.toMatchObject({ message: expect.stringMatching(/commits that are not on/) });
  w.git(tree, "checkout", "-q", `pacer/${impl}`);
  w.git(tree, "merge", "-q", "--ff-only", "side");
  await w.accept(impl);
  expect(w.step(run.id, "impl").status).toBe("done");
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "forgotten.txt")).toBe("never added");
});

test("a code step with nothing but uncommitted files is refused; a clean zero-change accept passes", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  const tree = await w.checkout(impl);
  writeFileSync(join(tree, "only.txt"), "uncommitted");
  recordStepResult(w.ctx, impl, { summary: "ok" });
  w.finish(impl);
  await w.tick();
  await expect(tasks.review(w.ctx, impl, { verdict: "accept" })).rejects.toMatchObject({ code: "invalid_input" });
  Bun.spawnSync(["rm", join(tree, "only.txt")]);
  await w.accept(impl);
  expect(w.step(run.id, "impl").status).toBe("done");
});

const fan: WorkflowDef = {
  id: "t/fan", version: 1, entry: "build",
  steps: {
    build: { type: "fanout", branches: ["x", "y"], each: { type: "agent", kind: "feature", prompt: "Build" }, join: "all" },
    done: { type: "end" },
  },
  edges: [{ from: "build", to: "done" }],
};

test("a merge conflict keeps the branch waiting; resolving it lets the accept and the join finish", async () => {
  const w = world();
  const run = await startChain(w, fan);
  const x = w.step(run.id, "build", "x").taskId!, y = w.step(run.id, "build", "y").taskId!;
  await w.checkout(x);
  await w.checkout(y);
  await w.execute(x, { file: "same.txt", body: "from x\n" });
  await w.execute(y, { file: "same.txt", body: "from y\n" });
  await w.accept(x);
  expect(w.step(run.id, "build", "x").status).toBe("done");
  expect(getRun(w.ctx, run.id)!.status).not.toBe("done");

  const conflict = await w.accept(y);
  expect(conflict).toMatchObject({ accepted: false, merge: "conflict" });
  expect(w.step(run.id, "build", "y").status).toBe("waiting");
  expect(readTask(w.ctx, y)!.review).toBeUndefined();
  expect(wakeCauseStillOpen(w.ctx, run.id, "review_due", stepWakeRef(run.id, "build", 1, "y"))).toBe(false);
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${y}`)!;
  expect(item.detail).toContain(conflict.resolution_task!);

  const resolution = conflict.resolution_task!;
  const tree = await w.checkout(resolution);
  Bun.spawnSync(["git", "-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", `pacer/${y}`]);
  writeFileSync(join(tree, "same.txt"), "both\n");
  w.git(tree, "commit", "-qam", "resolve");
  w.finish(resolution);
  await w.accept(resolution);
  await w.accept(y);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "same.txt")).toBe("both\n");
});

test("a send-back resumes the parked task, which may report again", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "a.txt" });
  updateTask(w.ctx, impl, t => { t.state = "running"; });
  recordStepResult(w.ctx, impl, { summary: "second" });
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("waiting");
  await w.commit(impl, "b.txt");
  w.finish(impl);
  await w.tick();
  expect(w.step(run.id, "impl")).toMatchObject({ status: "waiting", result: { summary: "second" } });
  await w.accept(impl);
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "b.txt")).toBe("b.txt");
});

test("a retry successor takes the step over, even in the reused worktree, and its work is merged", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "a.txt" });
  const parent = readTask(w.ctx, impl)!;
  // The shape a send-back retry leaves: same worktree and branch, linked tasks.
  const next: TaskRecord = createTask(w.ctx, { brief: parent.brief, kind: parent.kind, requestedExecutor: null, timeoutS: 600 });
  updateTask(w.ctx, next.id, t => { t.state = "running"; t.retryOf = impl; t.worktree = parent.worktree; t.baseSha = w.git(parent.worktree!, "rev-parse", "HEAD"); });
  updateTask(w.ctx, impl, t => { t.retriedBy = next.id; t.review = { accepted: false, kind: null, note: "again", at: w.ctx.now }; });
  await w.tick();
  expect(w.step(run.id, "impl")).toMatchObject({ status: "running", taskId: next.id });
  expect(w.step(run.id, "impl").result).toBeUndefined();
  writeFileSync(join(parent.worktree!, "b.txt"), "b");
  w.git(parent.worktree!, "add", "b.txt");
  w.git(parent.worktree!, "commit", "-qm", "fix");
  recordStepResult(w.ctx, next.id, { summary: "fixed" });
  w.finish(next.id);
  await w.tick();
  await w.accept(next.id);
  expect(w.step(run.id, "impl").status).toBe("done");
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(w.branchFile(branch, "a.txt")).toBe("a.txt");
  expect(w.branchFile(branch, "b.txt")).toBe("b");
});

test("a successor accepted before the engine adopts it is still merged", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl);
  const next = createTask(w.ctx, { brief: readTask(w.ctx, impl)!.brief, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(w.ctx, next.id, t => { t.retryOf = impl; });
  await w.commit(next.id, "late.txt");
  w.finish(next.id);
  updateTask(w.ctx, impl, t => { t.retriedBy = next.id; });
  await mergeTaskOnAccept(w.ctx, next.id);
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "late.txt")).toBe("late.txt");
});

test("stopping a run keeps the parked task's branch", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl, { file: "a.txt" });
  await stopRun(w.ctx, run.id, getRun(w.ctx, run.id)!.rev, w.deps);
  await awaitTerminalSettle(run.id);
  expect(w.step(run.id, "impl").status).toBe("stopped");
  // The finished task is left as it was, still reviewable.
  expect(readTask(w.ctx, impl)!.state).toBe("done");
  expect(w.branchFile(`pacer/${impl}`, "a.txt")).toBe("a.txt");
});

test("publish refuses a branch with no commits beyond its base", async () => {
  const w = world();
  const def: WorkflowDef = {
    id: "t/empty", version: 1, entry: "impl",
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "I" },
      ok: { type: "human", decision: "must", approves: "publish", question: { text: "ok?", kind: "approve_revise" } },
      done: { type: "end" },
    },
    edges: [{ from: "impl", to: "ok" }, { from: "ok", to: "done", when: "result.answer == 'approve'" }],
  };
  w.install(def);
  const run = await startRun(w.ctx, { workflow: def.id, repo: w.repo, brief: "b", publish: "draft" }, undefined, w.deps);
  const impl = w.step(run.id, "impl").taskId!;
  await w.execute(impl);
  await w.accept(impl);
  await expect(publishRun(w.ctx, run.id, { draft: true, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev }))
    .rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/no commits/) });
});

const evidence = { summary: "s", passed: 0, failed: 0, unverified: 1, surfaces: [{ name: "cli", status: "unverified", steps: ["x"], artifacts: [], reason: "no surface" }] };

test("bundled bug workflow: the pushed branch carries the fix", async () => {
  const w = world();
  const def = w.bundled("bug.yaml");
  const run = await startRun(w.ctx, { workflow: `${def.id}@${def.version}`, repo: w.repo, brief: "fix it" }, undefined, w.deps);
  await w.execute(w.step(run.id, "investigate").taskId!);
  const fix = w.step(run.id, "reproduce_or_fix").taskId!;
  await w.execute(fix, { file: "fix.txt" });
  await w.accept(fix);
  const testTask = w.step(run.id, "test").taskId!;
  expect(readFileSync(join(await w.checkout(testTask), "fix.txt"), "utf8")).toBe("fix.txt");
  await w.commit(testTask, "fix.test.txt");
  updateTask(w.ctx, testTask, t => { t.state = "running"; });
  recordStepResult(w.ctx, testTask, evidence);
  w.finish(testTask);
  await w.tick();
  await w.accept(testTask);
  await answerHumanStep(w.ctx, run.id, "approve_publish", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
  const published = await publishRun(w.ctx, run.id, { draft: false, title: "Fix", body: "body", expectRev: getRun(w.ctx, run.id)!.rev });
  expect(published.pr_url).toContain("/pull/7");
  const branch = published.run.branch!;
  expect(w.git(w.remote, "diff", "--name-only", `main..${branch}`).split("\n").sort()).toEqual(["fix.test.txt", "fix.txt"]);
});

test("bundled feature@2: the generated child's code reaches the parent's branch and PR", async () => {
  const w = world();
  w.bundled("feature-v2.yaml");
  const run = await startRun(w.ctx, { workflow: "pacer-dev/feature@2", repo: w.repo, brief: "add it" }, undefined, w.deps);
  const orch = w.step(run.id, "brainstorm").taskId!;
  updateTask(w.ctx, orch, t => { t.state = "running"; });
  recordStepResult(w.ctx, orch, { spec: "s" });
  updateTask(w.ctx, orch, t => { t.state = "done"; });
  await w.tick();
  await answerHumanStep(w.ctx, run.id, "approve_spec", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
  for (const branch of ["architecture", "devils-advocate", "ux", "security"]) {
    await w.execute(w.step(run.id, "review", branch).taskId!, { result: { verdict: "pass" } });
  }
  expect(w.step(run.id, "plan").status).toBe("waiting");
  const graph: WorkflowDef = {
    id: "gen/plan", version: 1, entry: "impl",
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "Implement" },
      look: { type: "agent", role: "reviewer", prompt: "Review", result: { required: ["verdict"] } },
      tests: { type: "agent", kind: "tests", prompt: "Test" },
      done: { type: "end" },
    },
    edges: [{ from: "impl", to: "look" }, { from: "look", to: "tests" }, { from: "tests", to: "done" }],
  };
  const submitted = await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: graph }, w.deps);
  expect(submitted.errors).toEqual([]);
  await answerGenerateApproval(w.ctx, { runId: run.id, stepId: "plan", answer: "approve", expectRev: getRun(w.ctx, run.id)!.rev }, w.deps);
  const childId = (w.step(run.id, "plan").result as { childRunId: string }).childRunId;
  const impl = w.step(childId, "impl").taskId!;
  await w.execute(impl, { file: "feature.txt" });
  // The item names the person's run, never the generated child's ids (UI-12).
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${impl}`)!;
  expect(item.detail).not.toMatch(/run_|gen\//);
  expect(item.run!.id).toBe(run.id);
  await w.accept(impl);
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(branch).toBeTruthy();
  expect(getRun(w.ctx, childId)!.branch ?? undefined).toBeUndefined();
  const look = w.step(childId, "look").taskId!;
  expect(readFileSync(join(await w.checkout(look), "feature.txt"), "utf8")).toBe("feature.txt");
  await w.execute(look, { result: { verdict: "pass" } });
  const checks = w.step(childId, "tests").taskId!;
  await w.execute(checks, { file: "feature.test.txt" });
  await w.accept(checks);
  expect(getRun(w.ctx, childId)!.status).toBe("done");
  await awaitTerminalSettle(childId);
  // B9: `result.status == 'done'` matches the child's result.
  expect(w.step(run.id, "plan")).toMatchObject({ status: "done", result: { status: "done" } });
  expect(w.step(run.id, "approve_publish").status).toBe("waiting");
  await answerHumanStep(w.ctx, run.id, "approve_publish", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
  await publishRun(w.ctx, run.id, { draft: false, title: "Add", body: "body", expectRev: getRun(w.ctx, run.id)!.rev });
  expect(w.git(w.remote, "diff", "--name-only", `main..${branch}`).split("\n").sort()).toEqual(["feature.test.txt", "feature.txt"]);
});

test("every bundled definition has an edge for each success result the engine produces", () => {
  const shapes: Record<string, unknown> = {
    human: { answer: "approve" },
    agent: { verdict: "pass" },
    fanout: { branches: {}, done: 1, failed: 0, verdict: "pass" },
    generate: { workflow: "gen/plan", reason: "", child: { id: "run_x", status: "done" }, steps: {}, status: "done" },
    choose_workflow: { workflow: "w", reason: "r", child: { id: "run_x", status: "done" }, steps: {}, status: "done" },
  };
  for (const file of readdirSync(join(WORKFLOWS, "workflows")).filter(f => f.endsWith(".yaml"))) {
    const { def } = parseWorkflow(readFileSync(join(WORKFLOWS, "workflows", file), "utf8"));
    for (const [id, step] of Object.entries(def!.steps)) {
      const out = def!.edges.filter(e => e.from === id);
      if (out.length === 0) continue;
      const matched = out.filter(e => e.when === undefined
        || evalCondition(parseCondition(e.when).ast!, { result: shapes[step.type], brief: "b" }));
      expect({ file, id, matched: matched.length > 0 }).toEqual({ file, id, matched: true });
    }
  }
});

test("a chosen child inherits the root's draft opt-in; a plain run's child does not gain one", async () => {
  const w = world();
  w.install(chain);
  const router: WorkflowDef = {
    id: "t/router", version: 1, entry: "pick",
    steps: { pick: { type: "choose_workflow" }, done: { type: "end" } },
    edges: [{ from: "pick", to: "done" }],
  };
  w.install(router);
  for (const publish of ["draft", undefined] as const) {
    const run = await startRun(w.ctx, { workflow: router.id, repo: w.repo, brief: "b", ...(publish ? { publish } : {}) }, undefined, w.deps);
    const child = await chooseWorkflow(w.ctx, { runId: run.id, stepId: "pick", workflow: chain.id, reason: "r" }, undefined, w.deps);
    expect(getRun(w.ctx, child.id)!.publishOptIn ?? undefined).toBe(publish);
  }
});

test("only workflow code steps are told to commit; ordinary briefs are unchanged", () => {
  const brief = { goal: "g", repo: "/r" };
  for (const mayDelegate of [false, true]) {
    const plain = buildPrompt(brief, "t-1", mayDelegate);
    const code = buildPrompt({ ...brief, commitWork: true }, "t-1", mayDelegate);
    expect(plain).toMatch(/Do not commit/);
    expect(plain).not.toMatch(/Commit your work/);
    expect(code).toMatch(/Commit your work on the current task branch/);
    expect(code).not.toMatch(/Do not commit/);
  }
  const w = world();
  const ordinary = createTask(w.ctx, { brief, kind: "feature", requestedExecutor: null, timeoutS: 60 });
  expect(renderTurnPrompt(w.ctx, ordinary, [])).toContain("Do not commit.");
  expect(renderTurnPrompt(w.ctx, { ...ordinary, brief: { ...brief, commitWork: true } }, [])).toContain("Commit your work");
});
