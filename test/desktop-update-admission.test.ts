import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../src/ctx";
import { beginWorkSync, finishWorkSync, claimWorkSync, reserveIdle, releaseReservation, reconcileAdmission } from "../src/update/desktop/admission";
import { processIdentity, sameProcess } from "../src/update/desktop/process-identity";

const roots: string[] = [];
function context() {
  const root = mkdtempSync(join(tmpdir(), "pacer-admission-")); roots.push(root);
  return makeCtx({ home: root, pacerHome: join(root, "state"), env: {} });
}
const blocker = { kind: "launch" as const, id: "task-a", label: "Task A" };
const fixture = join(import.meta.dir, "fixtures/desktop-update/admission-worker.ts");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function worker(home: string, mode: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, fixture, home, mode, ...args], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(output);
}

describe("desktop work admission", () => {
  test("pending launch blocks reservation until explicitly finished", async () => {
    const ctx = context(), lease = beginWorkSync(ctx, blocker);
    expect(await reserveIdle(ctx, "tx-a")).toEqual({ reserved: false, blockers: [blocker] });
    finishWorkSync(ctx, lease);
    expect(await reserveIdle(ctx, "tx-a")).toEqual({ reserved: true, blockers: [] });
    expect(() => beginWorkSync(ctx, blocker)).toThrow("maintenance");
    await expect(releaseReservation(ctx, "tx-other")).rejects.toThrow("conflict");
    await releaseReservation(ctx, "tx-a");
    finishWorkSync(ctx, beginWorkSync(ctx, blocker));
    expect(statSync(join(ctx.pacerHome, "desktop-updates/admission.sqlite")).mode & 0o777).toBe(0o600);
  });

  test("subprocess reserve-versus-launch has exactly one winner", async () => {
    for (let i = 0; i < 12; i++) {
      const ctx = context();
      const [launch, reserve] = await Promise.all([
        worker(ctx.pacerHome, "launch"), worker(ctx.pacerHome, "reserve"),
      ]);
      expect(Number(launch.started) + Number(reserve.reserved)).toBe(1);
    }
  });

  test("a parent crash leaves an ambiguous pending launch blocking", async () => {
    const ctx = context();
    await worker(ctx.pacerHome, "launch");
    await reconcileAdmission(ctx);
    expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  });

  test("child claims durable lease and parent cannot release child work", async () => {
    const ctx = context(), lease = beginWorkSync(ctx, blocker);
    const claimed = await worker(ctx.pacerHome, "claim", lease);
    expect(claimed.claimed).toBe(true);
    expect(() => finishWorkSync(ctx, lease)).toThrow("owner");
    await reconcileAdmission(ctx);
    expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  });

  test("process identity includes boot and exact birth, rejects PID reuse", () => {
    const identity = processIdentity(process.pid);
    expect(identity?.bootId).toBeTruthy();
    expect(identity?.birth).toBeTruthy();
    expect(sameProcess(identity, processIdentity(process.pid))).toBe(true);
    expect(sameProcess(identity, identity && { ...identity, birth: `${identity.birth}-reused` })).toBe(false);
    expect(sameProcess(identity, null)).toBe(false);
  });

  test("a reservation survives its owner process exiting", async () => {
    const ctx = context();
    expect((await worker(ctx.pacerHome, "reserve")).reserved).toBe(true);
    await reconcileAdmission(ctx);
    expect(() => beginWorkSync(ctx, blocker)).toThrow("maintenance");
    await releaseReservation(ctx, "worker-tx");
    const lease = beginWorkSync(ctx, blocker); claimWorkSync(ctx, lease); finishWorkSync(ctx, lease);
  });
});

import { createTask, updateTask, listTasks } from "../src/tasks/store";
import { delegate, superviseTask } from "../src/tasks/api";
import { runTask } from "../src/tasks/runner";
import { drainQueue } from "../src/tasks/drain";
import { startRun } from "../src/supervisor/run";
import { startJob, registerJobDaemon, cancelJob } from "../src/jobs/registry";
import { queueStrategy, queueDeps } from "./queue-helpers";
import { mkdirSync, writeFileSync } from "node:fs";

function task(ctx: ReturnType<typeof context>) {
  return createTask(ctx, { brief: { goal: "Work", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
}

test("completed awaiting-review tasks permit idle, existing running tasks block", async () => {
  const ctx = context(), record = task(ctx);
  updateTask(ctx, record.id, t => { t.state = "running"; });
  expect((await reserveIdle(ctx, "tx-a")).blockers).toContainEqual(expect.objectContaining({ kind: "task", id: record.id }));
  updateTask(ctx, record.id, t => { t.state = "done"; });
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(true);
});

test("a surviving PTY blocks even after completion with zero viewers", async () => {
  const ctx = context(), record = task(ctx), dir = join(ctx.pacerHome, "runs", record.id, "1");
  updateTask(ctx, record.id, t => { t.state = "done"; });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), String(process.pid));
  writeFileSync(join(dir, "session.state"), JSON.stringify({ viewers: 0 }));
  expect((await reserveIdle(ctx, "tx-a")).blockers).toContainEqual(expect.objectContaining({ kind: "session" }));
});

test("reservation prevents delegate and direct runner before mutations or executor work", async () => {
  const ctx = context();
  await reserveIdle(ctx, "tx-a");
  let spawned = 0;
  expect(() => delegate(ctx, { brief: { goal: "Work", repo: ctx.home } }, () => { spawned++; return 1; }, queueStrategy())).toThrow("maintenance");
  expect(listTasks(ctx, Infinity)).toHaveLength(0);
  const record = task(ctx);
  await expect(runTask(ctx, record.id, queueDeps())).rejects.toThrow("maintenance");
  expect(spawned).toBe(0);
});

test("status recovery and queue drain are held during maintenance without losing intent", async () => {
  const ctx = context(); await reserveIdle(ctx, "tx-a");
  const record = task(ctx);
  updateTask(ctx, record.id, t => { t.state = "running"; t.run = { host: "remote", attempt: 1 } as any; });
  let spawned = 0;
  const status = await superviseTask(ctx, record.id, () => { spawned++; return 1; });
  expect(spawned).toBe(0); expect(status?.resumeSpawnedAt).toBeUndefined();
  updateTask(ctx, record.id, t => { t.state = "queued"; delete t.run; t.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  expect(await drainQueue(ctx, () => { spawned++; return 1; }, queueDeps())).toEqual([]);
  expect(spawned).toBe(0);
});

test("detached supervisor cannot start a process during maintenance", async () => {
  const ctx = context(); await reserveIdle(ctx, "tx-a");
  const dir = join(ctx.pacerHome, "runs", "manual", "1");
  const result = startRun({ dir, argv: ["/bin/true"], cwd: ctx.home, env: { PACER_HOME: ctx.pacerHome, HOME: ctx.home } });
  expect(result).toHaveProperty("error", expect.stringContaining("maintenance"));
});

test("background operation lease lasts until cancelled callback really settles", async () => {
  const ctx = context(), stop = registerJobDaemon(ctx);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const job = await startJob(ctx, "host.check", "test", ["check"], async () => { await waiting; }, { cancellable: true });
  cancelJob(ctx, job.id);
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  release(); await Bun.sleep(20);
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(true);
  stop();
});

import { attachRunEvidenceSync } from "../src/update/desktop/admission";
import { withDesktopCoordinator } from "../src/update/desktop/coordinator";
import { workerClosureProof } from "../src/update/desktop/orca-proof";

test("old run completion cannot release a new launch in a reused directory", async () => {
  const ctx = context(), dir = join(ctx.pacerHome, "runs", "reuse", "1");
  mkdirSync(dir, { recursive: true });
  const old = beginWorkSync(ctx, blocker); attachRunEvidenceSync(ctx, old, dir);
  finishWorkSync(ctx, old);
  const current = beginWorkSync(ctx, blocker); attachRunEvidenceSync(ctx, current, dir);
  writeFileSync(join(dir, "exit"), "0\n");
  writeFileSync(join(dir, "admission.complete"), old + "\n");
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  writeFileSync(join(dir, "admission.complete"), current + "\n");
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(true);
});

test("real detached pipe run blocks until its exact completion receipt", async () => {
  const ctx = context(), dir = join(ctx.pacerHome, "runs", "actual", "1");
  const result = startRun({ dir, argv: ["/bin/sleep", "0.2"], cwd: ctx.home, env: { PACER_HOME: ctx.pacerHome, HOME: ctx.home }, session: "pipe" });
  expect(result).toHaveProperty("pid");
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  for (let i = 0; i < 100; i++) {
    if ((await reserveIdle(ctx, "tx-a")).reserved) return;
    await Bun.sleep(10);
  }
  throw new Error("detached work never released its completion lease");
});

test("coordinator rejects same-process nesting promptly", () => {
  const ctx = context(), start = Date.now();
  expect(() => withDesktopCoordinator(ctx, () => beginWorkSync(ctx, blocker))).toThrow("Nested");
  expect(Date.now() - start).toBeLessThan(1000);
  finishWorkSync(ctx, beginWorkSync(ctx, blocker));
});

test("Orca closure requires the exact dispatch and a process termination receipt", () => {
  const proof = { ok: true as const, result: { dispatchId: "dispatch", state: "stopped", processAction: "closed_agent_terminal", close: { handle: "terminal", ptyKilled: true } } };
  expect(workerClosureProof(proof, "dispatch", "terminal")).toBe(true);
  expect(workerClosureProof(proof, "wrong", "terminal")).toBe(false);
  expect(workerClosureProof(proof, "dispatch", "wrong")).toBe(false);
  expect(workerClosureProof({ ok: true, result: { dispatchId: "dispatch", state: "stopped" } }, "dispatch", "terminal")).toBe(false);
  expect(workerClosureProof({ ...proof, result: { ...proof.result, close: { handle: "terminal", ptyKilled: false } } }, "dispatch", "terminal")).toBe(false);
});


test("kernel coordinator survives an ancient mtime and releases only on owner crash", async () => {
  const ctx = context(), lease = beginWorkSync(ctx, blocker); finishWorkSync(ctx, lease);
  const owner = Bun.spawn([process.execPath, fixture, ctx.pacerHome, "hold"], { stdout: "pipe", stderr: "pipe" });
  const stream = owner.stdout.getReader();
  try {
    const ready = await stream.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    utimesSync(join(ctx.pacerHome, "desktop-updates/admission.sqlite"), 1, 1);
    let settled = false;
    const contender = worker(ctx.pacerHome, "reserve").then(value => { settled = true; return value; });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    owner.kill("SIGKILL"); await owner.exited;
    expect((await contender).reserved).toBe(true);
    const table = withDesktopCoordinator(ctx, db => db.query("SELECT name FROM sqlite_master WHERE name='interrupted'").get());
    expect(table).toBeNull();
  } finally { owner.kill(); await owner.exited; stream.releaseLock(); }
});

test("malformed or unsupported task and operation records never establish idle", async () => {
  for (const [directory, value] of [["tasks", {}], ["tasks", { state: "unexpected" }], ["state/jobs", {}], ["state/jobs", { state: "future" }]] as const) {
    const ctx = context(), dir = join(ctx.pacerHome, directory);
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "malformed.json"), JSON.stringify(value));
    expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  }
});

test("invalid delegation releases its unused pre-admission", async () => {
  const ctx = context();
  expect(() => delegate(ctx, { brief: { goal: "", repo: ctx.home } }, () => 1, queueStrategy())).toThrow();
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(true);
});

import { RemoteRunIO } from "../src/remote/run-io";
test("ambiguous detached SSH start stays blocked after its caller returns", async () => {
  const ctx = context();
  ctx.run = async () => ({ code: 255, stdout: "", stderr: "response lost after detached launch" });
  const host = { alias: "box", ssh: "box", repos: {}, maxTasks: 1, accounts: {} };
  const io = new RemoteRunIO(ctx, host, "/remote/run", join(ctx.pacerHome, "runs", "remote", "1"));
  expect(await io.start(["executor"], "/remote", {}, "", { session: "pipe" })).toHaveProperty("error");
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
});

test("remote completion is bound to host, directory and nonce after caller reconstruction", async () => {
  const ctx = context(), local = join(ctx.pacerHome, "runs", "remote", "1");
  const host = { alias: "box", ssh: "box", repos: {}, maxTasks: 1, accounts: {} };
  ctx.run = async () => ({ code: 0, stdout: "__PACER_BEGIN__\npid=42\n", stderr: "" });
  const io = new RemoteRunIO(ctx, host, "/remote/run", local);
  expect(await io.start(["executor"], "/remote", {}, "", { session: "pipe" })).toHaveProperty("pid");
  const first = JSON.parse(readFileSync(join(local, "admission.json"), "utf8")).lease;
  expect(await io.start(["executor"], "/remote", {}, "", { session: "pipe" })).toHaveProperty("pid");
  const second = JSON.parse(readFileSync(join(local, "admission.json"), "utf8")).lease;
  // An old remote completion cannot clear the replacement launch's lease.
  let receipt = first;
  ctx.run = async () => ({ code: 0, stdout: `__PACER_BEGIN__\npid=42\nalive=0\nexit=0\nout=0\nerr=0\nadmission_complete=${receipt}\n`, stderr: "" });
  const reconstructed = new RemoteRunIO(ctx, host, "/remote/run", local);
  await reconstructed.read();
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  receipt = second;
  await new RemoteRunIO(ctx, host, "/wrong/run", local).read();
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  await reconstructed.read();
  // The replacement is complete; the older unresolved launch remains protected.
  expect((await reserveIdle(ctx, "tx-a")).blockers).toHaveLength(1);
});

test("missing remote process and synthetic stop exit do not prove detached completion", async () => {
  const ctx = context(), local = join(ctx.pacerHome, "runs", "remote", "1");
  const host = { alias: "box", ssh: "box", repos: {}, maxTasks: 1, accounts: {} };
  ctx.run = async () => ({ code: 0, stdout: "__PACER_BEGIN__\npid=42\n", stderr: "" });
  const io = new RemoteRunIO(ctx, host, "/remote/run", local);
  await io.start(["executor"], "/remote", {}, "", { session: "pipe" });
  ctx.run = async () => ({ code: 0, stdout: "__PACER_BEGIN__\nalive=0\nexit=137\ncode=137\nkilled=0\nout=0\nerr=0\n", stderr: "" });
  await io.read(); await io.stop({ graceMs: 1, sleep: Bun.sleep });
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
});

test("malformed Orca state and worker rows cannot establish idle", async () => {
  for (const value of [{}, { workers: [] }, { coordinator: null, run: null, workers: { worker: {} } }]) {
    const ctx = context(); mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "orca.json"), JSON.stringify(value));
    expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
  }
});

import { runRemote } from "../src/remote/ssh";
import { SCRIPTS } from "../src/remote/scripts";
test("lost synchronous remote mutation response retains an operation blocker", async () => {
  const ctx = context();
  ctx.run = async () => ({ code: 255, stdout: "__PACER_BEGIN__\n", stderr: "transport lost" });
  const host = { alias: "box", ssh: "box", repos: {}, maxTasks: 1, accounts: {} };
  await runRemote(ctx, host, SCRIPTS.SET_IDENTITY, ["/repo", "name", "unused"]);
  expect((await reserveIdle(ctx, "tx-a")).blockers).toContainEqual(expect.objectContaining({ kind: "operation" }));
});

test("queued launch resumes exactly once after reservation release", async () => {
  const ctx = context(); await reserveIdle(ctx, "tx-a");
  const record = task(ctx);
  updateTask(ctx, record.id, t => { t.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  let launches = 0;
  const spawn = () => { launches++; return process.pid; };
  expect(await drainQueue(ctx, spawn, queueDeps())).toEqual([]);
  await releaseReservation(ctx, "tx-a");
  expect(await drainQueue(ctx, spawn, queueDeps())).toEqual([record.id]);
  expect(await drainQueue(ctx, spawn, queueDeps())).toEqual([]);
  expect(launches).toBe(1);
});

test("only an exact remote mutation completion releases admission and private receipt is stripped", async () => {
  const ctx = context(), host = { alias: "box", ssh: "box", repos: {}, maxTasks: 1, accounts: {} };
  ctx.run = async argv => {
    const nonce = argv.at(-1)!.match(/__PACER_DONE__=([a-f0-9-]{36})/)?.[1];
    expect(nonce).toBeTruthy();
    return { code: 0, stdout: `__PACER_BEGIN__\nresult\n\n__PACER_DONE__=${nonce}\n`, stderr: "" };
  };
  const result = await runRemote(ctx, host, SCRIPTS.SET_IDENTITY, ["/repo", "name", "unused"]);
  expect(result.stdout).toBe("result\n");
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(true);
  ctx.run = async () => ({ code: 0, stdout: "__PACER_BEGIN__\nread-only", stderr: "" });
  expect((await runRemote(ctx, host, SCRIPTS.PROBE, [])).stdout).toBe("read-only");
  await expect(runRemote(ctx, host, SCRIPTS.CLEAN, [])).rejects.toThrow("maintenance");
});

test("an unsupported queued-work reason requires recovery rather than proving idle", async () => {
  const ctx = context(), record = task(ctx);
  updateTask(ctx, record.id, t => { t.queue = { reason: "future-state" as any, since: ctx.now, position: 1 }; });
  expect((await reserveIdle(ctx, "tx-a")).reserved).toBe(false);
});
