import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { loadStrategy } from "../src/config/strategy";
import { issueConfiguredHostPrepareRecover, consumeConfiguredHostPrepareRecover } from "../src/plugins/host-prepare-recover-issuer";
import { issueConfiguredHostPrepare } from "../src/plugins/host-prepare-issuer";
import { pluginRegistry } from "../src/plugins";
import { admitOwnedRemotePrepare } from "../src/plugins/executor-remote-prepare";
import { answerOwnedRemotePrepare } from "../src/plugins/executor-remote-prepare-host";
import { createCallAuthority } from "../src/plugins/authority";
import { manifest as directManifest } from "../plugins/pacer-exec-direct/manifest";
import { manifestSchema } from "../src/plugins/protocol";
import { answerOwnedRemoteClaim } from "../src/plugins/executor-remote-claim";
import { answerOwnedRemoteStart, answerOwnedRemotePoll, answerOwnedRemoteOutput,
  answerOwnedRemoteStop, answerOwnedRemoteTransfer } from "../src/plugins/executor-remote-run";
import { taskStop, superviseTask } from "../src/tasks/api";
import { runOwnedDirectRemote } from "../src/plugins/executor-production";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import { eligibility } from "./fixtures/eligibility";
import * as tasks from "../src/core/tasks";

async function fixture() {
  const root = tmpDir(), repo = join(root, "repo"), home = join(root, "home"),
    hostHome = join(root, "host"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(home); mkdirSync(hostHome); mkdirSync(bin);
  const git = async (...args: string[]) => {
    const result = await realRun(["git", "-C", repo, ...args], 10_000);
    if (result.code) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-q"); await git("checkout", "-qb", "main");
  await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("commit", "--allow-empty", "-qm", "base");
  const clone = await realRun(["git", "clone", "-q", repo, join(hostHome, "repo")], 10_000);
  if (clone.code) throw new Error(clone.stderr);
  await realRun(["git", "-C", join(hostHome, "repo"), "config", "user.name", "Fixture"], 10_000);
  await realRun(["git", "-C", join(hostHome, "repo"), "config", "user.email", "fixture@example.invalid"], 10_000);
  const origin = "https://example.invalid/o/r";
  await git("remote", "add", "origin", origin);
  const baseSha = await git("rev-parse", "HEAD");
  const sshEnv = fakeSshEnv(hostHome, join(root, "ssh.log"));
  const env = { ...process.env, ...sshEnv, PATH: `${bin}:${sshEnv.PATH}` };
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env,
    which: name => name === "ssh" ? join(import.meta.dir, "fixtures", "bin", "ssh") : Bun.which(name),
    run: (argv, ms, options) => realRun(argv, ms, { ...options, env: { ...env, ...options?.env } }) });
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  const host = { ssh: "box-ssh", repos: { "example.invalid/o/r": "~/repo",
    "example.invalid/o/s": "~/other" }, accounts: {}, max_tasks: 1 };
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ accounts: { codex: { kind: "codex" } },
    planner: "codex", hosts: { box: host }, routing: [{ default: ["codex@box"] }] }));
  const parsedHost = loadStrategy(ctx).hosts.box;
  const task = createTask(ctx, { brief: { goal: "fixture", repo, base: "main" },
    kind: null, requestedExecutor: "codex@box", timeoutS: 30 });
  const tag = `r-${createHash("sha1").update("example.invalid/o/r").digest("hex").slice(0, 8)}`;
  updateTask(ctx, task.id, current => {
    current.state = "running"; current.executor = "codex@box";
    current.executorProvider = "pacer-exec-direct";
    current.remotePrepareIntent = { attempt: 1, providerId: "pacer-exec-direct",
      executor: "codex@box", alias: "box", hostFingerprint: JSON.stringify(parsedHost),
      repoTop: realpathSync(repo), originHash: createHash("sha256").update(origin).digest("hex"),
      checkout: "~/repo", tag, baseSha, base: "main" };
  });
  return { ctx, task, host, repo, baseSha, tag, hostHome, bin };
}

test("PREPARE recovery is issued only from the exact persisted unreceipted intent", async () => {
  const f = await fixture();
  const grant = await issueConfiguredHostPrepareRecover(f.ctx, f.task.id);
  expect(grant.resource).toMatchObject({ alias: "box", script: "PREPARE_RECOVER",
    args: ["~/repo", f.tag, f.task.id, f.baseSha, "main", "1"] });
  await consumeConfiguredHostPrepareRecover(f.ctx, grant);
  await expect(consumeConfiguredHostPrepareRecover(f.ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
  const stale = await issueConfiguredHostPrepareRecover(f.ctx, f.task.id);
  updateTask(f.ctx, f.task.id, current => { current.executorProvider = "other"; });
  await expect(consumeConfiguredHostPrepareRecover(f.ctx, stale)).rejects.toMatchObject({ code: "capability_denied" });
});

test("PREPARE recovery refuses missing intent and direct public provider calls", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  await expect(issueConfiguredHostPrepareRecover(f.ctx, f.task.id)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(pluginRegistry(f.ctx).call(f.ctx, "pacer-ssh", "hostRunner.run", {
    session: "a".repeat(32), script: "PREPARE_RECOVER",
    args: ["~/repo", f.tag, f.task.id, f.baseSha, "main", "1"],
    timeoutMs: 30_000, maxBytes: 65_536,
  })).rejects.toMatchObject({ code: "capability_denied" });
});

test("issued PREPARE recovery observes the same remote worktree through bundled SSH", async () => {
  const f = await fixture(), registry = pluginRegistry(f.ctx);
  const first = await registry.prepareConfiguredHost(f.ctx,
    await issueConfiguredHostPrepare(f.ctx, "box", f.task.id, f.baseSha, "main", new Uint8Array()));
  expect(first.code).toBe(0);
  const recovered = await registry.recoverConfiguredHostPrepare(f.ctx,
    await issueConfiguredHostPrepareRecover(f.ctx, f.task.id));
  expect(recovered).toMatchObject({ code: 0, timedOut: false, stdout: first.stdout });
  expect(recovered.stdout).toContain(join(f.hostHome, ".pacer-remote", "worktrees", f.tag, `${f.task.id}-1`));
}, 30_000);

test("owned remote admission persists first PREPARE and later permits only recovery", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  expect(first.mode).toBe("prepare");
  expect(readTask(f.ctx, f.task.id)?.remotePrepareIntent).toEqual(first.intent);
  const later = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  expect(later).toMatchObject({ mode: "recover", intent: first.intent });
  updateTask(f.ctx, f.task.id, current => { current.stopPending = { attempt: 1,
    providerId: "pacer-exec-direct", requestedAt: 1, graceMs: 5000 }; });
  await expect(admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha)).rejects.toMatchObject({ code: "capability_denied" });
});

test("owned remote recovery refuses a changed provider, host mapping or base", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct", "codex@box", "box", "main", f.baseSha);
  await expect(admitOwnedRemotePrepare(f.ctx, f.task.id, "other", "codex@box", "box", "main", f.baseSha))
    .rejects.toMatchObject({ code: "capability_denied" });
  await expect(admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct", "codex@box", "box", "HEAD", f.baseSha))
    .rejects.toMatchObject({ code: "capability_denied" });
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    accounts: { codex: { kind: "codex" } }, planner: "codex",
    hosts: { box: { ...f.host, repos: { "example.invalid/o/r": "~/other" } } },
    routing: [{ default: ["codex@box"] }],
  }));
  await expect(admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct", "codex@box", "box", "main", f.baseSha))
    .rejects.toMatchObject({ code: "capability_denied" });
});

test("origin drift after durable admission cannot redirect first PREPARE to another valid checkout", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const admitted = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: admitted.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  const changed = await realRun(["git", "-C", f.repo, "remote", "set-url", "origin",
    "https://example.invalid/o/s"], 10_000);
  expect(changed.code).toBe(0);
  let effects = 0;
  const broker = { prepareConfiguredHost: async () => {
    effects++; return { code: 0, timedOut: false, stdout: "", stderr: "" };
  }, recoverConfiguredHostPrepare: async () => {
    effects++; return { code: 0, timedOut: false, stdout: "", stderr: "" };
  } };
  try {
    await expect(answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(effects).toBe(0);
  } finally { await authority.revoke(); }
});

test("one-use owned host method publishes the exact remote run before START", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: first.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  const expectedWorktree = join(f.hostHome, ".pacer-remote", "worktrees", f.tag, `${f.task.id}-1`);
  let prepares = 0, recovers = 0;
  const broker = {
    prepareConfiguredHost: async () => {
      prepares++;
      expect(readTask(f.ctx, f.task.id)?.remotePrepareIntent).toEqual(first.intent);
      return { code: 0, timedOut: false, stderr: "",
        stdout: `worktree=${expectedWorktree}\nbranch=pacer/${f.task.id}\n` };
    },
    recoverConfiguredHostPrepare: async () => {
      recovers++;
      return { code: 0, timedOut: false, stderr: "",
        stdout: `worktree=${expectedWorktree}\nbranch=pacer/${f.task.id}\n` };
    },
  };
  try {
    expect(await answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .toEqual({ worktree: expectedWorktree, branch: `pacer/${f.task.id}` });
    const claimed = answerOwnedRemoteClaim(authority, { taskId: f.task.id, attempt: 1 });
    expect(claimed).toMatchObject({ worktree: expectedWorktree,
      branch: `pacer/${f.task.id}` });
    expect(readTask(f.ctx, f.task.id)?.run).toMatchObject({
      host: "box", remoteWorktree: expectedWorktree, remoteDir: claimed.remoteDir,
      attempt: 1, mode: "new" });
    await expect(answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
  expect(prepares).toBe(1);
  expect(recovers).toBe(0);
});

test("lost PREPARE reply can only enter read-only recovery", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: first.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  const worktree = join(f.hostHome, ".pacer-remote", "worktrees", f.tag, `${f.task.id}-1`);
  let prepares = 0, recovers = 0;
  const broker = {
    prepareConfiguredHost: async () => { prepares++; throw Error("reply lost"); },
    recoverConfiguredHostPrepare: async () => {
      recovers++; return { code: 0, timedOut: false, stderr: "",
        stdout: `worktree=${worktree}\nbranch=pacer/${f.task.id}\n` };
    },
  };
  try {
    await expect(answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .rejects.toThrow("reply lost");
  } finally { await authority.revoke(); }
  const next = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  expect(next.mode).toBe("recover");
  const recovery = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: next.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  try {
    expect(await answerOwnedRemotePrepare(recovery, { taskId: f.task.id, attempt: 1 }, broker))
      .toEqual({ worktree, branch: `pacer/${f.task.id}` });
    expect(prepares).toBe(1); expect(recovers).toBe(1);
  } finally { await recovery.revoke(); }
});

test("a definite missing-base receipt permits one journaled bundle retry", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: first.grant } }, { deadlineMs: Date.now() + 180_000, grants: ["hosts"] });
  let calls = 0;
  const worktree = join(f.hostHome, ".pacer-remote", "worktrees", f.tag, `${f.task.id}-1`);
  const broker = { prepareConfiguredHost: async () => {
    calls++;
    if (calls === 1) return { code: 3, timedOut: false, stderr: "missing-base\n", stdout: "" };
    expect(readTask(f.ctx, f.task.id)?.remotePrepareIntent?.bundleRetryIssuedAt).toBeGreaterThan(0);
    return { code: 0, timedOut: false, stderr: "",
      stdout: `worktree=${worktree}\nbranch=pacer/${f.task.id}\n` };
  }, recoverConfiguredHostPrepare: async () => { throw Error("must not recover a receipted missing base"); } };
  try {
    expect(await answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .toMatchObject({ worktree });
    expect(calls).toBe(2);
  } finally { await authority.revoke(); }
  expect((await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha)).mode).toBe("recover");
});

test("extra stderr cannot authorize a second remote PREPARE", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: first.grant } }, { deadlineMs: Date.now() + 180_000, grants: ["hosts"] });
  let calls = 0;
  const broker = { prepareConfiguredHost: async () => {
    calls++;
    return { code: 3, timedOut: false, stderr: "warning\nmissing-base\n", stdout: "" };
  }, recoverConfiguredHostPrepare: async () => { throw Error("unexpected recovery"); } };
  try {
    await expect(answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .rejects.toMatchObject({ code: "plugin_refused" });
    expect(calls).toBe(1);
    expect(readTask(f.ctx, f.task.id)?.remotePrepareIntent?.missingBaseReceiptAt).toBeUndefined();
  } finally { await authority.revoke(); }
});

test("lost bundle retry receipt never authorizes a third PREPARE", async () => {
  const f = await fixture();
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const first = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: first.grant } }, { deadlineMs: Date.now() + 180_000, grants: ["hosts"] });
  let calls = 0;
  const broker = { prepareConfiguredHost: async () => {
    calls++; if (calls === 1) return { code: 3, timedOut: false, stderr: "missing-base\n", stdout: "" };
    throw Error("bundle reply lost");
  }, recoverConfiguredHostPrepare: async () => { throw Error("unreachable"); } };
  try {
    await expect(answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, broker))
      .rejects.toThrow("bundle reply lost");
  } finally { await authority.revoke(); }
  expect(calls).toBe(2);
  expect((await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha)).mode).toBe("recover");
});

test("direct executor cannot use the general SSH broker despite its scoped hosts consent", async () => {
  const f = await fixture(), registry = pluginRegistry(f.ctx);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const invoke = registry as unknown as { answerHosts: (...args: unknown[]) => Promise<unknown> };
  try {
    await expect(invoke.answerHosts(f.ctx,
      { id: "pacer-exec-direct", manifest: manifestSchema.parse(directManifest) },
      { alive: true }, authority, "capability.hosts.open", { alias: "box" }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await expect(invoke.answerHosts(f.ctx,
      { id: "pacer-exec-direct", manifest: manifestSchema.parse(directManifest) },
      { alive: true }, authority, "capability.hosts.prepareOwned", { taskId: f.task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
});

test("owned remote pipe starts once and settles only on the exact completion receipt", async () => {
  const f = await fixture();
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat > PROMPT.txt\necho owned-remote-started\n" +
    "git add PROMPT.txt\ngit commit -q -m fixture\necho owned-remote-done\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const admitted = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: admitted.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  try {
    await answerOwnedRemotePrepare(authority, { taskId: f.task.id, attempt: 1 }, pluginRegistry(f.ctx));
    answerOwnedRemoteClaim(authority, { taskId: f.task.id, attempt: 1 });
    expect((await answerOwnedRemoteStart(authority, { taskId: f.task.id, attempt: 1 })).pid).toBeGreaterThan(0);
    await expect(answerOwnedRemoteStart(authority, { taskId: f.task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    let state: Awaited<ReturnType<typeof answerOwnedRemotePoll>> = { state: "uncertain", exitCode: null };
    for (let i = 0; i < 100 && state.state !== "exited"; i++) {
      await Bun.sleep(50);
      state = await answerOwnedRemotePoll(authority, { taskId: f.task.id, attempt: 1 });
    }
    expect(state).toMatchObject({ state: "exited", exitCode: 0 });
    const output = answerOwnedRemoteOutput(authority, { taskId: f.task.id, attempt: 1 });
    expect(Buffer.from(output.stdoutBase64, "base64").toString()).toContain("owned-remote-done");
    expect(readTask(f.ctx, f.task.id)?.executorExitReceipt).toMatchObject({ attempt: 1, exitCode: 0 });
  } finally { await authority.revoke(); }
}, 60_000);

test("remote stop remains pending until fixed STOP and REPORT verify the exact exit", async () => {
  const f = await fixture();
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat >/dev/null\nwhile :; do sleep 0.2; done\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const admitted = await admitOwnedRemotePrepare(f.ctx, f.task.id, "pacer-exec-direct",
    "codex@box", "box", "main", f.baseSha);
  const initial = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [],
    remotePrepare: { grant: admitted.grant } }, { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  try {
    await answerOwnedRemotePrepare(initial, { taskId: f.task.id, attempt: 1 }, pluginRegistry(f.ctx));
    answerOwnedRemoteClaim(initial, { taskId: f.task.id, attempt: 1 });
    await answerOwnedRemoteStart(initial, { taskId: f.task.id, attempt: 1 });
  } finally { await initial.revoke(); }
  const pending = taskStop(f.ctx, f.task.id)!;
  expect(pending.state).toBe("running");
  expect(pending.stopPending).toBeDefined();
  const run = pending.run!;
  const grant = { taskId: f.task.id, attempt: 1, providerId: "pacer-exec-direct",
    requestedAt: pending.stopPending!.requestedAt, graceMs: pending.stopPending!.graceMs,
    dir: run.dir, startedAt: run.startedAt };
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [], remoteStop: grant },
    { deadlineMs: Date.now() + 120_000, grants: ["hosts"] });
  try {
    const stopped = await answerOwnedRemoteStop(authority,
      { taskId: f.task.id, attempt: 1, graceMs: grant.graceMs });
    expect(stopped.code).toBeNumber();
    await expect(answerOwnedRemoteStop(authority,
      { taskId: f.task.id, attempt: 1, graceMs: grant.graceMs }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(f.ctx, f.task.id)?.executorExitReceipt?.exitCode).toBe(stopped.code);
  } finally { await authority.revoke(); }
  const settled = await superviseTask(f.ctx, f.task.id, () => undefined);
  expect(settled?.state).toBe("stopped");
  expect(settled?.stopPending).toBeUndefined();
}, 60_000);

test("production remote owner publishes placement, starts once and verifies its exit", async () => {
  const f = await fixture();
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat >/dev/null\necho production-remote-done > DONE.txt\n" +
    "git add DONE.txt\ngit commit -q -m fixture\necho production-remote-done\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const cfg = loadStrategy(f.ctx).providers["codex@box"]!;
  const out = await runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("production-remote-done");
  expect(readTask(f.ctx, f.task.id)?.executorExitReceipt).toMatchObject({
    attempt: 1, providerId: "pacer-exec-direct", exitCode: 0 });
  expect(readTask(f.ctx, f.task.id)?.run?.host).toBe("box");
  const unissued = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  try {
    await expect(answerOwnedRemoteTransfer(unissued, { taskId: f.task.id, attempt: 1 }))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await unissued.revoke(); }
}, 60_000);

test("lost provider transfer reply reuses the same admitted branch and remote run", async () => {
  const f = await fixture();
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat >/dev/null\necho once > ONCE.txt\n" +
    "git add ONCE.txt\ngit commit -q -m fixture\necho transferred\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const cfg = loadStrategy(f.ctx).providers["codex@box"]!;
  const registry = pluginRegistry(f.ctx);
  const lost = { call: async (...args: Parameters<typeof registry.call>) => {
    await registry.call(...args);
    throw Error("provider reply lost after transfer");
  } };
  await expect(runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!, lost))
    .rejects.toThrow("provider reply lost");
  const prior = readTask(f.ctx, f.task.id)!;
  expect(prior.remoteTransferIntent?.branch).toBe(`pacer/${f.task.id}`);
  expect(prior.run?.transferredHead).toMatch(/^[a-f0-9]{40}$/);
  updateTask(f.ctx, f.task.id, current => { delete current.run?.transferredHead; });
  const recovered = await runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!);
  expect(recovered.worktree).toBeDefined();
  expect(readTask(f.ctx, f.task.id)?.remoteTransferIntent).toEqual(prior.remoteTransferIntent);
  expect(readTask(f.ctx, f.task.id)?.run?.transferredHead).toBe(prior.run?.transferredHead);
  const forged = { call: async (...args: Parameters<typeof registry.call>) => {
    const actual = await registry.call<Record<string, unknown>>(args[0], args[1], args[2], args[3], args[4]);
    return { ...actual, worktree: f.repo };
  } };
  await expect(runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!, forged))
    .rejects.toMatchObject({ code: "conflict" });
  const forgedStatus = { call: async (...args: Parameters<typeof registry.call>) => {
    const actual = await registry.call<Record<string, unknown>>(args[0], args[1], args[2], args[3], args[4]);
    return { ...actual, exec: { ...(actual.exec as object), timedOut: true } };
  } };
  await expect(runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!, forgedStatus))
    .rejects.toMatchObject({ code: "conflict" });
  const omittedTransfer = { call: async (...args: Parameters<typeof registry.call>) => {
    const actual = await registry.call<Record<string, unknown>>(args[0], args[1], args[2], args[3], args[4]);
    updateTask(f.ctx, f.task.id, current => { delete current.run?.transferredHead; });
    const { worktree: _discard, ...withoutWorktree } = actual;
    return withoutWorktree;
  } };
  await expect(runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!, omittedTransfer))
    .rejects.toMatchObject({ code: "conflict" });
  const log = readFileSync(join(f.ctx.home, "..", "ssh.log"), "utf8");
  expect(log.match(/START/g)?.length).toBe(1);
}, 60_000);

test("failed remote exit with no commits requires host-recorded no-work preflight", async () => {
  const f = await fixture();
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat >/dev/null\necho failed >&2\nexit 2\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => { delete current.remotePrepareIntent; });
  const cfg = loadStrategy(f.ctx).providers["codex@box"]!;
  const out = await runOwnedDirectRemote(f.ctx, cfg, readTask(f.ctx, f.task.id)!);
  expect(out.exec.code).toBe(2);
  expect(out.worktree).toBeUndefined();
  expect(readTask(f.ctx, f.task.id)?.remoteTransferNoWork).toMatchObject({
    attempt: 1, providerId: "pacer-exec-direct", exitCode: 2 });
}, 60_000);

test("task runner selects provider-owned remote pipe without built-in SSH fallback", async () => {
  const f = await fixture();
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    accounts: { codex: { kind: "codex" }, "claude-code": { kind: "claude" } },
    planner: "claude-code", hosts: { box: f.host }, routing: [{ default: ["codex@box"] }] }));
  writeFileSync(join(f.bin, "codex"), "#!/bin/sh\ncat >/dev/null\necho routed > ROUTED.txt\n" +
    "git add ROUTED.txt\ngit commit -q -m fixture\necho routed-remote\n", { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(f.bin, "setsid"),
    `#!${Bun.which("python3")}\nimport os,sys\nos.setsid()\nos.execvp(sys.argv[1],sys.argv[1:])\n`, { mode: 0o755 });
  updateTask(f.ctx, f.task.id, current => {
    current.state = "queued"; delete current.executor; delete current.executorProvider;
    delete current.remotePrepareIntent;
  });
  const deps = {
    loadStrategy,
    computeStatus: async () => ({ generatedAt: f.ctx.now, strategy: "default", planner: "claude-code",
      mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
      providers: [{ id: "codex@box", eligibility: eligibility(), usage: "quota" as const,
        windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false }],
      executors: { ranked: [], excluded: [] } }),
    hooks: { ...defaultHooks, taskKind: async () => "research" },
    verifyRepo: async () => ({ files: "(no changes)" }),
  };
  const result = await runTask(f.ctx, f.task.id, deps);
  expect(result.executorProvider).toBe("pacer-exec-direct");
  expect(result.attempts).toHaveLength(1);
  expect(result.run?.host).toBe("box");
  expect(result.result?.report).toContain("routed-remote");
  updateTask(f.ctx, f.task.id, current => {
    current.state = "queued";
    delete current.result;
    delete current.executor;
    delete current.runnerPid;
  });
  const retry = await runTask(f.ctx, f.task.id, deps);
  expect(retry.executorProvider).toBe("pacer-exec-direct");
  expect(retry.attempts).toHaveLength(2);
  expect(retry.run?.attempt).toBe(2);
  expect(retry.startIntent).toMatchObject({ attempt: 2, providerId: "pacer-exec-direct" });
  expect(retry.remoteTransferIntent?.attempt).toBe(2);
  await tasks.review(f.ctx, retry.id, { accepted: true });
}, 90_000);
