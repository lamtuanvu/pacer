import type { Ctx } from "../types";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readTask } from "../tasks/store";
import { CoreError } from "../core/errors";
import { readWorkspaceFile } from "./openat";

export interface SessionFileRequest { id: string; attempt: number; reference: string }
export interface SessionFileResult { path: string; kind: "code" | "markdown" | "html"; text: string; size: number; modified: string; line?: number; column?: number }

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function readSessionFile(ctx: Ctx, request: SessionFileRequest): SessionFileResult {
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
  try { root = realpathSync(run.workdir); }
  catch { throw new CoreError("not_found", "Session workspace is unavailable"); }
  const absolute = resolve(root, name);
  if (!inside(root, absolute) || absolute === root) throw new CoreError("not_allowed", "File is outside the session workspace");
  let privateDirectory: { dev: number; ino: number } | undefined;
  try {
    const state = realpathSync(ctx.pacerHome);
    const info = statSync(state);
    privateDirectory = { dev: info.dev, ino: info.ino };
    if (inside(state, absolute)) throw new CoreError("not_allowed", "Private Pacer state cannot be previewed");
    try {
      if (inside(state, realpathSync(absolute))) throw new CoreError("not_allowed", "Private Pacer state cannot be previewed");
    } catch (error) { if (error instanceof CoreError) throw error; }
  } catch (error) { if (error instanceof CoreError) throw error; }
  const path = relative(root, absolute);
  let result: ReturnType<typeof readWorkspaceFile>;
  try { result = readWorkspaceFile(root, path.split(sep), privateDirectory); }
  catch (error) {
    if (error instanceof RangeError) throw new CoreError("too_large", "File is too large to preview");
    try { lstatSync(absolute); }
    catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ENOENT" || (probe as NodeJS.ErrnoException).code === "ENOTDIR")
        throw new CoreError("not_found", "File no longer exists in this session workspace");
    }
    throw new CoreError("not_allowed", "File is unavailable or cannot be previewed");
  }
  if (result.bytes.includes(0)) throw new CoreError("invalid_input", "Binary files cannot be previewed");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); }
  catch { throw new CoreError("invalid_input", "File is not UTF-8 text"); }
  const kind = /\.md(?:own)?$/i.test(path) ? "markdown" : /\.html?$/i.test(path) ? "html" : "code";
  return { path: path.split(sep).join("/"), kind, text, size: result.size, modified: result.modified,
    ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}
