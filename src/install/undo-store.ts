import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
/** Sanitized per-planner snapshot directory under $PACER_HOME/undo. */
export function undoKeyDir(ctx: Pick<Ctx, "pacerHome">, key: string): string {
  return join(undoRoot(ctx), key.replace(/[^A-Za-z0-9.#_=-]/g, "_"));
}

function readMeta(ctx: Pick<Ctx, "pacerHome">, key: string): StoreMeta | null {
  try {
    return JSON.parse(readFileSync(join(undoKeyDir(ctx, key), "meta.json"), "utf8")) as StoreMeta;
  } catch {
    return null;
  }
}

/** Build a snapshot for one connect's changed files, moving content into the store. Returns null above the size cap. */
export function writeUndoSnapshot(
  ctx: Pick<Ctx, "pacerHome">,
  key: string,
  changed: readonly SnapshotChange[],
  revision?: string,
  at = Math.floor(Date.now() / 1000),
): UndoSnapshot | null {
  const total = changed.reduce((sum, file) => sum + (file.before?.length ?? 0), 0);
  if (total > UNDO_CAP_BYTES) {
    clearUndoSnapshot(ctx, key);
    return null;
  }
  const dir = undoKeyDir(ctx, key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(undoRoot(ctx), 0o700);
  // A newer connect supersedes any earlier snapshot for the same key.
  for (const entry of readdirSync(dir)) {
    if (entry !== "meta.json") rmSync(join(dir, entry), { force: true });
  }
  const rev = revision ?? snapshotRevision(at, changed);
  const meta: StoreMeta = { schema: 1, at, revision: rev, files: {} };
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
  pruneUndoSnapshots(ctx, key, at);
  return { at, revision: rev, size: total, files };
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