import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { taskWorktreePath } from "../supervisor/worktree";
import { ask } from "../core/tasks";
import { tasksDir, readTask, updateTask } from "../tasks/store";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";
import { bundleToFile, runRemote } from "./ssh";

type TransferResult = { ok: true; branch: string; commits: number; reviewWorktree: string } | { ok: false; reason: string; bundle?: string };

/** Collect the file before cleanliness checks, including failed/no-commit attempts. */
export async function receiveQuestion(ctx: Ctx, task: TaskRecord, host: HostCfg, run: RunRef): Promise<void> {
  if (!run.remoteWorktree) return;
  const result = await runRemote(ctx,host,SCRIPTS.QUESTION,[run.remoteWorktree]);
  if (result.code) throw new Error(result.stderr || "cannot read remote question");
  if (!result.stdout) return;
  const prior = readTask(ctx,task.id)?.question;
  if (!prior) await ask(ctx,task.id,result.stdout);
  const cleared = await runRemote(ctx,host,SCRIPTS.QUESTION_CLEAR,[run.remoteWorktree]);
  if (cleared.code) throw new Error(cleared.stderr || "cannot clear remote question");
}

/** Receive only committed task changes, after checking ancestry, cleanliness and identity. */
export async function transferBack(ctx: Ctx, task: TaskRecord, host: HostCfg, run: RunRef): Promise<TransferResult> {
  let branch = `pacer/${task.id}`, ref = `refs/heads/${branch}`;
  const remoteBranch = run.remoteBranch ?? branch;
  let bundle: string | undefined;
  const fail = (reason: string): TransferResult => ({ ok: false, reason, ...(bundle ? { bundle } : {}) });
  const git = (...args: string[]) => ctx.run(["git", "-C", task.brief.repo, ...args], 60000);
  try {
    await receiveQuestion(ctx,task,host,run);
    const exists = await git("show-ref", "--verify", "--quiet", ref);
    if (exists.code !== 0 && exists.code !== 1) return fail(exists.stderr.trim() || "local branch check failed");
    if (!run.remoteWorktree || !run.baseSha) return fail("remote run has no worktree or base");
    let current = "";
    if (exists.code === 0) {
      const head = await git("rev-parse", "--verify", ref);
      if (head.code) return fail("local branch check failed");
      current = head.stdout.trim();
      const ahead = await git("rev-list", "--count", `${run.baseSha}..${current}`);
      if (ahead.code) return fail("local branch ancestry check failed");
      if (ahead.stdout.trim() !== "0") {
        branch += `-r${run.attempt}`;
        ref = `refs/heads/${branch}`;
        current = "";
      }
    }
    const preflight = await runRemote(ctx, host, SCRIPTS.PREFLIGHT, [run.remoteWorktree, run.baseSha, remoteBranch]);
    if (preflight.code) return fail(preflight.stderr.trim() || "remote pre-flight failed");
    const facts = Object.fromEntries(preflight.stdout.trim().split("\n").map(line => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (facts.ancestor !== "1") return fail("not a descendant of the base");
    if (!/^\d+$/.test(facts.dirty ?? "")) return fail("invalid remote pre-flight");
    if (Number(facts.dirty) !== 0) return fail(`uncommitted changes on the host: ${facts.dirty_files}`);
    const commits = Number(facts.commits);
    if (!Number.isSafeInteger(commits) || commits < 0 || !/^[a-f0-9]{40,64}$/.test(facts.head ?? "")) return fail("invalid remote pre-flight");
    if (!commits) return fail("no commits");
    if (commits > 500) return fail(`${commits} commits exceed 500`);
    const identity = await git("config", "user.email");
    if (identity.code || !identity.stdout.trim()) return fail("local repo has no user.email");
    const foreign = [...new Set([...(facts.emails ?? "").split(","), ...(facts.signoffs ?? "").split(",")].filter(email => email && email !== identity.stdout.trim()))].sort();
    if (foreign.length) return fail(`foreign identity ${foreign.join(",")}; run pacer host setup ${host.alias}`);
    if (!facts.emails) return fail("invalid remote pre-flight");
    const path = join(tasksDir(ctx), `${task.id}.bundle`);
    mkdirSync(dirname(path), { recursive: true });
    bundle = path;
    const streamed = await bundleToFile(ctx, host, [run.remoteWorktree, run.baseSha, remoteBranch], path, 50 * 1024 * 1024);
    if (streamed.stdoutOverflow) return fail("bundle over 50 MB");
    if (streamed.code) return fail(streamed.stderr.trim() || "bundle stream failed");
    const verified = await git("bundle", "verify", path);
    if (verified.code) return fail(verified.stderr.trim() || "bundle verification failed");
    const heads = await git("bundle", "list-heads", path);
    if (heads.code || heads.stdout.trim() !== `${facts.head} refs/heads/${remoteBranch}`) return fail("bundle head differs from pre-flight");
    // Fetch objects without a destination ref; compare-and-swap the selected
    // branch so changes made during the stream are never overwritten.
    const fetched = await git("fetch", "--no-tags", path, remoteBranch);
    if (fetched.code) return fail(fetched.stderr.trim() || "bundle fetch failed");
    const top = await git("rev-parse", "--show-toplevel");
    if (top.code) return fail(top.stderr.trim() || "local repo root unavailable");
    const reviewWorktree = taskWorktreePath(ctx, top.stdout.trim(), task.id);
    const reuse = existsSync(reviewWorktree);
    let switchBranch = false;
    if (reuse) {
      const checkedOut = await ctx.run(["git", "-C", reviewWorktree, "symbolic-ref", "HEAD"], 10000);
      const status = await ctx.run(["git", "-C", reviewWorktree, "status", "--porcelain"], 10000);
      if (checkedOut.code || ![ref, `refs/heads/pacer/${task.id}`].includes(checkedOut.stdout.trim()) || status.code || status.stdout.trim()) return fail("review worktree is occupied or dirty");
      switchBranch = checkedOut.stdout.trim() !== ref;
    }
    const created = await git("update-ref", ref, facts.head, current || "0".repeat(facts.head.length));
    if (created.code) return fail(`local branch ${branch} exists; not overwritten`);
    let added;
    if (reuse) {
      added = switchBranch
        ? await ctx.run(["git", "-C", reviewWorktree, "checkout", "-q", branch], 60000)
        : await ctx.run(["git", "-C", reviewWorktree, "read-tree", "--reset", "-u", facts.head], 60000);
    } else added = await git("worktree", "add", "-q", reviewWorktree, branch);
    if (added.code) return fail(added.stderr.trim() || "review worktree creation failed");
    run.transferredHead = facts.head;
    updateTask(ctx, task.id, t => {
      if (t.run?.attempt === run.attempt) t.run.transferredHead = facts.head;
    });
    unlinkSync(path);
    return { ok: true, branch, commits, reviewWorktree };
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}

/** A branch name alone is not evidence that this remote result was received. */
export async function transferred(ctx: Ctx, task: TaskRecord): Promise<boolean> {
  if (!task.run?.transferredHead) return false;
  const ref = await ctx.run(["git", "-C", task.brief.repo, "rev-parse", "--verify", `refs/heads/pacer/${task.id}`], 10000);
  return ref.code === 0 && ref.stdout.trim() === task.run.transferredHead;
}
