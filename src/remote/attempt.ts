import { resolveWorktreeBase } from "../supervisor/worktree";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HostCfg, repoKey } from "../config/hosts";
import { resolveRunner } from "../config/runner-id";
import { loadStrategy, type ProviderCfg } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { gitInfo } from "../core/git";
import { finishRun, outcome, progressPoller, runDir, type AttemptOutcome } from "../exec/direct";
import { remoteLaunch } from "../exec/launch";
import { buildPrompt } from "../exec/prompt";
import { tasksDir, updateTask } from "../tasks/store";
import { resolvePlacement, type RunRef, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { remoteExclusion } from "./eligibility";
import { RemoteRunIO } from "./run-io";
import { SCRIPTS } from "./scripts";
import { receiveQuestion, transferBack } from "./transfer";
import { runRemote } from "./ssh";
import { pluginRegistry } from "../plugins";
import { issueConfiguredHostPrepare } from "../plugins/host-prepare-issuer";
import { probeCodexUsage } from "./usage";

const MAX_BUNDLE = 50 * 1024 * 1024;

/** Preserve binary git bundles across RunFn's text-only output boundary. */
async function baseBundle(ctx: Ctx, repo: string, taskId: string, baseSha: string): Promise<Uint8Array> {
  const ref = `refs/pacer/base/${taskId}`;
  const set = await ctx.run(["git", "-C", repo, "update-ref", ref, baseSha], 10000);
  if (set.code) throw new Error(set.stderr);
  try {
    const proc = Bun.spawn(["git", "-C", repo, "bundle", "create", "-", ref], { env: ctx.env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 60000);
    const stderr = new Response(proc.stderr).text();
    try {
      const chunks: Uint8Array[] = []; let bytes = 0;
      for await (const chunk of proc.stdout) {
        bytes += chunk.length;
        if (bytes > MAX_BUNDLE) {
          proc.kill(); await proc.exited; await stderr;
          throw new Error("base bundle over 50 MB");
        }
        chunks.push(chunk);
      }
      const code = await proc.exited, error = await stderr;
      if (code) throw new Error(error || "base bundle failed");
      return Buffer.concat(chunks);
    } finally { clearTimeout(timer); }
  } finally {
    await ctx.run(["git", "-C", repo, "update-ref", "-d", ref], 10000);
  }
}

export async function runRemoteAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, host: HostCfg, onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  const startedAt = Date.now() / 1000, log = join(tasksDir(ctx), `${task.id}.${cfg.id}.log`);
  const failed = (reason: string) => outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
  try {
    const s = loadStrategy(ctx), ex = validateExecution(s.execution);
    const git = await gitInfo(ctx.run, task.brief.repo);
    if ("error" in git) return failed(git.error);
    const placement = resolvePlacement(task, ex.worktree, false, git.dirty);
    const excluded = await remoteExclusion(ctx, s, cfg.id, { repo: task.brief.repo, placement: placement.mode });
    if (excluded) return failed(excluded);
    const resolvedBase = await resolveWorktreeBase(ctx, git.top, task.brief, ex.baseBranch);
    if ("error" in resolvedBase) return failed(resolvedBase.error);
    const { base, sha: baseSha } = resolvedBase;
    const origin = await ctx.run(["git", "-C", git.top, "remote", "get-url", "origin"], 10000);
    const key = repoKey(origin.stdout.trim());
    if (!key || !host.repos[key]) return failed(`repo not set up on ${host.alias}`);
    const tag = `${key.split("/").at(-1)}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
    const attempt = task.attempts.length + 1;
    const args = [host.repos[key], tag, task.id, baseSha, base, String(attempt)];
    const registry = pluginRegistry(ctx);
    const initial = await issueConfiguredHostPrepare(ctx, host.alias, task.id, baseSha, base, new Uint8Array());
    if (JSON.stringify(initial.resource.args) !== JSON.stringify(args)) return failed("remote prepare snapshot changed");
    let prepared = await registry.prepareConfiguredHost(ctx, initial);
    if (prepared.code === 3 && prepared.stderr.includes("missing-base")) {
      const bundle = await baseBundle(ctx, git.top, task.id, baseSha);
      const retry = await issueConfiguredHostPrepare(ctx, host.alias, task.id, baseSha, base, bundle);
      if (JSON.stringify(retry.resource.args) !== JSON.stringify(args)) return failed("remote prepare snapshot changed");
      prepared = await registry.prepareConfiguredHost(ctx, retry);
    }
    if (prepared.code) return failed(prepared.stderr || "remote preparation failed");
    const worktree = prepared.stdout.split("\n").find(l => l.startsWith("worktree="))?.slice(9);
    if (!worktree) return failed("remote preparation returned no worktree");
    const remoteBranch = prepared.stdout.split("\n").find(l => l.startsWith("branch="))?.slice(7);
    if (!remoteBranch) return failed("remote preparation returned no branch");
    const dir = runDir(ctx, task.id, attempt);
    // PREPARE returns an absolute path rooted in the actual host HOME.
    const remoteDir = `${worktree.slice(0, worktree.indexOf("/.pacer-remote/"))}/.pacer-remote/runs/${task.id}/${attempt}`;
    const launch = remoteLaunch(cfg, worktree, remoteDir);
    mkdirSync(dir, { recursive: true });
    mkdirSync(tasksDir(ctx), { recursive: true });
    writeFileSync(join(dir, "argv"), launch.argv.join(" "));
    const run: RunRef = { dir, attempt, executor: cfg.id, startedAt, mode: "new", workdir: worktree, logFile: log, host: host.alias, remoteDir, remoteWorktree: worktree, remoteBranch, baseSha,
      ...(launch.lastMessageFile ? { lastMessageFile: join(dir, "last.md") } : {}) };
    updateTask(ctx, task.id, t => {
      t.run = run; t.baseBranch = base; t.baseSha = baseSha; t.worktree = `${host.alias}:${worktree}`;
      t.placement = { ...t.placement, requested: t.placement?.requested ?? "auto", ...placement };
    });
    let built = buildPrompt({ ...task.brief, repo: worktree }, task.id);
    const askRule = 'run pacer ask "<one question>" once, then stop';
    const askAt = built.lastIndexOf(askRule);
    built = built.slice(0,askAt) + 'write your one question (1–1000 characters) verbatim to .pacer-question in the worktree, leave that file uncommitted, then stop' + built.slice(askAt + askRule.length);
    const localRule = "- Do not commit, push, or change git branches.";
    const contractAt = built.lastIndexOf(localRule);
    const prompt = built.slice(0, contractAt)
      + `- Work only on ${remoteBranch} and commit there; don't push or change git config; leave the worktree clean.`
      + built.slice(contractAt + localRule.length);
    const runner = resolveRunner(s, cfg.id)!, env: Record<string, string> = { PACER_ROLE: "executor", PACER_TASK_ID: task.id };
    const home = host.accounts[runner.account ?? ""]?.home;
    if (home) env[runner.agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = home;
    const started = await new RemoteRunIO(ctx, host, remoteDir, dir).start(launch.argv, worktree, env, prompt);
    if ("error" in started) return failed(started.error);
    try { onSpawn?.(started.pid); } catch { /* observer does not own the run */ }
    const result = await finishRun(ctx, cfg, task, run, "", progressPoller(ctx, task, run));
    if (runner.agent === "codex") await probeCodexUsage(ctx, host, s.accounts[runner.account]);
    await receiveQuestion(ctx,task,host,run);
    if (result.exec.timedOut) return result;
    if (result.exec.code !== 0) {
      const preflight = await runRemote(ctx, host, SCRIPTS.PREFLIGHT, [worktree, baseSha, remoteBranch]);
      const commits = Number(preflight.stdout.match(/^commits=(\d+)$/m)?.[1] ?? 0);
      if (preflight.code || commits === 0) return result;
    }
    const transfer = await transferBack(ctx, task, host, run);
    if (!transfer.ok) {
      result.exec = { ...result.exec, code: result.exec.code || 1, stderr: `${result.exec.stderr}\n${transfer.reason}`.trim() };
      result.attempt.exitCode = result.exec.code;
      result.report = `${transfer.reason}\n\n${result.report}`;
      result.partial = transfer.reason;
      return result;
    }
    result.worktree = transfer.reviewWorktree;
    result.report = `ran on ${host.alias}; fetched ${transfer.branch} (${transfer.commits} commits)\n\n${result.report}`;
    return result;
  } catch (e) { return failed(e instanceof Error ? e.message : String(e)); }
}
