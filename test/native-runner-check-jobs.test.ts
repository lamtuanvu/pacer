import {expect, test} from "bun:test";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {assertIsolatedEnv, closedPort, isolatedEnv} from "./isolated-port";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const STRATEGY = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\n";
const NOW = 1_700_000_000;
const STEPS = [
  {name: "CLI found", state: "passed", detail: "Codex on this Mac"},
  {name: "Signed in", state: "passed", detail: "Account codex"},
  {name: "Usage readable", state: "passed", detail: "Weekly window · 3% used"},
  {name: "Model offered", state: "skipped", detail: "No model list for this agent"},
  {name: "Test task", state: "passed", detail: "Write and run a one-line test in a scratch worktree"},
];
const CASE = {
  id: "codex", now: NOW,
  runner: {id: "codex", agent: "codex", model: "gpt-5", account: "codex", host: null},
  account: {name: "codex", kind: "codex", usage: "quota", provider: "openai", source: "opencode"},
  found: {found: true, install_hint: "install codex"},
  status: {signedIn: true}, signInReason: null,
  row: {usedPct: 3, window: "weekly", error: null, hint: null, capturedAt: 1, stale: false},
  models: {source: "none", offered: null, closest: []},
  testError: false, refreshed: null, env: {}, raw: {},
};

function fixture() {
  const home = mkdtempSync("/tmp/prj-");
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, {mode: 0o700});
  writeFileSync(join(pacerHome, "strategy.yaml"), STRATEGY, {mode: 0o600});
  const env = isolatedEnv({HOME: home, PACER_HOME: pacerHome, PATH: "/usr/bin:/bin",
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", PACER_TEST_RUNNER_CHECK_CASE: JSON.stringify(CASE)});
  assertIsolatedEnv(env);
  const jobs = () => {
    const dir = join(pacerHome, "state", "jobs");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => name.endsWith(".json")).map(name =>
      JSON.parse(readFileSync(join(dir, name), "utf8")));
  };
  return {home, pacerHome, env, jobs, cleanup: () => rmSync(home, {recursive: true, force: true})};
}

async function stdioChecks() {
  const home = fixture();
  const child = Bun.spawn([front!, "api", "--stdio"], {env: home.env, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffered = "";
  const call = async (id: number, method: string, params: unknown) => {
    child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
    await child.stdin.flush();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const reply = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        expect(reply.id).toBe(id);
        return reply;
      }
      const {value, done} = await reader.read();
      if (done) throw Error(`stdout closed before reply ${id}`);
      buffered += decoder.decode(value, {stream: true});
    }
  };
  try {
    expect((await call(1, "hello", {protocol: 3})).result.protocol).toBe("3.0.0");
    const first = await call(2, "runner.check", {id: "codex"});
    const second = await call(3, "runner.check", {id: "codex", test: false});
    for (const reply of [first, second]) {
      expect(reply.error).toBeUndefined();
      expect(reply.result).toMatchObject({kind: "runner.check", target: "codex", state: "passed", steps: STEPS});
    }
    expect(first.result.id).not.toBe(second.result.id);
    expect(JSON.parse(readFileSync(join(home.pacerHome, "state/runner-checks.json"), "utf8")).codex)
      .toMatchObject({passed: true, detail: "Executor is ready"});
    expect(home.jobs().filter(job => job.kind === "runner.check")).toHaveLength(2);
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    const traces = (await stderr).split("\n").filter(line => line.startsWith("native runner.check"));
    expect(traces).toEqual(["native runner.check 2", "native runner.check 3"]);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    home.cleanup();
  }
}

async function httpChecks() {
  const home = fixture();
  const port = closedPort();
  const child = Bun.spawn([front!, "serve", "--port", String(port)], {env: {...home.env, PACER_PORT: String(port)},
    stdin: "ignore", stdout: "ignore", stderr: "pipe"});
  try {
    let token = "";
    for (let n = 0; n < 500 && !token; n++) {
      try {
        const candidate = readFileSync(join(home.pacerHome, "token"), "utf8").trim();
        if ((await fetch(`http://127.0.0.1:${port}/v3/hello`, {headers: {Authorization: `Bearer ${candidate}`}, signal: AbortSignal.timeout(500)})).ok) token = candidate;
      } catch {}
      if (!token) await Bun.sleep(20);
    }
    expect(token).not.toBe("");
    const response = await fetch(`http://127.0.0.1:${port}/v3/ops/runner.check`, {method: "POST",
      headers: {Authorization: `Bearer ${token}`}, body: JSON.stringify({id: "codex"})});
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.result).toMatchObject({kind: "runner.check", target: "codex", state: "passed", steps: STEPS});
    expect(home.jobs().filter(job => job.kind === "runner.check")).toHaveLength(1);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    home.cleanup();
  }
}

test.skipIf(!front)("runner.check starts native jobs over stdio and HTTP", async () => {
  await Promise.all([stdioChecks(), httpChecks()]);
}, 120_000);
