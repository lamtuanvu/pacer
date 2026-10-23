import { lstatSync } from "node:fs";
import { isDevArgv, validateInstallArgv } from "./self";
import { readInstallFile } from "./atomic";
import { managedContent } from "./managed-content";
import { commitInstall, recoverInstall, type PendingFile } from "./journal";
import { withInstallLock } from "./lock";
import { basename, join } from "node:path";
import type { Ctx } from "../types";
import { backupPath, sha256, shellCommand } from "./fsx";
import { mergeUndo, readManifest, type PlannerRecord, type UndoOp } from "./manifest";

export class InstallError extends Error {
  constructor(message: string) { super(message); this.name = "InstallError"; }
}
export interface InstallEnv { ctx: Ctx; pacerArgv: string[]; mcp?: boolean; folder?: string; plannerAccount?: string; plannerKey?: string; configEnv?: Record<string, string>; mode?: "connect" | "reconcile" }
export class Txn {
  readonly record: PlannerRecord;
  readonly touched: string[] = [];
  readonly notes: string[] = [];
  readonly pending = new Map<string, PendingFile>();
  private commandUndos: string[][] = [];
  constructor(readonly env: InstallEnv, planner: string, prior?: PlannerRecord) {
    this.record = prior ? structuredClone(prior) : {
      planner, installedAt: env.ctx.now, pacerArgv: [...env.pacerArgv], files: [], commands: [], notes: [],
    };
    this.record.pacerArgv = [...env.pacerArgv];
    if (env.plannerAccount) this.record.account = env.plannerAccount;
    if (env.folder) this.record.folder = env.folder;
    if (env.configEnv) this.record.configEnv = {...env.configEnv};
  }
  read(path: string): string | null {
    return this.pending.has(path) ? this.pending.get(path)!.after : readInstallFile(path);
  }
  edit(path: string, fn: (old: string | null) => string, undo: UndoOp[], backupDir?: string): boolean {
    const old = this.read(path);
    let next: string;
    try { next = fn(old); }
    catch (error) { throw new InstallError(`cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`); }
    let change = this.record.files.find(file => file.path === path);
    if (change?.action === "moved") throw new InstallError(`cannot update ${path}: already moved aside`);
    if (!change && next === old) return false;
    if (!change) {
      const backup = old === null ? undefined : backupPath(backupDir ? join(backupDir, basename(path)) : path, this.env.ctx.now);
      if (backup) this.pending.set(backup, { path: backup, before: null, after: old, mode: lstatSync(path).mode & 0o700 });
      change = { path, action: old === null ? "created" : "edited", backup, exact: true, undo: [] };
      this.record.files.push(change);
    } else if (old === null || sha256(old) !== change.afterHash) change.exact = false;
    change.undo = mergeUndo(change.undo, undo);
    change.afterHash = sha256(next);
    change.managed = { schema: 1, hash: sha256(managedContent(next, change.undo)) };
    // Include unchanged assets in the plan so fingerprints and integrity checks cover them.
    this.pending.set(path, { path, before: this.pending.has(path) ? this.pending.get(path)!.before : old, after: next });
    if (next !== old && !this.touched.includes(path)) this.touched.push(path);
    return next !== old;
  }
  moveAside(path: string): void {
    if (this.env.mode === "reconcile") return;
    if (this.record.files.some(file => file.path === path)) {
      this.notes.push(`${path} already recorded; skipping move`); return;
    }
    const old = this.read(path);
    if (old === null) return;
    const backup = backupPath(path, this.env.ctx.now);
    this.pending.set(backup, { path: backup, before: null, after: old, mode: lstatSync(path).mode & 0o700 });
    this.pending.set(path, { path, before: old, after: null });
    this.record.files.push({ path, action: "moved", backup, undo: [] });
    this.touched.push(path);
  }
  async run(argv: string[], undo?: string[], options: { quiet?: boolean; successNote?: string } = {}): Promise<void> {
    if (this.env.mode === "reconcile") throw new InstallError("automatic refresh cannot execute agent commands");
    try {
      const result = await this.env.ctx.run(argv, 30000, this.env.configEnv ? {env: {...this.env.ctx.env, ...this.env.configEnv}} : undefined);
      if (result.code === 0 && options.successNote) this.notes.push(options.successNote);
      if (!options.quiet && result.code !== 0) this.notes.push(`\`${shellCommand(argv)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
    } catch (error) {
      if (!options.quiet) this.notes.push(`\`${shellCommand(argv)}\` failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (undo) {
      const same = (item: string[]) => JSON.stringify(item) === JSON.stringify(undo);
      if (!this.record.commands.some(command => same(command.undo))) this.record.commands.push({ undo: [...undo] });
      if (!this.commandUndos.some(same)) this.commandUndos.push([...undo]);
    }
  }
  async rollback(): Promise<void> {
    for (const undo of this.commandUndos.reverse()) {
      try { await this.env.ctx.run(undo, 30000, this.env.configEnv ? {env: {...this.env.ctx.env, ...this.env.configEnv}} : undefined); } catch (error) { this.notes.push(`rollback command failed: ${String(error)}`); }
    }
    this.pending.clear(); this.commandUndos = [];
  }
  commit(): void {
    const manifest = readManifest(this.env.ctx);
    this.record.notes = [...this.notes];
    if (JSON.stringify(manifest.planners[this.record.planner]) === JSON.stringify(this.record)) return;
    manifest.planners[this.record.planner] = this.record;
    commitInstall(this.env.ctx, [...this.pending.values()].filter(file => file.before !== file.after), JSON.stringify(manifest, null, 2) + "\n");
  }
}
export async function runInstall(env: InstallEnv, planner: string, fn: (tx: Txn) => void | Promise<void>): Promise<{ record: PlannerRecord; touched: string[]; notes: string[] }> {
  return withInstallLock(env.ctx, async () => {
    recoverInstall(env.ctx);
    const tx = await planInstall(env, planner, fn);
    try { tx.commit(); }
    catch (error) { await tx.rollback(); throw error; }
    return { record: tx.record, touched: tx.touched, notes: tx.notes };
  });
}

export async function planInstall(env: InstallEnv, planner: string, fn: (tx: Txn) => void | Promise<void>): Promise<Txn> {
  validateInstallArgv(env.ctx.env, env.pacerArgv);
  planner = env.plannerKey ?? planner;
  const tx = new Txn(env, planner, readManifest(env.ctx).planners[planner]);
  if (isDevArgv(env.pacerArgv)) tx.notes.push(`WARNING: development install bakes this command into integrations: ${shellCommand(env.pacerArgv)}`);
  try { await fn(tx); }
  catch (error) { await tx.rollback(); throw error; }
  return tx;
}
