import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertIsolatedEnv, isolatedEnv } from "./isolated-port";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/runner-check-core.ts")]);
const STRATEGY = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";
const STEPS = [
  { name: "CLI found", state: "passed", detail: "Codex on this Mac" },
  { name: "Signed in", state: "passed", detail: "Account codex" },
  { name: "Usage readable", state: "passed", detail: "Weekly window · 3% used" },
  { name: "Test task", state: "passed", detail: "Write and run a one-line test in a scratch worktree" },
];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test.skipIf(!front)("stdio front door refuses runner.check natively and forwards configured runners to a TypeScript check job", async () => {
  // host.sock must fit SUN_LEN (~104); bun test's TMPDIR is too deep for the native front door.
  const home = mkdtempSync("/tmp/prc-");
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), STRATEGY, { mode: 0o600 });
  const env = isolatedEnv({ HOME: home, PACER_HOME: pacerHome, PATH: "/usr/bin:/bin", PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1" });
  assertIsolatedEnv(env);
  const child = Bun.spawn([front!, "api", "--stdio"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffered = "";
  const call = async (id: number, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await child.stdin.flush();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const reply = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        expect(reply.id).toBe(id);
        return reply;
      }
      const { value, done } = await reader.read();
      if (done) throw Error(`stdout closed before reply ${id}`);
      buffered += decoder.decode(value, { stream: true });
    }
  };
  let corePid = 0;
  try {
    expect((await call(1, "hello", { protocol: 3 })).result.protocol).toBe("3.0.0");
    expect(await call(2, "runner.check", { id: "cursor", test: false })).toEqual({ jsonrpc: "2.0", id: 2,
      error: { code: -32000, message: "unknown runner cursor", data: { code: "unknown_executor" } } });
    expect(await call(3, "runner.check", { id: "" })).toEqual({ jsonrpc: "2.0", id: 3,
      error: { code: -32602, message: "id: Too small: expected string to have >=1 characters", data: { code: "invalid_input" } } });
    const jobs = [];
    for (const [id, params] of [[4, { id: "codex" }], [5, { id: "codex", test: false }]] as const) {
      const reply = await call(id, "runner.check", params);
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({ kind: "runner.check", target: "codex", state: "passed", steps: STEPS });
      jobs.push(reply.result);
    }
    expect(jobs[0].id).not.toBe(jobs[1].id);
    corePid = jobs[0].pid;
    expect(jobs[1].pid).toBe(corePid);
    expect([child.pid, process.pid]).not.toContain(corePid);
    expect(readFileSync(join(pacerHome, "stub-test-tasks.log"), "utf8")).toBe(`codex ${corePid} ${env.PACER_PORT}\n`.repeat(2));
    expect(JSON.parse(readFileSync(join(pacerHome, "state/runner-checks.json"), "utf8")).codex).toMatchObject({ passed: true, detail: "Executor is ready" });
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(buffered + decoder.decode()).toBe("");
    expect((await reader.read()).done).toBe(true);
    const traces = (await stderr).split("\n").filter(line => line.startsWith("native runner.check"));
    expect(traces).toEqual(["native runner.check 2", "native runner.check 3"]);
    for (let n = 0; n < 100 && alive(corePid); n++) await Bun.sleep(20);
    expect(alive(corePid)).toBe(false);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    if (corePid && alive(corePid)) process.kill(corePid, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
  expect(existsSync(home)).toBe(false);
}, 60_000);
