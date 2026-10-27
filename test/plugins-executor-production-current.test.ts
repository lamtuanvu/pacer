import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderCfg, loadStrategy } from "../src/config/strategy";
import { resumeOwnedDirect, runOwnedDirectCurrent, runOwnedDirectNew } from "../src/plugins/executor-production";
import { pluginRegistry } from "../src/plugins";
import { issueOwnedWorktreeGrant } from "../src/plugins/executor-worktree";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability } from "../src/plugins/host";
import { manifest as directManifest } from "../plugins/pacer-exec-direct/manifest";
import { manifestSchema } from "../src/plugins/protocol";

const parsedDirectManifest = manifestSchema.parse(directManifest);
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { superviseTask, taskStop } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { realRun } from "./helpers";
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
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current}\n", { mode: 0o600 });
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
      "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: child-of-current}\n",
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
