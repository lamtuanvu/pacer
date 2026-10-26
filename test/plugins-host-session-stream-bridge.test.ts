import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { issueConfiguredHostSessionStream } from "../src/plugins/host-session-stream-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

test("host streams one persisted full-session run through the bundled provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-session-stream-bridge-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), ssh = join(bin, "ssh");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(ssh, "#!/bin/sh\nprintf '__PACER_BEGIN__\\nviewer output'\n", { mode: 0o755 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    session: full\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? ssh : null });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled caller"); }, eventPumpMs: 0 });
  try {
    const task = createTask(ctx, { brief: { goal: "view", repo: home }, kind: null,
      requestedExecutor: null, timeoutS: 60 });
    const local = join(pacerHome, "runs", task.id, "1");
    const remote = `/remote/.pacer-remote/runs/${task.id}/1`;
    updateTask(ctx, task.id, record => { record.state = "running";
      record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
        workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box",
        startedAt: 1, logFile: "unused" }; });
    await registry.enable(ctx, "pacer-ssh", true);
    const output: Buffer[] = [], controller = new AbortController();
    await expect(registry.call(ctx, "pacer-ssh", "hostRunner.stream",
      { session: "a".repeat(32), script: "SESSION_PIPE", args: [remote], timeoutMs: 60_000,
        maxBytes: 65_536, streamId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" },
      { deadlineMs: 0, signal: controller.signal, onStreamProgress: async () => {}, onStreamReady: () => {} }))
      .rejects.toMatchObject({ code: "capability_denied" });
    const grant = issueConfiguredHostSessionStream(ctx, "box", remote, local);
    const stream = await registry.streamConfiguredHost(ctx, grant,
      async bytes => { output.push(Buffer.from(bytes)); }, controller.signal);
    expect(await stream.done).toEqual({ code: 0, bytes: 13 });
    expect(Buffer.concat(output).toString()).toBe("viewer output");
    await expect(registry.streamConfiguredHost(ctx, grant, async () => {}, controller.signal))
      .rejects.toMatchObject({ code: "capability_denied" });
    let entered!: () => void, release!: () => void;
    const consuming = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const next = await registry.streamConfiguredHost(ctx,
      issueConfiguredHostSessionStream(ctx, "box", remote, local), async () => {
        entered(); await blocked;
      }, controller.signal);
    await consuming;
    updateTask(ctx, task.id, record => { record.run!.remoteDir = `/remote/.pacer-remote/runs/${task.id}/2`; });
    release();
    await expect(next.done).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

test("viewer cancellation retires the pinned SSH child without a direct fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-session-cancel-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), ssh = join(bin, "ssh");
  const pidFile = join(home, "ssh.pid"), providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 30\n`, { mode: 0o755 });
  writeFileSync(join(pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n    session: full\n");
  const ctx = fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? ssh : null });
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled caller"); }, eventPumpMs: 0 });
  try {
    const task = createTask(ctx, { brief: { goal: "view", repo: home }, kind: null,
      requestedExecutor: null, timeoutS: 60 });
    const local = join(pacerHome, "runs", task.id, "1");
    const remote = `/remote/.pacer-remote/runs/${task.id}/1`;
    updateTask(ctx, task.id, record => { record.state = "running";
      record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
        workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box",
        startedAt: 1, logFile: "unused" }; });
    await registry.enable(ctx, "pacer-ssh", true);
    const controller = new AbortController();
    const stream = await registry.streamConfiguredHost(ctx,
      issueConfiguredHostSessionStream(ctx, "box", remote, local), async () => {}, controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    controller.abort();
    await expect(stream.done).rejects.toMatchObject({ code: "plugin_unavailable" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await Bun.sleep(10); }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
