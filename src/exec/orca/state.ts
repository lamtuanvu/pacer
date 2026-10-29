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
export interface OrcaState { coordinator: string | null; run: string | null; workers: Record<string, OrcaWorkerEntry>; groups: Record<string, OrcaGroupEntry> }
export interface InboxEntry { outcome: string; subject: string; body: string; filesModified: string[]; messageId: string }

export const orcaStatePath = (ctx: Ctx) => join(ctx.pacerHome, "orca.json");
const orcaDir = (ctx: Ctx) => join(ctx.pacerHome, "orca");
export const inboxDir = (ctx: Ctx) => join(orcaDir(ctx), "inbox");
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const inboxFile = (ctx: Ctx, id: string) => join(inboxDir(ctx), `${id}.json`);

export function loadOrcaState(ctx: Ctx): OrcaState {
  const raw = readJson<unknown>(orcaStatePath(ctx));
  const o = isObj(raw) ? raw : {};
  return {
    coordinator: typeof o.coordinator === "string" ? o.coordinator : null,
    run: typeof o.run === "string" ? o.run : null,
    workers: isObj(o.workers) ? (o.workers as Record<string, OrcaWorkerEntry>) : {},
    groups: isObj(o.groups) ? (o.groups as Record<string, OrcaGroupEntry>) : {},
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
