import { expect, spyOn, test } from "bun:test";
import { realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cachedPath, pathProbeIO, refreshPath, rememberPath, schedulePathRefresh } from "../src/core/path-probe";
import { repoFor, resolveRepo } from "../src/core/repos";
import { eventsSince, liveSnapshot } from "../src/api/events";
import { pumpOnce, taskData } from "../src/link/pump";
import { appendOutbox } from "../src/link/store";
import { createTask, updateTask } from "../src/tasks/store";
import { startServer } from "../src/serve/http";
import { resolutionReason } from "../src/tasks/resolution";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { writeJsonAtomic } from "../src/fsutil";

const hang = <T>(): Promise<T> => new Promise(() => {});
const status = () => ({ generatedAt: 1, strategy: "s", planner: "p", mode: "normal" as const, disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } });

test("probe deadlines preserve known values and cache misses use a resolved path", async () => {
  const path = join(tmpDir(), "unseen");
  expect(cachedPath(path)).toMatchObject({ checkedAt: 0 });
  expect(cachedPath(path).real.endsWith("/unseen")).toBe(true);
  rememberPath(path, path);
  const before = cachedPath(path);
  const access = spyOn(pathProbeIO, "access").mockImplementation(() => hang());
  try {
    const start = performance.now();
    expect(await refreshPath(path, 20)).toMatchObject({...before, checkedAt:expect.any(Number), unreachable:true});
    expect(performance.now() - start).toBeLessThan(500);
  } finally { access.mockRestore(); }
  const realpath = spyOn(pathProbeIO, "realpath").mockImplementation(() => hang());
  try {
    const existing = tmpDir();
    rememberPath(existing, existing);
    const before = cachedPath(existing);
    expect(await refreshPath(existing, 20)).toMatchObject({...before, checkedAt:expect.any(Number), unreachable:true});
  } finally { realpath.mockRestore(); }
});

test("background scheduling is deduplicated and throttled after a failed probe", async () => {
  const path = tmpDir();
  const access = spyOn(pathProbeIO, "access").mockRejectedValue(new Error("unavailable"));
  try {
    schedulePathRefresh(path);
    schedulePathRefresh(path);
    await refreshPath(path);
    schedulePathRefresh(path);
    expect(access).toHaveBeenCalledTimes(1);
    expect(cachedPath(path).exists).toBeUndefined();
  } finally { access.mockRestore(); }
});

test("symlink identities and missing descendants canonicalize after probing", async () => {
  const ctx = fakeCtx({ run: realRun }), repo = gitRepo(), alias = join(tmpDir(), "alias");
  const ref = await resolveRepo(ctx, repo);
  symlinkSync(repo, alias);
  expect(repoFor(ctx, alias).path).toBe(cachedPath(alias).real);
  await refreshPath(alias);
  expect(cachedPath(alias).real).toBe(realpathSync(repo));
  expect(repoFor(ctx, alias)).toEqual(ref);
  expect(repoFor(ctx, join(alias, "missing", "nested"))).toEqual(ref);
  await refreshPath(join(alias, "missing", "nested"));
  expect(repoFor(ctx, join(alias, "missing", "nested"))).toEqual(ref);
});

test("hung repo probes and git leave snapshot, replay and pump responsive", async () => {
  const ctx = fakeCtx({ run: args => args[0] === "git" ? hang() : Promise.resolve({ code: 127, stdout: "", stderr: "unavailable" }) });
  const repo = tmpDir(), worker = tmpDir();
  const task = createTask(ctx, { brief: { goal: "hung volume", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const record = updateTask(ctx, task.id, t => { t.state = "partial"; t.worktree = worker; });
  appendOutbox(ctx, [{ seq: 1, at: ctx.now, envelope: { type: "task", data: taskData(record) } }]);
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [repo]: { path: repo, key: "local:hung", lastUsed: ctx.now } });
  const access = spyOn(pathProbeIO, "access").mockImplementation(() => hang());
  const realpath = spyOn(pathProbeIO, "realpath").mockImplementation(() => hang());
  try {
    const start = performance.now();
    const pump = pumpOnce(ctx, { tasks: () => [record], status: async () => status(), publish: async () => ({ seq: 1, transports: [], errors: [] }) });
    const snapshot = liveSnapshot(ctx, { status: async () => status() });
    expect(eventsSince(ctx, 0).events).toHaveLength(1);
    await Promise.all([pump, snapshot]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(access).toHaveBeenCalled();
    // Also prove the underlying git deadline independently of the pump's shorter budget.
    let gitStarted = false;
    const run = ctx.run;
    ctx.run = (...args) => { gitStarted = true; return run(...args); };
    expect(await resolutionReason(ctx, record, 20)).toBeNull();
    expect(gitStarted).toBe(true);

  } finally { access.mockRestore(); realpath.mockRestore(); }
});


test("serve health stays responsive while repo probes and git are hung", async () => {
  const ctx = fakeCtx({ run: args => args[0] === "git" ? hang() : Promise.resolve({ code: 127, stdout: "", stderr: "unavailable" }) });
  const repo = tmpDir(), worker = tmpDir();
  const task = createTask(ctx, { brief: { goal: "hung health", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const record = updateTask(ctx, task.id, t => { t.state = "partial"; t.worktree = worker; });
  const access = spyOn(pathProbeIO, "access").mockImplementation(() => hang());
  let server: ReturnType<typeof startServer> | undefined;
  try {
    server = startServer(() => ctx, { port: 0, pumpMs: 0 });
    const pump = pumpOnce(ctx, { tasks: () => [record], status: async () => status(), publish: async () => ({ seq: 1, transports: [], errors: [] }) });
    const start = performance.now();
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    await pump;
    expect(performance.now() - start).toBeLessThan(1000);
  } finally { server?.stop(); access.mockRestore(); }
});

test("unreachable repo snapshots retain task identity and recover after a successful probe", async () => {
  const repo = tmpDir(), ctx = fakeCtx({which: () => null});
  const ref = {key:"local:offline",label:repo.split("/").at(-1)!,path:repo};
  const task = createTask(ctx,{brief:{goal:"cached identity",repo},kind:null,requestedExecutor:null,timeoutS:60});
  updateTask(ctx,task.id,t=>{t.state="partial";t.repo=ref;});
  writeJsonAtomic(join(ctx.pacerHome,"state","repos.json"),{[repo]:{path:repo,key:ref.key,lastUsed:ctx.now}});
  rememberPath(repo,repo);
  const access = spyOn(pathProbeIO,"access").mockImplementation(() => hang());
  try {
    await refreshPath(repo,10);
    const result = await liveSnapshot(ctx,{status:async()=>status()});
    expect(result.snapshot.repos.find(r=>r.key===ref.key)).toMatchObject({...ref,unreachable:true});
    expect(result.snapshot.tasks[0].repo).toEqual(ref);
  } finally { access.mockRestore(); }
  await refreshPath(repo);
  expect(cachedPath(repo).unreachable).toBeUndefined();
  expect((await liveSnapshot(ctx,{status:async()=>status()})).snapshot.repos[0].unreachable).toBeUndefined();
});

test("non-ENOENT probe errors mark unreachable without discarding existence", async () => {
  const path=tmpDir();rememberPath(path,path);
  const access=spyOn(pathProbeIO,"access").mockRejectedValue(Object.assign(Error("denied"),{code:"EACCES"}));
  try { expect(await refreshPath(path,10)).toMatchObject({exists:true,real:path,unreachable:true}); }
  finally {access.mockRestore();}
});
