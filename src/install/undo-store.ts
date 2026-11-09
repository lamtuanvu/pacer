import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readInstallFile, writeInstallFile } from "./atomic";
import { sha256 } from "./fsx";
import type { Ctx } from "../types";
import type { UndoSnapshot } from "./manifest";

/**
 * Private, host-owned snapshot store for agent.undo. Pre-connect file contents
 * (which may hold planner credentials, SEC-1) are copied to separate files
 * under $PACER_HOME/undo/<key>/ (directory 0700, files 0600, written
 * atomically); install-manifest.json keeps only metadata: path, hashes, size,
 * time, revision and a reference to each copy.
 */

/** Total before-image bytes one connect may snapshot for undo. Beyond this there is no undo. */
export const UNDO_CAP_BYTES = 2 * 1024 * 1024;
/** How long a snapshot is kept after its connect (matches the 7-day undo window). */
export const UNDO_RETENTION_S = 7 * 86_400;

export interface SnapshotChange {
  path: string;
  /** pre-connect content; null when the connect created the file (undo removes it) */
  before: string | null;
  /** pre-connect mode, retained only in the private store, never the manifest */
  mode?: number;
  /** post-connect content; null when the connect removed the file */
  after?: string | null;
}

interface StoreMeta {
  schema: 1;
  at: number;
  revision: string;
  files: Record<string, { name: string; size: number; mode: number }>;
}

const undoRoot = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "undo");
const sanitize = (key: string) => key.replace(/[^A-Za-z0-9.#_=-]/g, "_");
/** Sanitized per-planner snapshot directory under $PACER_HOME/undo. */
export function undoKeyDir(ctx: Pick<Ctx, "pacerHome">, key: string): string {
  return join(undoRoot(ctx), sanitize(key));
}

function readMeta(ctx: Pick<Ctx, "pacerHome">, key: string): StoreMeta | null {
  try {
    return JSON.parse(readFileSync(join(undoKeyDir(ctx, key), "meta.json"), "utf8")) as StoreMeta;
  } catch {
    return null;
  }
}

function ensurePrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Total before-image bytes for `changed` (the size-cap gate). */
export function snapshotTotalBytes(changed: readonly SnapshotChange[]): number {
  return changed.reduce((sum, file) => sum + (file.before?.length ?? 0), 0);
}

/** Deterministic, always-set revision for a connect's snapshot (CLI, setup and config paths included). */
export function snapshotRevision(at: number, changed: readonly SnapshotChange[]): string {
  return sha256(
    JSON.stringify({
      at,
      files: changed.map((file) => [
        file.path,
        file.before === null ? null : sha256(file.before),
        file.after == null ? null : sha256(file.after),
      ]),
    }),
  );
}

/** Write copies + meta into `dir`. Callers own clearing/superseding semantics. */
function writeSnapshotInto(
  dir: string,
  ctx: Pick<Ctx, "pacerHome">,
  changed: readonly SnapshotChange[],
  revision: string | undefined,
  at: number,
): { snapshot: UndoSnapshot; dir: string } {
  ensurePrivate(dir);
  const meta: StoreMeta = { schema: 1, at, revision: revision ?? snapshotRevision(at, changed), files: {} };
  const files: UndoSnapshot["files"] = [];
  let index = 0;
  for (const file of changed) {
    const afterHash = file.after == null ? null : sha256(file.after);
    if (file.before !== null) {
      const name = `f-${index++}`;
      writeInstallFile(join(dir, name), file.before, 0o600);
      meta.files[file.path] = { name, size: file.before.length, mode: file.mode ?? 0o600 };
      files.push({
        path: file.path,
        beforeHash: sha256(file.before),
        size: file.before.length,
        afterHash,
        copy: name,
      });
    } else {
      files.push({ path: file.path, afterHash });
    }
  }
  writeInstallFile(join(dir, "meta.json"), JSON.stringify(meta), 0o600);
  return { snapshot: { at, revision: meta.revision, size: snapshotTotalBytes(changed), files }, dir };
}

/**
 * Build a snapshot for one connect's changed files in place (test helper and
 * standalone convenience). Returns null above the size cap (and clears the key).
 */
export function writeUndoSnapshot(
  ctx: Pick<Ctx, "pacerHome">,
  key: string,
  changed: readonly SnapshotChange[],
  revision?: string,
  at = Math.floor(Date.now() / 1000),
): UndoSnapshot | null {
  if (snapshotTotalBytes(changed) > UNDO_CAP_BYTES) {
    clearUndoSnapshot(ctx, key);
    return null;
  }
  const dir = undoKeyDir(ctx, key);
  // A newer connect supersedes any earlier snapshot for the same key.
  rmSync(dir, { recursive: true, force: true });
  const { snapshot } = writeSnapshotInto(dir, ctx, changed, revision, at);
  chmodSync(undoRoot(ctx), 0o700);
  pruneUndoSnapshots(ctx, key, at);
  return snapshot;
}

/**
 * Stage a connect's snapshot in a temp directory without touching the live key
 * dir. Caller stages before commit and calls `commitStagedUndoSnapshot` only
 * after the manifest actually commits, so an aborted commit leaves the prior
 * snapshot's copies intact and undoable. Returns null above the size cap.
 */
export function stageUndoSnapshot(
  ctx: Pick<Ctx, "pacerHome">,
  key: string,
  changed: readonly SnapshotChange[],
  revision?: string,
  at = Math.floor(Date.now() / 1000),
): { snapshot: UndoSnapshot; dir: string } | null {
  if (snapshotTotalBytes(changed) > UNDO_CAP_BYTES) {
    clearUndoSnapshot(ctx, key);
    return null;
  }
  const dir = join(undoRoot(ctx), `staging-${sanitize(key)}-${randomUUID()}`);
  ensurePrivate(dir);
  chmodSync(undoRoot(ctx), 0o700);
  return writeSnapshotInto(dir, ctx, changed, revision, at);
}

/** Atomically move a staged snapshot into the live key dir and prune expired keys. */
export function commitStagedUndoSnapshot(
  ctx: Pick<Ctx, "pacerHome">,
  key: string,
  stagedDir: string,
  now: number,
): void {
  const dir = undoKeyDir(ctx, key);
  rmSync(dir, { recursive: true, force: true });
  renameSync(stagedDir, dir);
  chmodSync(dir, 0o700);
  pruneUndoSnapshots(ctx, key, now);
}

/** Drop a staged snapshot without touching the live key dir (used on aborted commit). */
export function discardStagedUndoSnapshot(stagedDir: string): void {
  rmSync(stagedDir, { recursive: true, force: true });
}

/** Read one restored before-copy for `path`. Returns null when absent. */
export function readSnapshotFile(
  ctx: Pick<Ctx, "pacerHome">,
  key: string,
  path: string,
): { text: string; mode: number } | null {
  const meta = readMeta(ctx, key);
  const entry = meta?.files[path];
  if (!entry) return null;
  const text = readInstallFile(join(undoKeyDir(ctx, key), entry.name));
  return text === null ? null : { text, mode: entry.mode };
}

/** Remove one key's snapshot directory. */
export function clearUndoSnapshot(ctx: Pick<Ctx, "pacerHome">, key: string): void {
  rmSync(undoKeyDir(ctx, key), { recursive: true, force: true });
}

/** Remove snapshots older than the retention window (and any stale dirs), keeping `keepKey`. */
export function pruneUndoSnapshots(ctx: Pick<Ctx, "pacerHome">, key: string, now: number): void {
  let root: string[];
  try {
    root = readdirSync(undoRoot(ctx));
  } catch {
    return;
  }
  for (const name of root) {
    if (name === key) continue;
    const meta = readMeta(ctx, name);
    if (!meta || now - meta.at > UNDO_RETENTION_S) {
      rmSync(join(undoRoot(ctx), name), { recursive: true, force: true });
    }
  }
}