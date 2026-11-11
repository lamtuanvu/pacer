import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "../src/ctx";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { createTask, updateTask } from "../src/tasks/store";
import { assertIsolatedEnv, closedPort, isolatedEnv } from "./isolated-port";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/runner-check-core.ts")]);
const strategy = (home: string) => `planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  work: {kind: codex, home: ${join(home, "work")}}\nrunners:\n  claude-code: {}\n  codex: {}\n  codex#work: {}\n`;
// Longer than every front-door bridge deadline (120 s): Core's answer arrives only if no native layer cuts it short.
const DELAY_MS = 125_000;

function fixture() {
  // host.sock must fit SUN_LEN (~104); bun test's TMPDIR is too deep for the native front door.
  const home = mkdtempSync("/tmp/prf-");
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), strategy(home), { mode: 0o600 });
  const env = { HOME: home, PACER_HOME: pacerHome, PATH: "/usr/bin:/bin", PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", PACER_FIXTURE_DELAY_MS: String(DELAY_MS) };
  const logged = (file: string) => existsSync(join(pacerHome, file))
    ? readFileSync(join(pacerHome, file), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { home, pacerHome, env, logged, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
const traces = (stderr: string) => stderr.split("\n").filter(line => line.startsWith("native runner.check"));

async function stdioCheck(identity: Record<string, string>, params: Record<string, unknown>) {
  const home = fixture();
  const env = isolatedEnv({ ...home.env, ...identity });
  assertIsolatedEnv(env);
  const child = Bun.spawn([front!, "api", "--stdio"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n");
    const started = Date.now();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "runner.check", params }) + "\n");
    await child.stdin.flush();
    const replies: any[] = [];
    let buffered = "";
    while (!replies.some(reply => reply.id === 7)) {
      const { value, done } = await reader.read();
      if (done) throw Error("stdout closed before the runner.check reply");
      buffered += decoder.decode(value, { stream: true });
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        replies.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
      }
    }
    const elapsed = Date.now() - started;
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    return { replies, elapsed, port: env.PACER_PORT, tasks: home.logged("stub-test-tasks.log"), traces: traces(await stderr) };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    home.cleanup();
  }
}

async function httpChecks() {
  const home = fixture();
  const ctx = makeCtx({ home: home.home, pacerHome: home.pacerHome, env: { HOME: home.home, PACER_HOME: home.pacerHome } });
  const parent = createTask(ctx, { brief: { goal: "delegating parent", repo: home.home }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, parent.id, { allowDelegation: true });
  updateTask(ctx, parent.id, task => { task.state = "running"; });
  const grant = issueWorkGrant(ctx, parent.id, 1);
  const port = closedPort();
  const env = isolatedEnv({ ...home.env, PACER_AGENT: "alice" }, port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let result;
  try {
    let token = "";
    for (let n = 0; n < 500 && !token; n++) {
      try {
        const candidate = readFileSync(join(home.pacerHome, "token"), "utf8").trim();
        if ((await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) })).ok) token = candidate;
      } catch {}
      if (!token) await Bun.sleep(20);
    }
    expect(token).not.toBe("");
    const post = async (params: unknown, bearer: string) => {
      const started = Date.now();
      const response = await fetch(base + "/v3/ops/runner.check", { method: "POST", headers: { Authorization: `Bearer ${bearer}` },
        body: JSON.stringify(params), signal: AbortSignal.timeout(DELAY_MS + 60_000) });
      return { status: response.status, body: await response.json() as any, elapsed: Date.now() - started };
    };
    const refused = await post({ id: "cursor" }, token);
    const [operator, delegated] = await Promise.all([post({ id: "codex" }, token), post({ id: "codex#work", test: false }, grant)]);
    for (let n = 0; n < 250 && home.logged("stub-test-tasks.log").length < 2; n++) await Bun.sleep(20);
    result = { grant, port: env.PACER_PORT, refused, operator, delegated, tasks: home.logged("stub-test-tasks.log"), requests: home.logged("core-requests.log"),
      runners: home.logged("refused-runners.log") };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    home.cleanup();
  }
  return { ...result, traces: traces(await stderr) };
}

test.skipIf(!front)("forwarded runner.check keeps the caller's identity and Core's deadline over stdio and HTTP", async () => {
  const [operator, delegated, http] = await Promise.all([
    stdioCheck({ PACER_AGENT: "alice" }, { id: "codex" }),
    stdioCheck({ PACER_AGENT: "codex", PACER_ROLE: "executor", PACER_TASK_ID: "delegated-task" }, { id: "codex", test: false }),
    httpChecks(),
  ]);
  for (const [session, identity] of [[operator, { agent: "alice", role: null, task: null }], [delegated, { agent: "codex", role: "executor", task: "delegated-task" }]] as const) {
    const reply = session.replies.find(reply => reply.id === 7);
    expect(reply.error).toBeUndefined();
    expect(reply.result).toMatchObject({ kind: "runner.check", target: "codex", state: "passed" });
    expect(session.elapsed).toBeGreaterThanOrEqual(DELAY_MS);
    expect(session.tasks).toEqual([{ id: "codex", pid: reply.result.pid, port: session.port, grant: null, ...identity }]);
    expect(session.traces).toEqual([]);
  }

  expect(http.refused.status).toBe(404);
  expect(http.refused.body.error.code).toBe("unknown_executor");
  expect(http.refused.elapsed).toBeLessThan(DELAY_MS);
  // The operator gets the check job; the delegated caller reaches Core as a work grant, which Core refuses.
  expect(http.operator.status, JSON.stringify(http.operator.body)).toBe(200);
  expect(http.operator.body.result).toMatchObject({ kind: "runner.check", target: "codex" });
  expect(http.delegated).toMatchObject({ status: 403, body: { error: { code: "not_allowed", message: "Operation is not allowed by this work grant" } } });
  for (const call of [http.operator, http.delegated]) expect(call.elapsed).toBeGreaterThanOrEqual(DELAY_MS);
  expect(http.tasks).toEqual([{ id: "codex", pid: expect.any(Number), port: http.port, agent: "alice", role: null, task: null, grant: null }]);
  expect(http.requests.map(request => JSON.stringify(request)).sort()).toEqual([
    JSON.stringify({ auth: "bearer", grant: null }), JSON.stringify({ auth: "task", grant: `Bearer ${http.grant}` })].sort());
  expect(http.runners).toEqual([]);
  expect(http.traces).toEqual(["native runner.check"]);
}, 240_000);
