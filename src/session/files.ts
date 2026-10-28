import type { Ctx } from "../types";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readTask } from "../tasks/store";
import { CoreError } from "../core/errors";
import { readWorkspaceFile, resolveWorkspaceFile } from "./openat";
import { taskWorktreesDir } from "../supervisor/worktree";
import { isExecutorSession } from "../install/role";

export interface SessionFileRequest { id: string; attempt: number; reference: string }
export interface SessionFileResult { path: string; kind: "code" | "markdown" | "html"; text: string; size: number; modified: string; line?: number; column?: number }

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when root is within one pacer task worktree, <state>/worktrees/<repo>-<8 hex>/<task id>; the per-repo and worktrees directories never qualify. */
function insideTaskWorktree(ctx: Ctx, state: string, root: string): boolean {
  const worktrees = join(state, "worktrees");
  try {
    const info = lstatSync(taskWorktreesDir(ctx));
    if (!info.isDirectory() || realpathSync(taskWorktreesDir(ctx)) !== worktrees) return false;
  } catch { return false; }
  if (!inside(worktrees, root)) return false;
  const [tag, task] = relative(worktrees, root).split(sep);
  return !!tag && /-[0-9a-f]{8}$/.test(tag) && !!task && /^t-\d{8}-\d{6}-[0-9a-f]{4}$/.test(task);
}

interface LocatedFile {
  root: string; rootIdentity: { dev: number; ino: number }; privateDirectory?: { dev: number; ino: number };
  absolute: string; path: string; line?: number; column?: number;
}

/** Validate a reference against one local attempt's workspace; shared by the read and the desktop hand-off. */
function locateSessionFile(ctx: Ctx, request: SessionFileRequest): LocatedFile {
  if (isExecutorSession(ctx) || ctx.env.PACER_WORK_GRANT)
    throw new CoreError("not_allowed", "Session files are for people viewing sessions, not executor sessions");
  const task = readTask(ctx, request.id);
  if (!task) throw new CoreError("unknown_task", "Session not found");
  const run = task.run;
  if (!run || run.attempt !== request.attempt) throw new CoreError("conflict", "This session attempt has changed; refresh it");
  if (run.host || task.backend === "orca") throw new CoreError("not_allowed", "This session's files are not available here");
  if (!request.reference || request.reference.length > 4096 || /[\x00-\x1f\x7f]/.test(request.reference))
    throw new CoreError("invalid_input", "Invalid file reference");
  const location = /:(\d+)(?::(\d+))?$/.exec(request.reference);
  const name = location ? request.reference.slice(0, location.index) : request.reference;
  const line = location ? Number(location[1]) : undefined;
  const column = location?.[2] ? Number(location[2]) : undefined;
  if (!name || (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) ||
      (column !== undefined && (!Number.isSafeInteger(column) || column < 1)))
    throw new CoreError("invalid_input", "Invalid file location");
  let root: string;
  let rootIdentity: { dev: number; ino: number };
  try { root = realpathSync(run.workdir); const info = statSync(root); rootIdentity = { dev: info.dev, ino: info.ino }; }
  catch { throw new CoreError("not_found", "Session workspace is unavailable"); }
  const absolute = resolve(root, name);
  if (!inside(root, absolute) || absolute === root) throw new CoreError("not_allowed", "File is outside the session workspace");
  let privateDirectory: { dev: number; ino: number } | undefined;
  try {
    const state = realpathSync(ctx.pacerHome);
    const info = statSync(state);
    privateDirectory = { dev: info.dev, ino: info.ino };
    const ownWorktree = insideTaskWorktree(ctx, state, root);
    const isPrivate = (target: string) => inside(state, target) && !(ownWorktree && inside(root, target));
    if (isPrivate(absolute)) throw new CoreError("not_allowed", "Private Pacer state cannot be previewed");
    try {
      if (isPrivate(realpathSync(absolute))) throw new CoreError("not_allowed", "Private Pacer state cannot be previewed");
    } catch (error) { if (error instanceof CoreError) throw error; }
  } catch (error) { if (error instanceof CoreError) throw error; }
  return { root, rootIdentity, privateDirectory, absolute, path: relative(root, absolute), line, column };
}

/** Run the descriptor-relative traversal and map its failures to the read's typed errors. */
function traverse<T>(file: LocatedFile, walk: typeof readWorkspaceFile | typeof resolveWorkspaceFile): T {
  try { return walk(file.root, file.path.split(sep), file.privateDirectory, file.rootIdentity) as T; }
  catch (error) {
    if (error instanceof RangeError) throw new CoreError("too_large", "File is too large to preview");
    try { lstatSync(file.absolute); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ENOENT" || (probe as NodeJS.ErrnoException).code === "ENOTDIR")
        throw new CoreError("not_found", "File no longer exists in this session workspace");
    }
    throw new CoreError("not_allowed", "File is unavailable or cannot be previewed");
  }
}

const location = (file: LocatedFile) =>
  ({ ...(file.line === undefined ? {} : { line: file.line }), ...(file.column === undefined ? {} : { column: file.column }) });

export function readSessionFile(ctx: Ctx, request: SessionFileRequest): SessionFileResult {
  const file = locateSessionFile(ctx, request);
  const result = traverse<ReturnType<typeof readWorkspaceFile>>(file, readWorkspaceFile);
  if (result.bytes.includes(0)) throw new CoreError("invalid_input", "Binary files cannot be previewed");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
  catch { throw new CoreError("invalid_input", "File is not UTF-8 text"); }
  const path = file.path;
  const kind = /\.md(?:own)?$/i.test(path) ? "markdown" : /\.html?$/i.test(path) ? "html" : "code";
  return { path: path.split(sep).join("/"), kind, text, size: result.size, modified: result.modified, ...location(file) };
}

export interface SessionFileResolution {
  /** Real workspace root; the desktop shell re-walks from here without following symlinks. */
  root: string;
  path: string;
  absolute: string;
  dev: number;
  ino: number;
  line?: number;
  column?: number;
}

/** Resolve a session file by the read's bounded rules, for the desktop's open-in-editor hand-off (ADR 0011). Any regular file qualifies, including binary or oversized ones. */
export function resolveSessionFile(ctx: Ctx, request: SessionFileRequest): SessionFileResolution {
  const file = locateSessionFile(ctx, request);
  const identity = traverse<ReturnType<typeof resolveWorkspaceFile>>(file, resolveWorkspaceFile);
  return { root: file.root, path: file.path.split(sep).join("/"), absolute: file.absolute, dev: identity.dev, ino: identity.ino, ...location(file) };
}
