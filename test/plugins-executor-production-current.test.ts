import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderCfg, loadStrategy } from "../src/config/strategy";
import { resumeOwnedDirect, runOwnedDirectCurrent, runOwnedDirectNew } from "../src/plugins/executor-production";
import { pluginRegistry } from "../src/plugins";
import { issueOwnedWorktreeGrant } from "../src/plugins/executor-worktree";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability } from "../src/plugins/host";
import { answerDetachedStop } from "../src/plugins/capability-detached-stop";
import { manifest as directManifest } from "../plugins/pacer-exec-direct/manifest";
import { manifestSchema } from "../src/plugins/protocol";

const parsedDirectManifest = manifestSchema.parse(directManifest);
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { superviseTask, taskStop } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { retryWork } from "../src/core/work";
import { realRun } from "./helpers";
import { startRun, readRun } from "../src/supervisor/run";
import { eligibility } from "./fixtures/eligibility";
import { defaultHooks } from "../src/classify/hooks";
import { fakeCtx } from "./helpers";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-direct-current-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  mkdirSync(pacerHome, { mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n", { mode: 0o600 });
  const executable = join(bin, "codex");
  writeFileSync(executable, "#!/bin/sh\nprintf 'owned provider result\\n'\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${process.env.PATH}` },
    which: name => name === "codex" ? executable : null });
  const created = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 30, placement: { requested: "current" } });
  const task = updateTask(ctx, created.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  const cfg = loadStrategy(ctx).providers.codex as ProviderCfg;
  return { ctx, task, cfg, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("bundled direct provider owns a real current checkout wrapper and full outcome", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const out = await runOwnedDirectCurrent(ctx, cfg, task);
    expect(out.exec.code).toBe(0);
    expect(out.report).toContain("owned provider result");
    expect(out.attempt.executor).toBe("codex");
    expect(readTask(ctx, task.id)?.run?.mode).toBe("current");
    expect(readTask(ctx, task.id)?.startIntent).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
    expect(readTask(ctx, task.id)?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct", exitCode: 0 });
  } finally { cleanup(); }
});

test("local interactive owner preserves the session files and fails a wrapper exit without report", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nexit 0\n",
    { mode: 0o700 });
  try {
    const out = await runOwnedDirectCurrent({ ...ctx, run: realRun },
      { ...cfg, session: "interactive" }, task);
    expect(out.exec.code).toBe(1);
    const run = readTask(ctx, task.id)!.run!;
    expect(run.session).toBe("interactive");
    expect(existsSync(join(run.dir, "interactive.json"))).toBe(true);
    expect(existsSync(join(run.dir, "session.json"))).toBe(true);
    expect(existsSync(join(run.dir, "report-hook.sh"))).toBe(true);
    expect(out.report).toContain("without an explicit completion report");
  } finally { cleanup(); }
});

test("task runner routes an admitted current attempt through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const liveCtx = { ...ctx, run: realRun };
    const result = await runTask(liveCtx, task.id, {
      loadStrategy: loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const, windows: [],
          binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.result?.report).toContain("owned provider result");
  } finally { cleanup(); }
});

test("task runner selects the bundled provider for a local interactive session", async () => {
  const { ctx, task, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nexit 0\n",
    { mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "accounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nplanner: {agent: claude-code, account: claude}\nrunners:\n  codex: {agent: codex, account: codex, session: interactive}\nrouting:\n  - default: [codex]\nexecution: {worktree: current}\n",
    { mode: 0o600 });
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.run?.session).toBe("interactive");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.exitCode).toBe(1);
  } finally { cleanup(); }
});

test("supervision delivers a pending provider stop and settles only after wrapper exit", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const running = runOwnedDirectCurrent(ctx, cfg, task).catch(() => undefined);
  try {
    let current = readTask(ctx, task.id);
    for (let i = 0; i < 100 && !current?.startIntent; i++) {
      await Bun.sleep(20);
      current = readTask(ctx, task.id);
    }
    expect(current?.startIntent).toBeDefined();
    expect(taskStop(ctx, task.id)).toMatchObject({ state: "running", stopPending: { attempt: 1 } });
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(settled?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
  } finally { await running; cleanup(); }
});

test("supervision stops an exact interactive session and records its wrapper exit", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  writeFileSync(executable,
    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
    { mode: 0o700 });
  const running = runOwnedDirectCurrent({ ...ctx, run: realRun },
    { ...cfg, session: "interactive" }, task).catch(() => undefined);
  try {
    let current = readTask(ctx, task.id);
    for (let i = 0; i < 100 && !current?.startIntent; i++) {
      await Bun.sleep(20);
      current = readTask(ctx, task.id);
    }
    expect(current?.run?.session).toBe("interactive");
    expect(existsSync(join(current!.run!.dir, "session.json"))).toBe(true);
    expect(taskStop(ctx, task.id)).toMatchObject({ state: "running", stopPending: { attempt: 1 } });
    const issued = readTask(ctx, task.id)!;
    const dir = issued.run!.dir, identity = statSync(dir);
    const wrongMode = createCallAuthority(ctx, { reads: [], commands: [], stores: [], detachedStop: {
      taskId: task.id, rev: issued.rev, attempt: 1, dir,
      dirIdentity: { dev: identity.dev, ino: identity.ino },
      pid: Number(readFileSync(join(dir, "pid"), "utf8")),
      startedAt: issued.run!.startedAt, executor: "codex", graceMs: 5000,
      stopIntent: { requestedAt: issued.stopPending!.requestedAt, providerId: "pacer-exec-direct" },
    } }, { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    await expect(answerDetachedStop(wrongMode, { taskId: task.id, attempt: 1, graceMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await wrongMode.revoke();
    expect(existsSync(join(dir, "exit"))).toBe(false);
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("stopped");
    expect(settled?.executorExitReceipt).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct", exitCode: 143 });
  } finally { await running; cleanup(); }
});

test("current owner refuses an explicitly new placement even under a current default", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    updateTask(ctx, task.id, current => { current.placement = { requested: "new" }; });
    expect(runOwnedDirectCurrent(ctx, cfg, readTask(ctx, task.id)!))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { cleanup(); }
});

test("current owner refuses a concurrently active task in the same checkout", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const other = createTask(ctx, { brief: { goal: "other", repo: task.brief.repo }, kind: null,
      requestedExecutor: "codex", timeoutS: 30 });
    updateTask(ctx, other.id, current => {
      current.state = "running";
      current.runnerPid = process.pid;
      current.placement = { requested: "current", mode: "current", why: "fixture" };
    });
    expect(runOwnedDirectCurrent(ctx, cfg, task))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { cleanup(); }
});

test("a broken owned wrapper settles without a built-in fallback attempt", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\necho 'error: unknown option --force' >&2\nexit 2\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.state).toBe("failed");
  } finally { cleanup(); }
});

test("bundled provider creates and owns an explicit head-based task worktree", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(out.worktree).toBe(readTask(ctx, task.id)?.worktree);
    expect(out.worktree).not.toBe(task.brief.repo);
    expect(readTask(ctx, task.id)?.run?.mode).toBe("new");
    expect(readTask(ctx, task.id)?.baseSha).toMatch(/^[0-9a-f]{40}$/);
  } finally { cleanup(); }
});

test("task runner completes an explicit new worktree through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.result?.worktree).toBe(result.worktree);
    expect(result.worktree).not.toBe(task.brief.repo);
    expect(result.attempts).toHaveLength(1);
  } finally { cleanup(); }
});

test("lost provider reply reattaches to the exact wrapper without a second launch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nprintf x >> launch-count\nprintf 'resumed output\\n'\n",
      { mode: 0o700 });
    const registry = pluginRegistry(ctx);
    const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
      await registry.call(...args);
      throw Error("reply lost after provider completion");
    } };
    expect(runOwnedDirectCurrent(ctx, cfg, task, lostReply)).rejects.toThrow("reply lost");
    const persisted = readTask(ctx, task.id)!;
    expect(persisted.run).toBeDefined();
    expect(persisted.startIntent).toBeDefined();
    const recovered = await resumeOwnedDirect(ctx, cfg, persisted);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.report).toContain("resumed output");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
    expect(readTask(ctx, task.id)?.executorExitReceipt?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("lost interactive completion reply recovers the same reported attempt", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const executable = ctx.which("codex")!;
  // Keep the agent alive until the host observes its report and stops the run.
  expect(Bun.spawnSync(["mkfifo", join(task.brief.repo, "hold")]).exitCode).toBe(0);
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf x >> launch-count\nprintf '%s' '{\"status\":\"done\",\"summary\":\"owned done\",\"at\":101}' > \"$PACER_RUN_DIR/report.json\"\nread -r unused < hold\n",
    { mode: 0o700 });
  const runtime = { ...ctx, run: realRun }, interactive = { ...cfg, session: "interactive" as const };
  const registry = pluginRegistry(runtime);
  const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
    await registry.call(...args);
    throw Error("interactive reply lost after completion");
  } };
  try {
    await expect(runOwnedDirectCurrent(runtime, interactive, task, lostReply))
      .rejects.toThrow("interactive reply lost after completion");
    const persisted = readTask(ctx, task.id)!;
    expect(persisted.executorReportReceipt).toMatchObject({ status: "done", attempt: 1 });
    const recovered = await resumeOwnedDirect(runtime, interactive, persisted);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.report).toBe("owned done");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
  } finally { cleanup(); }
});

test("a pending stop after interactive provider completion refuses success settlement", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  writeFileSync(ctx.which("codex")!,
    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf '%s' '{\"status\":\"done\",\"summary\":\"owned done\",\"at\":101}' > \"$PACER_RUN_DIR/report.json\"\nsleep 30\n",
    { mode: 0o700 });
  const runtime = { ...ctx, run: realRun }, registry = pluginRegistry(runtime);
  const stopAfterReply = { call: async (...args: Parameters<typeof registry.call>) => {
    const result = await registry.call(...args);
    updateTask(ctx, task.id, current => {
      current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
        providerId: "pacer-exec-direct", graceMs: 5000 };
    });
    return result;
  } };
  try {
    await expect(runOwnedDirectCurrent(runtime, { ...cfg, session: "interactive" }, task,
      stopAfterReply)).rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.stopPending).toMatchObject({ attempt: 1 });
    expect(readTask(ctx, task.id)?.executorExitReceipt).toBeUndefined();
  } finally { cleanup(); }
});

test("task runner restart reconciles a lost provider result without relaunching", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nprintf x >> launch-count\nprintf 'recovered task\\n'\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const registry = pluginRegistry(ctx);
    const lostReply = { call: async (...args: Parameters<typeof registry.call>) => {
      await registry.call(...args);
      throw Error("reply lost");
    } };
    expect(runOwnedDirectCurrent(ctx, cfg, task, lostReply)).rejects.toThrow("reply lost");
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.attempts).toHaveLength(1);
    expect(result.result?.report).toContain("recovered task");
    expect(readFileSync(join(task.brief.repo, "launch-count"), "utf8")).toBe("x");
  } finally { cleanup(); }
});

/** A failed assertion must not strand the wrapper waiting on files that cleanup removes. */
function stopLiveRun(ctx: ReturnType<typeof fakeCtx>, id: string): void {
  const dir = readTask(ctx, id)?.run?.dir;
  if (!dir || existsSync(join(dir, "exit"))) return;
  const pid = readRun(dir).pid;
  if (pid) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

test("a live interactive run keeps its owner across repeated observation lease expiries", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const repo = task.brief.repo;
  expect(Bun.spawnSync(["mkfifo", join(repo, "hold")]).exitCode).toBe(0);
  writeFileSync(ctx.which("codex")!, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf x >> launch-count\nwhile [ ! -e release ]; do sleep 0.05; done\nprintf '%s' '{\"status\":\"done\",\"summary\":\"held through renewals\",\"at\":101}' > \"$PACER_RUN_DIR/report.json\"\nread -r unused < hold\n",
    { mode: 0o700 });
  const runtime = { ...ctx, run: realRun }, registry = pluginRegistry(runtime);
  let leases = 0;
  const shortLeases = { call: (...[c, id, method, params, options]: Parameters<typeof registry.call>) => {
    leases++;
    return registry.call(c, id, method, params, { ...options, deadlineMs: leases === 1 ? 3000 : 400 });
  } };
  try {
    const running = runOwnedDirectCurrent(runtime, { ...cfg, session: "interactive" }, task, shortLeases);
    for (let i = 0; i < 200 && leases < 4; i++) await Bun.sleep(25);
    expect(leases).toBeGreaterThanOrEqual(4);
    writeFileSync(join(repo, "release"), "");
    const out = await running;
    expect(out.exec.code).toBe(0);
    expect(out.report).toBe("held through renewals");
    expect(readFileSync(join(repo, "launch-count"), "utf8")).toBe("x");
  } finally { stopLiveRun(ctx, task.id); cleanup(); }
}, 30_000);

test("a runner reattaching to a live owned run clears Lost contact", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  const repo = task.brief.repo;
  writeFileSync(ctx.which("codex")!, "#!/bin/sh\nprintf x >> launch-count\nwhile [ ! -e release ]; do sleep 0.05; done\nprintf 'reattached result\\n'\n",
    { mode: 0o700 });
  const registry = pluginRegistry(ctx), owner = new AbortController();
  const endedOwner = { call: (...[c, id, method, params, options]: Parameters<typeof registry.call>) =>
    registry.call(c, id, method, params, { ...options, signal: owner.signal }) };
  try {
    const first = runOwnedDirectCurrent(ctx, cfg, task, endedOwner);
    // Cut the owner only once the run is fully bound and its wrapper has started, as a real loss would find it.
    const bound = () => { const t = readTask(ctx, task.id); return !!t?.run && t.startIntent?.dir === t.run.dir && existsSync(join(repo, "launch-count")); };
    for (let i = 0; i < 400 && !bound(); i++) await Bun.sleep(25);
    expect(bound()).toBe(true);
    owner.abort();
    await expect(first).rejects.toMatchObject({ code: "plugin_unavailable" });
    const lost = updateTask(ctx, task.id, current => {
      current.progress = { lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0, logBytes: 0,
        host: "local", phase: "lost-contact", updatedAt: Date.now() / 1000 };
    });
    expect(lost.run).toBeDefined();
    expect(existsSync(join(lost.run!.dir, "exit"))).toBe(false);
    const reattached = runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => { throw Error("a reattach never reroutes"); },
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    let current = readTask(ctx, task.id);
    for (let i = 0; i < 200 && current?.progress?.phase === "lost-contact"; i++) {
      await Bun.sleep(25);
      current = readTask(ctx, task.id);
    }
    expect(current?.runnerPid).toBe(process.pid);
    expect(current?.progress?.phase).not.toBe("lost-contact");
    expect(existsSync(join(lost.run!.dir, "exit"))).toBe(false);
    writeFileSync(join(repo, "release"), "");
    const result = await reattached;
    expect(result.state).toBe("done");
    expect(result.result?.report).toContain("reattached result");
    expect(readFileSync(join(repo, "launch-count"), "utf8")).toBe("x");
  } finally { stopLiveRun(ctx, task.id); cleanup(); }
}, 30_000);

test("owned deadline persists a stop intent and settles failed only after wrapper exit", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
      { mode: 0o700 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.timeoutS = 1;
      delete current.executor;
      delete current.executorProvider;
    });
    const running = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(running.state).toBe("running");
    expect(running.stopPending).toMatchObject({ attempt: 1, reason: "deadline" });
    let settled = await superviseTask(ctx, task.id, () => undefined);
    for (let i = 0; i < 20 && settled?.state === "running"; i++) {
      await Bun.sleep(50);
      settled = await superviseTask(ctx, task.id, () => undefined);
    }
    expect(settled?.state).toBe("failed");
    expect(settled?.attempts[0]?.timedOut).toBe(true);
  } finally { cleanup(); }
});

test("an interactive deadline whose wrapper died without an exit record settles failed", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    const executable = ctx.which("codex")!;
    writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
      { mode: 0o700 });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: interactive}\n", { mode: 0o600 });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.timeoutS = 1;
      current.interactive = true;
      delete current.executor;
      delete current.executorProvider;
    });
    const running = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    // The runner recorded the exhausted budget as a deadline stop and gave up its ownership.
    expect(running.state).toBe("running");
    expect(running.stopPending).toMatchObject({ attempt: 1, reason: "deadline" });
    expect(running.progress?.phase).toBe("lost-contact");
    const run = readTask(ctx, task.id)!.run!;
    expect(run.session).toBe("interactive");
    // The wrapper and its session die hard: no TERM trap, no exit record, only the lost pid.
    const pid = readRun(run.dir).pid!;
    expect(process.kill(-pid, "SIGKILL")).toBe(true);
    for (let i = 0; i < 100 && readRun(run.dir).alive; i++) await Bun.sleep(50);
    expect(readRun(run.dir).alive).toBe(false);
    expect(existsSync(join(run.dir, "exit"))).toBe(false);
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("failed");
    expect(settled?.result?.report).toContain("deadline");
    expect(settled?.attempts[0]).toMatchObject({ executor: "codex", timedOut: true, limitHit: false });
  } finally { cleanup(); }
}, 30_000);

test("a user stop whose wrapper ended without an exit record settles stopped", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const departed = Bun.spawnSync(["/bin/sleep", "0"]).pid;
    writeFileSync(join(dir, "pid"), String(departed), { mode: 0o600 });
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000,
        mode: "current", workdir: task.brief.repo,
        logFile: join(ctx.pacerHome, "tasks", `${task.id}.codex.log`), session: "interactive" };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
        providerId: "pacer-exec-direct", graceMs: 5000, reason: "user" };
      current.progress = { lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0,
        logBytes: 0, host: "local", phase: "lost-contact", updatedAt: Date.now() / 1000 };
    });
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("stopped");
    expect(settled?.stopPending).toBeUndefined();
    expect(existsSync(join(dir, "exit"))).toBe(false);
  } finally { cleanup(); }
}, 30_000);

test("missing-exit stop permits a retry on the same task id", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    registerWork(ctx, task.id, {});
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), String(Bun.spawnSync(["/bin/sleep", "0"]).pid));
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: ctx.now,
        providerId: "pacer-exec-direct", graceMs: 100, reason: "user" };
    });
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("stopped");
    await retryWork(ctx, task.id, { requestId: "missing-exit-retry", expectRev: settled!.rev }, () => undefined);
    const selected = updateTask(ctx, task.id, current => {
      current.state = "running";
      current.executor = "codex";
    });
    const next = await runOwnedDirectCurrent({ ...ctx, run: realRun }, cfg, selected);
    expect(next.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(2);
  } finally { cleanup(); }
});

test("missing-exit pipe stop terminates the surviving agent before settling", async () => {
  const { ctx, task, cleanup } = fixture();
  let pid: number | undefined;
  try {
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    const launched = startRun({ dir, argv: ["/bin/sh", "-c", "trap '' TERM; while :; do sleep 0.1; done"],
      cwd: task.brief.repo, env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, session: "pipe" });
    if ("error" in launched) throw new Error(launched.error);
    pid = launched.pid;
    chmodSync(dir, 0o700);
    for (let i = 0; i < 100 && !existsSync(join(dir, "child")); i++) await Bun.sleep(20);
    const child = Number(readFileSync(join(dir, "child"), "utf8"));
    await Bun.sleep(100);
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && readRun(dir).alive; i++) await Bun.sleep(20);
    expect(process.kill(child, 0)).toBe(true);
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: ctx.now,
        providerId: "pacer-exec-direct", graceMs: 100, reason: "user" };
    });
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("stopped");
    const childState = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)]).stdout.toString().trim();
    expect(childState === "" || childState.startsWith("Z")).toBe(true);
    expect(settled?.executorExitReceipt).toMatchObject({ exitCode: 143, unverified: true });
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    cleanup();
  }
});

test("missing-exit interactive stop terminates the surviving agent before settling", async () => {
  const { ctx, task, cleanup } = fixture();
  let pid: number | undefined, child: number | undefined;
  try {
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    const launched = startRun({ dir, argv: ["/bin/sh", "-c", "trap '' HUP TERM; while :; do sleep 0.1; done"],
      cwd: task.brief.repo, env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome }, session: "interactive" });
    if ("error" in launched) throw new Error(launched.error);
    pid = launched.pid;
    chmodSync(dir, 0o700);
    for (let i = 0; i < 100 && !existsSync(join(dir, "child")); i++) await Bun.sleep(20);
    child = Number(readFileSync(join(dir, "child"), "utf8"));
    await Bun.sleep(100);
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 100 && readRun(dir).alive; i++) await Bun.sleep(20);
    expect(process.kill(child, 0)).toBe(true);
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: ctx.now,
        providerId: "pacer-exec-direct", graceMs: 100, reason: "user" };
    });
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("stopped");
    const childState = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(child)]).stdout.toString().trim();
    expect(childState === "" || childState.startsWith("Z")).toBe(true);
    expect(settled?.executorExitReceipt).toMatchObject({ exitCode: 143, unverified: true });
  } finally {
    if (child) { try { process.kill(-child, "SIGKILL"); } catch {} }
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    cleanup();
  }
});

test("missing-exit stop retains an unowned live child without signalling it", async () => {
  const { ctx, task, cleanup } = fixture();
  const unrelated = Bun.spawn(["/bin/sleep", "60"], { detached: true, stdout: "ignore", stderr: "ignore" });
  try {
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), String(Bun.spawnSync(["/bin/sleep", "0"]).pid));
    writeFileSync(join(dir, "child"), String(unrelated.pid));
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: ctx.now,
        providerId: "pacer-exec-direct", graceMs: 100, reason: "user" };
    });
    const pending = await superviseTask(ctx, task.id, () => undefined);
    expect(pending?.state).toBe("running");
    expect(pending?.stopPending).toBeDefined();
    expect(pending?.attempts).toHaveLength(0);
    expect(pending?.executorExitReceipt).toBeUndefined();
    expect(process.kill(unrelated.pid, 0)).toBe(true);
  } finally {
    unrelated.kill("SIGKILL");
    await unrelated.exited;
    cleanup();
  }
});

test("default new placement records origin-fetch intent before using the selected base", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "push", "-q", "-u", "origin", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.baseFetchIntent).toMatchObject({
      attempt: 1, providerId: "pacer-exec-direct", base: "origin/main" });
    expect(readTask(ctx, task.id)?.baseSha).toBe(readTask(ctx, task.id)?.baseFetchIntent?.sha);
  } finally { cleanup(); }
});

test("default child placement in a local-only repo uses HEAD without a fetch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    const out = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(out.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.baseFetchIntent).toBeUndefined();
    expect(readTask(ctx, task.id)?.baseSha).toMatch(/^[0-9a-f]{40}$/);
  } finally { cleanup(); }
});

test("uncertain origin fetch retains intent and refuses a second fetch", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      delete current.brief.worktreeBase;
    });
    let fetches = 0;
    const uncertain = { ...ctx, run: async (...args: Parameters<typeof realRun>) => {
      if (args[0].includes("fetch")) {
        fetches++;
        return { code: 124, timedOut: true, stdout: "", stderr: "fixture timeout" };
      }
      return realRun(...args);
    } };
    expect(runOwnedDirectNew(uncertain, cfg, selected)).rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.baseFetchIntent).toMatchObject({ attempt: 1,
      providerId: "pacer-exec-direct" });
    expect(runOwnedDirectNew(uncertain, cfg, readTask(ctx, task.id)!))
      .rejects.toMatchObject({ code: "conflict" });
    expect(fetches).toBe(1);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
  } finally { cleanup(); }
});

test("default automatic child placement runs through the bundled provider", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: child-of-current, launch_mode: headless}\n",
      { mode: 0o600 });
    const origin = join(ctx.home, "origin.git");
    Bun.spawnSync(["git", "init", "--bare", "-q", origin]);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "push", "-q", "-u", "origin", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "symbolic-ref", "HEAD", "refs/heads/main"], { cwd: origin });
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "auto" };
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => null },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.placement?.mode).toBe("new");
    expect(result.baseFetchIntent?.base).toBe("origin/main");
  } finally { cleanup(); }
});

test("disabled bundled executor refuses before a local process effect", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    expect(runOwnedDirectCurrent(ctx, cfg, task)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(readTask(ctx, task.id)?.startIntent).toBeUndefined();
  } finally { cleanup(); }
});

test("retry reuses the prior task-owned worktree after its HEAD advances", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const worktree = initial.worktree!;
    writeFileSync(join(worktree, "first-commit.txt"), "retained\n");
    Bun.spawnSync(["git", "add", "first-commit.txt"], { cwd: worktree });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "-m", "task work"], { cwd: worktree });
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree }).stdout.toString().trim();
    updateTask(ctx, task.id, current => {
      current.state = "done";
      current.result = { status: "done", executor: "codex", model: null, files: "first-commit.txt",
        report: "fixture", backend: "direct", worktree };
    });
    const retried = createTask(ctx, { brief: { goal: "retry", repo: task.brief.repo }, kind: null,
      requestedExecutor: "codex", timeoutS: 30 });
    const selected = updateTask(ctx, retried.id, current => {
      current.state = "running";
      current.executor = "codex";
      current.executorProvider = "pacer-exec-direct";
      current.retryOf = task.id;
      current.worktree = worktree;
      current.placement = { requested: "new" };
    });
    const outcome = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, selected);
    expect(outcome.worktree).toBe(worktree);
    expect(readTask(ctx, retried.id)?.baseSha).toBe(head);
    expect(readFileSync(join(worktree, "first-commit.txt"), "utf8")).toBe("retained\n");
  } finally { cleanup(); }
});

// SP08 strict admission cannot certify Codex subagent denial; exercise the owned retry above until a certified fixture exists.
test.skip("a managed retry keeps the same task worktree under a second provider-owned run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    registerWork(ctx, task.id, { maxAttempts: 2 });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const original = readTask(ctx, task.id)!;
    expect(original.run?.attempt).toBe(1);
    expect(original.worktree).toBe(initial.worktree);
    writeFileSync(join(initial.worktree!, "first-attempt.txt"), "retained across retry\n");
    Bun.spawnSync(["git", "add", "first-attempt.txt"], { cwd: initial.worktree });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "-m", "first attempt"], { cwd: initial.worktree });
    const advancedHead = Bun.spawnSync(["git", "rev-parse", "HEAD"],
      { cwd: initial.worktree }).stdout.toString().trim();
    updateTask(ctx, task.id, current => {
      current.attempts.push(initial.attempt);
      current.state = "failed";
      current.result = { status: "failed", executor: "codex", model: null, files: "",
        report: "fixture asks for another attempt", backend: "direct", worktree: initial.worktree };
    });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    const liveCtx = { ...ctx, now: Date.now() / 1000, run: realRun };
    await retryWork(liveCtx, task.id,
      { expectRev: readTask(ctx, task.id)!.rev, requestId: "same-task-attempt-2" }, () => undefined);
    const selected = readTask(ctx, task.id)!;
    expect(selected.state).toBe("queued");
    expect(selected.worktree).toBe(initial.worktree);
    expect(selected.run).toBeUndefined();
    const status = async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
      mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
      providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
        windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
      executors: { ranked: [], excluded: [] } });
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: status,
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.attempts).toHaveLength(2);
    expect(result.worktree).toBe(initial.worktree);
    expect(result.run?.attempt).toBe(2);
    expect(result.startIntent).toMatchObject({ attempt: 2, providerId: "pacer-exec-direct" });
    expect(result.executorExitReceipt).toMatchObject({ attempt: 2, providerId: "pacer-exec-direct" });
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.baseSha).toBe(advancedHead);
    expect(readFileSync(join(initial.worktree!, "first-attempt.txt"), "utf8"))
      .toBe("retained across retry\n");
  } finally { cleanup(); }
});

// SP08 strict admission cannot certify Codex subagent denial; keep this end-to-end route UNVERIFIED.
test.skip("delegating managed work reaches only the owned executor child with its attempt grant", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    writeFileSync(ctx.which("codex")!, "#!/bin/sh\nif [ -n \"$PACER_WORK_GRANT\" ]; then echo grant-present; else echo grant-missing; fi\n", { mode: 0o700 });
    registerWork(ctx, task.id, { allowDelegation: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const liveCtx = { ...ctx, now: Date.now() / 1000, run: realRun };
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.startIntent?.attempt).toBe(1);
    expect(result.result?.report).toContain("grant-present");
    expect(JSON.stringify(result)).not.toMatch(/pwg_[0-9a-f]{64}/);
    expect(readFileSync(result.run!.logFile, "utf8")).not.toMatch(/pwg_[0-9a-f]{64}/);
    const grants = dispatchDatabase(ctx).query<{ n: number; live: number }, [string]>(
      "SELECT count(*) AS n, sum(CASE WHEN revoked=0 THEN 1 ELSE 0 END) AS live FROM work_grants WHERE task_id=?",
    ).get(task.id)!;
    expect(grants.n).toBe(1);
    expect(grants.live).toBe(0);
  } finally { cleanup(); }
});

test("disabled bundled executor never falls back for delegating managed work", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const marker = join(task.brief.repo, "legacy-ran.txt");
    writeFileSync(ctx.which("codex")!, `#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 0.162.1; exit 0; fi\nprintf legacy > '${marker}'\n`, { mode: 0o700 });
    registerWork(ctx, task.id, { allowDelegation: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
      planner: "claude-code", accounts: { "claude-code": { kind: "claude" },
        codex: { kind: "codex", usage: "unmetered" } },
      runners: { codex: { models: [{ id: "provider/fixture", tier: "small" }] } },
      execution: { worktree: "new-child" },
      dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
    }));
    await pluginRegistry(ctx).disable(ctx, "pacer-exec-direct");
    updateTask(ctx, task.id, current => {
      current.state = "queued";
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
      delete current.executor;
      delete current.executorProvider;
    });
    const result = await runTask({ ...ctx, now: Date.now() / 1000, run: realRun }, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).not.toBe("done");
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/pwg_[0-9a-f]{64}/);
    const grants = dispatchDatabase(ctx).query<{ live: number }, [string]>(
      "SELECT count(*) AS live FROM work_grants WHERE task_id=? AND revoked=0",
    ).get(task.id)!;
    expect(grants.live).toBe(0);
  } finally { cleanup(); }
});

test("an uncertain prior local attempt cannot launch a second provider run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const first = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const initial = await runOwnedDirectNew({ ...ctx, run: realRun }, cfg, first);
    const uncertain = updateTask(ctx, task.id, current => {
      current.attempts.push(initial.attempt);
      delete current.run;
      delete current.executorExitReceipt;
    });
    expect(runOwnedDirectNew({ ...ctx, run: realRun }, cfg, uncertain))
      .rejects.toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(readTask(ctx, task.id)?.startIntent?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("a settled in-place attempt can claim a second provider run", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    const first = await runOwnedDirectCurrent({ ...ctx, run: realRun }, cfg, task);
    const retry = updateTask(ctx, task.id, current => {
      current.attempts.push(first.attempt);
      delete current.run;
    });
    const second = await runOwnedDirectCurrent({ ...ctx, run: realRun }, cfg, retry);
    expect(second.exec.code).toBe(0);
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(2);
    expect(readTask(ctx, task.id)?.startIntent?.attempt).toBe(2);
    expect(readTask(ctx, task.id)?.executorExitReceipt?.attempt).toBe(2);
  } finally { cleanup(); }
});

test("lost worktree effect reply recovers the exact placement before run claim", async () => {
  const { ctx, task, cfg, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    const selected = updateTask(ctx, task.id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const liveCtx = { ...ctx, run: realRun };
    const grant = await issueOwnedWorktreeGrant(liveCtx, task.id, "pacer-exec-direct", 1, "HEAD");
    const authority = createCallAuthority(liveCtx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      await answerCapability(liveCtx, { id: "pacer-exec-direct", manifest: parsedDirectManifest },
        "capability.worktree.createOrReuse", { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority);
    } finally { await authority.revoke(); }
    expect(readTask(ctx, task.id)?.worktreeIntent).toMatchObject({ path: grant.path, baseSha: grant.baseSha });
    const recovered = await runOwnedDirectNew(liveCtx, cfg, readTask(ctx, selected.id)!);
    expect(recovered.exec.code).toBe(0);
    expect(recovered.worktree).toBe(grant.workdir);
    expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
    expect(readTask(ctx, task.id)?.run?.attempt).toBe(1);
  } finally { cleanup(); }
});

test("runner restart resumes a journaled worktree before any run was published", async () => {
  const { ctx, task, cleanup } = fixture();
  try {
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: task.brief.repo });
    Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-q", "--allow-empty", "-m", "init"], { cwd: task.brief.repo });
    updateTask(ctx, task.id, current => {
      current.placement = { requested: "new", mode: "new", why: "fixture" };
      current.brief.worktreeBase = "head";
      current.attemptStartedAt = ctx.now;
      current.runnerPid = 999_999;
    });
    const liveCtx = { ...ctx, run: realRun };
    const grant = await issueOwnedWorktreeGrant(liveCtx, task.id, "pacer-exec-direct", 1, "HEAD");
    const authority = createCallAuthority(liveCtx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      await answerCapability(liveCtx, { id: "pacer-exec-direct", manifest: parsedDirectManifest },
        "capability.worktree.createOrReuse", { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority);
    } finally { await authority.revoke(); }
    const result = await runTask(liveCtx, task.id, {
      loadStrategy,
      computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code",
        mode: "normal", disabled: false, calendarPace: true, accounts: [],
        providers: ["claude-code", "codex"].map(id => ({ id, eligibility: eligibility(), usage: "quota" as const,
          windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
        executors: { ranked: [], excluded: [] } }),
      hooks: { ...defaultHooks, taskKind: async () => "research" },
      verifyRepo: async () => ({ files: "(no changes)" }),
    });
    expect(result.state).toBe("done");
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    expect(result.worktree).toBe(grant.workdir);
  } finally { cleanup(); }
});

for (const reason of ["user", "deadline"] as const) {
  test(`an expired ${reason} stop settles without signalling an uncertain child`, async () => {
    const { ctx, task, cleanup } = fixture();
    const unrelated = Bun.spawn(["/bin/sleep", "60"], { detached: true });
    try {
      const dir = join(ctx.pacerHome, "runs", task.id, "1");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "pid"), String(Bun.spawnSync(["/bin/sleep", "0"]).pid));
      writeFileSync(join(dir, "child"), String(unrelated.pid));
      updateTask(ctx, task.id, current => {
        current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
          mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
        current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
        current.stopPending = { attempt: 1, requestedAt: ctx.now - 601,
          providerId: "pacer-exec-direct", graceMs: 100, reason };
      });
      const settled = await superviseTask(ctx, task.id, () => undefined);
      expect(settled?.state).toBe(reason === "deadline" ? "failed" : "stopped");
      expect(settled?.result?.report).toContain("cleanup was not confirmed");
      expect(settled?.executorExitReceipt?.unverified).toBe(true);
      expect(process.kill(unrelated.pid, 0)).toBe(true);
    } finally { unrelated.kill("SIGKILL"); await unrelated.exited; cleanup(); }
  });
}

test("a reused wrapper pid settles without signalling the unrelated process", async () => {
  const { ctx, task, cleanup } = fixture();
  const unrelated = Bun.spawn(["/bin/sleep", "60"], { detached: true });
  try {
    const dir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "pid"), String(unrelated.pid));
    updateTask(ctx, task.id, current => {
      current.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now,
        mode: "current", workdir: task.brief.repo, logFile: join(dir, "log") };
      current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir };
      current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
        providerId: "pacer-exec-direct", graceMs: 100, reason: "user" };
    });
    const settled = await superviseTask(ctx, task.id, () => undefined);
    expect(settled?.state).toBe("stopped");
    expect(settled?.result?.report).toContain("cleanup was not confirmed");
    expect(process.kill(unrelated.pid, 0)).toBe(true);
  } finally { unrelated.kill("SIGKILL"); await unrelated.exited; cleanup(); }
});
