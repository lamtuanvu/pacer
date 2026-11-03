import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearTerminalEnvCache } from "../src/exec/login-env";
import { runnerLogPath, spawnRunner } from "../src/tasks/api";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx, fakeLoginShell, tmpDir, withLoginIndicators } from "./helpers";

afterEach(clearTerminalEnvCache);

const cli = join(import.meta.dir, "..", "src", "cli.ts");

// A login profile that sets a umask and NO_COLOR gives the launch plan umask and keepColor;
// the run claim must carry both, or the provider route refuses the launch and the runner exits.
test("a detached runner launches a local claude-code attempt through the direct executor provider", async () => {
  const root = tmpDir(), bin = join(root, "profile-bin"), repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho hello > greeting.txt\nexec bun ${JSON.stringify(cli)} report --task "$PACER_TASK_ID" --outcome done --summary greeted\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const shell = fakeLoginShell(root, `export PATH="${bin}:${dirname(process.execPath)}:$PATH" NO_COLOR=1\numask 027`);
  const ctx = withLoginIndicators(fakeCtx());
  mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: codex\nproviders:\n  codex: {}\n  claude-code: {}\nrouting:\n  - default: [claude-code]\n");
  ctx.env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.home, SHELL: shell, PACER_HOME: ctx.pacerHome,
    PACER_LOGIN_ENV: "on", PACER_BACKEND: "direct", PACER_NO_UPDATE_CHECK: "1" };
  for (const argv of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]])
    expect(Bun.spawnSync(["git", "-C", repo, ...argv]).exitCode).toBe(0);
  const task = createTask(ctx, { brief: { goal: "Create greeting.txt containing hello", repo, acceptance: "grep -q hello greeting.txt" },
    kind: null, requestedExecutor: "claude-code", timeoutS: 120 });

  // The production launcher re-invokes this pacer from argv; point it at the source CLI.
  const argv = process.argv;
  process.argv = [process.execPath, cli];
  let pid: number | undefined;
  try { pid = spawnRunner(ctx, task.id); } finally { process.argv = argv; }
  expect(pid).toBeGreaterThan(0);
  const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 60_000;
  while (alive() && Date.now() < deadline) await Bun.sleep(100);
  if (alive()) process.kill(-pid!, "SIGKILL");

  const log = existsSync(runnerLogPath(ctx)) ? readFileSync(runnerLogPath(ctx), "utf8") : "";
  const done = readTask(ctx, task.id)!;
  expect({ state: done.state, log }).toEqual({ state: "done", log: expect.not.stringContaining("attempt failed") });
  expect(done.executorProvider).toBe("pacer-exec-direct");
  expect(done.attempts).toHaveLength(1);
  expect(readFileSync(join(done.run!.workdir, "greeting.txt"), "utf8").trim()).toBe("hello");
}, 90_000);
