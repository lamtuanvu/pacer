import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskWorktreePath } from "../src/supervisor/worktree";
import { transferBack, transferred } from "../src/remote/transfer";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { taskStop } from "../src/tasks/api";
import type { RunRef } from "../src/tasks/types";
import type { HostCfg } from "../src/config/hosts";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";
import { pluginRegistry } from "../src/plugins";

async function setup() {
  const root = tmpDir(), hostHome = join(root, "host"), repo = join(root, "local"), origin = join(root, "origin.git"), checkout = join(hostHome, "src/r");
  mkdirSync(hostHome, { recursive: true });
  writeFileSync(join(hostHome, ".bash_profile"), "echo hello from profile\n");
  const git = async (...args: string[]) => {
    const r = await realRun(["git", ...args], 60000);
    if (r.code) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  await git("init", "--bare", "-q", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "config", "user.email", "test@example.invalid");
  await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  await git("-C", repo, "push", "-q", "origin", "main");
  await git("clone", "-q", origin, checkout);
  await git("-C", checkout, "config", "user.name", "Test");
  await git("-C", checkout, "config", "user.email", "test@example.invalid");
  const env = { ...process.env, ...fakeSshEnv(hostHome, join(root, "ssh.log")) };
  const ctx = fakeCtx({ env, run: (argv, ms, o) => realRun(argv, ms, { ...o, env }),
    which: name => name === "ssh" ? join(import.meta.dir, "fixtures", "bin", "ssh") :
      name === "git" ? "/usr/bin/git" : null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: box-ssh\n");
  const task = createTask(ctx, { brief: { goal: "transfer", repo }, kind: "feature", requestedExecutor: null, timeoutS: 30 });
  const baseSha = await git("-C", repo, "rev-parse", "HEAD"), branch = `pacer/${task.id}`;
  await git("-C", checkout, "checkout", "-q", "-b", branch);
  const host: HostCfg = { alias: "box", ssh: "box-ssh", repos: {}, accounts: {}, maxTasks: 2 };
  const run: RunRef = { dir: root, attempt: 1, executor: "codex@box", startedAt: 0, mode: "new", workdir: checkout, logFile: join(root, "log"), host: "box", remoteWorktree: checkout, baseSha, remoteBranch: branch };
  updateTask(ctx, task.id, record => { record.run = run; });
  const commit = (...args: string[]) => git("-C", checkout, "commit", "-q", "--allow-empty", ...args);
  return { ctx, task, host, run, git, repo, checkout, branch, commit };
}

// Real Git repositories and SSH scripts can exceed the default 5 s under suite load.
test("pre-flight refusals leave local refs untouched", async () => {
  for (const kind of ["author", "committer", "signoff", "non-descendant", "empty", "dirty", "501"]) {
    const f = await setup();
    let reason: string;
    if (kind === "author") {
      await f.commit("--author", "Foreign <foreign@example.invalid>", "-m", "foreign");
      reason = "claimed bundle contains foreign commit identity";
    } else if (kind === "committer") {
      await f.git("-C", f.checkout, "config", "user.email", "foreign@example.invalid");
      await f.commit("--author", "Test <test@example.invalid>", "-m", "foreign");
      reason = "claimed bundle contains foreign commit identity";
    } else if (kind === "signoff") {
      await f.commit("-m", "result\n\nSigned-off-by: Foreign <foreign@example.invalid>");
      reason = "claimed bundle contains foreign sign-off identity";
    } else if (kind === "non-descendant") {
      await f.git("-C", f.checkout, "checkout", "-q", "--orphan", "other");
      await f.commit("-m", "other");
      await f.git("-C", f.checkout, "branch", "-f", f.branch, "HEAD");
      await f.git("-C", f.checkout, "checkout", "-q", f.branch);
      reason = "remote preflight has no clean descendant head";
    } else if (kind === "empty") reason = "remote preflight has no clean descendant head";
    else if (kind === "dirty") {
      await f.commit("-m", "result");
      writeFileSync(join(f.checkout, "dirty.txt"), "dirty");
      reason = "remote preflight has no clean descendant head";
    } else {
      // Build the real history in one process instead of spawning 501 commits under suite load.
      const history = Array.from({ length: 501 }, (_, i) => {
        const message = `commit ${i}`;
        return `commit refs/heads/${f.branch}\nmark :${i + 1}\ncommitter Test <test@example.invalid> 1700000000 +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i === 0 ? f.run.baseSha : `:${i}`}\n\n`;
      }).join("");
      const imported = await realRun(["git", "-C", f.checkout, "fast-import", "--quiet"], 60000, { stdin: history });
      expect(imported.code).toBe(0);
      expect(await f.git("-C", f.checkout, "rev-list", "--count", `${f.run.baseSha}..${f.branch}`)).toBe("501");
      reason = "remote preflight has no clean descendant head";
    }
    expect(await transferBack(f.ctx, f.task, f.host, f.run)).toEqual({ ok: false, reason });
    expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  }
}, 120000);

for (const committed of [false, true]) test(`an earlier local branch ${committed ? "with commits is preserved" : "at base is advanced"}`, async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  await f.git("-C", f.repo, "branch", f.branch);
  if (committed) {
    await f.git("-C", f.repo, "checkout", "-q", f.branch);
    await f.git("-C", f.repo, "commit", "-q", "--allow-empty", "-m", "local result");
    await f.git("-C", f.repo, "checkout", "-q", "main");
  }
  await f.git("-C", f.repo, "worktree", "add", taskWorktreePath(f.ctx, f.repo, f.task.id), f.branch);
  const before = await f.git("-C", f.repo, "rev-parse", f.branch);
  updateTask(f.ctx, f.task.id, t => { t.run = f.run; });
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.branch).toBe(committed ? `${f.branch}-r1` : f.branch);
  const head = await f.git("-C", f.checkout, "rev-parse", "HEAD");
  expect(await f.git("-C", f.repo, "rev-parse", result.branch)).toBe(head);
  if (committed) expect(await f.git("-C", f.repo, "rev-parse", f.branch)).toBe(before);
  expect(readTask(f.ctx, f.task.id)?.run).toHaveProperty("transferredHead", head);
}, 30000);

test("owned transferred detection follows the admitted retry branch and exact run", async () => {
  const f = await setup();
  const branch = `${f.branch}-r1`;
  await f.git("-C", f.repo, "branch", branch);
  const head = await f.git("-C", f.repo, "rev-parse", branch);
  const saved = updateTask(f.ctx, f.task.id, current => {
    current.executorProvider = "pacer-exec-direct";
    current.run!.transferredHead = head;
    current.remoteTransferIntent = { attempt: 1, providerId: "pacer-exec-direct",
      dir: f.run.dir, startedAt: f.run.startedAt, branch, oldHead: "" };
  });
  expect(await transferred(f.ctx, saved)).toBe(true);
  const wrong = updateTask(f.ctx, f.task.id, current => {
    current.remoteTransferIntent!.attempt = 2;
  });
  expect(await transferred(f.ctx, wrong)).toBe(false);
}, 30000);

test("stop during an owned transfer is a conflict until the single admitted branch settles", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const bin = join(f.run.dir, "slow-owned-ssh");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nsleep 0.15\nexec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"\n`,
    { mode: 0o700 });
  f.ctx.which = name => name === "ssh" ? join(bin, "ssh") : name === "git" ? "/usr/bin/git" : null;
  updateTask(f.ctx, f.task.id, current => {
    current.state = "running"; current.executor = f.run.executor;
    current.executorProvider = "pacer-exec-direct";
    current.startIntent = { attempt: 1, providerId: "pacer-exec-direct", dir: f.run.dir };
    current.executorExitReceipt = { attempt: 1, providerId: "pacer-exec-direct",
      dir: f.run.dir, startedAt: f.run.startedAt, exitCode: 0 };
  });
  const transfer = transferBack(f.ctx, f.task, f.host, f.run);
  for (let i = 0; i < 200 && !readTask(f.ctx, f.task.id)?.remoteTransferIntent; i++) await Bun.sleep(10);
  expect(readTask(f.ctx, f.task.id)?.remoteTransferIntent?.branch).toBe(f.branch);
  expect(() => taskStop(f.ctx, f.task.id)).toThrow("remote transfer is in progress");
  const result = await transfer;
  expect(result.ok).toBe(true);
  expect(readTask(f.ctx, f.task.id)?.stopPending).toBeUndefined();
  expect(await f.git("-C", f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/pacer"))
    .toBe(`refs/heads/${f.branch}`);
}, 30000);

test("a clean transfer fetches only pacer/<id> and opens a review worktree", async () => {
  const f = await setup();
  writeFileSync(join(f.checkout, "binary"), Buffer.from([0, 255, 254, 128, 10]));
  await f.git("-C", f.checkout, "add", "binary");
  await f.commit("-m", "result\n\nSigned-off-by: Test <test@example.invalid>");
  await f.git("-C", f.checkout, "tag", "do-not-fetch");
  const before = (await f.git("-C", f.repo, "for-each-ref", "--format=%(refname)")).split("\n");
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.branch).toBe(f.branch);
  expect(result.commits).toBe(1);
  const after = (await f.git("-C", f.repo, "for-each-ref", "--format=%(refname)")).split("\n");
  expect(after.filter(r => !before.includes(r))).toEqual([`refs/heads/${f.branch}`]);
  expect(await f.git("-C", result.reviewWorktree, "rev-parse", "HEAD")).toBe(await f.git("-C", f.checkout, "rev-parse", "HEAD"));
  expect(Buffer.from(await Bun.file(join(result.reviewWorktree, "binary")).arrayBuffer())).toEqual(Buffer.from([0, 255, 254, 128, 10]));
  expect(readdirSync(join(f.ctx.pacerHome, "tasks")).filter(name => name.startsWith(`${f.task.id}.`) && name.endsWith(".bundle"))).toEqual([]);
});

test("disabling the bundled remote caller fails closed without a direct SSH transfer", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  await pluginRegistry(f.ctx).disable(f.ctx, "pacer-remote-caller");
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result).toEqual({ ok: false, reason: "bundled remote caller plugin is unavailable" });
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  expect(readdirSync(join(f.ctx.pacerHome, "tasks")).filter(name => name.startsWith(`${f.task.id}.`) && name.endsWith(".bundle"))).toEqual([]);
});

test("stale caller repository cannot redirect a verified transfer", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const other = join(f.run.dir, "other-repo");
  await f.git("clone", "-q", join(f.run.dir, "origin.git"), other);
  await f.git("-C", other, "config", "user.name", "Test");
  await f.git("-C", other, "config", "user.email", "test@example.invalid");
  updateTask(f.ctx, f.task.id, record => { record.brief.repo = other; });
  expect(await transferBack(f.ctx, f.task, f.host, f.run))
    .toEqual({ ok: false, reason: "remote transfer task or run changed" });
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  expect(await f.git("-C", other, "for-each-ref", "refs/heads/pacer")).toBe("");
});

test("a task revision during immutable bundle import cannot publish a branch", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const originalWhich = f.ctx.which;
  let changed = false;
  f.ctx.which = name => {
    if (name === "git" && !changed && readdirSync(join(f.ctx.pacerHome, "tasks"))
      .some(file => file.startsWith(`${f.task.id}.`) && file.endsWith(".bundle"))) {
      changed = true;
      updateTask(f.ctx, f.task.id, record => { record.run!.remoteWorktree = "/remote/changed"; });
    }
    return originalWhich(name);
  };
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(changed).toBe(true);
  expect(result.ok).toBe(false);
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  expect(readTask(f.ctx, f.task.id)?.run?.transferredHead).toBeUndefined();
});

test("private bundle cleanup failure precedes branch publication", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const originalWhich = f.ctx.which;
  let replacement: string | undefined;
  f.ctx.which = name => {
    if (name === "git" && !replacement) {
      const bundle = readdirSync(join(f.ctx.pacerHome, "tasks"))
        .find(file => file.startsWith(`${f.task.id}.`) && file.endsWith(".bundle"));
      if (bundle) {
        replacement = join(f.ctx.pacerHome, "tasks", bundle);
        renameSync(replacement, `${replacement}.moved`);
        writeFileSync(replacement, "replacement", { mode: 0o600 });
      }
    }
    return originalWhich(name);
  };
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(replacement).toBeDefined();
  expect(result.ok).toBe(false);
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  expect(readTask(f.ctx, f.task.id)?.run?.transferredHead).toBeUndefined();
  expect(readFileSync(replacement!, "utf8")).toBe("replacement");
});

test("broker rollback never returns a stale diagnostic bundle path", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const bin = join(f.run.dir, "mismatch-bin"), ssh = join(bin, "ssh");
  mkdirSync(bin);
  const originalSsh = join(import.meta.dir, "fixtures", "bin", "ssh");
  writeFileSync(ssh, `#!/bin/sh\ncase "$*" in\n  *"git merge-base"*) printf '__PACER_BEGIN__\\nancestor=1\\ndirty=0\\ncommits=1\\nhead=${"c".repeat(40)}\\n' ;;\n  *) exec '${originalSsh}' "$@" ;;\nesac\n`, { mode: 0o700 });
  f.ctx.which = name => name === "ssh" ? ssh : name === "git" ? "/usr/bin/git" : null;
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty("bundle");
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
  expect(readdirSync(join(f.ctx.pacerHome, "tasks")).filter(name => name.startsWith(`${f.task.id}.`) && name.endsWith(".bundle"))).toEqual([]);
});

test("a retained bundle from a prior attempt does not block a fresh transfer", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const prior = join(f.ctx.pacerHome, "tasks", `${f.task.id}.prior.bundle`);
  writeFileSync(prior, "retained previous verification failure", { mode: 0o600 });
  const result = await transferBack(f.ctx, f.task, f.host, f.run);
  expect(result.ok).toBe(true);
  expect(readFileSync(prior, "utf8")).toBe("retained previous verification failure");
}, 30000);

test("a timed-out host fetch leaves no published artifact or local ref", async () => {
  const f = await setup();
  await f.commit("-m", "remote result");
  const bin = join(f.run.dir, "timeout-bin");
  mkdirSync(bin);
  const originalSsh = join(import.meta.dir, "fixtures", "bin", "ssh");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\ncase "$*" in\n  *"git merge-base"*) exec '${originalSsh}' "$@" ;;\nesac\nprintf '__PACER_BEGIN__\\n'\nsleep 5\n`, { mode: 0o700 });
  f.ctx.env = { ...f.ctx.env, PATH: `${bin}:${f.ctx.env.PATH ?? ""}` };
  f.ctx.which = name => name === "ssh" ? join(bin, "ssh") : name === "git" ? "/usr/bin/git" : null;
  const result = await transferBack(f.ctx, f.task, f.host, f.run, 40);
  expect(result).toEqual({ ok: false, reason: "host fetch expired" });
  expect(readdirSync(join(f.ctx.pacerHome, "tasks")).filter(name => name.startsWith(`${f.task.id}.`) && name.endsWith(".bundle"))).toEqual([]);
  expect(await f.git("-C", f.repo, "for-each-ref", "refs/heads/pacer")).toBe("");
}, 30000);
