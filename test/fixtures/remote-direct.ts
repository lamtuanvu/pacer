import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../../src/config/strategy";
import { createTask, updateTask } from "../../src/tasks/store";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "../helpers";

async function remoteDirectFixture() {
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
    which: name => name === "ssh" ? join(import.meta.dir, "bin", "ssh") : Bun.which(name),
    run: (argv, ms, options) => realRun(argv, ms, { ...options, env: { ...env, ...options?.env } }) });
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  const host = { ssh: "box-ssh", repos: { "example.invalid/o/r": "~/repo",
    "example.invalid/o/s": "~/other" }, accounts: {}, max_tasks: 1 };
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ execution: { launch_mode: "headless" }, accounts: { codex: { kind: "codex" } },
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

export { remoteDirectFixture };