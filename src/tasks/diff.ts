import { repoFs, withTimeout } from "../core/path-probe";
import { existsSync, readdirSync, mkdirSync, openSync, writeFileSync, closeSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { boundedGitRead } from "../core/git";
import { CoreError } from "../core/errors";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";
import type { TaskRecord } from "./types";

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffOptions { path?: string; summaryOnly?: boolean; snapshot?: boolean }
export interface TaskDiff {
  base: string | null; worktree: string; files: DiffFile[]; patch: string; diff: string;
  untracked: string[]; truncated: boolean; note?: string;
}
const snapshotFile = (ctx: Ctx, task: TaskRecord) => join(ctx.pacerHome, "runs", task.id, String(task.run?.attempt ?? task.attempts.length), "diff.json");

export async function taskDiff(ctx: Ctx, task: TaskRecord, o: DiffOptions = {}): Promise<TaskDiff> {
  const reviewWorktree = task.result?.worktree?.startsWith(`${task.run?.host}:`) ? undefined : task.result?.worktree;
  const worktree = task.run?.host
    ? reviewWorktree ?? task.brief.repo
    : task.run?.workdir ?? task.worktree ?? task.result?.worktree ?? task.brief.repo;
  const base = task.run?.mode === "new" ? task.baseSha ?? task.baseBranch ?? null : null;
  if (task.run?.host && (!reviewWorktree || task.state === "running")) {
    return { base, worktree, files: [], patch: "", diff: "", untracked: [], truncated: false, note: `changes are on ${task.run.host} until the run ends` };
  }
  if (!o.snapshot && !await withTimeout(() => repoFs.access(worktree)).then(() => true, error => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  })) {
    const stored = readJson<TaskDiff>(snapshotFile(ctx, task));
    if (stored) {
      // Git emits patch sections in the same order as --numstat. Avoid parsing
      // quoted filenames so tabs, newlines and renames remain unambiguous.
      const sections = stored.patch.split(/(?=^diff --git )/m).filter(Boolean);
      const output = o.path === undefined ? stored.patch : sections[stored.files.findIndex(f => f.path === o.path)] ?? "";
      const patch = o.summaryOnly ? "" : capPatch(output, o.path === undefined ? 1 : 4);
      return { ...stored, patch, diff: patch, truncated: !o.summaryOnly && patch !== output,
        untracked: o.summaryOnly ? [] : stored.untracked.filter(p => o.path === undefined || p === o.path) };
    }
  }
  const git = async (args: string[]) => {
    const argv = ["git", "--literal-pathspecs", "-C", worktree, ...args];
    const r = await (o.summaryOnly ? boundedGitRead(ctx.run, argv) : ctx.run(argv, 10_000));
    if (r.code !== 0) throw new CoreError("invalid_input", `cannot diff: ${r.stderr.trim().split("\n")[0] || `git exited with code ${r.code}`}`);
    return r.stdout;
  };
  const args = ["diff", ...(base ? ["--merge-base"] : []), "--no-ext-diff", "--no-textconv", "-M"];
  const against = ["--end-of-options", base ?? "HEAD", "--"];
  const [nameOutput, statOutput] = await Promise.all([
    git([...args, "--name-status", "-z", ...against]),
    git([...args, "--numstat", "-z", ...against]),
  ]);
  const names = nameOutput.split("\0");
  const statuses = new Map<string, DiffFile["status"]>();
  const renamedFrom = new Map<string, string>();
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++];
    let path = names[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = path;
      path = names[i++];
      renamedFrom.set(path, source);
    }
    statuses.set(path, status.startsWith("R") ? "renamed" : status === "A" || status.startsWith("C") ? "added" : status === "D" ? "deleted" : "modified");
  }
  const stats = statOutput.split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < stats.length && stats[i];) {
    const entry = stats[i++];
    const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1);
    const added = entry.slice(0, first), removed = entry.slice(first + 1, second);
    let path = entry.slice(second + 1);
    if (!path) { i++; path = stats[i++]; } // -z encodes a rename as old NUL new NUL.
    files.push({ path, status: statuses.get(path) ?? "modified", added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), binary: added === "-" || removed === "-" });
  }
  if (o.summaryOnly) return { base, worktree, files, patch: "", diff: "", untracked: [], truncated: false };
  const paths = o.path === undefined ? [] : [...new Set([renamedFrom.get(o.path), o.path].filter((p): p is string => p !== undefined))];
  const output = await git([...args, ...against, ...paths]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", ...(o.path === undefined ? [] : ["--", o.path])])).split("\0").filter(Boolean);
  const patch = o.snapshot ? output : capPatch(output, o.path === undefined ? 1 : 4);
  return { base, worktree, files, patch, diff: patch, untracked, truncated: patch !== output };
}

function capPatch(output: string, maxMb: number): string {
  const bytes = Buffer.from(output, "utf8"), max = maxMb * 1024 * 1024;
  return bytes.length > max ? new TextDecoder().decode(bytes.subarray(0, max), { stream: true }) : output;
}

/** Preserve review evidence before the attempt's checkout can be removed. */
export async function persistTaskDiff(ctx: Ctx, task: TaskRecord): Promise<void> {
  const result = await taskDiff(ctx, task, { snapshot: true });
  if (result.note) return; // Remote changes have not been transferred locally.
  const file = snapshotFile(ctx, task);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(result)); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } finally { rmSync(tmp, { force: true }); }
}

/** Remove disposable run files while retaining each attempt's review evidence. */
export function cleanTaskRuns(ctx: Ctx, task: TaskRecord): void {
  const root = join(ctx.pacerHome, "runs", task.id);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && existsSync(join(path, "diff.json"))) {
      for (const name of readdirSync(path)) {
        if (name !== "diff.json") rmSync(join(path, name), { recursive: true, force: true });
      }
    } else rmSync(path, { recursive: true, force: true });
  }
  if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
}
