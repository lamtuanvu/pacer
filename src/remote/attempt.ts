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
import { receiveQuestion, transferBack } from "./transfer";
import { pluginRegistry } from "../plugins";
import { issueConfiguredHostPrepare } from "../plugins/host-prepare-issuer";
import { issueConfiguredHostAttemptPreflight } from "../plugins/host-attempt-preflight-issuer";
import { probeCodexUsage } from "./usage";
import { baseBundle } from "./base-bundle";
import { hasCommittedWork } from "./committed-work";

export async function runRemoteAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, host: HostCfg, onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  const startedAt = Date.now() / 1000, log = join(tasksDir(ctx), `${task.id}.${cfg.id}.log`);
  const failed = (reason: string) => outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
  try {
    const s = loadStrategy(ctx), ex = validateExecution(s.execution);
    const git = await gitInfo(ctx.run, task.brief.repo);
    if ("error" in git) return failed(git.error);
    const placement = resolvePlacement(task, ex.worktree, false, git.dirty);
    const excluded = await remoteExclusion(ctx, s, cfg.id, { repo: task.brief.repo, placement: placement.mode }, { currentTaskId: task.id });
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
    // Remote hosts cannot reach the pacer service: swap the contract's local-only rules.
    // Replace the last occurrence only, so identical text in the brief is left untouched.
    const replaceLast = (text: string, from: string, to: string) => {
      const at = text.lastIndexOf(from);
      if (at < 0) throw new Error(`remote prompt: executor contract changed; missing ${JSON.stringify(from)}`);
      return text.slice(0, at) + to + text.slice(at + from.length);
    };
    let built = buildPrompt({ ...task.brief, repo: worktree }, task.id);
    built = replaceLast(built, 'run `pacer ask "<one question>"` and end your turn; the answer resumes this same session',
      'write your one question (1–1000 characters) verbatim to .pacer-question in the worktree, leave that file uncommitted, then stop');
    built = replaceLast(built, '\n- To send other messages, run `pacer msg send --to <participant> "<text>"` (your parent is the default reader of your final response). Your final response in each turn is delivered to your parent as your report.', "");
    const prompt = replaceLast(built, "- Do not commit, push, or change git branches.",
      `- Work only on ${remoteBranch} and commit there; don't push or change git config; leave the worktree clean.`);
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
      const preflightGrant = issueConfiguredHostAttemptPreflight(ctx, task.id, attempt);
      if (preflightGrant.resource.alias !== host.alias ||
        JSON.stringify(preflightGrant.resource.args) !== JSON.stringify([worktree, baseSha, remoteBranch]))
        return failed("remote preflight snapshot changed");
      const preflight = await registry.preflightConfiguredHostAttempt(ctx, preflightGrant);
      if (preflight.code || preflight.timedOut || !hasCommittedWork(preflight.stdout)) return result;
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
