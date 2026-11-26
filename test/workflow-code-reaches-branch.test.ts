// Step code must reach the run branch and the PR (B8, B9, N1, N2, N3, N6). Real
// git, the real engine and tick, and the real review op: no step row is written by
// hand and no verdict is recorded around the engine, so the ordering is covered.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { adoptGeneratedBranches, mergeTaskOnAccept, reviewRef, runBranchName, syncBase } from "../src/workflow/branch";
import { reviewerPanels } from "../src/view-model/run-board";
import type { RunDetail } from "../src/dashboard/screens/types";
import { registerWork } from "../src/dispatch/work";
import {
  answerGenerateApproval, answerHumanStep, awaitTerminalSettle, chooseWorkflow, failRun, recordStepResult,
  retryFailedStep, skipFailedStep, startRun, stopRun, type EngineDeps,
} from "../src/workflow/engine";
import { submitGraph, validateGenerated } from "../src/workflow/generate";
import { parseWorkflow } from "../src/workflow/parse";
import { publishRun } from "../src/workflow/publish";
import type { WorkflowDef } from "../src/workflow/schema";
import { addDefinition, clearRunBranch, getRun, listDecisions, recordDecision, setCursor, setPublishOptIn, setRunConflict, setRunBranch, stepsOfRun, workflowDatabase, type StepRow } from "../src/workflow/store";
import { taskChangesSince } from "../src/tasks/changes";
import { settleTurn } from "../src/workflow/orchestrator";
import { issueRunGrant } from "../src/workflow/run-grant";
import { authorizeWorkOperation } from "../src/core/work";
import { assertPublishGate } from "../src/workflow/publish";
import { advanceRuns } from "../src/workflow/tick";
import { liveTurn, wakeCauseStillOpen, stepWakeRef } from "../src/workflow/wakeups";
import type { Ctx } from "../src/types";

const WORKFLOWS = join(import.meta.dir, "..", "plugins", "pacer-dev");

function world() {
  const home = tmpDir();
  const bin = tmpDir();
  const ghLog = join(bin, "gh.log");
  const gh = join(bin, "gh");
  const prView = join(bin, "pr-view.json"), prList = join(bin, "pr-list.json");
  /** What GitHub says about the pull request now; null: gh cannot tell. */
  const pr = (state: { state: string; isDraft: boolean } | null) =>
    state ? writeFileSync(prView, JSON.stringify(state)) : rmSync(prView, { force: true });
  writeFileSync(gh, `#!/bin/sh
echo "$@" >> "${ghLog}"
case "$1 $2" in
  "pr list") cat "${prList}" 2>/dev/null || echo '[]' ;;
  "pr view") cat "${prView}" 2>/dev/null || exit 1 ;;
  *) cat >/dev/null
     case "$*" in *--draft*) d=true ;; *) d=false ;; esac
     echo "{\\"state\\":\\"OPEN\\",\\"isDraft\\":$d}" > "${prView}"
     echo "https://github.com/acme/widget/pull/7" ;;
esac
`);
  chmodSync(gh, 0o755);
  const ctx = fakeCtx({ run: realRun, home, pacerHome: join(home, ".pacer"), now: Math.floor(Date.now() / 1000), which: name => name === "gh" ? gh : "/usr/bin/fake" });
  workflowDatabase(ctx);
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\n");
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
  /** The attempt record a runner leaves, with a session a send-back can resume. */
  const resumable = (taskId: string) => updateTask(ctx, taskId, t => {
    const workdir = t.worktree!;
    t.executor = "codex";
    t.run = { mode: "new", workdir, dir: tmpDir(), logFile: join(bin, "log"), startedAt: ctx.now, executor: "codex", attempt: 1, agentSession: { id: "session-1", source: "assigned" } };
  });
  const spawned: { id: string; env: Ctx["env"] }[] = [];
  const spawnRunner = (c: Ctx, id: string) => { spawned.push({ id, env: c.env }); return 4242; };
  /** Dependencies of the review op: a delegate that honours the retry's commit. */
  const reviewDeps = {
    spawnRunner,
    delegate: async (c: Ctx, input: DelegateInput) => {
      const commitTask = () => {
        const next = createTask(c, { brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600 });
        return updateTask(c, next.id, t => {
          t.retryOf = input.retryOf;
          if (input.reuseWorktree) { t.worktree = input.reuseWorktree; t.baseSha = input.baseSha; }
        });
      };
      return input.commitWith ? input.commitWith(commitTask) : commitTask();
    },
  };
  /** A real send-back that continues the task's session; the runner then takes it up. */
  const sendBack = async (taskId: string, c: Ctx = ctx) => {
    const sent = await tasks.review(c, taskId, { verdict: "send_back", note: "again" }, reviewDeps);
    updateTask(ctx, taskId, t => { t.state = "running"; });
    return sent;
  };
  const taskOf = (runId: string, stepId: string, branch?: string) => step(runId, stepId, branch).taskId!;
  const reject = async (taskId: string) => { await tasks.review(ctx, taskId, { verdict: "reject" }); await tick(); };
  const wakes = (cause: string) => workflowDatabase(ctx)
    .query<{ ref: string }, [string]>("SELECT ref FROM workflow_wakeups WHERE cause = ? AND done_at IS NULL").all(cause).map(r => r.ref);
  return {
    ctx, repo, remote, ghLog, git, inputs, deps, tick, checkout, commit, finish, execute, step, accept, branchFile,
    install, bundled, pr, prList, resumable, spawned, reviewDeps, sendBack, taskOf, reject, wakes,
  };
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

test("a verdict the change log no longer holds is picked up by the next tick", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  await tasks.review(w.ctx, impl, { verdict: "accept" });
  // The cursor is already past the verdict's change.
  setCursor(w.ctx, taskChangesSince(w.ctx, 0).head);
  expect(w.step(run.id, "impl").status).toBe("waiting");
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("done");
  expect(w.inputs).toHaveLength(2);
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
  await expect(callOp(executor, "step.result", { result: { summary: "ok" } }))
    .rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/uncommitted changes/) });
  Bun.spawnSync(["mv", join(tree, "forgotten.txt"), join(tree, "..", `${impl}.aside`)]);
  await callOp(executor, "step.result", { result: { summary: "ok" } });
  // Written after the report: accepting still refuses it.
  Bun.spawnSync(["mv", join(tree, "..", `${impl}.aside`), join(tree, "forgotten.txt")]);
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
  expect(item.detail).toContain("merge conflict");
  // No session to continue: the person resolves it, so no turn is woken.
  expect(item.actions.map(a => a.label)).toEqual(["Accept", "Reject"]);

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

test("the real delegate's retry commit moves the step to the new task", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  const spawn = () => 4242;
  const sent = await tasks.review(w.ctx, impl, { verdict: "retry", executor: "codex" }, {
    delegate: (c, input) => tasks.delegate(c, input, spawn), spawnRunner: spawn,
  });
  expect(w.step(run.id, "impl")).toMatchObject({ status: "running", taskId: sent.retry!.id });
  expect(readTask(w.ctx, sent.retry!.id)!.brief).toMatchObject({ commitWork: true, base: getRun(w.ctx, run.id)!.branch });
});

test("a send-back resumes the parked task, which may report again", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  w.resumable(impl);
  await w.sendBack(impl);
  expect(w.spawned.map(s => s.id)).toEqual([impl]);
  recordStepResult(w.ctx, impl, { summary: "second" });
  await w.tick();
  expect(w.step(run.id, "impl").status).toBe("waiting");
  await w.commit(impl, "b.txt");
  w.finish(impl);
  await w.tick();
  expect(w.step(run.id, "impl")).toMatchObject({ status: "waiting", taskId: impl, result: { summary: "second" } });
  expect(w.wakes("review_due")).toEqual([stepWakeRef(run.id, "impl", 1)]);
  await w.accept(impl);
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "b.txt")).toBe("b.txt");
});

test("a retry takes the step over before it can report, and the reused worktree's work is merged and diffed", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  // No resumable session: the real send-back falls back to a retry in the same worktree.
  const sent = await tasks.review(w.ctx, impl, { verdict: "send_back", note: "again" }, w.reviewDeps);
  const next = sent.retry!.id;
  expect(next).not.toBe(impl);
  // No tick yet: the successor already owns the step, so its report is accepted.
  expect(w.step(run.id, "impl")).toMatchObject({ status: "running", taskId: next });
  expect(w.step(run.id, "impl").result).toBeUndefined();
  const tree = readTask(w.ctx, next)!.worktree!;
  writeFileSync(join(tree, "b.txt"), "b");
  w.git(tree, "add", "b.txt");
  w.git(tree, "commit", "-qm", "fix");
  recordStepResult(w.ctx, next, { summary: "fixed" });
  w.finish(next);
  await w.tick();
  const ref = await reviewRef(w.ctx, next);
  expect(ref).toMatchObject({ branch: `pacer/${impl}`, runBranch: getRun(w.ctx, run.id)!.branch });
  // The planner's next turn is told to diff the branch that holds the work.
  const turn = liveTurn(w.ctx, run.id);
  if (turn) await settleTurn(w.ctx, turn.id, { outcome: "done" });
  w.ctx.now += 600;
  await w.tick();
  const prompt = readTask(w.ctx, getRun(w.ctx, run.id)!.orchestratorTaskId!)!.brief.goal;
  expect(prompt).toContain(`"branch": "pacer/${impl}"`);
  await w.accept(next);
  expect(w.step(run.id, "impl").status).toBe("done");
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(w.branchFile(branch, "a.txt")).toBe("a.txt");
  expect(w.branchFile(branch, "b.txt")).toBe("b");
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

const fan3 = (join: "all" | "any" | { quorum: number }): WorkflowDef => ({
  id: `t/fan3-${typeof join === "string" ? join : "quorum"}`, version: 1, entry: "build",
  steps: {
    build: { type: "fanout", branches: ["x", "y", "z"], each: { type: "agent", kind: "feature", prompt: "Build" }, join },
    done: { type: "end" },
  },
  edges: [{ from: "build", to: "done" }],
});

async function parkedFan(w: ReturnType<typeof world>, join: "all" | "any" | { quorum: number }) {
  const run = await startChain(w, fan3(join));
  const [x, y, z] = ["x", "y", "z"].map(b => w.taskOf(run.id, "build", b)) as [string, string, string];
  for (const id of [x, y, z]) await w.checkout(id);
  for (const [id, file] of [[x, "x.txt"], [y, "y.txt"], [z, "z.txt"]] as const) await w.execute(id, { file });
  return { run, x, y, z };
}

test("rejecting one fan-out branch asks for a decision; a retry of only that branch finishes the join", async () => {
  const w = world();
  const { run, x, y, z } = await parkedFan(w, "all");
  await w.reject(y);
  expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
  expect(w.wakes("step_failed")).toEqual([stepWakeRef(run.id, "build", 1, "y")]);
  await w.accept(x);
  await w.accept(z);
  // Every other branch is in, and the rejected one still holds the join.
  expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
  expect(stepsOfRun(w.ctx, run.id).filter(s => s.branch === undefined)).toEqual([]);
  const before = w.inputs.length;
  await retryFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps);
  expect(w.inputs).toHaveLength(before + 1);
  expect(w.wakes("step_failed")).toEqual([]);
  const again = w.step(run.id, "build", "y");
  expect(again).toMatchObject({ attempt: 2, status: "running" });
  await w.execute(again.taskId!, { file: "y2.txt" });
  await w.accept(again.taskId!);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect(["x.txt", "y2.txt", "z.txt", "y.txt"].map(f => w.branchFile(branch, f) !== null)).toEqual([true, true, true, false]);
});

test("skipping a rejected fan-out branch finishes the join without its code", async () => {
  const w = world();
  const { run, x, y, z } = await parkedFan(w, "all");
  await w.accept(x);
  await w.accept(z);
  await w.reject(y);
  await skipFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(w.branchFile(getRun(w.ctx, run.id)!.branch!, "y.txt")).toBeNull();
});

test("join any: a reject does not fail the run; an accept ends parked rows and stops a resumed one", async () => {
  const w = world();
  const { run, x, y, z } = await parkedFan(w, "any");
  await w.reject(x);
  expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
  w.resumable(z);
  await w.sendBack(z);
  await w.accept(y);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(readTask(w.ctx, z)!.state).toBe("stopped");
  expect(w.step(run.id, "build", "z").status).toBe("stopped");
  expect(w.wakes("step_failed")).toEqual([]);
  expect(w.wakes("review_due")).toEqual([]);
});

test("join any leaves a parked task as it is", async () => {
  const w = world();
  const { run, x, y } = await parkedFan(w, "any");
  await w.accept(x);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(readTask(w.ctx, y)!.state).toBe("done");
  expect(w.step(run.id, "build", "y").status).toBe("stopped");
});

test("quorum: two accepts satisfy it despite a rejected branch", async () => {
  const w = world();
  const { run, x, y, z } = await parkedFan(w, { quorum: 2 });
  await w.reject(z);
  await w.accept(x);
  expect(getRun(w.ctx, run.id)!.status).toBe("waiting");
  await w.accept(y);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(w.wakes("step_failed")).toEqual([]);
});

test("failRun leaves finished parked tasks reviewable and stops resumed ones", async () => {
  const w = world();
  const { run, x, y } = await parkedFan(w, "all");
  w.resumable(y);
  await w.sendBack(y);
  await failRun(w.ctx, run.id, "boom", undefined, w.deps);
  expect(readTask(w.ctx, x)!.state).toBe("done");
  expect(readTask(w.ctx, y)!.state).toBe("stopped");
  expect(["x", "y", "z"].map(b => w.step(run.id, "build", b).status)).toEqual(["stopped", "stopped", "stopped"]);
  expect(w.branchFile(`pacer/${x}`, "x.txt")).toBe("x.txt");
});

test("a verdict cannot land between an accept's merge and its record", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  let rejecting: Promise<unknown> | undefined;
  const slow: Ctx = {
    ...w.ctx,
    run: async (argv, timeout, o) => {
      const result = await w.ctx.run(argv, timeout, o);
      if (!rejecting && argv.includes("merge") && argv.includes("--no-ff")) {
        // The merge has landed, the verdict is not recorded yet.
        rejecting = tasks.review(w.ctx, impl, { verdict: "reject" }).then(() => "rejected", e => (e as CoreError).code);
        await Bun.sleep(150);
      }
      return result;
    },
  };
  await tasks.review(slow, impl, { verdict: "accept" });
  expect(await rejecting).toBe("conflict");
  expect(readTask(w.ctx, impl)!.review).toMatchObject({ accepted: true });
});

test("the run grant continues a parked task to commit its work, and never starts a new one", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  const token = issueRunGrant(w.ctx, { runId: run.id, turnId: "turn_t", deadline: w.ctx.now + 600 });
  const orch: Ctx = { ...w.ctx, env: { ...w.ctx.env, PACER_ROLE: "orchestrator", PACER_RUN_GRANT: token, PACER_TASK_ID: "t-orch" } };
  const verdict = (v: string) => () => authorizeWorkOperation(orch, "task.review", { id: impl, verdict: v, expect_rev: 1 });
  expect(verdict("send_back")).not.toThrow();
  expect(verdict("retry")).toThrow(/never delegate/);
  // No session to resume: the fallback would be a new task, which the grant may not start.
  await expect(tasks.review(orch, impl, { verdict: "send_back", note: "commit" }, w.reviewDeps)).rejects.toMatchObject({ code: "not_allowed" });
  expect(readTask(w.ctx, impl)!.retriedBy).toBeUndefined();
  w.resumable(impl);
  await w.sendBack(impl, orch);
  expect(w.spawned.map(s => s.id)).toEqual([impl]);
  expect(w.spawned[0]!.env.PACER_RUN_GRANT).toBeUndefined();
  expect(w.spawned[0]!.env.PACER_TASK_ID).toBeUndefined();
  // Not under review any more (it is running): the grant refuses another send_back.
  w.finish(impl);
  await w.tick();
  expect(w.step(run.id, "impl")).toMatchObject({ status: "waiting", taskId: impl });
});

test("a conflicting branch is sent back to merge the run branch, then accepted; the record closes", async () => {
  const w = world();
  const run = await startChain(w, fan);
  const x = w.taskOf(run.id, "build", "x"), y = w.taskOf(run.id, "build", "y");
  await w.checkout(x);
  await w.checkout(y);
  await w.execute(x, { file: "same.txt", body: "from x\n" });
  await w.execute(y, { file: "same.txt", body: "from y\n" });
  await w.accept(x);
  w.resumable(y);
  const conflict = await w.accept(y);
  expect(conflict).toMatchObject({ accepted: false, merge: "conflict" });
  // The planner is woken and can act on it.
  expect(w.wakes("review_due")).toEqual([stepWakeRef(run.id, "build", 1, "y")]);
  expect(wakeCauseStillOpen(w.ctx, run.id, "review_due", stepWakeRef(run.id, "build", 1, "y"))).toBe(true);
  const record = readTask(w.ctx, conflict.resolution_task!)!;
  expect(record.question).toBeUndefined();
  expect(record.brief.goal).toContain(`pacer review ${y} --send-back`);
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${y}`)!;
  expect(item.actions.map(a => a.label)).toEqual(["Send back to resolve", "Accept", "Reject"]);
  await callOp(w.ctx, item.actions[0]!.op, item.actions[0]!.params, { spawnRunner: () => 4242 });
  updateTask(w.ctx, y, t => { t.state = "running"; });
  expect(readTask(w.ctx, record.id)!.dismissed).toBe(true);
  const tree = readTask(w.ctx, y)!.worktree!;
  const branch = getRun(w.ctx, run.id)!.branch!;
  Bun.spawnSync(["git", "-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", branch]);
  writeFileSync(join(tree, "same.txt"), "both\n");
  w.git(tree, "commit", "-qam", "resolve");
  w.finish(y);
  await w.tick();
  await w.accept(y);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(w.branchFile(branch, "same.txt")).toBe("both\n");
});

test("a conflict on a task out of attempts offers only what still works", async () => {
  const w = world();
  const run = await startChain(w, fan);
  const x = w.taskOf(run.id, "build", "x"), y = w.taskOf(run.id, "build", "y");
  await w.checkout(x);
  await w.checkout(y);
  await w.execute(x, { file: "same.txt", body: "from x\n" });
  await w.execute(y, { file: "same.txt", body: "from y\n" });
  w.resumable(y);
  registerWork(w.ctx, y, { allowDelegation: false, maxAttempts: 1 });
  updateTask(w.ctx, y, t => { t.attempts = [{ executor: "codex" } as TaskRecord["attempts"][number]]; });
  await w.accept(x);
  await mergeTaskOnAccept(w.ctx, y);
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${y}`)!;
  expect(item.actions.map(a => a.label)).toEqual(["Accept", "Reject"]);
  expect(wakeCauseStillOpen(w.ctx, run.id, "review_due", stepWakeRef(run.id, "build", 1, "y"))).toBe(false);
});

test("a base update conflict can be resolved by the commands its record gives", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "same.txt", body: "run\n" });
  await w.accept(impl);
  writeFileSync(join(w.repo, "same.txt"), "base\n");
  w.git(w.repo, "add", "same.txt");
  w.git(w.repo, "commit", "-qm", "base moves");
  const synced = await syncBase(w.ctx, run.id, getRun(w.ctx, run.id)!.rev);
  expect(synced.ok).toBe(false);
  if (synced.ok) return;
  const id = synced.resolution_task, branch = getRun(w.ctx, run.id)!.branch!;
  const goal = readTask(w.ctx, id)!.brief.goal;
  expect(goal).toContain(`git worktree add <dir> -b pacer/${id} ${branch}`);
  const source = getRun(w.ctx, run.id)!.conflict![0]!.branch;
  const dir = join(tmpDir(), "resolve");
  w.git(w.repo, "worktree", "add", "-q", dir, "-b", `pacer/${id}`, branch);
  Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", source]);
  writeFileSync(join(dir, "same.txt"), "both\n");
  w.git(dir, "commit", "-qam", "resolve");
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:${id}`)!;
  expect(item.actions[0]!.op).toBe("run.sync_base");
  await tasks.review(w.ctx, id, { verdict: "accept" });
  expect(getRun(w.ctx, run.id)!.conflict ?? []).toEqual([]);
  expect(w.branchFile(branch, "same.txt")).toBe("both\n");
});

const planned: WorkflowDef = {
  id: "t/planned", version: 1, entry: "prep", policy: { replan: { auto: 1, then: "ask" } },
  steps: {
    prep: { type: "agent", kind: "docs", prompt: "Prep" },
    plan: { type: "generate", role: "orchestrator", prompt: "Plan", limits: { step_types: ["agent", "fanout"], max_steps: 5, max_depth: 2, kinds: ["feature", "tests"] } },
    ok: { type: "human", decision: "must", approves: "publish", question: { text: "ok?", kind: "approve_revise" } },
    done: { type: "end" },
  },
  edges: [{ from: "prep", to: "plan" }, { from: "plan", to: "ok", when: "result.status == 'done'" }, { from: "ok", to: "done", when: "result.answer == 'approve'" }],
};

async function startPlanned(w: ReturnType<typeof world>, graph: WorkflowDef, parentCode: boolean) {
  const def: WorkflowDef = parentCode ? planned : {
    ...planned, id: "t/planned-bare", entry: "plan",
    steps: { plan: planned.steps.plan!, ok: planned.steps.ok!, done: planned.steps.done! },
    edges: planned.edges.slice(1),
  };
  const run = await startChain(w, def);
  if (parentCode) {
    const prep = w.taskOf(run.id, "prep");
    await w.execute(prep, { file: "prep.txt" });
    await w.accept(prep);
  }
  const submitted = await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: graph }, w.deps);
  expect(submitted.errors).toEqual([]);
  return { run, childId: (w.step(run.id, "plan").result as { childRunId: string }).childRunId };
}

const single: WorkflowDef = {
  id: "gen/one", version: 1, entry: "impl",
  steps: { impl: { type: "agent", kind: "feature", prompt: "I" }, done: { type: "end" } },
  edges: [{ from: "impl", to: "done" }],
};

test("a rejected fan-out branch in a generated child goes to the re-plan policy, not to a failed run", async () => {
  const w = world();
  const graph: WorkflowDef = {
    id: "gen/fan", version: 1, entry: "build",
    steps: { build: { type: "fanout", branches: ["x", "y"], each: { type: "agent", kind: "feature", prompt: "B" }, join: "all" }, done: { type: "end" } },
    edges: [{ from: "build", to: "done" }],
  };
  const { run, childId } = await startPlanned(w, graph, false);
  const x = w.taskOf(childId, "build", "x");
  await w.execute(x, { file: "x.txt" });
  await w.reject(x);
  expect(getRun(w.ctx, run.id)!.status).not.toBe("failed");
  expect(w.wakes("replan")).toHaveLength(1);
});

for (const parentCode of [false, true]) {
  test(`upgrade: a generated child that kept its own branch hands it to the parent (${parentCode ? "parent has one" : "parent has none"})`, async () => {
    const w = world();
    const { run, childId } = await startPlanned(w, single, parentCode);
    // The state an earlier service version left: the branch belongs to the child.
    if (!parentCode) {
      w.git(w.repo, "branch", "-D", runBranchName(run.id));
      clearRunBranch(w.ctx, run.id);
    }
    const own = runBranchName(childId);
    w.git(w.repo, "branch", own, "main");
    setRunBranch(w.ctx, childId, { branch: own, base_ref: "main", base_sha: w.git(w.repo, "rev-parse", "main") });
    // Its code step was already delegated against the parent in the new code; redo it from the child's branch.
    const impl = w.taskOf(childId, "impl");
    updateTask(w.ctx, impl, t => { t.brief = { ...t.brief, base: own }; });
    await w.execute(impl, { file: "old.txt" });
    await w.accept(impl);
    await awaitTerminalSettle(childId);
    await w.tick();
    expect(getRun(w.ctx, childId)!.status).toBe("done");
    expect(getRun(w.ctx, childId)!.branch ?? undefined).toBeUndefined();
    expect(w.step(run.id, "plan").status).toBe("done");
    const branch = getRun(w.ctx, run.id)!.branch!;
    expect(branch).toBe(parentCode ? runBranchName(run.id) : own);
    expect(w.branchFile(branch, "old.txt")).toBe("old.txt");
    if (parentCode) expect(w.branchFile(branch, "prep.txt")).toBe("prep.txt");
    await answerHumanStep(w.ctx, run.id, "ok", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
    // The child's id publishes the same branch under the same gate.
    await assertPublishGate(w.ctx, getRun(w.ctx, childId)!, false);
    await publishRun(w.ctx, childId, { draft: false, title: "t", body: "b", expectRev: getRun(w.ctx, childId)!.rev });
    expect(w.git(w.remote, "diff", "--name-only", `main..${branch}`)).toContain("old.txt");
    expect(getRun(w.ctx, run.id)!.prUrl).toContain("/pull/7");
  });
}

/** Two branches write the same file: x is accepted, y's accept conflicts. */
async function conflicted(w: ReturnType<typeof world>, join: "all" | { quorum: number } = "all") {
  const branches = join === "all" ? ["x", "y"] : ["x", "y", "z"];
  const def: WorkflowDef = {
    id: `t/pubfan-${branches.length}`, version: 1, entry: "build",
    steps: {
      build: { type: "fanout", branches, each: { type: "agent", kind: "feature", prompt: "Build" }, join },
      ok: { type: "human", decision: "must", approves: "publish", question: { text: "ok?", kind: "approve_revise" } },
      done: { type: "end" },
    },
    edges: [{ from: "build", to: "ok" }, { from: "ok", to: "done", when: "result.answer == 'approve'" }],
  };
  const run = await startChain(w, def);
  const ids = branches.map(b => w.taskOf(run.id, "build", b));
  for (const id of ids) await w.checkout(id);
  await w.execute(ids[0]!, { file: "same.txt", body: "from x\n" });
  await w.execute(ids[1]!, { file: "same.txt", body: "from y\n" });
  if (ids[2]) await w.execute(ids[2], { file: "z.txt" });
  await w.accept(ids[0]!);
  const conflict = await w.accept(ids[1]!);
  expect(conflict.merge).toBe("conflict");
  expect(getRun(w.ctx, run.id)!.conflict).toHaveLength(1);
  const y = ids[1]!, record = conflict.resolution_task!;
  /** The person approves and publishes; nothing about the conflict is left. */
  const publishes = async (files: string[]) => {
    expect(getRun(w.ctx, run.id)!.conflict ?? []).toEqual([]);
    expect(readTask(w.ctx, record)!.dismissed).toBe(true);
    expect(deriveWorkflowAttention(w.ctx).filter(i => i.id.startsWith("run_review:"))).toEqual([]);
    await answerHumanStep(w.ctx, run.id, "ok", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
    await publishRun(w.ctx, run.id, { draft: false, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev });
    const branch = getRun(w.ctx, run.id)!.branch!;
    expect(w.git(w.remote, "diff", "--name-only", `main..${branch}`).split("\n").sort()).toEqual(files);
  };
  return { run, y, z: ids[2], record, publishes };
}

test("publish after a conflicted branch is rejected, retried and accepted", async () => {
  const w = world();
  const c = await conflicted(w);
  await w.reject(c.y);
  await retryFailedStep(w.ctx, { runId: c.run.id, stepId: "build" }, undefined, w.deps);
  const again = w.taskOf(c.run.id, "build", "y");
  await w.execute(again, { file: "again.txt" });
  await w.accept(again);
  await c.publishes(["again.txt", "same.txt"]);
});

test("publish after a conflicted branch is rejected and skipped", async () => {
  const w = world();
  const c = await conflicted(w);
  await w.reject(c.y);
  await skipFailedStep(w.ctx, { runId: c.run.id, stepId: "build" }, undefined, w.deps);
  await w.tick();
  await c.publishes(["same.txt"]);
});

test("publish after a conflicted branch moves to a new task that resolves it", async () => {
  const w = world();
  const c = await conflicted(w);
  const sent = await tasks.review(w.ctx, c.y, { verdict: "send_back", note: "again" }, w.reviewDeps);
  const next = sent.retry!.id;
  expect(next).not.toBe(c.y);
  expect(getRun(w.ctx, c.run.id)!.conflict ?? []).toEqual([]);
  const tree = readTask(w.ctx, next)!.worktree!;
  const branch = getRun(w.ctx, c.run.id)!.branch!;
  Bun.spawnSync(["git", "-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", branch]);
  writeFileSync(join(tree, "same.txt"), "both\n");
  w.git(tree, "commit", "-qam", "resolve");
  recordStepResult(w.ctx, next, { summary: "resolved" });
  w.finish(next);
  await w.tick();
  await w.accept(next);
  await c.publishes(["same.txt"]);
  expect(w.branchFile(branch, "same.txt")).toBe("both\n");
});

test("publish after a join stops a conflicted branch", async () => {
  const w = world();
  const c = await conflicted(w, { quorum: 2 });
  await w.accept(c.z!);
  // A quorum leaves the others parked; the person rejects the one that conflicts.
  await w.reject(c.y);
  await c.publishes(["same.txt", "z.txt"]);
});

test("publish after join any stops the conflicted branch itself", async () => {
  const w = world();
  const def: WorkflowDef = {
    id: "t/pubany", version: 1, entry: "prep",
    steps: {
      prep: { type: "agent", kind: "feature", prompt: "Prep" },
      build: { type: "fanout", branches: ["x", "y"], each: { type: "agent", kind: "feature", prompt: "Build" }, join: "any" },
      done: { type: "end" },
    },
    edges: [{ from: "prep", to: "build" }, { from: "build", to: "done" }],
  };
  const run = await startRun(w.ctx, (w.install(def), { workflow: def.id, repo: w.repo, brief: "b", publish: "draft" }), undefined, w.deps);
  const prep = w.taskOf(run.id, "prep");
  await w.execute(prep, { file: "same.txt", body: "prep\n" });
  await w.accept(prep);
  const x = w.taskOf(run.id, "build", "x"), y = w.taskOf(run.id, "build", "y");
  await w.checkout(x);
  await w.checkout(y);
  // y works from before prep, so its accept conflicts.
  const tree = readTask(w.ctx, y)!.worktree!;
  w.git(tree, "reset", "-q", "--hard", "main");
  await w.execute(y, { file: "same.txt", body: "y\n" });
  await w.execute(x, { file: "x.txt" });
  expect((await w.accept(y)).merge).toBe("conflict");
  await w.accept(x);
  expect(getRun(w.ctx, run.id)!.status).toBe("done");
  expect(w.step(run.id, "build", "y").status).toBe("stopped");
  expect(getRun(w.ctx, run.id)!.conflict ?? []).toEqual([]);
  await publishRun(w.ctx, run.id, { draft: true, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev });
});

for (const end of ["stop", "fail"] as const) {
  test(`publish after a ${end === "stop" ? "stopped" : "failed"} run leaves a conflicted step behind`, async () => {
    const w = world();
    const c = await conflicted(w);
    if (end === "stop") await stopRun(w.ctx, c.run.id, getRun(w.ctx, c.run.id)!.rev, w.deps);
    else await failRun(w.ctx, c.run.id, "boom", undefined, w.deps);
    await awaitTerminalSettle(c.run.id);
    expect(getRun(w.ctx, c.run.id)!.conflict ?? []).toEqual([]);
    expect(readTask(w.ctx, c.record)!.dismissed).toBe(true);
    setPublishOptIn(w.ctx, c.run.id, "draft");
    await publishRun(w.ctx, c.run.id, { draft: true, title: "t", body: "b", expectRev: getRun(w.ctx, c.run.id)!.rev });
  });
}

test("the publish gate drops a marker its step left behind", async () => {
  const w = world();
  const c = await conflicted(w);
  await w.reject(c.y);
  await skipFailedStep(w.ctx, { runId: c.run.id, stepId: "build" }, undefined, w.deps);
  await w.tick();
  // The state an earlier revision left: the marker survived its step.
  setRunConflict(w.ctx, c.run.id, { taskId: c.y, branch: `pacer/${c.y}`, resolutionTaskId: c.record });
  await answerHumanStep(w.ctx, c.run.id, "ok", "approve", getRun(w.ctx, c.run.id)!.rev, w.deps);
  await publishRun(w.ctx, c.run.id, { draft: false, title: "t", body: "b", expectRev: getRun(w.ctx, c.run.id)!.rev });
  expect(getRun(w.ctx, c.run.id)!.conflict ?? []).toEqual([]);
});

test("a live conflict keeps publishing closed", async () => {
  const w = world();
  const c = await conflicted(w);
  await expect(assertPublishGate(w.ctx, getRun(w.ctx, c.run.id)!, false))
    .rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/conflict/) });
});

test("a review lock left by a dead holder is taken over; a live one gives an ordinary error", async () => {
  const w = world();
  const run = await startChain(w);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "a.txt" });
  const lock = join(w.ctx.pacerHome, "orca", `review-${impl}.lock`);
  mkdirSync(join(w.ctx.pacerHome, "orca"), { recursive: true });
  expect(tasks.REVIEW_LOCK.staleMs).toBeLessThan(tasks.REVIEW_LOCK.timeoutMs);
  const saved = { ...tasks.REVIEW_LOCK };
  Object.assign(tasks.REVIEW_LOCK, { timeoutMs: 300 });
  try {
    // A living holder keeps its lock however old the file looks.
    writeFileSync(lock, `${process.pid}:held`);
    const stale = new Date(Date.now() - saved.staleMs - 5_000);
    utimesSync(lock, stale, stale);
    await expect(tasks.review(w.ctx, impl, { verdict: "accept" }))
      .rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/still in progress/) });
    // A reused pid can hold it for good: the error says which file that is.
    await expect(tasks.review(w.ctx, impl, { verdict: "accept" }))
      .rejects.toMatchObject({ message: expect.stringContaining(lock) });
    // A holder that is gone is taken over once it is silent.
    const gone = Bun.spawnSync(["true"]).pid;
    writeFileSync(lock, `${gone}:dead`);
    utimesSync(lock, stale, stale);
    await tasks.review(w.ctx, impl, { verdict: "accept" });
  } finally { Object.assign(tasks.REVIEW_LOCK, saved); }
  expect(readTask(w.ctx, impl)!.review).toMatchObject({ accepted: true });
});

test("after a branch retry the join, the reviewer panel and templates all show the whole fan-out", async () => {
  const w = world();
  const def: WorkflowDef = {
    id: "t/after", version: 1, entry: "build",
    steps: {
      build: { type: "fanout", branches: ["x", "y"], each: { type: "agent", kind: "feature", prompt: "Build" }, join: "all" },
      sum: { type: "agent", role: "orchestrator", prompt: "Joined: {{steps.build.result}}" },
      look: { type: "agent", role: "reviewer", prompt: "Done branches: {{steps.build.result.done}}" },
      done: { type: "end" },
    },
    edges: [{ from: "build", to: "sum" }, { from: "build", to: "look" }, { from: "sum", to: "done" }, { from: "look", to: "done" }],
  };
  const run = await startChain(w, def);
  const x = w.taskOf(run.id, "build", "x"), y = w.taskOf(run.id, "build", "y");
  await w.execute(x, { file: "x.txt" });
  await w.execute(y, { file: "y.txt" });
  await w.reject(y);
  await retryFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps);
  const again = w.taskOf(run.id, "build", "y");
  const panel = async () => reviewerPanels(await callOp(w.ctx, "run.get", { id: run.id }) as RunDetail, [])
    .find(p => p.stepId === "build")!;
  // While the retry runs, the finished lane is still there.
  expect((await panel()).lanes.map(l => [l.branch, l.status])).toEqual([["x", "waiting"], ["y", "running"]]);
  await w.accept(x);
  await w.execute(again, { file: "y2.txt" });
  await w.accept(again);
  const shown = await panel();
  expect(shown.lanes.map(l => [l.branch, l.status])).toEqual([["x", "done"], ["y", "done"]]);
  expect(shown.join).toMatchObject({ status: "done" });
  expect(w.inputs.at(-1)!.brief.goal).toContain("Done branches: ");
  expect(w.inputs.at(-1)!.brief.goal).toMatch(/\n2\n/);
  const orch = readTask(w.ctx, getRun(w.ctx, run.id)!.orchestratorTaskId!)!.brief.goal;
  expect(orch).toContain('"branches"');
});

test("a branch at the retry cap does not block retrying the others", async () => {
  const w = world();
  const { run, x, y } = await parkedFan(w, "all");
  await w.reject(x);
  for (let i = 0; i < 3; i++) {
    await retryFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps);
    const next = w.taskOf(run.id, "build", "x");
    await w.execute(next, { file: `x${i}.txt` });
    await w.reject(next);
  }
  await expect(retryFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps))
    .rejects.toMatchObject({ code: "not_allowed" });
  await w.reject(y);
  await retryFailedStep(w.ctx, { runId: run.id, stepId: "build" }, undefined, w.deps);
  expect(w.step(run.id, "build", "y").status).toBe("running");
});

test("work accepted after publishing is pushed with a new approval, never silently skipped", async () => {
  const w = world();
  const { run, childId } = await startPlanned(w, single, false);
  const impl = w.taskOf(childId, "impl");
  await w.execute(impl, { file: "first.txt" });
  await w.accept(impl);
  const publish = (id: string) => publishRun(w.ctx, id, { draft: false, title: "t", body: "b", expectRev: getRun(w.ctx, id)!.rev });
  const approve = () => answerHumanStep(w.ctx, run.id, "ok", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
  await approve();
  const first = await publish(childId);
  const branch = getRun(w.ctx, run.id)!.branch!;
  expect((await publish(childId)).pr_url).toBe(first.pr_url);
  // Later accepted work on the same branch.
  const tree = join(tmpDir(), "later");
  w.git(w.repo, "worktree", "add", "-q", "--force", tree, branch);
  writeFileSync(join(tree, "later.txt"), "later");
  w.git(tree, "add", "later.txt");
  w.git(tree, "commit", "-qm", "later");
  await expect(publish(childId)).rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/not pushed to/) });
  recordDecision(w.ctx, {
    runId: run.id, stepId: "ok", attempt: 2, actor: "person", kind: "publish_approved", choice: "approve",
    reason: `approves: publish tip=${w.git(w.repo, "rev-parse", branch)}`,
  });
  expect((await publish(childId)).pr_url).toBe(first.pr_url);
  expect(w.git(w.remote, "show", `${branch}:later.txt`)).toBe("later");
  expect(readFileSync(w.ghLog, "utf8").split("\n").filter(l => l.startsWith("pr create"))).toHaveLength(1);
});

test("a branch that cannot be adopted for a reason other than a conflict is shown", async () => {
  const w = world();
  const { run, childId } = await startPlanned(w, single, false);
  w.git(w.repo, "branch", "-D", runBranchName(run.id));
  clearRunBranch(w.ctx, run.id);
  const own = runBranchName(childId);
  w.git(w.repo, "branch", own, "main");
  setRunBranch(w.ctx, childId, { branch: own, base_ref: "main", base_sha: w.git(w.repo, "rev-parse", "main") });
  const impl = w.taskOf(childId, "impl");
  updateTask(w.ctx, impl, t => { t.brief = { ...t.brief, base: own }; });
  await w.execute(impl, { file: "old.txt" });
  await w.accept(impl);
  await awaitTerminalSettle(childId);
  // Someone holds the child branch checked out elsewhere: the owner cannot take it
  // while git refuses, and the person is told why.
  const broken: Ctx = { ...w.ctx, run: async (argv, t, o) => argv.includes("rev-parse") && argv.includes(`refs/heads/${own}`)
    ? { code: 128, stdout: "", stderr: "fatal: object store is broken" } : w.ctx.run(argv, t, o) };
  setRunBranch(w.ctx, childId, { branch: own, base_ref: "main", base_sha: w.git(w.repo, "rev-parse", "main") });
  workflowDatabase(w.ctx).query("UPDATE workflow_steps SET status = 'waiting', result = ? WHERE run_id = ? AND step_id = 'plan'")
    .run(JSON.stringify({ childRunId: childId }), run.id);
  workflowDatabase(w.ctx).query("UPDATE workflow_runs SET status = 'waiting', branch = NULL WHERE id = ?").run(run.id);
  expect(await adoptGeneratedBranches(broken, getRun(w.ctx, run.id)!)).toBe(false);
  const item = deriveWorkflowAttention(w.ctx).find(i => i.id === `run_review:adopt:${childId}`)!;
  expect(item.detail).toContain("object store is broken");
  expect(item.actions[0]!.op).toBe("run.stop");
  expect(await adoptGeneratedBranches(w.ctx, getRun(w.ctx, run.id)!)).toBe(true);
  expect(deriveWorkflowAttention(w.ctx).some(i => i.id === `run_review:adopt:${childId}`)).toBe(false);
});

/** One accepted code step, a publish approval, and more code after it. */
const shipping: WorkflowDef = {
  id: "t/ship", version: 1, entry: "impl",
  steps: {
    impl: { type: "agent", kind: "feature", prompt: "I" },
    ok: { type: "human", decision: "must", approves: "publish", question: { text: "ok?", kind: "approve_revise" } },
    more: { type: "agent", kind: "feature", prompt: "M" },
    done: { type: "end" },
  },
  edges: [{ from: "impl", to: "ok" }, { from: "ok", to: "more", when: "result.answer == 'approve'" }, { from: "more", to: "done" }],
};

async function shipped(how: "approval" | "draft_opt_in") {
  const w = world();
  w.install(shipping);
  const run = await startRun(w.ctx, { workflow: shipping.id, repo: w.repo, brief: "b", publish: "draft" }, undefined, w.deps);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "first.txt" });
  await w.accept(impl);
  const publish = (draft: boolean) => publishRun(w.ctx, run.id, { draft, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev });
  if (how === "approval") await answerHumanStep(w.ctx, run.id, "ok", "approve", getRun(w.ctx, run.id)!.rev, w.deps);
  await publish(how === "draft_opt_in");
  if (how === "draft_opt_in") await answerHumanStep(w.ctx, run.id, "ok", "revise", getRun(w.ctx, run.id)!.rev, w.deps).catch(() => {});
  const branch = getRun(w.ctx, run.id)!.branch!;
  const published = w.git(w.remote, "rev-parse", branch);
  /** More accepted work on the run branch than the pull request has. */
  const moreWork = (file: string) => {
    const tree = join(tmpDir(), "later");
    w.git(w.repo, "worktree", "add", "-q", "--force", tree, branch);
    writeFileSync(join(tree, file), file);
    w.git(tree, "add", file);
    w.git(tree, "commit", "-qm", file);
    w.git(w.repo, "worktree", "remove", "--force", tree);
  };
  const untouched = () => expect(w.git(w.remote, "rev-parse", branch)).toBe(published);
  return { w, run, publish, branch, moreWork, untouched };
}

test("the draft opt-in never pushes into a ready pull request an approval opened", async () => {
  const s = await shipped("approval");
  s.moreWork("later.txt");
  for (const draft of [false, true]) {
    await expect(s.publish(draft)).rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining(`git push origin ${s.branch}`) });
  }
  s.untouched();
  // Even a draft now: it was not published as one.
  s.w.pr({ state: "OPEN", isDraft: true });
  await expect(s.publish(true)).rejects.toMatchObject({ code: "not_allowed" });
  s.untouched();
});

test("the draft opt-in updates a pull request only while it is confirmed to be a draft", async () => {
  const s = await shipped("draft_opt_in");
  s.moreWork("later.txt");
  await s.publish(true);
  expect(s.w.git(s.w.remote, "show", `${s.branch}:later.txt`)).toBe("later.txt");
  s.moreWork("ready.txt");
  const before = s.w.git(s.w.remote, "rev-parse", s.branch);
  s.w.pr({ state: "OPEN", isDraft: false }); // marked ready
  await expect(s.publish(true)).rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/not one/) });
  s.w.pr(null); // gh cannot tell
  await expect(s.publish(true)).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/nothing was pushed/) });
  expect(s.w.git(s.w.remote, "rev-parse", s.branch)).toBe(before);
});

for (const state of ["CLOSED", "MERGED"]) {
  test(`later work is refused, with the way out, when the pull request is ${state.toLowerCase()}`, async () => {
    const s = await shipped("draft_opt_in");
    s.moreWork("later.txt");
    s.w.pr({ state, isDraft: true });
    const refused = { code: "not_allowed", message: expect.stringMatching(new RegExp(`is ${state.toLowerCase()}.*git push origin`)) };
    await expect(s.publish(true)).rejects.toMatchObject(refused);
    // An approval of the tip does not reopen it either.
    recordDecision(s.w.ctx, {
      runId: s.run.id, stepId: "ok", attempt: 2, actor: "person", kind: "publish_approved", choice: "approve",
      reason: `approves: publish tip=${s.w.git(s.w.repo, "rev-parse", s.branch)}`,
    });
    await expect(s.publish(false)).rejects.toMatchObject(refused);
    s.untouched();
  });
}

test("the draft opt-in does not push onto a branch that already has a ready pull request", async () => {
  const w = world();
  w.install(shipping);
  const run = await startRun(w.ctx, { workflow: shipping.id, repo: w.repo, brief: "b", publish: "draft" }, undefined, w.deps);
  const impl = w.taskOf(run.id, "impl");
  await w.execute(impl, { file: "first.txt" });
  await w.accept(impl);
  writeFileSync(w.prList, JSON.stringify([{ url: "https://github.com/acme/widget/pull/3", state: "OPEN", isDraft: false }]));
  await expect(publishRun(w.ctx, run.id, { draft: true, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev }))
    .rejects.toMatchObject({ code: "not_allowed" });
  expect(w.git(w.remote, "branch", "--list", "pacer/*")).toBe("");
});

/** A code step whose task works from before the accepted prep step, so merging it conflicts. */
const stale: WorkflowDef = {
  id: "t/stale", version: 1, entry: "prep",
  steps: {
    prep: { type: "agent", kind: "feature", prompt: "P" },
    impl: { type: "agent", kind: "feature", prompt: "I" },
    done: { type: "end" },
  },
  edges: [{ from: "prep", to: "impl" }, { from: "impl", to: "done" }],
};

async function staleRun() {
  const w = world();
  w.install(stale);
  const run = await startRun(w.ctx, { workflow: stale.id, repo: w.repo, brief: "b", publish: "draft" }, undefined, w.deps);
  const prep = w.taskOf(run.id, "prep");
  await w.execute(prep, { file: "same.txt", body: "prep\n" });
  await w.accept(prep);
  const impl = w.taskOf(run.id, "impl");
  const conflictingWork = async (taskId: string) => {
    const tree = await w.checkout(taskId);
    w.git(tree, "reset", "-q", "--hard", "main");
    await w.commit(taskId, "same.txt", `${taskId}\n`);
  };
  const publish = () => publishRun(w.ctx, run.id, { draft: true, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev });
  const blocked = { code: "not_allowed", message: expect.stringMatching(/conflict/) };
  return { w, run, impl, conflictingWork, publish, blocked };
}

test("a conflict from accepting the task of an already failed step keeps publishing closed", async () => {
  const s = await staleRun();
  await s.conflictingWork(s.impl);
  s.w.finish(s.impl, "limit");
  await s.w.tick();
  expect(s.w.step(s.run.id, "impl").status).toBe("failed");
  expect((await s.w.accept(s.impl)).merge).toBe("conflict");
  await s.w.tick();
  await expect(s.publish()).rejects.toMatchObject(s.blocked);
  expect(getRun(s.w.ctx, s.run.id)!.conflict).toHaveLength(1);
  // Rejecting the task is the way to give its work up.
  await s.w.reject(s.impl);
  await s.publish();
});

test("a conflict from a retry the failed step did not take over keeps publishing closed", async () => {
  const s = await staleRun();
  await s.conflictingWork(s.impl);
  recordStepResult(s.w.ctx, s.impl, { summary: "ok" });
  s.w.finish(s.impl);
  await s.w.tick();
  expect((await s.w.accept(s.impl)).merge).toBe("conflict");
  await s.w.reject(s.impl);
  expect(getRun(s.w.ctx, s.run.id)!.conflict ?? []).toEqual([]);
  // The person retries the rejected task; the failed step does not follow it.
  const { retry } = await tasks.retry(s.w.ctx, s.impl, {}, {
    delegate: async (c, input) => input.commitWith!(() => {
      const next = createTask(c, { brief: input.brief, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 600 });
      return updateTask(c, next.id, t => { t.retryOf = input.retryOf; });
    }),
  });
  expect(s.w.step(s.run.id, "impl").taskId).toBe(s.impl);
  await s.conflictingWork(retry.id);
  s.w.finish(retry.id);
  expect((await s.w.accept(retry.id)).merge).toBe("conflict");
  await s.w.tick();
  await expect(s.publish()).rejects.toMatchObject(s.blocked);
  expect(getRun(s.w.ctx, s.run.id)!.conflict!.map(e => e.taskId)).toEqual([retry.id]);
});

test("clearing a resolved conflict keeps one raised while git was running", async () => {
  const s = await staleRun();
  await s.conflictingWork(s.impl);
  recordStepResult(s.w.ctx, s.impl, { summary: "ok" });
  s.w.finish(s.impl);
  await s.w.tick();
  await s.w.accept(s.impl);
  const tree = readTask(s.w.ctx, s.impl)!.worktree!;
  Bun.spawnSync(["git", "-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", getRun(s.w.ctx, s.run.id)!.branch!]);
  writeFileSync(join(tree, "same.txt"), "both\n");
  s.w.git(tree, "commit", "-qam", "resolve");
  const meanwhile = { taskId: "base:main", branch: "0".repeat(40), resolutionTaskId: "t-other" };
  let raised = false;
  const racing: Ctx = {
    ...s.w.ctx,
    run: async (argv, timeout, o) => {
      if (!raised && argv.includes("--is-ancestor") && argv.includes(`pacer/${s.impl}`) && !argv.includes("HEAD")) {
        raised = true;
        setRunConflict(s.w.ctx, s.run.id, meanwhile);
      }
      return s.w.ctx.run(argv, timeout, o);
    },
  };
  await tasks.review(racing, s.impl, { verdict: "accept" });
  expect(raised).toBe(true);
  expect(getRun(s.w.ctx, s.run.id)!.conflict).toEqual([meanwhile]);
});

test("a generated graph may not declare publishing approval, and one already stored approves nothing", async () => {
  const gated: WorkflowDef = {
    id: "gen/gate", version: 1, entry: "impl",
    steps: {
      impl: { type: "agent", kind: "feature", prompt: "I" },
      sure: { type: "human", decision: "must", approves: "publish", question: { text: "ok?", kind: "approve_revise" } },
      done: { type: "end" },
    },
    edges: [{ from: "impl", to: "sure" }, { from: "sure", to: "done", when: "result.answer == 'approve'" }],
  };
  expect(validateGenerated(gated, planned.steps.plan!.type === "generate" ? { ...planned.steps.plan!.limits, step_types: ["agent", "human"] } : (undefined as never), 1))
    .toContainEqual({ path: "steps.sure.approves", message: "a generated graph may not declare approves: publish" });
  const w = world();
  const plain: WorkflowDef = { ...gated, steps: { ...gated.steps, sure: { type: "human", decision: "must", question: { text: "ok?", kind: "approve_revise" } } } };
  const bare: WorkflowDef = {
    ...planned, id: "t/planned-gate", entry: "plan",
    steps: { plan: { ...planned.steps.plan!, limits: { step_types: ["agent", "human"], max_steps: 5, max_depth: 2, kinds: ["feature"] } } as WorkflowDef["steps"][string], ok: planned.steps.ok!, done: planned.steps.done! },
    edges: planned.edges.slice(1),
  };
  const run = await startChain(w, bare);
  expect((await submitGraph(w.ctx, { runId: run.id, stepId: "plan", source: plain }, w.deps)).errors).toEqual([]);
  const childId = (w.step(run.id, "plan").result as { childRunId: string }).childRunId;
  const child = getRun(w.ctx, childId)!;
  // As an earlier version could have stored it.
  const row = workflowDatabase(w.ctx).query<{ def: string }, [string, number]>("SELECT def FROM workflow_defs WHERE id = ? AND version = ?").get(child.workflow, child.version)!;
  const def = JSON.parse(row.def) as WorkflowDef;
  (def.steps.sure as { approves?: string }).approves = "publish";
  workflowDatabase(w.ctx).query("UPDATE workflow_defs SET def = ? WHERE id = ? AND version = ?").run(JSON.stringify(def), child.workflow, child.version);
  const impl = w.taskOf(childId, "impl");
  await w.execute(impl, { file: "a.txt" });
  await w.accept(impl);
  await answerHumanStep(w.ctx, childId, "sure", "approve", getRun(w.ctx, childId)!.rev, w.deps);
  expect(listDecisions(w.ctx, run.id).concat(listDecisions(w.ctx, childId)).filter(d => d.kind === "publish_approved")).toEqual([]);
  await expect(publishRun(w.ctx, run.id, { draft: false, title: "t", body: "b", expectRev: getRun(w.ctx, run.id)!.rev }))
    .rejects.toMatchObject({ code: "not_allowed" });
});

test("publishing reports success once the later work was pushed by hand, and pushes nothing itself", async () => {
  const s = await shipped("approval");
  s.moreWork("later.txt");
  await expect(s.publish(false)).rejects.toMatchObject({ code: "not_allowed" });
  s.w.git(s.w.repo, "push", "-q", "origin", s.branch);
  const calls = readFileSync(s.w.ghLog, "utf8");
  expect((await s.publish(false)).pr_url).toBe("https://github.com/acme/widget/pull/7");
  expect(readFileSync(s.w.ghLog, "utf8")).toBe(calls);
  // Origin must have this tip, not an earlier one.
  const pushed = s.w.git(s.w.remote, "rev-parse", s.branch);
  s.moreWork("again.txt");
  await expect(s.publish(false)).rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/not pushed/) });
  expect(s.w.git(s.w.remote, "rev-parse", s.branch)).toBe(pushed);
});

test("publishing refuses when origin cannot be read for work the last publish did not record", async () => {
  const s = await shipped("approval");
  s.moreWork("later.txt");
  s.w.git(s.w.repo, "remote", "set-url", "origin", join(s.w.remote, "gone"));
  await expect(s.publish(false)).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/cannot confirm/) });
  s.untouched();
});
