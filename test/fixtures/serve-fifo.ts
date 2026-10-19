import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/serve/http";
import { createTask, updateTask } from "../../src/tasks/store";
import { writeJsonAtomic } from "../../src/fsutil";
import { defaultPumpDeps, pumpOnce } from "../../src/link/pump";
import { taskDetail } from "../../src/core/task-detail";
import { fakeCtx, realRun } from "../helpers";
const root = mkdtempSync(join(tmpdir(), "pacer-fifo-"));
let server: ReturnType<typeof startServer> | undefined;
try {
  const home = join(root, "home"), repo = join(root, "repo-fifo"), worktree = join(root, "worktree");
  const stuck = join(root, "stuck-worktree");
  mkdirSync(home); mkdirSync(worktree); mkdirSync(join(stuck, ".git"), { recursive: true });
  const fifo = Bun.spawnSync(["mkfifo", repo, join(worktree, ".git"), join(stuck, ".git", "HEAD")]);
  if (fifo.exitCode) throw Error("mkfifo failed");
  const ctx = fakeCtx({ home, run: realRun, which: () => null });
  mkdirSync(ctx.pacerHome);
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), Object.fromEntries([repo,worktree].map(path => [path,{path,key:`local:${path.split('/').pop()}`,lastUsed:ctx.now}])));
  for (const path of [repo,worktree]) {
    const task = createTask(ctx,{brief:{goal:"FIFO test",repo:path},kind:null,requestedExecutor:null,timeoutS:60});
    updateTask(ctx,task.id,t=>{t.state="partial";t.worktree=worktree;});
  }
  server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  await pumpOnce(ctx, { ...defaultPumpDeps, status: async () => ({generatedAt:ctx.now,strategy:"test",planner:"claude-code",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}}) });
  for (let i=0;i<5;i++) for (const path of ["/health","/v3/snapshot"]) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {headers:{Authorization:`Bearer ${server.token}`},signal:AbortSignal.timeout(1000)});
    await response.text();
    if (response.status !== 200 || performance.now()-start >= 1000) throw Error(`${path} failed: ${response.status}`);
  }
  // A read that never returns (a FIFO with no writer, like an open behind a macOS privacy prompt)
  // must surface as service.waiting while health and the snapshot keep answering.
  const blocked = createTask(ctx,{brief:{goal:"FIFO HEAD",repo:stuck},kind:null,requestedExecutor:null,timeoutS:60});
  updateTask(ctx,blocked.id,t=>{t.state="partial";t.worktree=stuck;});
  const detailStart = performance.now();
  await taskDetail(ctx, blocked.id);
  if (performance.now()-detailStart >= 1000) throw Error("task detail waited on a stuck read");
  await Bun.sleep(1200);
  for (const path of ["/health","/v3/snapshot"]) {
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {headers:{Authorization:`Bearer ${server.token}`},signal:AbortSignal.timeout(1000)});
    const body = await response.json() as { snapshot?: { service: { waiting?: { kind: string; path: string; since: number } } } };
    if (response.status !== 200 || performance.now()-start >= 1000) throw Error(`${path} failed while a read was stuck: ${response.status}`);
    if (path === "/v3/snapshot") {
      const waiting = (body.snapshot ?? body as never as { service: { waiting?: { kind: string; path: string } } }).service.waiting;
      // The first read can legitimately be stale; the background refresh must
      // eventually publish the waiting marker without delaying any individual read.
      let current = waiting;
      for (let n = 0; n < 30 && current?.path !== join(stuck, ".git", "HEAD"); n++) {
        await Bun.sleep(100);
        const next = await fetch(`http://127.0.0.1:${server.port}/v3/snapshot`, { headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(1000) });
        current = (await next.json() as { snapshot: { service: { waiting?: typeof waiting } } }).snapshot.service.waiting;
      }
      if (current?.kind !== "folder" || current.path !== join(stuck, ".git", "HEAD")) throw Error(`service.waiting missing: ${JSON.stringify(current)}`);
    }
  }
} finally { server?.stop(); rmSync(root,{recursive:true,force:true}); }
// A worker may still be in a FIFO open after its deadline; no service process leaks.
process.exit(0);
