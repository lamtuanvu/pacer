import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { loadStrategy } from "../src/config/strategy";
import { issueConfiguredHostPrepareRecover, consumeConfiguredHostPrepareRecover } from "../src/plugins/host-prepare-recover-issuer";
import { issueConfiguredHostPrepare } from "../src/plugins/host-prepare-issuer";
import { pluginRegistry } from "../src/plugins";

async function fixture() {
  const root = tmpDir(), repo = join(root, "repo"), home = join(root, "home"), hostHome = join(root, "host");
  mkdirSync(repo); mkdirSync(home); mkdirSync(hostHome);
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
  const origin = "https://example.invalid/o/r";
  await git("remote", "add", "origin", origin);
  const baseSha = await git("rev-parse", "HEAD");
  const sshEnv = fakeSshEnv(hostHome, join(root, "ssh.log"));
  const env = { ...process.env, ...sshEnv };
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env,
    which: name => name === "ssh" ? join(import.meta.dir, "fixtures", "bin", "ssh") : Bun.which(name),
    run: (argv, ms, options) => realRun(argv, ms, { ...options, env: { ...env, ...options?.env } }) });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const host = { ssh: "box-ssh", repos: { "example.invalid/o/r": "~/repo" }, accounts: {}, max_tasks: 1 };
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
  return { ctx, task, host, repo, baseSha, tag, hostHome };
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
});
