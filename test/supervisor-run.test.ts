import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readOutput, readRun, startRun, stopRun } from "../src/supervisor/run";
import { tmpDir } from "./helpers";
import { processIdentity } from "../src/update/desktop/process-identity";

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

test("identity-checked stop refuses a changed session host without signalling", async () => {
  const dir = tmpDir();
  const started = startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env, session: "pty" }) as { pid: number };
  await until(() => existsSync(join(dir, "child")));
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  const hostIdentity = processIdentity(started.pid)!;
  const childIdentity = processIdentity(child)!;
  expect(await stopRun(dir, { graceMs: 100, expectedIdentities: { host: { ...hostIdentity, birth: "wrong" }, child: childIdentity } })).toEqual({ code: 137, killed: false });
  expect(readRun(dir).alive).toBe(true);
  await stopRun(dir, { graceMs: 100 });
}, 30_000);

test("identity-checked stop terminates only the recorded terminal shell", async () => {
  const dir = tmpDir();
  const started = startRun({ dir, argv: ["sleep", "30"], cwd: tmpDir(), env, session: "pty" }) as { pid: number };
  await until(() => existsSync(join(dir, "child")));
  const child = Number(readFileSync(join(dir, "child"), "utf8"));
  const result = await stopRun(dir, { graceMs: 2000, expectedIdentities: { host: processIdentity(started.pid)!, child: processIdentity(child)! } });
  expect(result.killed).toBe(false);
  await until(() => readRun(dir).exit !== null);
}, 30_000);

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
