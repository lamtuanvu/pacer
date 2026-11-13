import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installKeychainStub } from "../scripts/live/keychain";
import { taskStop } from "../src/tasks/api";
import { readTask } from "../src/tasks/store";
import { TERMINAL_STATES } from "../src/tasks/types";
import { fakeCtx, gitRepo } from "./helpers";
import { alive, front, frontEnv, freePort, makeHome, type Home, type Reply, spawnServe } from "./native-plugin-door";
import { closedPort } from "./pinned-port";

// Serve's supervision stops an orphaned direct-executor attempt (its `_run` runner gone, its executor still
// running) with a one-use detached stop grant. With the native owner (PACER_NATIVE_PLUGIN_HOST=1) Core keeps
// that grant and answers the plugin's `capability.process.stopRun` itself, exactly as flag-off (ADR 0027).

const script = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/** Codex records its pid, reads the prompt and runs until it is stopped. */
const LONG_CODEX = `case "$1" in
  --version) echo "codex-cli 0.50.0";;
  exec) echo "codex $*" >> "$HOME/codex.log"; echo $$ > "$HOME/codex.pid"; cat > /dev/null; exec sleep 150;;
  *) echo "codex $*" >> "$HOME/codex.log"; case "$*" in *app-server*) read -r _;; esac; exit 1;;
esac`;

function stopHome(): Home & { bin: string } {
  const h = makeHome(), bin = join(h.home, "bin");
  installKeychainStub(bin, join(h.home, "keychain"));
  symlinkSync(process.execPath, join(bin, "bun"));
  // The run wrapper's liveness check runs `ps`; use the one this test resolves (a sandbox may shim the setuid one).
  symlinkSync(Bun.which("ps")!, join(bin, "ps"));
  script(bin, "codex", LONG_CODEX);
  script(bin, "claude", `case "$1" in --version) echo "2.1.0 (Claude Code)";; *) exit 1;; esac`);
  for (const stub of ["launchctl", "systemctl"]) script(bin, stub, "exit 1");
  writeFileSync(join(h.state, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {session: headless}\n", { mode: 0o600 });
  mkdirSync(join(h.home, ".codex"), { recursive: true });
  writeFileSync(join(h.home, ".codex", "auth.json"), "{}");
  return { ...h, bin };
}

/** `pacer serve` on its own port, with the native owner on (`"1"`) or off (`"0"`). */
async function door(h: Home & { bin: string }, nativeHost: "0" | "1") {
  const port = freePort();
  const { child, logs } = spawnServe(h, "", { nativeHost, env: {
    PATH: `${h.bin}:/usr/bin:/bin`, PACER_PORT: String(port),
    PACER_TEST_LOCAL_SERVER_PORTS: `${closedPort()},${closedPort()}`, OLLAMA_HOST: `127.0.0.1:${closedPort()}`,
  } }, port);
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let i = 0; ; i++) {
    try {
      token = readFileSync(join(h.state, "token"), "utf8").trim();
      if ((await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* Wait for this child only. */ }
    if (child.exitCode !== null || i > 750) { child.kill("SIGKILL"); throw Error(`serve did not start:\n${await logs}`); }
    await Bun.sleep(20);
  }
  return {
    async call(op: string, params: unknown): Promise<Reply> {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(60000) });
      const line = await response.text();
      return { line, text: line.slice(1, -1), json: JSON.parse(line) };
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        if (await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung")]) === "hung") child.kill("SIGKILL");
        await child.exited;
      }
      return await logs;
    },
  };
}

async function poll<T>(read: () => T, done: (value: T) => boolean, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}

function processes(match: (command: string) => boolean) {
  return Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n")
    .map(line => line.trim().split(/\s+/)).filter(([pid, ...command]) => pid && match(command.join(" "))).map(([pid]) => Number(pid));
}

/**
 * A flag-off serve launches a direct codex attempt; its runner is killed and the serve stopped, leaving the
 * executor running. With no service up the user's stop is recorded, then a serve in the mode under test
 * reconciles the orphan. (Flag-on serve launches it the same way once runners stop inheriting the owner socket.)
 */
async function orphanStop(nativeHost: "0" | "1") {
  const h = stopHome(), repo = gitRepo(), ctx = fakeCtx({ home: h.home, pacerHome: h.state });
  const pidFile = join(h.home, "codex.pid");
  let id = "", serve: Awaited<ReturnType<typeof door>> | undefined, logs = "";
  try {
    serve = await door(h, "0");
    const reply = await serve.call("task.delegate", { goal: "Write a note", repo, executor: "codex", difficulty: "simple" });
    expect(reply.json.error, reply.line).toBeUndefined();
    id = reply.json.result.task_id;
    await poll(() => existsSync(pidFile), started => started, 60000);
    const codex = Number(readFileSync(pidFile, "utf8").trim());
    for (const pid of processes(command => command.includes(`_run ${id}`))) process.kill(pid, "SIGKILL");
    await poll(() => alive(readTask(ctx, id)!.runnerPid!), up => !up, 10000);
    logs += await serve.stop();
    serve = undefined;
    const orphaned = { running: readTask(ctx, id)?.state === "running", codex: alive(codex) };
    expect(taskStop(ctx, id)?.stopPending?.reason).toBe("user");
    serve = await door(h, nativeHost);
    const task = await poll(() => readTask(ctx, id), value => TERMINAL_STATES.includes(value?.state ?? "queued"), 45000);
    logs += await serve.stop();
    serve = undefined;
    return { orphaned, state: task?.state, exitCode: task?.attempts[0]?.exitCode ?? null, report: task?.result?.report ?? null,
      codexAlive: alive(codex), reconcileErrors: logs.split("\n").filter(line => line.includes("stop reconcile failed")) };
  } finally {
    if (serve) await serve.stop();
    if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL"); } catch { /* Already gone. */ }
    if (id) for (const pid of processes(command => command.includes(`_run ${id}`))) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
    rmSync(repo, { recursive: true, force: true });
    h.done();
  }
}

test.skipIf(!front)("serve stops an orphaned direct attempt flag-on as flag-off: stopped/143 and the executor is gone", async () => {
  const off = await orphanStop("0");
  const on = await orphanStop("1");
  console.log(JSON.stringify({ off, on }));
  expect(off).toEqual({ orphaned: { running: true, codex: true }, state: "stopped", exitCode: 143,
    report: "Executor exited after stop was requested", codexAlive: false, reconcileErrors: [] });
  expect(on).toEqual(off);
}, 300000);
