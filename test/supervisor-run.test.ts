import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOutput, readRun, startRun, stopRun } from "../src/supervisor/run";
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
