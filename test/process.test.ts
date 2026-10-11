import { expect, test } from "bun:test";
import { join } from "node:path";
import { execProcess } from "../src/exec/process";
import { tmpDir } from "./helpers";

const env = { PATH: process.env.PATH, HOME: process.env.HOME };

test("captures stdout, stderr and exit code; feeds stdin; runs in cwd with env", async () => {
  const dir = tmpDir();
  const r = await execProcess({
    argv: ["sh", "-c", 'read x; echo "got:$x"; pwd; echo "v=$PACER_T"; echo oops >&2; exit 3'],
    cwd: dir, stdin: "hello\n", env: { ...env, PACER_T: "7" }, timeoutMs: 5000,
  });
  expect(r.code).toBe(3);
  expect(r.timedOut).toBe(false);
  expect(r.stdout).toContain("got:hello");
  expect(r.stdout).toContain(dir.split("/").pop()!);
  expect(r.stdout).toContain("v=7");
  expect(r.stderr).toBe("oops\n");
});

test("missing binary is code 127 and still writes the log", async () => {
  const dir = tmpDir();
  const log = join(dir, "x.log");
  const r = await execProcess({ argv: ["definitely-not-a-binary-pacer"], cwd: dir, env, timeoutMs: 5000, logFile: log });
  expect(r.code).toBe(127);
  expect(await Bun.file(log).exists()).toBe(true);
});

test("timeout kills the process and reports timedOut", async () => {
  const started = Date.now();
  const r = await execProcess({ argv: ["sleep", "30"], cwd: tmpDir(), env, timeoutMs: 300 });
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("onSpawn receives the pid; the log records command, output and exit", async () => {
  const dir = tmpDir();
  const log = join(dir, "run.log");
  let pid = 0;
  await execProcess({ argv: ["sh", "-c", "echo hi"], cwd: dir, env, timeoutMs: 5000, logFile: log, onSpawn: (p) => { pid = p; } });
  expect(pid).toBeGreaterThan(0);
  const text = await Bun.file(log).text();
  expect(text).toContain("$ sh -c echo hi");
  expect(text).toContain("hi");
  expect(text).toContain("--- exit 0");
});

test("timeout holds when a grandchild keeps the pipes open", async () => {
  const started = Date.now();
  const r = await execProcess({
    argv: ["sh", "-c", "sleep 30 & wait"],
    cwd: tmpDir(),
    env,
    timeoutMs: 300,
  });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("a throwing onSpawn does not escape", async () => {
  const r = await execProcess({
    argv: ["sh", "-c", "echo ok"],
    cwd: tmpDir(),
    env,
    timeoutMs: 5000,
    onSpawn: () => {
      throw new Error("onSpawn boom");
    },
  });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("ok\n");
});

test("an unwritable log file does not escape", async () => {
  const r = await execProcess({
    argv: ["sh", "-c", "echo ok"],
    cwd: tmpDir(),
    env,
    timeoutMs: 5000,
    logFile: "/dev/null/nope.log",
  });
  expect(r.code).toBe(0);
});


test("timeout kills grandchildren", async () => {
  const dir = tmpDir();
  const pidFile = join(dir, "gc.pid");
  let pid = 0;
  try {
    const r = await execProcess({
      argv: ["sh", "-c", `sleep 30 & echo $! > '${pidFile}'; wait`],
      cwd: dir, env, timeoutMs: 300,
    });
    pid = Number(await Bun.file(pidFile).text());
    expect(pid).toBeGreaterThan(0);
    expect(r.timedOut).toBe(true);
    await Bun.sleep(300);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});
