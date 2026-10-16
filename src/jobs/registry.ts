import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";

export interface Job {
  id: string;
  kind: "host.check" | "runner.check" | "host.repo.setup" | "host.clean" | "update.apply";
  target: string;
  state: "running" | "passed" | "failed" | "cancelled";
  steps: { name: string; state: "pending" | "running" | "passed" | "failed" | "skipped"; detail?: string }[];
  startedAt: number;
  endedAt?: number;
  error?: { code: string; message: string; hint?: string };
  pid: number;
  cancellable: boolean;
}
export interface StepApi {
  start(name: string): void;
  pass(name: string, detail?: string): void;
  fail(name: string, detail: string): void;
  skip(name: string, detail?: string): void;
  signal: AbortSignal;
}
type OnChange = (job: Job) => void;
const daemons = new Map<string, number>();
const controllers = new Map<string, AbortController>();
const observers = new Map<string, OnChange>();
const directory = (ctx: Ctx) => join(ctx.pacerHome, "state", "jobs");
const key = (ctx: Ctx, id: string) => `${resolve(ctx.pacerHome)}:${id}`;
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
function path(ctx: Ctx, id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new CoreError("invalid_input", "invalid job id");
  return join(directory(ctx), `${id}.json`);
}
function save(ctx: Ctx, job: Job, onChange?: OnChange) {
  mkdirSync(directory(ctx), { recursive: true });
  const file = path(ctx, job.id), temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(job), { mode: 0o600 });
  renameSync(temp, file);
  // Observers must never interrupt the work they are observing.
  try { onChange?.(structuredClone(job)); } catch { /* best-effort notification */ }
}
/** Marks calls in this serving process as background work; release on server stop. */
export function registerJobDaemon(ctx: Ctx): () => void {
  const home = resolve(ctx.pacerHome);
  daemons.set(home, (daemons.get(home) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (daemons.get(home) ?? 1) - 1;
    if (count) daemons.set(home, count); else daemons.delete(home);
  };
}
export function getJob(ctx: Ctx, id: string): Job {
  const file = path(ctx, id);
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new CoreError("invalid_input", `unknown job ${id}`);
    throw e;
  }
}
export function listJobs(ctx: Ctx, o: { target?: string } = {}): Job[] {
  let files: string[];
  try { files = readdirSync(directory(ctx)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const jobs: Job[] = [];
  for (const file of files.filter(f => /^[a-zA-Z0-9-]+\.json$/.test(f))) {
    let job: Job;
    try { job = getJob(ctx, file.slice(0, -5)); } catch { continue; }
    if (job.state !== "running" && ctx.now - (job.endedAt ?? job.startedAt) > 86400) {
      rmSync(join(directory(ctx), file), { force: true }); continue;
    }
    if (o.target === undefined || job.target === o.target) jobs.push(job);
  }
  return jobs.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
}
function settleSteps(job: Job) {
  for (const step of job.steps) {
    if (step.state === "running") step.state = job.state === "failed" ? "failed" : "skipped";
    if (step.state === "pending") step.state = "skipped";
  }
}
export function cancelJob(ctx: Ctx, id: string, onChange?: OnChange): Job {
  const job = getJob(ctx, id);
  if (!job.cancellable) throw new CoreError("not_allowed", "job is not cancellable");
  if (job.state !== "running") return job;
  job.state = "cancelled"; job.endedAt = ctx.now;
  settleSteps(job); save(ctx, job, onChange ?? observers.get(key(ctx, id)));
  controllers.get(key(ctx, id))?.abort();
  return job;
}
export function recoverJobs(ctx: Ctx, onChange?: OnChange): void {
  for (const job of listJobs(ctx)) {
    if (job.state !== "running" || alive(job.pid)) continue;
    job.state = "failed"; job.endedAt = ctx.now;
    job.error = { code: "interrupted", message: "pacer restarted while this was running" };
    settleSteps(job); save(ctx, job, onChange);
  }
}
export async function startJob(
  ctx: Ctx, kind: Job["kind"], target: string, steps: string[], run: (step: StepApi) => Promise<void>,
  o: { cancellable?: boolean; onChange?: OnChange } = {},
): Promise<Job> {
  // Only creation is locked: work must not block a second caller reading its id.
  const { job, created } = await withLock(ctx, "jobs", async () => {
    const existing = listJobs(ctx, { target }).find(j => j.kind === kind && j.state === "running");
    if (existing) return { job: existing, created: false };
    const job: Job = { id: randomUUID(), kind, target, state: "running", steps: steps.map(name => ({ name, state: "pending" })), startedAt: ctx.now, pid: process.pid, cancellable: o.cancellable ?? false };
    save(ctx, job, o.onChange);
    return { job, created: true };
  });
  if (!created) return job;
  if (o.onChange) observers.set(key(ctx, job.id), o.onChange);
  const controller = new AbortController(); controllers.set(key(ctx, job.id), controller);
  const started = Date.now(), now = () => ctx.now + (Date.now() - started) / 1000;
  const update = (name: string, state: Job["steps"][number]["state"], detail?: string) => {
    if (getJob(ctx, job.id).state !== "running") return;
    const step = job.steps.find(s => s.name === name);
    if (!step) throw new CoreError("invalid_input", `unknown job step ${name}`);
    step.state = state; if (detail !== undefined) step.detail = detail;
    save(ctx, job, o.onChange);
  };
  const execute = async () => {
    // A separate in-process client may cancel a job owned by the serving process.
    const timer = job.cancellable ? setInterval(() => {
      if (getJob(ctx, job.id).state === "cancelled") controller.abort();
    }, 100) : undefined;
    try {
      await run({ start: name => update(name, "running"), pass: (name, detail) => update(name, "passed", detail), fail: (name, detail) => update(name, "failed", detail), skip: (name, detail) => update(name, "skipped", detail), signal: controller.signal });
      const failed = job.steps.find(s => s.state === "failed");
      if (failed) throw Error(failed.detail ?? `step failed: ${failed.name}`);
      job.state = "passed";
    } catch (e) {
      job.state = "failed";
      job.error = { code: e instanceof CoreError ? e.code : "failed", message: e instanceof Error ? e.message : String(e) };
    } finally {
      clearInterval(timer); controllers.delete(key(ctx, job.id)); observers.delete(key(ctx, job.id));
    }
    const stored = getJob(ctx, job.id);
    if (stored.state === "cancelled") return stored;
    job.endedAt = now(); settleSteps(job); save(ctx, job, o.onChange);
    return job;
  };
  const completion = execute();
  if (daemons.has(resolve(ctx.pacerHome))) {
    // Persisted failures are returned through job.get; prevent unhandled rejection on I/O failure.
    void completion.catch(() => {});
    return structuredClone(job);
  }
  return completion;
}
