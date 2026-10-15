import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostCfg } from "../config/hosts";
import { execProcess } from "../exec/process";
import { taskWorktreePath } from "../supervisor/worktree";
import { tasksDir } from "../tasks/store";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { SCRIPTS } from "./scripts";
import { runRemote, sshArgv } from "./ssh";

type TransferResult = { ok: true; branch: string; commits: number; reviewWorktree: string } | { ok: false; reason: string; bundle?: string };

/** Receive only committed task changes, after checking ancestry, cleanliness and identity. */
export async function transferBack(ctx: Ctx, task: TaskRecord, host: HostCfg, run: RunRef): Promise<TransferResult> {
  const branch = `pacer/${task.id}`, ref = `refs/heads/${branch}`;
  let bundle: string | undefined;
  const fail = (reason: string): TransferResult => ({ ok: false, reason, ...(bundle ? { bundle } : {}) });
  const git = (...args: string[]) => ctx.run(["git", "-C", task.brief.repo, ...args], 60000);
  try {
    const exists = await git("show-ref", "--verify", "--quiet", ref);
    if (exists.code === 0) return fail(`local branch ${branch} exists; not overwritten`);
    if (exists.code !== 1) return fail(exists.stderr.trim() || "local branch check failed");
    if (!run.remoteWorktree || !run.baseSha) return fail("remote run has no worktree or base");
    const preflight = await runRemote(ctx, host, SCRIPTS.PREFLIGHT, [run.remoteWorktree, run.baseSha, task.id]);
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
    const streamed = await execProcess({ argv: sshArgv(ctx, host, SCRIPTS.BUNDLE_OUT, [run.remoteWorktree, run.baseSha, task.id]), cwd: task.brief.repo, env: ctx.env, timeoutMs: 60000, stdoutFile: path, maxStdoutBytes: 50 * 1024 * 1024 });
    if (streamed.stdoutOverflow) return fail("bundle over 50 MB");
    if (streamed.code || streamed.timedOut) return fail(streamed.stderr.trim() || "bundle stream failed");
    const verified = await git("bundle", "verify", path);
    if (verified.code) return fail(verified.stderr.trim() || "bundle verification failed");
    const heads = await git("bundle", "list-heads", path);
    if (heads.code || heads.stdout.trim() !== `${facts.head} ${ref}`) return fail("bundle head differs from pre-flight");
    // Fetch objects without a destination ref; create the sole allowed ref with
    // compare-and-swap so a branch created during the stream is never overwritten.
    const fetched = await git("fetch", "--no-tags", path, branch);
    if (fetched.code) return fail(fetched.stderr.trim() || "bundle fetch failed");
    const created = await git("update-ref", ref, facts.head, "0".repeat(facts.head.length));
    if (created.code) return fail(`local branch ${branch} exists; not overwritten`);
    const top = await git("rev-parse", "--show-toplevel");
    if (top.code) return fail(top.stderr.trim() || "local repo root unavailable");
    const reviewWorktree = taskWorktreePath(ctx, top.stdout.trim(), task.id);
    const added = await git("worktree", "add", "-q", reviewWorktree, branch);
    if (added.code) return fail(added.stderr.trim() || "review worktree creation failed");
    unlinkSync(path);
    return { ok: true, branch, commits, reviewWorktree };
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}
