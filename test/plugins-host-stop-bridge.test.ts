import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { issueConfiguredHostStop } from "../src/plugins/host-stop-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { releaseReservation, reserveIdle } from "../src/update/desktop/admission";
import { fakeCtx, realRun, folderPlugins } from "./helpers";

test("host-issued STOP is one-use and leaves ambiguous completion unsettled", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-stop-bridge-"));
  const pacerHome = join(home, ".pacer"), bin = join(home, "bin"), ssh = join(bin, "ssh"), log = join(home, "ssh.log");
  const providerDir = join(pacerHome, "plugins", "pacer-ssh");
  mkdirSync(providerDir, { recursive: true }); mkdirSync(bin, { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  for (const file of ["index.ts", "manifest.ts", "probe.ts", "session-stream.ts", "pacer-plugin.json"])
    copyFileSync(join(import.meta.dir, "..", "plugins", "pacer-ssh", file), join(providerDir, file));
  chmodSync(join(providerDir, "index.ts"), 0o755);
  const success = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nnonce=$(printf '%s' "$*" | sed -n 's/.*__PACER_DONE__=\\([a-f0-9-]*\\).*/\\1/p')\nprintf '__PACER_BEGIN__\\ncode=137\\nkilled=1\\n\\n__PACER_DONE__=%s\\n' "$nonce"\n`;
  writeFileSync(ssh, success); chmodSync(ssh, 0o755);
  const registry = new PluginRegistry(folderPlugins([providerDir]));
  try {
    writeFileSync(join(pacerHome, "strategy.yaml"),
      "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
    const ctx = fakeCtx({ home, pacerHome, run: realRun,
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
      which: name => name === "ssh" ? ssh : null });
    const task = createTask(ctx, { brief: { goal: "run", repo: home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const local = join(pacerHome, "runs", task.id, "1"), remote = `/remote/.pacer-remote/runs/${task.id}/1`;
    updateTask(ctx, task.id, record => { record.state = "running";
      record.run = { host: "box", mode: "new", remoteDir: remote, remoteWorktree: "/remote/worktree",
        workdir: "/remote/worktree", dir: local, attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
    await registry.enable(ctx, "pacer-ssh", true);
    await expect(registry.call(ctx, "pacer-ssh", "hostRunner.run", {
      session: "a".repeat(32), script: "STOP", args: [remote, "5"], timeoutMs: 15_000,
      maxBytes: 65_536, completionNonce: "123e4567-e89b-42d3-a456-426614174000",
    })).rejects.toMatchObject({ code: "capability_denied" });
    const grant = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    const result = await registry.stopConfiguredHost(ctx, grant);
    expect(result).toEqual({ code: 0, stdout: "code=137\nkilled=1\n", stderr: "", timedOut: false });
    expect(readFileSync(log, "utf8")).toContain("BatchMode=yes");
    await expect(registry.stopConfiguredHost(ctx, grant)).rejects.toMatchObject({ code: "capability_denied" });
    const clear = await reserveIdle(ctx, "123e4567-e89b-42d3-a456-426614174001");
    expect(clear.blockers.some(blocker => blocker.label === "Remote stop operation on box")).toBe(false);
    if (clear.reserved) await releaseReservation(ctx, "123e4567-e89b-42d3-a456-426614174001");
    await registry.disable(ctx, "pacer-ssh");
    const before = readFileSync(log, "utf8"), disabled = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    await expect(registry.stopConfiguredHost(ctx, disabled)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(readFileSync(log, "utf8")).toBe(before);
    await registry.enable(ctx, "pacer-ssh", true);
    writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '__PACER_BEGIN__\\ncode=137\\nkilled=1\\n'\n`);
    chmodSync(ssh, 0o755);
    const ambiguous = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    await expect(registry.stopConfiguredHost(ctx, ambiguous)).rejects.toMatchObject({ code: "plugin_refused" });
    const blocked = await reserveIdle(ctx, "123e4567-e89b-42d3-a456-426614174002");
    expect(blocked.reserved).toBe(false);
    expect(blocked.blockers.some(blocker => blocker.label === "Remote stop operation on box")).toBe(true);
    writeFileSync(ssh, success); chmodSync(ssh, 0o755);
    const later = issueConfiguredHostStop(ctx, "box", remote, local, 5);
    expect((await registry.stopConfiguredHost(ctx, later)).code).toBe(0);
    const stillBlocked = await reserveIdle(ctx, "123e4567-e89b-42d3-a456-426614174003");
    expect(stillBlocked.reserved).toBe(false);
    expect(stillBlocked.blockers.some(blocker => blocker.label === "Remote stop operation on box")).toBe(true);
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});
