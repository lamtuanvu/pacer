import { basename, join } from "node:path";
import { backupPath, sha256 } from "./helpers";
import { managedContent } from "./managed-content";
import { mergeUndo, type PlannerRecord, type UndoOp } from "./undo";

export class InstallError extends Error {
  constructor(message: string) { super(message); this.name = "InstallError"; }
}
export interface PlanIO {
  /** Only null means missing; permission, redirection and other errors must reject. */
  read(path: string): Promise<{ text: string; mode: number } | null>;
  signal?: AbortSignal;
}
export interface PlanEnv {
  now: number;
  pacerArgv: string[];
  mcp?: boolean;
  folder?: string;
  plannerAccount?: string;
  plannerKey?: string;
  configEnv?: Record<string, string>;
  mode?: "connect" | "reconcile";
  skillFolder?: string;
}
export interface PendingFile {
  path: string;
  before: string | null;
  after: string | null;
  mode?: number;
  beforeMode?: number;
}

/** Internal staging only. A pending plan does not authorize or commit file effects. */
export class InstallPlan {
  readonly record: PlannerRecord;
  readonly touched: string[] = [];
  readonly notes: string[] = [];
  readonly pending = new Map<string, PendingFile>();
  readonly env: PlanEnv;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly io: PlanIO, env: PlanEnv, planner: string, prior?: PlannerRecord) {
    this.env = structuredClone(env);
    this.record = prior ? structuredClone(prior) : {
      planner: env.plannerKey ?? planner, installedAt: env.now, pacerArgv: [...env.pacerArgv], files: [], commands: [], notes: [],
    };
    this.record.pacerArgv = [...env.pacerArgv];
    if (env.mcp !== undefined && env.mode !== "reconcile") this.record.mcp = env.mcp;
    if (env.plannerAccount) this.record.account = env.plannerAccount;
    if (env.folder) this.record.folder = env.folder;
    if (env.configEnv) this.record.configEnv = { ...env.configEnv };
  }
  private active(): void {
    if (this.io.signal?.aborted) throw new InstallError("installation planning cancelled");
  }
  private sequence<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => { this.active(); return await action(); });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async external(path: string) {
    this.active();
    const image = await this.io.read(path);
    this.active();
    if (image === null) return null;
    if (!image || typeof image.text !== "string" || !Number.isSafeInteger(image.mode) || image.mode < 0) {
      throw new InstallError("invalid installation file image");
    }
    return { text: image.text, mode: image.mode };
  }
  private async image(path: string): Promise<{ text: string; mode: number } | null> {
    this.active();
    const staged = this.pending.get(path);
    if (!staged) return await this.external(path);
    return staged.after === null ? null : { text: staged.after, mode: staged.mode ?? staged.beforeMode ?? 0o600 };
  }
  read(path: string): Promise<string | null> {
    return this.sequence(async () => (await this.image(path))?.text ?? null);
  }
  private async backup(path: string): Promise<string> {
    const occupied = new Set(this.pending.keys());
    for (;;) {
      const candidate = backupPath(path, this.env.now, name => occupied.has(name));
      const image = await this.external(candidate);
      if (image === null && !this.pending.has(candidate)) return candidate;
      occupied.add(candidate);
    }
  }
  edit(path: string, fn: (old: string | null) => string, undo: UndoOp[], backupDir?: string): Promise<boolean> {
    return this.sequence(async () => {
      const image = await this.image(path), old = image?.text ?? null;
      this.active();
      let next: string;
      try { next = fn(old); }
      catch (error) { throw new InstallError(`cannot update ${path}: ${error instanceof Error ? error.message : String(error)}`); }
      this.active();
      const prior = this.record.files.find(file => file.path === path);
      if (prior?.action === "moved") throw new InstallError(`cannot update ${path}: already moved aside`);
      if (!prior && next === old) return false;
      const change = prior ? structuredClone(prior) : {
        path, action: old === null ? "created" as const : "edited" as const,
        backup: old === null ? undefined : await this.backup(backupDir ? join(backupDir, basename(path)) : path),
        exact: true, undo: [] as UndoOp[],
      };
      if (prior && (old === null || sha256(old) !== change.afterHash)) change.exact = false;
      change.undo = mergeUndo(change.undo, undo);
      change.afterHash = sha256(next);
      change.managed = { schema: 1, hash: sha256(managedContent(next, change.undo)) };
      this.active();
      // Publish only after every read/probe/computation succeeds. The first
      // observed before bytes/mode remain the future host commit precondition.
      if (!prior && change.backup) this.pending.set(change.backup, {
        path: change.backup, before: null, after: old, mode: image!.mode & 0o700,
      });
      if (prior) this.record.files[this.record.files.indexOf(prior)] = change;
      else this.record.files.push(change);
      const pending = this.pending.get(path);
      this.pending.set(path, {
        path, before: pending ? pending.before : old, after: next,
        beforeMode: pending ? pending.beforeMode : image === null ? undefined : image.mode & 0o700,
      });
      if (next !== old && !this.touched.includes(path)) this.touched.push(path);
      return next !== old;
    });
  }
  moveAside(path: string): Promise<void> {
    return this.sequence(async () => {
      if (this.env.mode === "reconcile") return;
      if (this.record.files.some(file => file.path === path)) {
        this.notes.push(`${path} already recorded; skipping move`); return;
      }
      const image = await this.image(path);
      if (image === null) return;
      const backup = await this.backup(path);
      this.active();
      this.pending.set(backup, { path: backup, before: null, after: image.text, mode: image.mode & 0o700 });
      this.pending.set(path, { path, before: image.text, after: null, beforeMode: image.mode & 0o700 });
      this.record.files.push({ path, action: "moved", backup, undo: [] });
      this.touched.push(path);
    });
  }
}
