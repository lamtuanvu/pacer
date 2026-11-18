import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerWork } from "../src/dispatch/work";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { TERMINAL_STATES } from "../src/tasks/types";
import { fakeCtx, gitRepo } from "./helpers";
import { front, stdio } from "./native-plugin-door";
import { closedPort } from "./pinned-port";
import { useMatrixRoot, matrixPath, type Mode, type Run, type Running, fileText, httpOff, httpOn, matrixHome, openDoor, poll, script, stdioOff, stdioOwn } from "./plugins-native-owner-matrix-support";

// Detached runner rows of the flag-on matrix: owner sockets and attempts that outlive their door.
useMatrixRoot();

/** Bun processes the preload probe recorded: the `_run` runners Core detaches for a retried task, or every other one. */
function runnerEnvs(log: string, runners = true) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { socket: string | null; key: string | null; secrets?: string | null; args: string[] })
    .filter(entry => (entry.args[0] === "_run") === runners);
}
function killRunners(id: string) {
  for (const line of Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString().split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (pid && command.join(" ").includes(`_run ${id}`)) try { process.kill(Number(pid), "SIGKILL"); } catch { /* Already gone. */ }
  }
}

/** A matrix home whose preload probe records the owner socket of every bun process started from it: Core, its runners and their plugins. */
function runnerHome(name: string, codex?: string) {
  const root = matrixPath(name);
  const h = matrixHome(root, closedPort());
  if (codex) {
    script(join(h.home, "bin"), "codex", codex);
    // A codex below 0.162.1 runs only headless.
    const strategy = join(h.state, "strategy.yaml");
    writeFileSync(strategy, readFileSync(strategy, "utf8").replace("runners:\n  claude-code: {}\n  codex: {}", "runners:\n  claude-code: {}\n  codex: {session: headless}"), { mode: 0o600 });
  }
  const repo = gitRepo();
  const log = join(h.home, "bun-processes");
  const probe = join(h.home, "socket-probe.cjs");
  writeFileSync(probe, `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ socket: process.env.PACER_HOST_SOCKET ?? null, key: process.env.PACER_HOST_SOCKET_KEY ? "present" : null, secrets: process.env.PACER_CORE_SECRETS ?? null, args: process.argv.slice(2) }) + "\\n");\n`);
  // Serve clears BUN_OPTIONS for its Core child; Bun still reads bunfig.toml from the working directory Core and its runners share.
  writeFileSync(join(h.home, "bunfig.toml"), `preload = [${JSON.stringify(probe)}]\n`);
  writeFileSync(join(h.home, ".codex", "auth.json"), "{}");
  const ctx = fakeCtx({ home: h.home, pacerHome: h.state, now: Math.floor(Date.now() / 1000) });
  const ids: string[] = [];
  return {
    h, ctx, repo, ids,
    open: (mode: Mode) => openDoor(h, mode, { BUN_OPTIONS: `--preload ${probe}` }, h.home),
    sockets: (runners: boolean) => [...new Set(runnerEnvs(log, runners).map(entry => entry.socket?.replace(h.state, "<PACER_HOME>") ?? null))],
    keys: (runners: boolean) => [...new Set(runnerEnvs(log, runners).map(entry => entry.key))],
    markers: (runners: boolean) => [...new Set(runnerEnvs(log, runners).map(entry => entry.secrets))],
    runnerStarted: () => poll(async () => runnerEnvs(log), entries => entries.length > 0, 60000),
    done() {
      for (const id of ids) killRunners(id);
      rmSync(repo, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** I1: what PACER_HOST_SOCKET a detached `_run` runner inherits from Core in each mode, retrying failed managed work. */
async function runnerSocket(mode: Mode) {
  const fixture = runnerHome("i1"), { ctx, h } = fixture;
  const { id } = createTask(ctx, { title: "Retry me", brief: { goal: "Retry me", repo: fixture.repo }, kind: "feature", requestedExecutor: null, timeoutS: 3600 });
  fixture.ids.push(id);
  registerWork(ctx, id, {});
  updateTask(ctx, id, record => {
    record.executor = "codex";
    record.attempts = [{ executor: "codex", model: null, startedAt: ctx.now - 600, endedAt: ctx.now - 120, exitCode: 1, timedOut: false, limitHit: false, log: join(h.state, "logs", `${id}.log`) }];
    record.state = "failed"; record.settledAt = ctx.now - 120;
    record.result = { status: "failed", executor: "codex", model: null, backend: "direct", files: "", report: "Failed.", acceptance: { cmd: "bun test", passed: false, tail: "1 failed" } };
  });
  const door = await fixture.open(mode);
  try {
    const task = (await door.call("task.get", { id })).json.result;
    const retry = await door.call("dispatch.retry", { id, expect_rev: task?.rev ?? task?.task?.rev, requestId: `i1-${mode.label.replaceAll(" ", "-")}`, feedback: "Run the tests first" });
    expect(retry.json.error, retry.line).toBeUndefined();
    await fixture.runnerStarted();
    await poll(() => door.call("task.get", { id }), reply => reply.json.result?.state !== "running", 30000);
    return { runners: fixture.sockets(true), runnerKeys: fixture.keys(true), runnerMarkers: fixture.markers(true), core: fixture.sockets(false), coreKeys: fixture.keys(false), coreMarkers: fixture.markers(false) };
  } finally {
    await door.stop();
    fixture.done();
  }
}

test.skipIf(!front)("I1: a detached _run runner gets no owner socket in any mode, while Core keeps its door's", async () => {
  const on = await runnerSocket(httpOn);
  const off = await runnerSocket(httpOff);
  const owned = await runnerSocket(stdioOwn);
  console.log(JSON.stringify({ on, off, owned }));
  expect(on.runners).toEqual([null]);
  expect(off.runners).toEqual([null]);
  expect(owned.runners).toEqual([null]);
  expect(on.core).toContain("<PACER_HOME>/run/host.sock");
  expect(off.core).toEqual([null]);
  expect(owned.core.some(socket => /^<PACER_HOME>\/run\/s[0-9a-f]{12}\.sock$/.test(socket ?? ""))).toBe(true);
  // Only Core holds the owner's credential (#918), and it reaches Core on stdin, not in its
  // environment: neither Core nor a runner starts with it in any mode.
  for (const run of [on, off, owned]) {
    expect(run.runnerKeys).toEqual([null]);
    expect(run.coreKeys).toEqual([null]);
    expect(run.coreMarkers).toContain("stdin/1");
    expect(run.runnerMarkers).toEqual([null]);
  }
}, 400000);

/** Codex reads the attempt's prompt and succeeds after a pause long enough to end the door under it. */
const SLOW_CODEX = `case "$1" in
  --version) echo "codex-cli 0.50.0";;
  exec) echo "codex $*" >> "$HOME/codex.log"; cat > /dev/null; sleep 4; echo "Attempt done."; exit 0;;
  *) echo "codex $*" >> "$HOME/codex.log"; case "$*" in *app-server*) read -r _;; esac; exit 1;;
esac`;

/**
 * Item 8: a direct codex attempt outlives the door that dispatched it. The door closes (stdio)
 * or restarts (serve) while codex runs; the attempt is then read from the store.
 */
async function runnerAttempt(mode: Mode, after: "close" | "restart") {
  const fixture = runnerHome(`attempt-${mode.label.replaceAll(" ", "-")}`, SLOW_CODEX);
  let door: Running | undefined = await fixture.open(mode);
  try {
    const reply = await door.call("task.delegate", { goal: "Write a note", repo: fixture.repo, executor: "codex", difficulty: "simple" });
    expect(reply.json.error, reply.line).toBeUndefined();
    const id: string = reply.json.result.task_id;
    fixture.ids.push(id);
    const attempt = () => readTask(fixture.ctx, id)?.attempts[0];
    await fixture.runnerStarted();
    const started = await poll(async () => fileText(fixture.h, "codex.log").includes("codex exec"), ran => ran || attempt()?.endedAt !== undefined, 60000);
    await door.stop();
    door = after === "restart" ? await fixture.open(mode) : undefined;
    const task = await poll(async () => readTask(fixture.ctx, id), value => TERMINAL_STATES.includes(value?.state ?? "queued"), 60000);
    const ended = attempt();
    return { started, exitCode: ended?.exitCode, timedOut: ended?.timedOut, state: task?.state, status: task?.result?.status, runners: fixture.sockets(true) };
  } finally {
    await door?.stop();
    fixture.done();
  }
}

test.skipIf(!front)("I1: a flag-on stdio self-owned runner completes its attempt after the connection ends, as flag-off", async () => {
  const off = await runnerAttempt(stdioOff, "close");
  const owned = await runnerAttempt(stdioOwn, "close");
  console.log(JSON.stringify({ off, owned }));
  expect(off).toMatchObject({ started: true, exitCode: 0, timedOut: false, runners: [null] });
  expect(owned).toEqual(off);
}, 300000);

test.skipIf(!front)("I1: a flag-on serve runner completes its attempt across a service restart, as flag-off", async () => {
  const off = await runnerAttempt(httpOff, "restart");
  const on = await runnerAttempt(httpOn, "restart");
  console.log(JSON.stringify({ off, on }));
  expect(off).toMatchObject({ started: true, exitCode: 0, timedOut: false, runners: [null] });
  expect(on).toEqual(off);
}, 300000);
