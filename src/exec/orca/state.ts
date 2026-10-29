import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../fsutil";
import type { Ctx } from "../../types";
import { isObj } from "../../util";

export interface OrcaWorkerEntry {
  dispatchId: string;
  taskId: string;
  executor: string;
  worktree: string | null;
  terminal: string | null;
  startedAt: number;
}
export interface OrcaGroupEntry { selector: string }
/** A worktree pacer created through Orca and could not remove before falling back. */
export interface StrandedWorktree { taskId: string; id: string; path: string; name: string; at: number }
/** A pacer terminal whose worker-start result was uncertain; a later pass reconciles it. */
export interface UncertainStart { taskId: string; terminal: string; run: string; worktree: Omit<StrandedWorktree, "taskId" | "at"> | null; at: number }
/** A pacer-owned terminal whose close returned no receipt proof; a later pass retries the close. */
export interface UnclosedTerminal { taskId: string; terminal: string; worktreeId?: string; at: number }
/** Orca's initial terminal handles, recorded before pacer's agent terminal existed: the only terminals a stray sweep may close. */
export interface StrayRisk extends StrandedWorktree { initial: string[] }
/** A worktree pacer removed through Orca: positive evidence that its terminals died with it. */
export interface RemovedWorktree { id: string; path: string; at: number }
export interface OrcaState {
  coordinator: string | null; run: string | null; workers: Record<string, OrcaWorkerEntry>;
  stranded: Record<string, StrandedWorktree>; uncertain: Record<string, UncertainStart>; unclosed: Record<string, UnclosedTerminal>;
  /** Pacer-created worktrees whose terminal listing failed, keyed by worktree id; `pacer clean` closes only their recorded initial terminals. */
  strays: Record<string, StrayRisk>;
  removed: Record<string, RemovedWorktree>;
  groups: Record<string, OrcaGroupEntry>;
}
export interface InboxEntry { outcome: string; subject: string; body: string; filesModified: string[]; messageId: string }

export const orcaStatePath = (ctx: Ctx) => join(ctx.pacerHome, "orca.json");
const orcaDir = (ctx: Ctx) => join(ctx.pacerHome, "orca");
export const inboxDir = (ctx: Ctx) => join(orcaDir(ctx), "inbox");
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const inboxFile = (ctx: Ctx, id: string) => join(inboxDir(ctx), `${id}.json`);

function records<T>(raw: unknown, valid: (v: Record<string, unknown>) => boolean): Record<string, T> {
  return isObj(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => isObj(v) && valid(v))) as Record<string, T> : {};
}

export function loadOrcaState(ctx: Ctx): OrcaState {
  const raw = readJson<unknown>(orcaStatePath(ctx));
  const o = isObj(raw) ? raw : {};
  return {
    coordinator: typeof o.coordinator === "string" ? o.coordinator : null,
    run: typeof o.run === "string" ? o.run : null,
    workers: isObj(o.workers) ? (o.workers as Record<string, OrcaWorkerEntry>) : {},
    stranded: records<StrandedWorktree>(o.stranded, v => ["taskId", "id", "path", "name"].every(k => typeof v[k] === "string")),
    uncertain: records<UncertainStart>(o.uncertain, v => ["taskId", "terminal", "run"].every(k => typeof v[k] === "string")),
    unclosed: records<UnclosedTerminal>(o.unclosed, v => ["taskId", "terminal"].every(k => typeof v[k] === "string")),
    strays: Object.fromEntries(Object.entries(records<StrandedWorktree & { initial?: unknown }>(o.strays, v => ["taskId", "id", "path", "name"].every(k => typeof v[k] === "string")))
      .map(([k, v]) => [k, { ...v, initial: Array.isArray(v.initial) ? v.initial.filter((h): h is string => typeof h === "string") : [] }])),
    removed: records<RemovedWorktree>(o.removed, v => ["id", "path"].every(k => typeof v[k] === "string")),
    groups: records<OrcaGroupEntry>(o.groups, v => typeof v.selector === "string" && v.selector.startsWith("path:")),
  };
}

export function updateOrcaState(ctx: Ctx, mutate: (s: OrcaState) => void): OrcaState {
  const s = loadOrcaState(ctx);
  mutate(s);
  writeJsonAtomic(orcaStatePath(ctx), s);
  return s;
}

/** Hand a worker_done to whichever runner waits for that dispatch. The first write wins. */
export function putInbox(ctx: Ctx, dispatchId: string, entry: InboxEntry): void {
  if (!SAFE_ID.test(dispatchId)) return;
  const f = inboxFile(ctx, dispatchId);
  if (existsSync(f)) return;
  writeJsonAtomic(f, entry);
}

export function hasInbox(ctx: Ctx, dispatchId: string): boolean {
  return SAFE_ID.test(dispatchId) && existsSync(inboxFile(ctx, dispatchId));
}

export function takeInbox(ctx: Ctx, dispatchId: string): InboxEntry | null {
  if (!SAFE_ID.test(dispatchId)) return null;
  const f = inboxFile(ctx, dispatchId);
  const e = readJson<InboxEntry>(f);
  if (e) rmSync(f, { force: true });
  return e;
}

export { withLock } from "../../core/lock";
