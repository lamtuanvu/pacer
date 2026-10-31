import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { answerCapability } from "../src/plugins/host";
import { CAPABILITY_METHODS, capabilityOf, manifestSchema } from "../src/plugins/protocol";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { stopRun } from "../src/supervisor/run";
import { writeReport } from "../src/session/reports";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { issueOwnedWorktreeGrant } from "../src/plugins/executor-worktree";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-run-claim-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  const ctx = fakeCtx({ home, pacerHome, now: Date.now() / 1000 });
  const created = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  const task = updateTask(ctx, created.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0",
    publisher: "pacer", host: ">=1.9.0", contributes: { executor: { backends: ["direct"] } },
    capabilities: [{ name: "process.spawn", scopes: ["bun", "codex"] }] });
  const executable = realpathSync(process.execPath);
  const binary = statSync(executable), cwd = realpathSync(home);
  const resource = { taskId: task.id, attempt: 1, providerId: manifest.id,
    executor: "codex", workdir: home, launch: { argv: ["bun", "-e", "console.log('owned')"], cwd,
      executable, executableIdentity: { dev: binary.dev, ino: binary.ino, size: binary.size,
        mtimeMs: binary.mtimeMs, mode: binary.mode },
      env: { PATH: ctx.env.PATH ?? "/usr/bin:/bin" } } };
  const call = async (issued = true, extra: Record<string, unknown> = {}) => {
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      ...(issued ? { executorClaim: { ...resource, ...extra } } : {}) } as any,
    { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    try {
      return await answerCapability(ctx, { id: manifest.id, manifest }, "capability.process.claimRun",
        { taskId: task.id, attempt: 1 }, authority);
    } finally { await authority.revoke(); }
  };
  return { ctx, task, call, resource, manifest,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("run claim protocol admits only task and attempt, with explicit process authority", () => {
  expect(capabilityOf("capability.process.claimRun")).toBe("process.spawn");
  const method = CAPABILITY_METHODS["capability.process.claimRun"]!;
  expect(method.params.safeParse({ taskId: "t-fixture", attempt: 1 }).success).toBe(true);
  expect(method.params.safeParse({ taskId: "t-fixture", attempt: 1, argv: ["sh"] }).success).toBe(false);
  expect(method.params.safeParse({ taskId: "t-fixture", attempt: 1, dir: "/tmp/foreign" }).success).toBe(false);
});

test("host claim publishes the exact run and lost reply recovers that run without a second directory", async () => {
  const { ctx, task, call, cleanup } = fixture();
  try {
    await expect(call(false)).rejects.toMatchObject({ code: "capability_denied" });
    const first = await call() as { task: { id: string; rev: number }; attempt: number; runDir: number };
    expect(first.task.id).toBe(task.id);
    expect(first.attempt).toBe(1);
    expect(first.runDir).toBe(1);
    expect(readTask(ctx, task.id)?.run?.dir).toBe(join(ctx.pacerHome, "runs", task.id, "1"));
    expect(await call()).toMatchObject({ task: { id: task.id }, attempt: 1, runDir: 1 });
  } finally { cleanup(); }
});

test("read-only restart observation requires the exact host-issued owner", async () => {
  const { ctx, task, call, manifest, cleanup } = fixture();
  try {
    await call();
    const run = readTask(ctx, task.id)!.run!, dir = statSync(run.dir);
    const resource = { taskId: task.id, attempt: 1, providerId: manifest.id,
      executor: "codex", workdir: run.workdir, dir: run.dir,
      dirIdentity: { dev: dir.dev, ino: dir.ino }, startedAt: run.startedAt };
    const unissued = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
      { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
    try {
      await expect(answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.pollRun", { taskId: task.id, attempt: 1 }, unissued))
        .rejects.toMatchObject({ code: "capability_denied" });
    } finally { await unissued.revoke(); }
    const issued = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      executorObserve: resource }, { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
    try {
      expect(await answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.pollRun", { taskId: task.id, attempt: 1 }, issued))
        .toMatchObject({ state: "uncertain" });
      updateTask(ctx, task.id, current => { current.executorProvider = "foreign"; });
      await expect(answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.pollRun", { taskId: task.id, attempt: 1 }, issued))
        .rejects.toMatchObject({ code: "capability_denied" });
    } finally { await issued.revoke(); }
  } finally { cleanup(); }
});

test("pending stop and provider swap refuse run claim without a new effect", async () => {
  for (const change of ["stop", "provider"] as const) {
    const { ctx, task, call, cleanup } = fixture();
    try {
      updateTask(ctx, task.id, current => {
        if (change === "stop") current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
          providerId: "pacer-exec-direct", graceMs: 5000 };
        else current.executorProvider = "foreign";
      });
      await expect(call()).rejects.toMatchObject({ code: "capability_denied" });
      expect(readTask(ctx, task.id)?.run).toBeUndefined();
    } finally { cleanup(); }
  }
});

test("an in-place claim refuses a checkout another task occupied after the grant was issued", async () => {
  const { ctx, task, call, cleanup } = fixture();
  try {
    const top = realpathSync(task.brief.repo), nested = join(top, "nested");
    mkdirSync(nested);
    // Admission passed; another task starts in place inside the same checkout before the claim.
    const other = createTask(ctx, { brief: { goal: "other", repo: nested }, kind: null,
      requestedExecutor: "codex", timeoutS: 60 });
    updateTask(ctx, other.id, current => {
      current.state = "running";
      current.runnerPid = process.pid;
      current.placement = { requested: "current", mode: "current", why: "fixture" };
    });
    await expect(call(true, { inPlaceTop: top })).rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(existsSync(join(ctx.pacerHome, "runs", task.id))).toBe(false);
  } finally { cleanup(); }
});

test("run claim binds one start and a lost start receipt cannot authorize another launch", async () => {
  const { ctx, task, resource, manifest, call, cleanup } = fixture();
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], executorClaim: resource },
    { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
  try {
    const claim = await answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.claimRun", { taskId: task.id, attempt: 1 }, authority) as
      { task: { id: string; rev: number }; attempt: number; runDir: 1 };
    const before = await answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.pollRun", { taskId: task.id, attempt: 1 }, authority) as { state: string };
    expect(before.state).toBe("uncertain");
    const start = await answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.startRun", { task: claim.task, attempt: claim.attempt, runDir: claim.runDir }, authority) as { pid: number };
    expect(start.pid).toBeGreaterThan(0);
    expect(readTask(ctx, task.id)?.startIntent).toMatchObject({ attempt: 1, providerId: manifest.id });
    await expect(answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.startRun", { task: claim.task, attempt: claim.attempt, runDir: claim.runDir }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
    let state = "";
    for (let i = 0; i < 40; i++) {
      const poll = await answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.pollRun", { taskId: task.id, attempt: 1 }, authority) as { state: string };
      state = poll.state;
      if (state === "exited") break;
      await Bun.sleep(50);
    }
    expect(state).toBe("exited");
    const output = await answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.readRunOutput", { taskId: task.id, attempt: 1 }, authority) as
      { stdoutBase64: string; stderrBase64: string };
    expect(Buffer.from(output.stdoutBase64, "base64").toString("utf8")).toContain("owned");
    await expect(call()).rejects.toMatchObject({ code: "capability_denied" });
    const stdout = join(ctx.pacerHome, "runs", task.id, "1", "stdout");
    const foreign = join(ctx.home, "foreign-output");
    writeFileSync(foreign, "foreign", { mode: 0o600 });
    unlinkSync(stdout);
    symlinkSync(foreign, stdout);
    await expect(answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.readRunOutput", { taskId: task.id, attempt: 1 }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
    updateTask(ctx, task.id, current => { current.executorProvider = "foreign"; });
    await expect(answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.pollRun", { taskId: task.id, attempt: 1 }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    await authority.revoke();
    const dir = readTask(ctx, task.id)?.run?.dir;
    if (dir) await stopRun(dir, { graceMs: 1000 });
    cleanup();
  }
});

test("host-issued interactive claim starts a session but the provider cannot upgrade a pipe grant", async () => {
  for (const session of ["pipe", "interactive"] as const) {
    const { ctx, task, resource, manifest, cleanup } = fixture();
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      executorClaim: { ...resource, launch: { ...resource.launch,
        ...(session === "interactive" ? { session, files: [{ name: "report-hook.sh" as const,
          content: "#!/bin/sh\nexit 0\n", mode: 0o700 }] } : {}) } } },
    { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    try {
      const claim = await answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.claimRun", { taskId: task.id, attempt: 1 }, authority) as
        { task: { id: string; rev: number }; attempt: number; runDir: 1 };
      await expect(answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1,
          session: "interactive" }, authority)).rejects.toMatchObject({ code: "invalid_input" });
      expect(readTask(ctx, task.id)?.startIntent).toBeUndefined();
      expect(await answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 }, authority))
        .toHaveProperty("pid");
      const dir = readTask(ctx, task.id)!.run!.dir;
      expect(existsSync(join(dir, "interactive.json"))).toBe(session === "interactive");
      expect(existsSync(join(dir, "session.json"))).toBe(session === "interactive");
      if (session === "interactive")
        expect(readFileSync(join(dir, "report-hook.sh"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
      await expect(answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 }, authority))
        .rejects.toMatchObject({ code: "capability_denied" });
    } finally {
      await authority.revoke();
      const dir = readTask(ctx, task.id)?.run?.dir;
      if (dir) await stopRun(dir, { graceMs: 1000 });
      cleanup();
    }
  }
});

test("interactive artifact publication never replaces a preexisting hook", async () => {
  const { ctx, task, resource, manifest, cleanup } = fixture();
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
    executorClaim: { ...resource, launch: { ...resource.launch, session: "interactive",
      files: [{ name: "report-hook.sh", content: "#!/bin/sh\nexit 0\n", mode: 0o700 }] } } },
  { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
  try {
    const claim = await answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.claimRun", { taskId: task.id, attempt: 1 }, authority) as
      { task: { id: string; rev: number }; attempt: number; runDir: 1 };
    const dir = readTask(ctx, task.id)!.run!.dir;
    writeFileSync(join(dir, "report-hook.sh"), "foreign", { mode: 0o600, flag: "wx" });
    await expect(answerCapability(ctx, { id: manifest.id, manifest },
      "capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readFileSync(join(dir, "report-hook.sh"), "utf8")).toBe("foreign");
    expect(existsSync(join(dir, "pid"))).toBe(false);
    expect(readTask(ctx, task.id)?.startIntent).toMatchObject({ attempt: 1 });
  } finally { await authority.revoke(); cleanup(); }
});

test("reported interactive completion requires the exact live report and reaped run", async () => {
  const { ctx, task, resource, manifest, cleanup } = fixture();
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
    executorClaim: { ...resource, launch: { ...resource.launch,
      argv: ["bun", "-e", "setTimeout(() => {}, 30000)"], session: "interactive" } } },
  { deadlineMs: Date.now() + 15_000, grants: ["process.spawn"] });
  const call = (method: string, params: unknown) => answerCapability(ctx,
    { id: manifest.id, manifest }, method, params, authority);
  try {
    const claim = await call("capability.process.claimRun", { taskId: task.id, attempt: 1 }) as
      { task: { id: string; rev: number }; attempt: number; runDir: 1 };
    await call("capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 });
    const dir = readTask(ctx, task.id)!.run!.dir;
    await expect(call("capability.process.completeReportedRun", { taskId: task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    writeReport(dir, "done", "fixture complete");
    const result = await call("capability.process.completeReportedRun", { taskId: task.id,
      attempt: 1 }) as { status: string; summary: string; exitCode: number };
    expect(result).toMatchObject({ status: "done", summary: "fixture complete" });
    expect(Number.isInteger(result.exitCode)).toBe(true);
    expect((await call("capability.process.pollRun", { taskId: task.id,
      attempt: 1 }) as { state: string }).state).toBe("exited");
    await expect(call("capability.process.completeReportedRun", { taskId: task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally {
    await authority.revoke();
    const dir = readTask(ctx, task.id)?.run?.dir;
    if (dir) await stopRun(dir, { graceMs: 1000 });
    cleanup();
  }
});

test("interactive completion refuses a pipe run and a changed owner before signaling", async () => {
  for (const change of ["pipe", "provider", "stop"] as const) {
    const { ctx, task, resource, manifest, cleanup } = fixture();
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      executorClaim: { ...resource, launch: { ...resource.launch,
        argv: ["bun", "-e", "setTimeout(() => {}, 30000)"],
        ...(change === "pipe" ? {} : { session: "interactive" as const }) } } },
    { deadlineMs: Date.now() + 15_000, grants: ["process.spawn"] });
    const call = (method: string, params: unknown) => answerCapability(ctx,
      { id: manifest.id, manifest }, method, params, authority);
    try {
      const claim = await call("capability.process.claimRun", { taskId: task.id, attempt: 1 }) as
        { task: { id: string; rev: number }; attempt: number; runDir: 1 };
      await call("capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 });
      const dir = readTask(ctx, task.id)!.run!.dir;
      writeReport(dir, "done", "must not settle");
      if (change === "provider") updateTask(ctx, task.id, current => { current.executorProvider = "foreign"; });
      if (change === "stop") updateTask(ctx, task.id, current => {
        current.stopPending = { attempt: 1, requestedAt: Date.now() / 1000,
          providerId: manifest.id, graceMs: 5000 };
      });
      await expect(call("capability.process.completeReportedRun", { taskId: task.id, attempt: 1 }))
        .rejects.toMatchObject({ code: "capability_denied" });
      expect(readTask(ctx, task.id)?.executorReportReceipt).toBeUndefined();
    } finally {
      await authority.revoke();
      const dir = readTask(ctx, task.id)?.run?.dir;
      if (dir) await stopRun(dir, { graceMs: 1000 });
      cleanup();
    }
  }
});

test("isolated run claim requires the issued worktree effect and binds its exact placement", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  const worktree = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  const executable = realpathSync(process.execPath), binary = statSync(executable);
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0",
    publisher: "pacer", host: ">=1.9.0", contributes: { executor: { backends: ["direct"] } },
    capabilities: [{ name: "worktree", scopes: ["task-owned"] },
      { name: "process.spawn", scopes: ["bun", "codex"] }] });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree,
    executorClaim: { taskId: task.id, attempt: 1, providerId: manifest.id,
      executor: "codex", workdir: worktree.workdir, launch: {
        argv: ["bun", "-e", "process.exit(0)"], cwd: worktree.workdir, executable,
        executableIdentity: { dev: binary.dev, ino: binary.ino, size: binary.size,
          mtimeMs: binary.mtimeMs, mode: binary.mode }, env: { PATH: ctx.env.PATH ?? "/usr/bin:/bin" },
      } },
  }, { deadlineMs: Date.now() + 120_000, grants: ["worktree", "process.spawn"] });
  const call = (method: string, params: unknown) => answerCapability(ctx, { id: manifest.id, manifest },
    method, params, authority);
  try {
    await expect(call("capability.process.claimRun", { taskId: task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    await call("capability.worktree.createOrReuse", { taskId: task.id, attempt: 1,
      baseSha: worktree.baseSha });
    expect(await call("capability.process.claimRun", { taskId: task.id, attempt: 1 }))
      .toMatchObject({ task: { id: task.id }, attempt: 1, runDir: 1 });
    expect(readTask(ctx, task.id)?.run?.workdir).toBe(worktree.workdir);
    expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
  } finally { await authority.revoke(); }
});

test("a pipe claim publishes the strict guard file but refuses an interactive-only launch file", async () => {
  for (const name of ["strict-claude-settings.json", "prompt.md"] as const) {
    const { ctx, task, resource, manifest, cleanup } = fixture();
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      executorClaim: { ...resource, launch: { ...resource.launch,
        files: [{ name, content: "{}", mode: 0o600 }] } } },
    { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
    try {
      const claim = await answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.claimRun", { taskId: task.id, attempt: 1 }, authority) as
        { task: { id: string; rev: number }; attempt: number; runDir: 1 };
      const dir = readTask(ctx, task.id)!.run!.dir;
      const start = answerCapability(ctx, { id: manifest.id, manifest },
        "capability.process.startRun", { task: claim.task, attempt: 1, runDir: 1 }, authority);
      if (name === "prompt.md") {
        await expect(start).rejects.toMatchObject({ code: "capability_denied" });
        expect(existsSync(join(dir, name))).toBe(false);
        expect(existsSync(join(dir, "pid"))).toBe(false);
      } else {
        expect(await start).toHaveProperty("pid");
        expect(readFileSync(join(dir, name), "utf8")).toBe("{}");
      }
    } finally {
      await authority.revoke();
      const dir = readTask(ctx, task.id)?.run?.dir;
      if (dir && existsSync(join(dir, "pid"))) await stopRun(dir, { graceMs: 1000 });
      cleanup();
    }
  }
});
