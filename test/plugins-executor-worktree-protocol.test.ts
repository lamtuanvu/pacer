import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_METHODS, capabilityOf, PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";
import { answerCapability } from "../src/plugins/host";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";
import { gitRepo, realRun, tmpDir } from "./helpers";
import { manifestSchema } from "../src/plugins/protocol";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { bindOwnedWorktreeIntent, issueOwnedWorktreeGrant } from "../src/plugins/executor-worktree";
import { runOwnedExecutorAttempt } from "../src/plugins/executor-attempt";

test("worktree authority has three bounded task-owned methods and a distinct consent capability", () => {
  expect(PLUGIN_PROTOCOL_VERSION).toBe("1.9.0");
  for (const name of ["inspect", "resolveBase", "createOrReuse"]) {
    const method = `capability.worktree.${name}`;
    expect(capabilityOf(method)).toBe("worktree");
    expect(CAPABILITY_METHODS[method]).toBeDefined();
    expect(CAPABILITY_METHODS[method]!.deadlineMs).toBeGreaterThan(0);
  }
  const inspect = CAPABILITY_METHODS["capability.worktree.inspect"]!;
  const resolve = CAPABILITY_METHODS["capability.worktree.resolveBase"]!;
  const create = CAPABILITY_METHODS["capability.worktree.createOrReuse"]!;
  const identity = { taskId: "t-fixture", attempt: 1 };
  expect(inspect.params.safeParse(identity).success).toBe(true);
  expect(resolve.params.safeParse(identity).success).toBe(true);
  expect(create.params.safeParse({ ...identity, baseSha: "a".repeat(40) }).success).toBe(true);
  for (const unsafe of [{ ...identity, path: "/tmp/foreign" }, { ...identity, argv: ["git", "worktree"] }]) {
    expect(inspect.params.safeParse(unsafe).success).toBe(false);
    expect(resolve.params.safeParse(unsafe).success).toBe(false);
  }
  expect(create.params.safeParse({ ...identity, baseSha: "a".repeat(40), path: "/tmp/foreign" }).success).toBe(false);
  expect(create.params.safeParse({ ...identity, baseSha: "not-a-commit" }).success).toBe(false);
  expect(create.result.safeParse({ path: "/tmp/owned", workdir: "/tmp/owned", branch: "pacer/t-fixture",
    baseSha: "a".repeat(40), reused: false }).success).toBe(true);
});

test("host-issued placement is journaled before one Git effect and reuses only the exact result", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo, worktreeBase: "head" },
    kind: null, requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  const call = (method: string, params: unknown) => answerCapability(ctx, { id: manifest.id, manifest }, method, params, authority);
  try {
    expect(await call("capability.worktree.inspect", { taskId: task.id, attempt: 1 }))
      .toMatchObject({ top: realpathSync(repo), dirty: false, existingWorkdir: null });
    expect(await call("capability.worktree.resolveBase", { taskId: task.id, attempt: 1 }))
      .toEqual({ base: "HEAD", sha: grant.baseSha });
    const params = { taskId: task.id, attempt: 1, baseSha: grant.baseSha };
    expect(await call("capability.worktree.createOrReuse", params))
      .toMatchObject({ path: grant.path, branch: `pacer/${task.id}`, reused: false });
    expect(readTask(ctx, task.id)?.worktreeIntent).toMatchObject({ path: grant.path, baseSha: grant.baseSha });
    await expect(call("capability.worktree.createOrReuse", params))
      .rejects.toMatchObject({ code: "capability_denied" });
    const recoveryGrant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
    const recovery = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: recoveryGrant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      expect(await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
        params, recovery)).toMatchObject({ path: grant.path, reused: true });
    } finally { await recovery.revoke(); }
    expect((await realRun(["git", "-C", grant.path, "checkout", "-q", "-b", "foreign"], 10_000)).code).toBe(0);
    const driftGrant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
    const drift = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: driftGrant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try {
      await expect(answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
        params, drift)).rejects.toMatchObject({ code: "capability_denied" });
    } finally { await drift.revoke(); }
  } finally { await authority.revoke(); }
});

test("base drift and provider swap refuse before worktree effect", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const use = async () => {
    const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
      { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
    try { return await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
      { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority); }
    finally { await authority.revoke(); }
  };
  expect((await realRun(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "drift"], 10_000)).code).toBe(0);
  await expect(use()).rejects.toMatchObject({ code: "capability_denied" });
  expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
  updateTask(ctx, task.id, current => { current.executorProvider = "other"; });
  await expect(use()).rejects.toMatchObject({ code: "capability_denied" });
  expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
});

test("repository source symlink replacement refuses a previously issued placement", async () => {
  const first = gitRepo(), foreign = gitRepo(), home = tmpDir(), source = join(home, "source");
  symlinkSync(first, source);
  const ctx = fakeCtx({ run: realRun, home });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: source }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  unlinkSync(source); symlinkSync(foreign, source);
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try {
    await expect(answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
      { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
  } finally { await authority.revoke(); }
});

test("later attempts cannot overwrite an uncertain placement and may inspect after durable run binding", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try { await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
    { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority); }
  finally { await authority.revoke(); }
  updateTask(ctx, task.id, current => { current.attempts.push({ executor: "codex", model: null,
    startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false,
    limitHit: false, log: "fixture" }); });
  await expect(issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 2, "HEAD"))
    .rejects.toMatchObject({ code: "capability_denied" });
  updateTask(ctx, task.id, current => {
    current.attempts.pop();
    current.worktree = grant.workdir;
    current.run = { dir: join(ctx.pacerHome, "runs", task.id, "1"), attempt: 1, executor: "codex",
      startedAt: ctx.now, mode: "new", workdir: grant.workdir, logFile: "fixture" };
  });
  mkdirSync(join(ctx.pacerHome, "runs", task.id, "1"), { recursive: true, mode: 0o700 });
  await bindOwnedWorktreeIntent(ctx, task.id, "pacer-exec-direct", 1);
  expect(readTask(ctx, task.id)?.worktreeIntent).toBeUndefined();
  updateTask(ctx, task.id, current => { current.attempts.push({ executor: "codex", model: null,
    startedAt: ctx.now, endedAt: ctx.now + 1, exitCode: 0, timedOut: false,
    limitHit: false, log: "fixture" }); delete current.run; });
  const retry = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 2, "HEAD");
  expect(retry.workdir).toBe(grant.workdir);
  expect((await realRun(["git", "-C", grant.path, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "task change"], 10_000)).code).toBe(0);
  const changed = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 2, "HEAD");
  expect(changed.baseSha).not.toBe(grant.baseSha);
  const next = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: changed },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try {
    const reused = await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
      { taskId: task.id, attempt: 2, baseSha: changed.baseSha }, next) as { path: string; reused: boolean; baseSha: string };
    expect(reused).toMatchObject({ reused: true, baseSha: changed.baseSha });
    expect(realpathSync(reused.path)).toBe(realpathSync(grant.path));
  } finally { await next.revoke(); }
});

test("legacy owner-owned 0755 parents and symlinked PACER_HOME migrate without changing placement", async () => {
  const repo = gitRepo(), home = tmpDir(), actual = join(home, "actual"), link = join(home, "linked");
  mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, link);
  const ctx = fakeCtx({ run: realRun, home, pacerHome: link });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  mkdirSync(join(link, "worktrees"), { mode: 0o755 });
  mkdirSync(join(link, "worktrees", grant.path.split("/").at(-2)!), { mode: 0o755 });
  chmodSync(join(link, "worktrees"), 0o755);
  chmodSync(join(link, "worktrees", grant.path.split("/").at(-2)!), 0o755);
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try {
    expect(await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
      { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, authority))
      .toMatchObject({ path: grant.path, reused: false });
  } finally { await authority.revoke(); }
});

test("a retry task reuses its settled parent's worktree at the committed HEAD", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const parent = createTask(ctx, { brief: { goal: "parent", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, parent.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const first = await issueOwnedWorktreeGrant(ctx, parent.id, "pacer-exec-direct", 1, "HEAD");
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const firstOwner = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: first },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try { await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
    { taskId: parent.id, attempt: 1, baseSha: first.baseSha }, firstOwner); }
  finally { await firstOwner.revoke(); }
  expect((await realRun(["git", "-C", first.path, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-q", "--allow-empty", "-m", "parent work"], 10_000)).code).toBe(0);
  updateTask(ctx, parent.id, current => {
    current.state = "done"; current.worktree = first.workdir; delete current.worktreeIntent;
  });
  const retry = createTask(ctx, { brief: { goal: "retry", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, retry.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; current.retryOf = parent.id;
    current.worktree = first.workdir; current.baseSha = first.baseSha; });
  const next = await issueOwnedWorktreeGrant(ctx, retry.id, "pacer-exec-direct", 1, "HEAD");
  expect(realpathSync(next.path)).toBe(realpathSync(first.path));
  expect(next.baseSha).not.toBe(first.baseSha);
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: next },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try {
    const reused = await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
      { taskId: retry.id, attempt: 1, baseSha: next.baseSha }, authority) as { path: string; reused: boolean; baseSha: string };
    expect(reused).toMatchObject({ reused: true, baseSha: next.baseSha });
    expect(realpathSync(reused.path)).toBe(realpathSync(first.path));
  } finally { await authority.revoke(); }
  const fakeCaller = { call: async () => ({ status: "done", exitCode: 0, report: "fixture" }) };
  await runOwnedExecutorAttempt(ctx, fakeCaller, "pacer-exec-direct", retry.id, "codex", next.workdir,
    { argv: ["bun", "-e", "console.log('fixture')"], cwd: next.workdir, timeoutMs: 1000 });
  expect(readTask(ctx, retry.id)?.run).toMatchObject({ mode: "new", workdir: next.workdir });
  expect(readTask(ctx, retry.id)?.worktree).toBe(next.workdir);
  expect(readTask(ctx, retry.id)?.worktreeIntent).toBeUndefined();
});

test("a refused run publication keeps the exact placement journal for recovery", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "pacer-exec-direct"; });
  const grant = await issueOwnedWorktreeGrant(ctx, task.id, "pacer-exec-direct", 1, "HEAD");
  const manifest = manifestSchema.parse({ id: "pacer-exec-direct", version: "0.1.0", publisher: "pacer", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const owner = createCallAuthority(ctx, { reads: [], commands: [], stores: [], worktree: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["worktree"] });
  try { await answerCapability(ctx, { id: manifest.id, manifest }, "capability.worktree.createOrReuse",
    { taskId: task.id, attempt: 1, baseSha: grant.baseSha }, owner); }
  finally { await owner.revoke(); }
  updateTask(ctx, task.id, current => { current.stopPending = {
    attempt: 1, requestedAt: ctx.now, providerId: "pacer-exec-direct", graceMs: 5000 }; });
  const fakeCaller = { call: async () => ({ status: "done", exitCode: 0, report: "unexpected" }) };
  await expect(runOwnedExecutorAttempt(ctx, fakeCaller, "pacer-exec-direct", task.id, "codex", grant.workdir,
    { argv: ["bun"], cwd: grant.workdir, timeoutMs: 1000 })).rejects.toMatchObject({ code: "conflict" });
  expect(readTask(ctx, task.id)?.run).toBeUndefined();
  expect(readTask(ctx, task.id)?.worktreeIntent).toMatchObject({ path: grant.path, baseSha: grant.baseSha });
});

test("in-place run refuses a different persisted provider before claiming its directory", async () => {
  const repo = gitRepo(), ctx = fakeCtx({ run: realRun, home: tmpDir() });
  const task = createTask(ctx, { brief: { goal: "fixture", repo }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => { current.state = "running"; current.executor = "codex";
    current.executorProvider = "foreign-provider"; });
  const fakeCaller = { call: async () => ({ status: "done", exitCode: 0, report: "unexpected" }) };
  await expect(runOwnedExecutorAttempt(ctx, fakeCaller, "pacer-exec-direct", task.id, "codex", repo,
    { argv: ["bun"], cwd: repo, timeoutMs: 1000 })).rejects.toMatchObject({ code: "conflict" });
  expect(readTask(ctx, task.id)?.run).toBeUndefined();
});

test("worktree methods refuse missing consent and an unissued placement", async () => {
  const ctx = fakeCtx();
  const method = "capability.worktree.createOrReuse";
  const params = { taskId: "t-fixture", attempt: 1, baseSha: "a".repeat(40) };
  const declared = manifestSchema.parse({ id: "fx-worktree", version: "0.1.0", publisher: "fixture", host: "^1.6",
    contributes: { diagnostic: {} }, capabilities: [{ name: "worktree", scopes: ["task-owned"] }] });
  const absent = { ...declared, capabilities: [] };
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["worktree"] });
  try {
    await expect(answerCapability(ctx, { id: declared.id, manifest: absent }, method, params, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
    await expect(answerCapability(ctx, { id: declared.id, manifest: declared }, method, params))
      .rejects.toMatchObject({ code: "capability_denied" });
    await expect(answerCapability(ctx, { id: declared.id, manifest: declared }, method, params, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
});
