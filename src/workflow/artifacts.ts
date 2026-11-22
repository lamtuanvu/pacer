// Step artifacts for the workflow frame (Phase 5): copy a file from the asking
// task's worktree or the run's evidence directory into PACER_HOME/runs/<run>/artifacts/
// with size caps. Blobs are DATA (0600); paths are jail-checked with realpath.
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync,
} from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import { getRun, stepByTask, workflowDatabase } from "./store";

export const ARTIFACT_FILE_LIMIT = 10 * 1024 * 1024;
export const ARTIFACT_RUN_LIMIT = 200 * 1024 * 1024;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newArtifactId(): string {
  const bytes = randomBytes(10);
  let id = "art_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}

export type ArtifactRow = {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  label: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
};

type ArtifactDbRow = {
  id: string;
  run_id: string;
  step_id: string;
  attempt: number;
  label: string;
  name: string;
  mime: string;
  size: number;
  created_at: number;
};

function fromRow(row: ArtifactDbRow): ArtifactRow {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    attempt: row.attempt,
    label: row.label,
    name: row.name,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
  };
}

/** Directory holding one run's artifact blobs: PACER_HOME/runs/<runId>/artifacts. */
export function runArtifactsDir(ctx: Ctx, runId: string): string {
  return join(ctx.pacerHome, "runs", runId, "artifacts");
}

/** Evidence directory a step may read from when attaching captures. */
export function runEvidenceDir(ctx: Ctx, runId: string): string {
  return join(ctx.pacerHome, "runs", runId, "evidence");
}

/** Flat blob path: step id lives in the DB only (I9 — no step id in the filesystem). */
function artifactBlobPath(ctx: Ctx, runId: string, artId: string): string {
  return join(runArtifactsDir(ctx, runId), artId);
}

function assertUnderArtifacts(dest: string, root: string): void {
  const resolvedDest = resolve(dest);
  const resolvedRoot = resolve(root);
  if (resolvedDest !== resolvedRoot && !resolvedDest.startsWith(resolvedRoot + sep)) {
    throw new CoreError("not_allowed", "artifact destination escapes the run artifacts directory");
  }
}

function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json";
  if (ext === ".md" || ext === ".txt" || ext === ".log") return "text/plain; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function realDir(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const real = realpathSync(path);
    const st = lstatSync(real);
    if (!st.isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

function underRoot(realFile: string, realRoot: string): boolean {
  return realFile === realRoot || realFile.startsWith(realRoot + sep);
}

/** Allowed roots: the task worktree (if any) and the run evidence directory. */
function allowedRoots(ctx: Ctx, taskId: string, runId: string): string[] {
  const roots: string[] = [];
  const task = readTask(ctx, taskId);
  if (task?.worktree) {
    const wt = realDir(task.worktree);
    if (wt) roots.push(wt);
  }
  const evidence = runEvidenceDir(ctx, runId);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const ev = realDir(evidence);
  if (ev) roots.push(ev);
  return roots;
}

function resolveJaildPath(ctx: Ctx, taskId: string, runId: string, requested: string): string {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new CoreError("invalid_input", "path is required");
  }
  if (requested.split(/[/\\]/).includes("..")) {
    throw new CoreError("not_allowed", "path is outside the task worktree and evidence directory");
  }
  const abs = resolve(requested);
  let realFile: string;
  try {
    // realpath follows symlinks: a link that escapes the jail is refused below.
    realFile = realpathSync(abs);
  } catch {
    throw new CoreError("not_found", "artifact source file not found");
  }
  const st = lstatSync(realFile);
  if (!st.isFile()) {
    throw new CoreError("not_allowed", "artifact source must be a regular file");
  }
  const roots = allowedRoots(ctx, taskId, runId);
  if (!roots.some(root => underRoot(realFile, root))) {
    throw new CoreError("not_allowed", "path is outside the task worktree and evidence directory");
  }
  return realFile;
}

function runBytesUsed(ctx: Ctx, runId: string): number {
  const row = workflowDatabase(ctx).query<{ n: number | null }, [string]>(
    "SELECT SUM(size) AS n FROM workflow_artifacts WHERE run_id = ?",
  ).get(runId);
  return Number(row?.n ?? 0);
}

/**
 * Copy a file from the asking step task's worktree or evidence directory into the
 * run artifact store. Returns the new art_ id metadata.
 */
export function storeArtifact(ctx: Ctx, taskId: string, input: { path: string; label: string }): ArtifactRow & { absPath: string } {
  if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 256) {
    throw new CoreError("invalid_input", "label must be 1..256 characters");
  }
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} is not a workflow step`);
  const run = getRun(ctx, step.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${step.runId}`);

  const source = resolveJaildPath(ctx, taskId, run.id, input.path);
  const size = lstatSync(source).size;
  if (size > ARTIFACT_FILE_LIMIT) {
    throw new CoreError("too_large", `artifact exceeds ${ARTIFACT_FILE_LIMIT} bytes`);
  }
  const used = runBytesUsed(ctx, run.id);
  if (used + size > ARTIFACT_RUN_LIMIT) {
    throw new CoreError("too_large", `run artifacts would exceed ${ARTIFACT_RUN_LIMIT} bytes`);
  }

  const id = newArtifactId();
  const name = basename(source);
  const mime = mimeFor(name);
  const root = runArtifactsDir(ctx, run.id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dest = artifactBlobPath(ctx, run.id, id);
  assertUnderArtifacts(dest, root);
  const tmp = join(root, `${id}.tmp-${process.pid}`);
  assertUnderArtifacts(tmp, root);
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o600);
    renameSync(tmp, dest);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* */ }
    throw error instanceof CoreError ? error : new CoreError("unavailable", "failed to store artifact");
  }

  workflowDatabase(ctx).query(
    "INSERT INTO workflow_artifacts(id, run_id, step_id, attempt, label, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, run.id, step.stepId, step.attempt, input.label.trim(), name, mime, size, ctx.now);

  return {
    ...fromRow({
      id, run_id: run.id, step_id: step.stepId, attempt: step.attempt,
      label: input.label.trim(), name, mime, size, created_at: ctx.now,
    }),
    absPath: dest,
  };
}

export function listArtifacts(ctx: Ctx, runId: string): ArtifactRow[] {
  workflowDatabase(ctx);
  return workflowDatabase(ctx).query<ArtifactDbRow, [string]>(
    "SELECT * FROM workflow_artifacts WHERE run_id = ? ORDER BY created_at, id",
  ).all(runId).map(fromRow);
}

export function getArtifact(ctx: Ctx, runId: string, artId: string): (ArtifactRow & { absPath: string }) | null {
  workflowDatabase(ctx);
  const row = workflowDatabase(ctx).query<ArtifactDbRow, [string, string]>(
    "SELECT * FROM workflow_artifacts WHERE run_id = ? AND id = ?",
  ).get(runId, artId);
  if (!row) return null;
  const absPath = artifactBlobPath(ctx, runId, row.id);
  if (!existsSync(absPath)) return null;
  return { ...fromRow(row), absPath };
}

/** True when every art_ id exists on this run. */
export function artifactsExist(ctx: Ctx, runId: string, ids: string[]): boolean {
  if (ids.length === 0) return true;
  workflowDatabase(ctx);
  for (const id of ids) {
    if (!/^art_[a-z2-7]{10}$/.test(id)) return false;
    const row = workflowDatabase(ctx).query<{ id: string }, [string, string]>(
      "SELECT id FROM workflow_artifacts WHERE run_id = ? AND id = ?",
    ).get(runId, id);
    if (!row) return false;
  }
  return true;
}
