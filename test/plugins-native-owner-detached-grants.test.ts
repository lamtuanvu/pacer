import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { manifest } from "../plugins/pacer-exec-direct/manifest";
import type { CoreError } from "../src/core/errors";
import { inspectOwnedExecutorSession } from "../src/plugins/executor-session-state";
import { stopOwnedExecutorAttempt } from "../src/plugins/executor-stop";
import { manifestSchema } from "../src/plugins/protocol";
import { PluginRegistry } from "../src/plugins/registry";
import { readRun, startRun, stopRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { relayOwner, type Relay } from "./fixtures/native-owner-relay";
import { fakeCtx } from "./helpers";

const direct = join(import.meta.dir, "..", "plugins", "pacer-exec-direct", "index.ts");
// Answers hello as the direct executor, then each call by sending every capability request in turn (with @TASK@ the
// call's own task) under the call's capability metadata, writing what it got to `file`, and replying with `reply`.
const askScript = (template: [string, unknown][], file: string, reply: unknown) => `const template=${JSON.stringify(JSON.stringify(template))},file=${JSON.stringify(file)},reply=${JSON.stringify(reply)};const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let call,meta,asks=[],answers=[];const ask=()=>{if(answers.length<asks.length)return send({id:900+answers.length,method:asks[answers.length][0],params:asks[answers.length][1],...(meta?{_meta:meta}:{})});require('node:fs').writeFileSync(file,JSON.stringify(answers));send({id:call,result:reply});};for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:m.params.protocol,id:'pacer-exec-direct',version:m.params.manifest.version,contributes:['executor']}});else if(m.method&&m.id!==undefined){call=m.id;meta=m._meta;asks=JSON.parse(template.replaceAll('@TASK@',m.params.taskId));answers=[];ask();}else if(m.id>=900){answers.push(m.error?{code:m.error.data?.code,message:m.error.message}:{value:m.result});ask();}}}`;
const FOREIGN = "t-20260101-000000-zzzz";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A home with one running direct-executor attempt, served flag-off or through a relay owner on `host.sock`. */
async function fixture(flag: boolean, asks?: [string, unknown][], reply?: unknown) {
  const home = mkdtempSync(join(tmpdir(), "pacer-owner-detached-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(join(pacerHome, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: codex\nproviders: {codex: {}}\n");
  const path = join(pacerHome, "run", "host.sock");
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ...(flag ? { PACER_HOST_SOCKET: path } : {}) };
  const ctx = fakeCtx({ home, pacerHome, env });
  const task = createTask(ctx, { brief: { goal: "fixture", repo: home }, kind: null, requestedExecutor: "codex", timeoutS: 60 });
  const dir = join(pacerHome, "runs", task.id, "1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  updateTask(ctx, task.id, value => {
    value.state = "running"; value.executor = "codex";
    value.run = { dir, attempt: 1, executor: "codex", startedAt: Date.now() / 1000, mode: "current", workdir: home, logFile: join(dir, "stdout") };
  });
  const answers = join(home, "answers.json");
  const argv = asks ? [process.execPath, "-e", askScript(asks, answers, reply)] : [process.execPath, direct];
  const registry = new PluginRegistry({ bundled: [{ manifest: manifestSchema.parse(manifest), main: () => import("../plugins/pacer-exec-direct/index") }],
    spawnBundled: () => ({ argv, cwd: home, env: { PATH: env.PATH } }), eventPumpMs: 0 });
  const relay: Relay | undefined = flag ? await relayOwner(path) : undefined;
  cleanups.push(async () => {
    await stopRun(dir, { graceMs: 500 }).catch(() => {});
    await registry.shutdown();
    await relay?.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { ctx, task, dir, registry, relay, answers: () => JSON.parse(readFileSync(answers, "utf8")) as unknown[] };
}

async function running(dir: string, env: Record<string, string | undefined>) {
  expect(startRun({ dir, argv: ["sleep", "30"], cwd: dirname(dir), env })).toHaveProperty("pid");
  for (const deadline = Date.now() + 5000; !readRun(dir).alive;) {
    if (Date.now() > deadline) throw Error("wrapper did not start");
    await Bun.sleep(25);
  }
}

const outcome = (call: Promise<unknown>) => call.then(value => ({ value }), (error: CoreError) => ({ code: error.code, message: error.message }));
const DETACHED = ["capability.process.stopRun", "capability.process.inspectRun", "capability.hosts.stopOwned"];
/** The detached grant methods Core sealed as its own for a relayed call. */
const detached = (call: { coreMethods?: string[] }) => (call.coreMethods ?? []).filter(method => DETACHED.includes(method));

test("flag-on stops a detached executor run with the one-use grant Core keeps, as flag-off", async () => {
  const results = [];
  for (const flag of [false, true]) {
    const f = await fixture(flag);
    await running(f.dir, f.ctx.env);
    const pid = readRun(f.dir).pid!;
    results.push(await outcome(stopOwnedExecutorAttempt(f.ctx, f.registry, "pacer-exec-direct", f.task.id, 1, 3000)));
    expect(readRun(f.dir).alive).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    if (f.relay) {
      expect(f.relay.calls.map(detached)).toEqual([["capability.process.stopRun"]]);
      expect(JSON.stringify(f.relay.calls)).not.toContain("detachedStop");
      expect(f.relay.forwarded).toEqual(["capability.process.stopRun"]);
      expect(f.relay.refused).toEqual([]);
    }
  }
  expect(results[0]).toEqual({ value: { code: 143, killed: false } });
  expect(results[1]).toEqual(results[0]);
});

test("flag-on inspects a detached executor run with the one-use grant Core keeps, as flag-off", async () => {
  const results = [];
  for (const flag of [false, true]) {
    const f = await fixture(flag);
    const inspect = () => inspectOwnedExecutorSession(f.ctx, f.registry, "pacer-exec-direct", f.task.id, 1);
    const states = [await outcome(inspect())];
    await running(f.dir, f.ctx.env);
    states.push(await outcome(inspect()));
    expect((await stopRun(f.dir, { graceMs: 3000 })).code).toBe(143);
    states.push(await outcome(inspect()));
    results.push(states);
    if (f.relay) {
      expect(f.relay.calls.map(detached)).toEqual(Array(3).fill(["capability.process.inspectRun"]));
      expect(JSON.stringify(f.relay.calls)).not.toContain("detachedInspect");
      expect(f.relay.forwarded).toEqual(Array(3).fill("capability.process.inspectRun"));
    }
  }
  const state = (value: string) => ({ value: { state: value, host: "builtin", handle: null } });
  expect(results[0]).toEqual([state("uncertain"), state("running"), state("exited")]);
  expect(results[1]).toEqual(results[0]);
});

function grants(f: Awaited<ReturnType<typeof fixture>>) {
  const task = readTask(f.ctx, f.task.id)!, linked = statSync(f.dir);
  const run = { taskId: f.task.id, attempt: 1, dir: f.dir, startedAt: task.run!.startedAt };
  const local = { ...run, rev: task.rev, dirIdentity: { dev: linked.dev, ino: linked.ino }, executor: "codex" };
  return { detachedStop: { ...local, pid: readRun(f.dir).pid!, graceMs: 3000 }, detachedInspect: local,
    remoteStop: { ...run, providerId: "pacer-exec-direct", requestedAt: 1, graceMs: 3000 } };
}
const scoped = (resources: object) => ({ resources: { reads: [], commands: [], stores: [], ...resources }, deadlineMs: 8000 });

test("flag-on detached stop grant is bound to its run and used once, with the flag-off refusals", async () => {
  const results = [];
  for (const flag of [false, true]) {
    const stop = (taskId: string) => ["capability.process.stopRun", { taskId, attempt: 1, graceMs: 3000 }] as [string, unknown];
    const f = await fixture(flag, [stop(FOREIGN), stop("@TASK@"), stop("@TASK@")], { code: 143, killed: true });
    await running(f.dir, f.ctx.env);
    const { detachedStop } = grants(f);
    await f.registry.call(f.ctx, "pacer-exec-direct", "executor.stop", { taskId: f.task.id, attempt: 1, graceMs: 3000 }, scoped({ detachedStop }));
    results.push(f.answers());
    expect(readRun(f.dir).alive).toBe(false);
    if (f.relay) {
      expect(f.relay.calls.map(detached)).toEqual([["capability.process.stopRun"]]);
      expect(f.relay.forwarded).toEqual(Array(3).fill("capability.process.stopRun"));
    }
  }
  const denied = { code: "capability_denied", message: "detached stop is not issued for this call" };
  expect(results[0]).toEqual([denied, { value: { code: 143, killed: false } }, denied]);
  expect(results[1]).toEqual(results[0]);
});

test("flag-on detached inspection grant is bound to its run and used once, with the flag-off refusals", async () => {
  const results = [];
  for (const flag of [false, true]) {
    const inspect = (taskId: string) => ["capability.process.inspectRun", { taskId, attempt: 1 }] as [string, unknown];
    const f = await fixture(flag, [inspect(FOREIGN), inspect("@TASK@"), inspect("@TASK@")], { state: "running", host: "builtin", handle: null });
    await running(f.dir, f.ctx.env);
    const { detachedInspect } = grants(f);
    await f.registry.call(f.ctx, "pacer-exec-direct", "executor.sessionState", { taskId: f.task.id, attempt: 1 }, scoped({ detachedInspect }));
    results.push(f.answers());
    expect(readRun(f.dir).alive).toBe(true);
    if (f.relay) expect(f.relay.forwarded).toEqual(Array(3).fill("capability.process.inspectRun"));
  }
  const denied = { code: "capability_denied", message: "detached inspection is not issued for this call" };
  expect(results[0]).toEqual([denied, { value: expect.objectContaining({ state: "running" }) }, denied]);
  expect(results[1]).toEqual(results[0]);
});

test("flag-on remote stop grant reaches Core's flag-off broker, bound to its run and used once", async () => {
  const results = [];
  for (const flag of [false, true]) {
    const stop = (taskId: string) => ["capability.hosts.stopOwned", { taskId, attempt: 1, graceMs: 3000 }] as [string, unknown];
    const f = await fixture(flag, [stop(FOREIGN), stop("@TASK@"), stop("@TASK@")], { code: 143, killed: true });
    const { remoteStop } = grants(f);
    await f.registry.call(f.ctx, "pacer-exec-direct", "executor.stop", { taskId: f.task.id, attempt: 1, graceMs: 3000, remote: true }, scoped({ remoteStop }));
    results.push(f.answers());
    if (f.relay) {
      expect(f.relay.calls.map(detached)).toEqual([["capability.hosts.stopOwned"]]);
      expect(JSON.stringify(f.relay.calls)).not.toContain("remoteStop");
      expect(f.relay.forwarded).toEqual(Array(3).fill("capability.hosts.stopOwned"));
    }
  }
  const denied = { code: "capability_denied", message: "remote stop is not issued for this call" };
  // The exact request consumes the grant; this fixture has no prepared remote run, so the broker then refuses it.
  expect(results[0]).toEqual([denied, { code: "capability_denied", message: "owned remote run changed" }, denied]);
  expect(results[1]).toEqual(results[0]);
});
