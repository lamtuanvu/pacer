import { publish } from "../link/publish";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import { redactEndpointError } from "../endpoints/state";
import type { Ctx } from "../types";

export const ACTIVITY_KINDS = ["task_started", "task_settled", "verdict", "retry", "mode", "budget_refreshed", "executor_state", "host_state", "account_state", "config", "update"] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export interface ActivityEntry {
  id: string;
  at: number;
  kind: ActivityKind;
  level: "info" | "warn" | "error";
  text: string;
  /** RepoRef.key. */
  repo?: string;
  taskId?: string;
  executor?: string;
  host?: string;
}
export interface ActivityOptions { before?: string; limit?: number; repo?: string; kinds?: ActivityKind[]; taskId?: string }
const stateDir = (ctx: Ctx) => join(ctx.pacerHome, "state");
const logPath = (ctx: Ctx) => join(stateDir(ctx), "activity.jsonl");
const RETENTION_S = 30 * 86400;

// The public append API is synchronous. Serialize its single write with rotation
// across CLI/service processes so replacing the log cannot discard an append.
function withLogLock<T>(ctx: Ctx, action: () => T): T {
  mkdirSync(stateDir(ctx), { recursive: true });
  const lock = join(stateDir(ctx), "activity.lock"), deadline = Date.now() + 10_000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) { unlinkSync(lock); continue; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (Date.now() >= deadline) throw new Error("timed out waiting for activity log lock");
      Atomics.wait(sleep, 0, 0, 10);
    }
  }
  try { return action(); } finally { unlinkSync(lock); }
}
const safeText = (text: string) => redactEndpointError(text).replace(/(\btoken\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]").replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");

function entries(ctx: Ctx): ActivityEntry[] {
  let text: string;
  try { text = readFileSync(logPath(ctx), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  return text.split("\n").flatMap(line => {
    try {
      const e = JSON.parse(line);
      if (!e || typeof e.id !== "string" || !Number.isFinite(e.at) || !ACTIVITY_KINDS.includes(e.kind)
        || !["info", "warn", "error"].includes(e.level) || typeof e.text !== "string"
        || ["repo", "taskId", "executor", "host"].some(k => e[k] !== undefined && typeof e[k] !== "string")) return [];
      return [e as ActivityEntry];
    } catch { return []; }
  });
}

/** Append in one write and publish to API clients. */
export function appendActivity(ctx: Ctx, e: Omit<ActivityEntry, "id" | "at">, onAppend: (entry: ActivityEntry) => void = () => {}): ActivityEntry {
  const entry: ActivityEntry = { ...e, text: safeText(e.text), id: `${ctx.now}-${randomBytes(2).toString("hex")}`, at: ctx.now };
  withLogLock(ctx, () => appendFileSync(logPath(ctx), JSON.stringify(entry) + "\n", { mode: 0o600 }));
  void publish(ctx, [{ v: 1, type: "entity", data: { kind: "activity", id: entry.id, value: entry } }], { channel: false });
  onAppend(entry);
  return entry;
}

export function readActivity(ctx: Ctx, o: ActivityOptions = {}): { entries: ActivityEntry[]; next: string | null } {
  // File order breaks timestamp ties, so appends in the same second page consistently.
  const all = entries(ctx).reverse();
  const start = o.before === undefined ? 0 : all.findIndex(e => e.id === o.before) + 1;
  if (o.before !== undefined && start === 0) return { entries: [], next: null };
  const filtered = all.slice(start).filter(e => (o.repo === undefined || e.repo === o.repo)
    && (o.kinds === undefined || o.kinds.includes(e.kind)) && (o.taskId === undefined || e.taskId === o.taskId));
  const limit = Math.min(500, Math.max(1, Math.floor(o.limit ?? 50)));
  const page = filtered.slice(0, limit);
  return { entries: page, next: filtered.length > limit ? page.at(-1)!.id : null };
}

/** Called by the pump; a persisted marker also throttles rotation across restarts. */
export function rotateActivity(ctx: Ctx): void {
  withLogLock(ctx, () => {
    const marker = join(stateDir(ctx), "activity-rotation.json"), last = readJson<number>(marker);
    if (typeof last === "number" && ctx.now - last < 86400) return;
    const kept = entries(ctx).filter(e => e.at >= ctx.now - RETENTION_S).slice(-20_000);
    mkdirSync(stateDir(ctx), { recursive: true });
    const tmp = `${logPath(ctx)}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map(e => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
    renameSync(tmp, logPath(ctx));
    writeJsonAtomic(marker, ctx.now);
  });
}
