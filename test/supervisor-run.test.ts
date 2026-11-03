import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOutput, readRun, startRun, stopRun } from "../src/supervisor/run";
import { killTree } from "../src/exec/process";
import { tmpDir } from "./helpers";

const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(25); } };
const env = { PATH: process.env.PATH };

test("a run records pid, output and exit code in its directory", async () => {
  const dir = tmpDir(), cwd = tmpDir();
  const r = startRun({ dir, argv: ["sh", "-c", "echo out; echo err >&2; exit 3"], cwd, env });
  expect("pid" in r).toBe(true);
  await until(() => readRun(dir).exit !== null);
  const s = readRun(dir);
  expect(s).toMatchObject({ exit: 3, alive: false, stdoutBytes: 4, stderrBytes: 4 });
  expect(readOutput(dir)).toEqual({ stdout: "out\n", stderr: "err\n" });
  expect(s.lastOutputAt).not.toBeNull();
});

test("stdin is fed from the spec and the cwd is honoured", async () => {
  const dir = tmpDir(), cwd = tmpDir();
  startRun({ dir, argv: ["sh", "-c", "cat; pwd"], cwd, env, stdin: "hello\n" });
  await until(() => readRun(dir).exit !== null);
  expect(readOutput(dir).stdout).toBe(`hello\n${realpathSync(cwd)}\n`);
});

test("a missing command exits 127 with the shell's message", async () => {
  const dir = tmpDir();
  startRun({ dir, argv: ["definitely-not-a-command-xyz"], cwd: tmpDir(), env });
  await until(() => readRun(dir).exit !== null);
  expect(readRun(dir).exit).toBe(127);
  expect(readOutput(dir).stderr).toMatch(/not found/);
});

test("the run survives its starter: the wrapper is its own session leader", async () => {
  const dir = tmpDir();
  const r = startRun({ dir, argv: ["sleep", "2"], cwd: tmpDir(), env }) as { pid: number };
  const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(r.pid)]).stdout.toString().trim();
  expect(Number(ps)).toBe(r.pid);
  expect(readRun(dir).alive).toBe(true);
  await stopRun(dir, { graceMs: 2000 });
});

test("stopRun ends a TERM-respecting run with exit 143", async () => {
  const dir = tmpDir();
  startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env });
  await until(() => readRun(dir).alive);
  expect(await stopRun(dir, { graceMs: 3000 })).toEqual({ code: 143, killed: false });
  expect(readRun(dir).alive).toBe(false);
});

test("stopRun waits for a delayed exit receipt after the owned wrapper dies", async () => {
  const dir = tmpDir(), script = join(dir, "run.sh");
  writeFileSync(script, "#!/bin/sh\ntrap 'exit 143' TERM\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(join(dir, "pid"), String(proc.pid));
  writeFileSync(join(dir, "child"), "0");
  try {
    await until(() => readRun(dir).alive);
    let deadPolls = 0;
    const stopped = await stopRun(dir, { graceMs: 1500, sleep: async ms => {
      if (!readRun(dir).alive && ++deadPolls === 2) writeFileSync(join(dir, "exit"), "143");
      await Bun.sleep(Math.min(ms, 20));
    } });
    expect(stopped).toEqual({ code: 143, killed: false });
    expect(readRun(dir).exit).toBe(143);
  } finally {
    killTree(proc.pid, "SIGKILL");
    await proc.exited;
  }
});

test("stopRun does not forge an exit after the wrapper vanishes", async () => {
  const dir = tmpDir(), script = join(dir, "run.sh");
  writeFileSync(script, "#!/bin/sh\ntrap 'exit 143' TERM\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(join(dir, "pid"), String(proc.pid));
  writeFileSync(join(dir, "child"), "0");
  try {
    await until(() => readRun(dir).alive);
    await expect(stopRun(dir, { graceMs: 200, requireRecordedExit: true }))
      .rejects.toThrow("detached run stop has no recorded exit");
    expect(await stopRun(dir, { graceMs: 200 })).toEqual({ code: 137, killed: false });
    expect(existsSync(join(dir, "exit"))).toBe(false);
  } finally {
    killTree(proc.pid, "SIGKILL");
    await proc.exited;
  }
});

test("stopRun does not signal a process that replaced the wrapper during readiness", async () => {
  const dir = tmpDir(), script = join(dir, "run.sh");
  writeFileSync(script, "#!/bin/sh\ntrap 'exec sleep 30' TERM\nwhile :; do sleep 0.1; done\n", { mode: 0o700 });
  const proc = Bun.spawn(["/bin/sh", script, dir], {
    detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(join(dir, "pid"), String(proc.pid));
  const originalKill = process.kill;
  let replacementReady = false, staleSignals = 0;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (replacementReady && Math.abs(pid) === proc.pid && signal === "SIGTERM") {
      staleSignals++;
      return true;
    }
    return originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    await until(() => readRun(dir).alive);
    let switched = false;
    await expect(stopRun(dir, { graceMs: 500, requireRecordedExit: true, sleep: async ms => {
      if (!switched) {
        switched = true;
        process.kill(proc.pid, "SIGTERM");
        await until(() => !readRun(dir).alive);
        replacementReady = true;
        writeFileSync(join(dir, "child"), "0");
      }
      await Bun.sleep(Math.min(ms, 20));
    } })).rejects.toThrow("detached run stop has no recorded exit");
    expect(await stopRun(dir, { graceMs: 100 })).toEqual({ code: 137, killed: false });
    expect(staleSignals).toBe(0);
    expect(existsSync(join(dir, "exit"))).toBe(false);
  } finally {
    process.kill = originalKill;
    killTree(proc.pid, "SIGKILL");
    await proc.exited;
  }
});

test("stopRun escalates to KILL when TERM is ignored", async () => {
  const dir = tmpDir(), marker = join(tmpDir(), "child");
  startRun({ dir, argv: ["sh", "-c", `trap '' TERM; sleep 30 & echo $! > '${marker}'; trap '' TERM; wait`], cwd: tmpDir(), env });
  await until(() => existsSync(marker));
  const res = await stopRun(dir, { graceMs: 500 });
  expect(res.killed).toBe(true);
  expect(res.code).toBe(137);
  const child = Number(readFileSync(marker, "utf8"));
  await until(() => { try { process.kill(child, 0); return false; } catch { return true; } });
});

test("a reused pid is not mistaken for the wrapper", async () => {
  const dir = tmpDir();
  startRun({ dir, argv: ["true"], cwd: tmpDir(), env });
  await until(() => readRun(dir).exit !== null);
  rmSync(join(dir, "exit"));                       // as if the wrapper died without recording an exit
  const other = Bun.spawn(["sleep", "5"]);         // an unrelated live process now owns the recorded pid
  writeFileSync(join(dir, "pid"), String(other.pid));
  expect(readRun(dir).alive).toBe(false);
  other.kill();
});

test("the wrapper records pid and exit even when the agent's PATH lacks mv and date", async () => {
  const dir = tmpDir(), bin = tmpDir();
  writeFileSync(join(bin, "agent"), "#!/bin/sh\necho ran\n", { mode: 0o755 });
  startRun({ dir, argv: ["agent"], cwd: tmpDir(), env: { PATH: bin } });
  await until(() => readRun(dir).exit !== null);
  expect(readRun(dir)).toMatchObject({ exit: 0, startedAt: expect.any(Number) });
  expect(readOutput(dir).stdout).toBe("ran\n");
});

test("starting again in the same directory never reports the previous run's record", async () => {
  const dir = tmpDir(), cwd = tmpDir();
  startRun({ dir, argv: ["sh", "-c", "echo first"], cwd, env });
  await until(() => readRun(dir).exit !== null);
  startRun({ dir, argv: ["sh", "-c", "sleep 0.3; echo second; exit 2"], cwd, env });
  expect(readRun(dir).exit).toBeNull();
  await until(() => readRun(dir).exit !== null);
  expect(readRun(dir).exit).toBe(2);
  expect(readOutput(dir).stdout).toBe("second\n");
});

test("a reduced run environment preserves the isolated HOME and PACER_HOME", async () => {
  const dir = tmpDir();
  const run = startRun({ dir, argv: ["sh", "-c", 'printf "%s|%s" "$HOME" "$PACER_HOME"'], cwd: dir, env });
  expect("pid" in run).toBe(true);
  await until(() => readRun(dir).exit !== null);
  expect(readOutput(dir).stdout).toBe(`${process.env.HOME}|${join(process.env.HOME!, ".pacer")}`);
});
