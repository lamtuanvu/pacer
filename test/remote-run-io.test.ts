import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteRunIO } from "../src/remote/run-io";
import { Unreachable, type RunIO } from "../src/supervisor/io";
import { readRun, type RunState } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
function setup() {
  const home = tmpDir(), local = tmpDir(), log = join(tmpDir(), "ssh.log");
  writeFileSync(join(home, ".bash_profile"), "echo hello from profile\n");
  const env = fakeSshEnv(home, log);
  // macOS has no setsid utility; provide the same session semantics on the fake host.
  if (!Bun.which("setsid")) {
    const bin = join(home, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  const ctx = fakeCtx({ run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env } }) });
  const remote = join(home, ".pacer-remote/runs/t/1");
  return { io: new RemoteRunIO(ctx, host, remote, local), home, remote, local, log };
}
async function exited(io: RemoteRunIO): Promise<RunState> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const s = await io.read();
    if (s.exit !== null) return s;
    await Bun.sleep(50);
  }
  throw new Error("remote run did not exit");
}

test("a remote run starts detached, mirrors output and records its exit", async () => {
  const { io, home, local } = setup();
  expect(await io.start(["sh", "-c", "echo one; sleep 1; echo two; exit 3"], home, {}, "")).toHaveProperty("pid");
  const s = await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("one\ntwo\n");
  expect(s.exit).toBe(3); expect(s.alive).toBe(false);
  expect(readRun(local).exit).toBe(3);
}, 10000);

test("the prompt reaches the host agent unchanged", async () => {
  const { io, home, local, log } = setup();
  const prompt = `hostile-brief '" $(touch "$HOME/pwned") \`id\`\nline two\n__PACER_STDIN__\nlast line`;
  expect(await io.start(["sh", "-c", "cat"], home, {}, prompt)).toHaveProperty("pid");
  await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt);
  expect(readFileSync(log, "utf8")).not.toContain("hostile-brief");
  expect(existsSync(join(home, "pwned"))).toBe(false);
}, 10000);

test("stop terminates the remote process group", async () => {
  const { io, home, remote } = setup();
  expect(await io.start(["sh", "-c", 'trap "" TERM; echo ready; sleep 30'], home, {}, "")).toHaveProperty("pid");
  while (!(await io.read()).stdoutBytes) await Bun.sleep(50);
  const started = Date.now();
  expect(await io.stop({ graceMs: 1000, sleep: Bun.sleep })).toEqual({ code: 137, killed: true });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(readFileSync(join(remote, "exit"), "utf8").trim()).toBe("137");
}, 10000);

test("unreachable polls keep the run until the grace ends", async () => {
  let calls = 0, now = 0;
  const state: RunState = { pid: 1, startedAt: 1, exit: 3, alive: false, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  const io: RunIO = { read: async () => { if (++calls <= 3) throw new Unreachable("box"); return state; }, stop: async () => { throw new Error("must not stop unreachable run"); } };
  const options = { io, deadlineMs: 10000, isStopped: () => false, pollMs: 10, now: () => now, sleep: async (ms: number) => { now += ms; }, unreachableGraceMs: 50 };
  expect(await supervise(options)).toEqual({ kind: "exited", code: 3 });
  io.read = async () => { throw new Unreachable("box"); };
  expect(await supervise(options)).toEqual({ kind: "lost", code: 137 });
});

test("mirrors capped byte chunks without losing a split UTF-8 character", async () => {
  const { io, home, remote, local } = setup();
  expect(await io.start(["sh", "-c", "exit 0"], home, {}, "")).toHaveProperty("pid");
  await exited(io);
  const output = "a".repeat(262143) + "🦊" + "z";
  writeFileSync(join(remote, "stdout"), output);
  const first = await io.read();
  expect(readFileSync(join(local, "stdout")).length).toBe(262144);
  expect(first.exit).toBeNull();
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(output);
}, 10000);

test("a failed SSH poll is unreachable and does not erase the local record", async () => {
  const local = tmpDir(); writeFileSync(join(local, "stdout"), "kept\n");
  const env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "box-ssh");
  const ctx = fakeCtx({ run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env } }) });
  const io = new RemoteRunIO(ctx, host, "~/.pacer-remote/runs/t/1", local);
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("kept\n");
});

test("read reports remote command failures as unreachable, and stop on an unreachable host ends quietly", async () => {
  const { RemoteRunIO } = await import("../src/remote/run-io");
  const { Unreachable } = await import("../src/supervisor/io");
  const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
  const failing = (code: number) => ({ ...fakeCtx(), run: async () => ({ code, stdout: "", stderr: "boom" }) });
  expect(await new RemoteRunIO(failing(1), host, "~/r", tmpDir()).read().catch((e) => e)).toBeInstanceOf(Unreachable);
  expect(await new RemoteRunIO(failing(255), host, "~/r", tmpDir()).stop({ graceMs: 1000, sleep: async () => {} })).toEqual({ code: 137, killed: false });
});
