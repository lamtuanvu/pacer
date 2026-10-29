import { materializeAgentReporting } from "../session/agent-reporting";
import { ensureProviderIntegration } from "../core/integrations";
import { withWork } from "../update/desktop/admission";
import { probeAgentSession } from "../session/agent-probe";
import { conversationIdentity } from "../session/native-identity";
import { conversationActivity } from "../session/conversation";
import { prepareAgentSession, agentSessionCapabilities } from "../plugins/agent-session";
import { resolveAttachments } from "../attachments/claims";
import { attachmentDirectory } from "../attachments/store";
import { executorExclusion } from "../executors/availability";
import { codexInteractiveGap, prepareInteractive, requireCodexInteractive, cleanSummary, readReport, transcriptReport, sessionTranscript } from "../session/reports";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, openSync, readSync, closeSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadStrategy, strategyPath, type ProviderCfg } from "../config/strategy";
import { IDLE_AFTER_S, IDLE_FAIL_S, type ExecutionCfg, validateExecution } from "../config/execution";
import { publish } from "../link/publish";
import { pidAlive } from "../link/store";
import { gitInfo, realpathSafe } from "../core/git";
import { tasksDir, listTasksWhere, readTask, updateTask } from "../tasks/store";
import { resolvePlacement, type Attempt, type RunRef, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { parseRunnerId } from "../config/runner-id";
import { resolveRunner } from "../config/runner-id";
import { reduceClaudeStream, USAGE_FILE } from "../tokens/extract";
import { claudeResultFromStream, captureClaudeStreamUsageFile } from "../usage/claude";
import { readAccountUsage } from "../usage";
import { RemoteRunIO } from "../remote/run-io";
import { runRemoteAttempt } from "../remote/attempt";
import { SCRIPTS } from "../remote/scripts";
import { runRemote } from "../remote/ssh";
import { launchFor, launchModeFor, providerEnv, resumeLaunchFor, type LaunchModeChoice } from "./launch";
import { claudeConfigFile, grantClaudeFolderTrust, projectMcpChoices, type McpChoices } from "./claude-trust";
import { detectLimit } from "./limits";
import { type ExecResult, executorEnv, execProcess } from "./process";
import { profileColor, profileKeys, strictServiceEnv, terminalEnv, terminalEnvNote, terminalEnvRecord, terminalUmask, type TerminalEnv } from "./login-env";
import { recordDefaultFolder, recordRunFolder, withDefaultFolder } from "./account-folder";
import { buildPrompt } from "./prompt";
import { localRunIO, readOutput, startRun } from "../supervisor/run";
import { type SuperviseEnd, supervise } from "../supervisor/supervise";
import { receiveQuestion, transferBack, transferred } from "../remote/transfer";
import { taskWorktreePath, taskWorktreesDir, createTaskWorktree, resolveWorktreeBase } from "../supervisor/worktree";
import { gitFingerprint, idleSeconds, nextProgress } from "../supervisor/progress";
import { STRICT_INTERACTIVE_REASON, strictClaudeLaunch } from "../dispatch/enforcement";

export const REPORT_CHARS = 4000;

export interface AttemptOutcome { takeover?: boolean; attempt: Attempt; exec: ExecResult; report: string; backend?: string; worktree?: string; partial?: string }

export function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

export function outcome(cfg: ProviderCfg, startedAt: number, exec: ExecResult, log: string, report: string, skipLimits = false): AttemptOutcome {
  return {
    backend: "direct",
    exec,
    report,
    attempt: {
      executor: cfg.id, model: cfg.model, startedAt, endedAt: Date.now() / 1000,
      exitCode: exec.code, timedOut: exec.timedOut, limitHit: !skipLimits && detectLimit(cfg.id, cfg.session === "interactive" ? {...exec, stdout: report, stderr: ""} : exec), log,
    },
  };
}

export const runDir = (ctx: Ctx, taskId: string, attempt: number) => join(ctx.pacerHome, "runs", taskId, String(attempt));

function loadExec(ctx: Ctx): ExecutionCfg {
  try { return validateExecution(loadStrategy(ctx).execution); } catch { return validateExecution(undefined); }
}

export function parseSessionHeader(header: string): string | undefined {
  return /(?:^|\n)\s*session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i.exec(header)?.[1];
}
function discoverSession(ctx: Ctx, task: TaskRecord, run: RunRef) {
  if (run.host || run.agentSession) return;
  try {
    const id = readFileSync(join(run.dir, "agent-session-id"), "utf8");
    if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      run.agentSession = {id, source: "lookup"};
      updateTask(ctx, task.id, t => {if (t.run?.dir === run.dir) {t.run.agentSession = run.agentSession; if (t.conversation) t.conversation.agentSessionId = id;}});
      return;
    }
  } catch { /* no identity hook yet */ }
  if ((parseRunnerId(run.executor)?.agent ?? run.executor) !== "codex") return;
  try {
    const fd = openSync(join(run.dir, existsSync(join(run.dir, "session.json")) && !(existsSync(join(run.dir,"session.host")) && readFileSync(join(run.dir,"session.host"),"utf8").trim() === "none") ? "stdout" : "stderr"), "r");
    let header: string;
    try { const bytes = Buffer.alloc(16 * 1024); header = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0)).toString("utf8"); } finally { closeSync(fd); }
    const id = parseSessionHeader(header);
    if (id) {
      run.agentSession = {id, source:"header"};
      updateTask(ctx, task.id, t => { if (t.run?.dir === run.dir) t.run.agentSession = run.agentSession; });
    }
  } catch { /* header may not have been written yet */ }
}

/** Progress every poll (written at most every 10 s or on a phase change); git activity every 30 s; idle stop after idleFailS. */
export function progressPoller(ctx: Ctx, task: TaskRecord, run: RunRef) {
  const ex = loadExec(ctx), scale = Number(ctx.env.PACER_IDLE_SCALE ?? "1") || 1; // PACER_IDLE_SCALE: test-only
  const idleAfter = (ex.idleAfterS ?? IDLE_AFTER_S) * scale, idleFail = (ex.idleFailS ?? IDLE_FAIL_S) * scale;
  let files = 0, commits = 0, gitAt = 0, writtenAt = 0, alerted = false;
  let fingerprint: string | undefined;
  let waiting = false, controlled = false;
  let waitKey: string | undefined;
  let resumedAt = 0;
  let prev = readTask(ctx, task.id)?.progress;
  return async (s: import("../supervisor/run").RunState): Promise<"continue" | "idle"> => {
    const now = Date.now() / 1000;
    discoverSession(ctx, task, run);
    if ((waiting && s.report?.status !== "needs-input" && s.report?.status !== "turn-ended") || (controlled && !(s.interactive && s.controller))) resumedAt = now;
    controlled = !!(s.interactive && s.controller);
    let changed = false;
    if (!run.host && now - gitAt >= 30) {
      gitAt = now;
      try {
        const st = await ctx.run(["git", "-C", run.workdir, "status", "--porcelain=v1", "-z"], 15_000);
        if (st.code === 0) {
          const entries = st.stdout.split("\0").filter(Boolean);
          files = 0;
          for (let n = 0; n < entries.length; n++) {
            files++;
            if (/^[RC]|^.[RC]/.test(entries[n])) n++; // Renames/copies include the original path too.
          }
        }
        const base = readTask(ctx, task.id)?.baseBranch;
        if (base && run.mode === "new") {
          const c = await ctx.run(["git", "-C", run.workdir, "rev-list", "--count", `${base}..HEAD`], 15_000);
          if (c.code === 0) commits = Number(c.stdout.trim()) || 0;
        }
        const diff = await ctx.run(["git", "-C", run.workdir, "diff", "HEAD"], 15_000);
        if (st.code === 0 && diff.code === 0) {
          const next = gitFingerprint(st.stdout, diff.stdout);
          changed = fingerprint === undefined ? files > 0 || commits > 0 : next !== fingerprint;
          fingerprint = next;
        }
      } catch { /* git progress is best effort, including when git is unavailable */ }
    }
    const p = nextProgress({ now, startedAt: run.startedAt, logBytes: s.stdoutBytes + s.stderrBytes, lastOutputAt: Math.max(s.lastOutputAt ?? 0, s.interactive ? s.report?.at ?? 0 : 0, resumedAt) || null, files, commits, prev, host: run.host, changed }, idleAfter);
    const turnEnded = s.interactive && s.report?.status === "turn-ended";
    const conversation = run.interactionMode === "conversation";
    const needsInput = s.interactive && (s.report?.status === "needs-input" || (!conversation && turnEnded && !controlled && now - Math.max(s.report!.at, s.lastOutputAt ?? 0, p.lastChangeAt ?? 0, resumedAt) >= 120));
    if (needsInput) {
      if (!waiting) {
        waitKey = `needs-input-${task.id}-${crypto.randomUUID()}`;
        try { await publish(ctx, [{type: "alert", data: {key: waitKey!, level: "warn", title: "Task needs input: attach to answer", body: cleanSummary(s.report!.summary).slice(0, 1000), at: Math.floor(now)}}]); } catch { /* best effort */ }
      }
      p.phase = "needs-input";
    } else if (controlled || turnEnded) p.phase = "working";
    if (waiting && !needsInput && waitKey) {
      try { await publish(ctx, [{type: "alert", data: {key: waitKey, level: "info", title: "Task input resumed", body: "The input wait has cleared", at: Math.floor(now)}}]); } catch { /* best effort */ }
      waitKey = undefined;
    }
    waiting = !!needsInput;
    if (run.takeover) p.phase = "driving";
    if (p.phase !== prev?.phase || now - writtenAt >= 10) {
      updateTask(ctx, task.id, t => { t.progress = p; });
      writtenAt = now;
    }
    if (conversation) {
      const activity = conversationActivity(s);
      const current = readTask(ctx, task.id);
      if (current?.conversation?.activity !== activity) updateTask(ctx, task.id, t => {
        t.conversation = {...t.conversation, activity, ...(run.agentSession ? {agentSessionId: run.agentSession.id} : {})};
      });
    }
    if (!conversation && p.phase === "idle" && !alerted) {
      alerted = true;
      try {
        await publish(ctx, [{ type: "alert", data: { key: `idle-${task.id}`, level: "warn", title: "Task is idle", body: `${task.brief.goal.slice(0, 120)}: no output or file changes for ${Math.round(idleSeconds(p, run.startedAt, now) / 60)} min`, at: Math.floor(now) } }]);
      } catch { /* alerts are best effort */ }
    }
    prev = p;
    return !conversation && !run.takeover && !needsInput && !controlled && !turnEnded && idleSeconds(p, run.startedAt, now) >= idleFail ? "idle" : "continue";
  };
}

/** Shared tail of a fresh or resumed attempt: supervise, collect files, write the legacy log, build the outcome. */
export async function finishRun(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, run: RunRef, note: string, onPoll?: Parameters<typeof supervise>[0]["onPoll"]): Promise<AttemptOutcome> {
  const host = run.host ? loadStrategy(ctx).hosts[run.host] : undefined;
  if (run.host && (!host || !run.remoteDir)) throw new Error(`remote run ${task.id} has no configured host or run directory`);
  const io = host ? new RemoteRunIO(ctx, host, run.remoteDir!, run.dir) : localRunIO(run.dir);
  const end: SuperviseEnd = await supervise({
    io, ...(host ? { pollMs: 5000 } : {}), deadlineMs: ((task.attemptStartedAt ?? run.startedAt) + task.timeoutS) * 1000,
    interactionMode: run.interactionMode,
    isStopped: () => readTask(ctx, task.id)?.state === "stopped", onPoll,
  });
  if (!run.host && !run.takeover && cfg.session !== "interactive" && (parseRunnerId(cfg.id)?.agent ?? cfg.id) === "claude-code") {
    const path = join(run.dir, "stdout");
    try {
      const strategy = loadStrategy(ctx);
      const runner = resolveRunner(strategy, cfg.id);
      const account = runner && strategy.accounts[runner.account];
      if (account) {
        const captured = await captureClaudeStreamUsageFile({...ctx, now: Date.now() / 1000}, account, path);
        if (captured) {
          try {
            await readAccountUsage({...ctx, now: Date.now() / 1000}, account,
              Object.values(strategy.runners).filter(r => r.account === account.name), true, false, strategy.hosts);
          } catch { /* The captured cache remains available for the next status refresh. */ }
        }
      }
      const raw = readOutput(run.dir).stdout;
      // The stream is about to be replaced by its result text; keep its numeric usage for token accounting.
      const usage = reduceClaudeStream(raw);
      if (usage) { const file = join(run.dir, USAGE_FILE); rmSync(file, {force: true}); writeFileSync(file, usage, {flag: "wx", mode: 0o600}); }
      const result = claudeResultFromStream(raw);
      if (result !== null) {
        const temp = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temp, `${result}\n`, {flag: "wx", mode: 0o600});
          renameSync(temp, path);
        } finally {
          try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
    } catch { /* Keep the original output and task outcome when telemetry is unavailable. */ }
  }
  const out = readOutput(run.dir);
  const exec: ExecResult = { code: end.code, stdout: out.stdout, stderr: out.stderr, timedOut: end.kind === "timeout" };
  if (end.kind === "idle") exec.stderr += `\npacer: stopped after ${Math.round((loadExec(ctx).idleFailS ?? IDLE_FAIL_S) / 60)} min without output or file changes`;
  if (end.kind === "lost") exec.stderr += host ? `\npacer: host ${host.alias} unreachable or wrapper missing after the contact grace period` : "\npacer: the attempt's wrapper vanished without an exit record";
  if (host && run.lastMessageFile) {
    try {
      const last = await runRemote(ctx, host, SCRIPTS.READ_FROM, [run.remoteDir!, "last.md", "0", "262144"]);
      if (last.code === 0) writeFileSync(run.lastMessageFile, last.stdout);
    } catch { /* mirrored output remains available */ }
  }
  try {
    (run.takeover ? appendFileSync : writeFileSync)(run.logFile, `$ ${launchArgv(run)}\n--- stdout\n${exec.stdout}\n--- stderr\n${exec.stderr}\n--- exit ${exec.code}${exec.timedOut ? " (timed out)" : ""}\n`);
  } catch { /* the run directory keeps the full record */ }
  if (!run.takeover && !run.host && existsSync(join(run.dir, "takeover.json")) && readTask(ctx, task.id)?.state !== "stopped") {
    return startTakeoverRun(ctx, cfg, task, run, note);
  }
  const interactive = existsSync(join(run.dir, "interactive.json"));
  const signal = interactive ? readReport(run.dir) : null;
  const completed = end.kind === "reported";
  const conversation = run.interactionMode === "conversation";
  let report = interactive
    ? completed ? signal!.summary : `Interactive session ${end.kind} without an explicit completion report${signal ? `\n\n${signal.summary}` : ""}`
    : tail(exec.stdout.trim() || exec.stderr.trim(), REPORT_CHARS);
  if (interactive) {
    const transcript = transcriptReport(run.dir);
    if (transcript) report += `\n\n${tail(transcript, REPORT_CHARS)}`;
    if (!conversation && !run.takeover && end.kind === "exited" && !completed) exec.stderr += "\npacer: interactive agent exited without an explicit completion report";
  }
  if (conversation) {
    report = transcriptReport(run.dir) || signal?.summary || (end.kind === "exited" ? "Agent session ended" : "Session stopped");
    updateTask(ctx, task.id, t => {
      t.conversation = {...t.conversation, activity: "ended", endReason: end.kind === "stopped" ? "user" : end.kind === "exited" && end.code === 0 ? "agent_exit" : "failure"};
    });
  }
  if (!interactive && run.lastMessageFile && existsSync(run.lastMessageFile)) report = tail(readFileSync(run.lastMessageFile, "utf8").trim(), REPORT_CHARS) || report;
  if (run.takeover) {
    let endedAt = Date.now() / 1000;
    try { endedAt = Number(readFileSync(join(run.dir, "session.ended"), "utf8")) || endedAt; } catch { /* launch failure */ }
    let rawCode = end.code;
    try { rawCode = Number(readFileSync(join(run.dir, "exit"), "utf8")); } catch { /* supervisor result */ }
    const startupFailed = end.kind === "lost" || (end.kind === "exited" && rawCode !== 0 && endedAt - run.startedAt <= 5 && !existsSync(join(run.dir, "session.input")));
    if (startupFailed) { exec.stderr = exec.stderr.trim() || exec.stdout.trim() || "Take over resume failed to start"; exec.code = 127; }
    const failedReport = signal?.status === "failed";
    exec.code = failedReport || startupFailed || end.kind === "timeout" || end.kind === "stopped" ? exec.code || 1 : 0;
    report = failedReport ? signal!.summary : startupFailed ? exec.stderr.trim() || exec.stdout.trim() || "Take over resume failed to start"
      : transcriptReport(run.dir) || (run.agentSession ? sessionTranscript(cfg.via === "opencode" ? "opencode" : parseRunnerId(cfg.id)?.agent ?? cfg.id, run.agentSession.id, withDefaultFolder(ctx, parseRunnerId(cfg.id)?.agent ?? cfg.id, executorEnv(ctx.env, await providerEnv(ctx, cfg).catch(() => ({})), task.id), run.dir), ctx.home) : "") || "You drove this task; the agent left no summary";
    updateTask(ctx, task.id, t => { if (t.takeover) t.takeover.state = "ended"; });
    const result = outcome({...cfg, session:"interactive"}, task.attemptStartedAt ?? run.startedAt, exec, run.logFile, note + report, true);
    result.attempt.limitHit = false;
    return {...result, takeover:true, ...(run.mode === "new" ? {worktree:run.workdir} : {})};
  }
  return {
    ...outcome(interactive ? {...cfg, session: "interactive"} : cfg, run.startedAt, exec, run.logFile, note + report),
    ...(run.mode === "new" ? { worktree: run.host ? `${run.host}:${run.remoteWorktree}` : run.workdir } : {}),
  };
}

/**
 * The executor's base environment: what a new terminal would give the user, except under strict delegation
 * enforcement, whose attempt runs with exactly the service environment its certification checked (no login shell,
 * per-folder tools or login umask; the account folder is the certified one).
 */
const executorBase = (ctx: Ctx, workdir: string): Promise<TerminalEnv> => ctx.env.PACER_ENFORCEMENT_MODE === "strict"
  ? Promise.resolve(strictServiceEnv(ctx.env)) : terminalEnv(ctx.env, {cwd: ctx.home, workdir});

/** Where the executor's base environment came from; names the shell or the reason only, never a value. */
function recordEnvironment(dir: string, base: TerminalEnv): void {
  try { writeFileSync(join(dir, "environment.json"), JSON.stringify(terminalEnvRecord(base)), {mode: 0o600}); }
  catch { /* diagnostics only */ }
}

/** Only a worktree pacer created for the task, under its worktrees root; never an in-place checkout, $HOME or /. */
function pacerTaskWorktree(ctx: Ctx, mode: "current" | "new", folder: string): boolean {
  const real = realpathSafe(folder), rootDir = realpathSafe(taskWorktreesDir(ctx));
  return mode === "new" && real !== "/" && real !== realpathSafe(ctx.home) && real.startsWith(rootDir + "/");
}

/** Claude asks about folder trust before it loads pacer's hooks, so an unattended task would wait unseen. */
async function preapproveClaudeTrust(ctx: Ctx, env: Record<string, string | undefined>, mode: "current" | "new", folder: string, root?: string): Promise<string> {
  if (!pacerTaskWorktree(ctx, mode, folder)) return "claude folder trust: not pre-approved (only pacer-created task worktrees are); Claude may ask whether to trust this folder\n\n";
  const result = await grantClaudeFolderTrust(claudeConfigFile(env, ctx.home), folder, root)
    .catch(() => ({status: "skipped" as const, reason: "the Claude config file could not be updated"}));
  return result.status === "skipped" ? `claude folder trust: not pre-approved (${result.reason}); Claude may ask whether to trust this folder\n\n` : "";
}

/**
 * The source checkout's MCP answers, read only for a pacer-created task worktree, whose untracked settings.local.json
 * is not in the worktree. An in-place run is left to Claude, which reads that checkout's own answers and may prompt.
 */
function projectMcpAnswers(ctx: Ctx, env: Record<string, string | undefined>, mode: "current" | "new", folder: string, roots: string[]): McpChoices | {reason: string} {
  if (!pacerTaskWorktree(ctx, mode, folder)) return {reason: "only pacer-created task worktrees are"};
  return projectMcpChoices(claudeConfigFile(env, ctx.home), roots);
}

/** The attempt note when the source checkout's MCP answers are not carried into the run's settings. */
export const mcpNotApproved = (reason: string) => `claude project MCP servers: not pre-approved (${reason}); Claude may ask whether to use this project's MCP servers`;

/** The second run belongs to the original attempt and always uses its worktree. */
async function startTakeoverRun(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, previous: RunRef, note: string): Promise<AttemptOutcome> {
  const dir = runDir(ctx, task.id, previous.attempt) + "-takeover";
  const run: RunRef = {dir, attempt:previous.attempt, executor:previous.executor, startedAt:Date.now()/1000, mode:previous.mode, workdir:previous.workdir, logFile:previous.logFile, takeover:true};
  try {
    const request = JSON.parse(readFileSync(join(previous.dir, "takeover.json"), "utf8")) as {sessionId:string;at:number;by?:string};
    if (typeof request.sessionId !== "string" || !request.sessionId) throw Error("Take over request has no session id");
    run.agentSession = {id:request.sessionId, source:readTask(ctx,task.id)?.run?.agentSession?.source ?? "lookup"};
    await ensureProviderIntegration(ctx, cfg.id);
    const base = await executorBase(ctx, run.workdir);
    note += terminalEnvNote(base);
    const account = await providerEnv(ctx,cfg);
    const env = executorEnv(base.env, account, task.id, profileKeys(base));
    const agent = cfg.via === "opencode" ? "opencode" : parseRunnerId(cfg.id)?.agent ?? cfg.id;
    recordDefaultFolder(ctx, agent, account, base);
    if (agent === "codex") await requireCodexInteractive(ctx,env);
    // Codex resolves linked-worktree trust against the main repository root.
    const trust = agent === "codex" || agent === "claude-code" ? await gitInfo(ctx.run, run.workdir) : null;
    const trustRoot = trust && !("error" in trust) ? trust.main : task.brief.repo;
    if (agent === "claude-code") note += await preapproveClaudeTrust(ctx, env, run.mode, run.workdir, trust && !("error" in trust) ? trust.main : undefined);
    // The user drives a take over, so Claude's own project MCP prompt stays.
    const launch = prepareInteractive(agent,dir,resumeLaunchFor(cfg,request.sessionId,run.workdir,dir,trustRoot),{attended:true});
    env.PACER_HOME = ctx.pacerHome; env.PACER_RUN_DIR = dir; env.PACER_TRANSCRIPT_REPORT = join(dir,"transcript-report.md");
    mkdirSync(dir,{recursive:true,mode:0o700});
    writeFileSync(join(dir,"argv"),launch.argv.join(" "),{mode:0o600});
    recordEnvironment(dir, base);
    recordRunFolder(dir, ctx, agent, env);
    run.startedAt = Date.now()/1000;
    // Publish before spawn so run-bound reports validate even from a fast CLI.
    updateTask(ctx,task.id,t=>{t.run=run;t.takeover={...t.takeover,state:"driving",at:request.at,sessionId:request.sessionId,...(request.by?{by:request.by}:{})};t.progress={lastOutputAt:null,lastChangeAt:null,files:0,commits:0,logBytes:0,host:"local",...t.progress,phase:"driving",updatedAt:Date.now()/1000};});
    const started = startRun({dir,argv:launch.argv,cwd:run.workdir,env,session:"interactive",takeover:true,umask:terminalUmask(base),keepColor:profileColor(base)});
    if ("error" in started) throw Error(started.error);
    return await finishRun(ctx,cfg,task,run,note,progressPoller(ctx,task,run));
  } catch (e) {
    const message = (e as Error).message;
    updateTask(ctx,task.id,t=>{if(t.takeover)t.takeover.state="ended";});
    try {appendFileSync(previous.logFile, `\n--- takeover launch error\n${message}\n`);}catch{/* full run retained */}
    const result = outcome(cfg,task.attemptStartedAt ?? previous.startedAt,{code:127,stdout:"",stderr:message,timedOut:false},previous.logFile,note+message,true);
    result.attempt.limitHit=false;
    return {...result,takeover:true,...(previous.mode==="new"?{worktree:previous.workdir}:{})};
  }
}

const launchArgv = (run: RunRef) => { try { return readFileSync(join(run.dir, "argv"), "utf8"); } catch { return ""; } };

/** One executor attempt through the executor's own CLI, under the file-backed supervisor. */
export async function runAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  return withWork(ctx, { kind: "operation", id: task.id, label: "Executor attempt" }, () => runAttemptAdmitted(ctx, cfg, task, onSpawn));
}
async function runAttemptAdmitted(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  const conversation = task.interactionMode === "conversation";
  const ex = loadExec(ctx);
  let choice: LaunchModeChoice = conversation ? {mode: "interactive", explicit: true} : launchModeFor(cfg, ex, {managed: ctx.env.PACER_ENFORCEMENT_MODE === "strict"});
  cfg = {...cfg, session: choice.mode};
  const alias = parseRunnerId(cfg.id)?.host;
  if (alias) {
    const out = await runRemoteAttempt(ctx, cfg, task, loadStrategy(ctx).hosts[alias], onSpawn);
    if (choice.fallback) try { appendFileSync(out.attempt.log, `launch mode: headless (${choice.fallback})\n`); } catch { /* the attempt result stands */ }
    return out;
  }
  const dir = tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now() / 1000, log = join(dir, `${task.id}.${cfg.id}.log`);
  // Certification covers headless launches only; an explicit interactive runner set after admission must not slip through.
  if (ctx.env.PACER_ENFORCEMENT_MODE === "strict" && choice.mode === "interactive") {
    return outcome(cfg, startedAt, {code: 1, stdout: "", stderr: STRICT_INTERACTIVE_REASON, timedOut: false}, log, STRICT_INTERACTIVE_REASON);
  }
  const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
  const top = realpathSafe("error" in git ? task.brief.repo : git.top);
  if (task.worktree && existsSync(task.worktree) && !("error" in git)) {
    const original = await ctx.run(["git", "-C", git.top, "rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000);
    const candidate = await ctx.run(["git", "-C", task.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], 10_000);
    if (original.code !== 0 || candidate.code !== 0 || realpathSafe(original.stdout.trim()) !== realpathSafe(candidate.stdout.trim())) {
      const reason = "task worktree no longer belongs to its repository; restore it before retrying";
      return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
    }
  }
  const busy = listTasksWhere(ctx, { states: ["running"] }).some(t => { const path = realpathSafe(t.worktree ?? t.result?.worktree ?? t.brief.repo); return t.id !== task.id && t.state === "running" && !!t.runnerPid && pidAlive(t.runnerPid) && t.placement?.mode === "current" && (path === top || path.startsWith(top + "/")); });
  let resolved = task.worktree ? { mode: realpathSafe(task.worktree) === realpathSafe(task.brief.repo) ? "current" as const : "new" as const, why: "reuse task worktree" } : resolvePlacement(task, ex.worktree, busy, !("error" in git) && git.dirty);
  let note = "", workdir = task.brief.repo, mode: "current" | "new" = resolved.mode;
  if (mode === "new" && "error" in git) {
    if (conversation) {
      const reason = `Cannot create an isolated conversation: ${git.error}`;
      return outcome(cfg, startedAt, {code: 1, stdout: "", stderr: reason, timedOut: false}, log, reason);
    }
    note = `ran in place: ${git.error}\n\n`; mode = "current"; resolved = { mode: "current", why: resolved.why };
  }
  if (mode === "current" && (busy || (resolved.why === "strategy default" && !("error" in git) && git.dirty))) {
    const reason = busy ? "another pacer task is running in the current worktree; in-place execution refused" : "current worktree has uncommitted changes";
    return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
  }
  if (mode === "current" && listTasksWhere(ctx, {states: ["queued", "running"]}).some(t =>
    t.id !== task.id && t.interactionMode === "conversation" && t.placement?.requested === "current" && realpathSafe(t.brief.repo) === realpathSafe(workdir))) {
    const reason = "Another conversation owns this checkout";
    return outcome(cfg, startedAt, {code: 1, stdout: "", stderr: reason, timedOut: false}, log, reason);
  }
  if (mode === "new" && !("error" in git)) {
    // Retries and fallback attempts retain all committed and uncommitted work.
    const path = taskWorktreePath(ctx, git.top, task.id);
    if (task.worktree && !existsSync(task.worktree)) {
      const reason = "original task worktree is unavailable; restore it before retrying";
      return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: reason, timedOut: false }, log, reason);
    }
    const reused = task.worktree && existsSync(task.worktree) ? task.worktree : undefined;
    const existing = reused ?? (existsSync(path) && (await ctx.run(["git", "-C", git.top, "show-ref", "--verify", "--quiet", `refs/heads/pacer/${task.id}`], 10_000)).code === 0 ? (git.sub ? join(path, git.sub) : path) : undefined);
    if (existing) {
      workdir = existing;
    } else {
      const base = await resolveWorktreeBase(ctx, git.top, task.brief, ex.baseBranch, ex.worktree === "child-of-current" && task.placement?.requested !== "new");
      if ("error" in base) return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: base.error, timedOut: false }, log, base.error);
      const w = await createTaskWorktree(ctx, git, task.id, base.sha);
      if ("error" in w) return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: w.error, timedOut: false }, log, w.error);
      workdir = w.workdir;
      if (git.dirty) note = `note: ${git.top} has uncommitted changes; the task's worktree starts from ${base.base} without them\n\n`;
      updateTask(ctx, task.id, t => { t.baseBranch = base.base; t.baseSha = base.sha; });
    }
  }
  const guard = executorExclusion({ ...ctx, now: Date.now() / 1000 }, existsSync(strategyPath(ctx)) ? loadStrategy(ctx) : undefined, cfg.id);
  if (guard) return outcome(cfg, startedAt, { code: 1, stdout: "", stderr: guard, timedOut: false }, log, guard);
  const attempt = task.attempts.length + 1, rdir = runDir(ctx, task.id, attempt);
  updateTask(ctx, task.id, t => {
    t.placement = { requested: task.placement?.requested ?? "auto", ...task.placement, mode, why: resolved.why };
    t.worktree = workdir;
  });
  const prompt = conversation ? task.brief.goal : mode === "new"
    ? buildPrompt({ ...task.brief, repo: task.worktree ? `${workdir} (the task worktree; keep its current branch; do not edit ${task.brief.repo} itself)` : `${workdir} (a new git worktree of ${task.brief.repo} on branch pacer/${task.id}; do not edit ${task.brief.repo} itself)` }, task.id, !!ctx.env.PACER_WORK_GRANT)
    : buildPrompt(task.brief, task.id, !!ctx.env.PACER_WORK_GRANT);
  let launch: ReturnType<typeof launchFor>;
  let env: Record<string, string | undefined>;
  let base: TerminalEnv | undefined;
  let agentSession: RunRef["agentSession"];
  try {
    base = await executorBase(ctx, workdir);
    note += terminalEnvNote(base);
    const account = await providerEnv(ctx, cfg);
    env = executorEnv(base.env, account, task.id, profileKeys(base));
    const agent = parseRunnerId(cfg.id)?.agent ?? cfg.id;
    if (cfg.via !== "opencode") recordDefaultFolder(ctx, agent, account, base);
    if (choice.mode === "interactive" && !choice.explicit && agent === "codex" && cfg.via !== "opencode") {
      const gap = await codexInteractiveGap(ctx, env);
      if (gap) { choice = {mode: "headless", explicit: false, fallback: gap}; cfg = {...cfg, session: "headless"}; }
    }
    if (choice.fallback) note += `launch mode: headless (${choice.fallback})\n\n`;
    const interactive = cfg.session === "interactive";
    const instructions = interactive && !conversation ? `\n\nInteractive pacer session: completion requires running pacer report --task ${task.id} --outcome done --summary "<result>" (or --outcome failed). Before asking the user, run pacer report --status needs-input --summary "<question>"; when resuming use --status running. Do not infer completion from the terminal. PACER_RUN_DIR identifies this attempt. You may write a longer Markdown result to $PACER_TRANSCRIPT_REPORT.\n` : "";
    if (!interactive && cfg.via !== "opencode") {
      if (agent === "claude-code") agentSession = {id:crypto.randomUUID(),source:"assigned"};
      if (agent === "cursor") {
        try {
          const chat = await execProcess({argv:["cursor-agent","create-chat"],cwd:workdir,env,timeoutMs:5000});
          const id = chat.stdout.trim();
          if (chat.code === 0 && id && !/\s|[\x00-\x1f\x7f]/.test(id)) agentSession = {id,source:"assigned"};
        } catch { /* best effort: launch unchanged */ }
      }
    }
    if (conversation) {
      const sessionAgent = cfg.via === "opencode" ? "opencode" : agent;
      const probe = await probeAgentSession(ctx, sessionAgent, env);
      if (probe.reason) throw Error(probe.reason);
      const capabilities = await agentSessionCapabilities(ctx, probe);
      if (!capabilities.interactive) throw Error(capabilities.reason ?? "Interactive sessions are unavailable");
      agentSession = await conversationIdentity(ctx, {...probe, model: cfg.model ?? undefined, sessionId: task.conversation?.agentSessionId,
        taskId: task.id, workspace: workdir, env});
      let request = prompt;
      if (Buffer.byteLength(request) > 32 * 1024) {
        mkdirSync(rdir, {recursive: true, mode: 0o700});
        const path = join(rdir, "prompt.md");
        writeFileSync(path, request, {mode: 0o600});
        request = `Read the request in ${JSON.stringify(path)} and continue this conversation.`;
      }
      launch = await prepareAgentSession(ctx, {...probe, request,
        workspace: workdir, runDir: rdir, ...(task.sessionDraftId ? {attachmentDir: attachmentDirectory(ctx, task.sessionDraftId)} : {}), attachments: resolveAttachments(ctx, task.id), permissionPolicy: "native",
        ...(task.conversation?.agentSessionId ? {sessionId: task.conversation.agentSessionId} : agentSession ? {newSessionId: agentSession.id} : {}), ...(cfg.model ? {model: cfg.model} : {})});
      materializeAgentReporting(rdir, launch, env);
    } else launch = launchFor(cfg, prompt + instructions, workdir, rdir, task.id, agentSession?.id, "error" in git ? task.brief.repo : git.main);
    if(env.PACER_ENFORCEMENT_MODE==="strict"&&agent==="claude-code")launch={...launch,argv:strictClaudeLaunch(ctx,launch.argv,rdir)};
    if (interactive) {
      if (agent === "codex" && !conversation && choice.explicit) await requireCodexInteractive(ctx, env);
      // A chat's user answers Claude's trust and MCP prompts; a delegated interactive lane runs unattended, as a task does.
      const attended = conversation && !task.interactive;
      if (agent === "claude-code" && !attended) note += await preapproveClaudeTrust(ctx, env, mode, launch.cwd, "error" in git ? undefined : git.main);
      let mcp: McpChoices | undefined;
      if (agent === "claude-code" && !attended) {
        const answers = projectMcpAnswers(ctx, env, mode, launch.cwd, [task.brief.repo, ...("error" in git ? [] : [git.top, git.main])]);
        if ("reason" in answers) note += `${mcpNotApproved(answers.reason)}\n\n`;
        else mcp = answers;
      }
      launch = prepareInteractive(agent, rdir, launch, {attended, ...(mcp ? {mcp} : {})});
      env.PACER_HOME = ctx.pacerHome;
      env.PACER_RUN_DIR = rdir;
      env.PACER_TRANSCRIPT_REPORT = join(rdir, "transcript-report.md");
    }
  } catch (e) {
    const exec = { code: 127, stdout: "", stderr: (e as Error).message, timedOut: false };
    await Bun.write(log, `--- launch error\n${exec.stderr}\n`);
    return outcome(cfg, startedAt, exec, log, note + exec.stderr);
  }
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "argv"), launch.argv.join(" "));
  if (base) recordEnvironment(rdir, base);
  if (cfg.via !== "opencode") recordRunFolder(rdir, ctx, parseRunnerId(cfg.id)?.agent ?? cfg.id, env);
  const run: RunRef = { interactionMode: task.interactionMode, ...(agentSession ? {agentSession} : {}), dir: rdir, attempt, executor: cfg.id, startedAt, mode, workdir, logFile: log, ...(launch.lastMessageFile ? { lastMessageFile: launch.lastMessageFile } : {}) };
  updateTask(ctx, task.id, t => {
    t.run = run;
    if (conversation && agentSession) t.conversation = {...t.conversation, activity: "starting", agentSessionId: agentSession.id};
  });
  const started = startRun({ interactionMode: task.interactionMode, dir: rdir, argv: launch.argv, cwd: launch.cwd, stdin: launch.stdin, env, ...(cfg.session === "interactive" ? {session: "interactive" as const} : {}),
    ...(base ? {umask: terminalUmask(base), keepColor: profileColor(base)} : {}) });
  if ("error" in started) {
    const exec = { code: 127, stdout: "", stderr: started.error, timedOut: false };
    return outcome(cfg, startedAt, exec, log, note + started.error);
  }
  try { onSpawn?.(started.pid); } catch { /* the run continues regardless */ }
  return finishRun(ctx, cfg, task, run, note, progressPoller(ctx, task, run));
}

/** Re-attach to an attempt whose pacer runner died (Task 6). */
export async function resumeAttempt(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord): Promise<AttemptOutcome> {
  return withWork(ctx, { kind: "operation", id: task.id, label: "Executor attempt" }, () => resumeAttemptAdmitted(ctx, cfg, task));
}
async function resumeAttemptAdmitted(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord): Promise<AttemptOutcome> {
  if (!task.run) throw new Error(`task ${task.id} has no run to resume`);
  const run = task.run;
  if (run.takeover && !existsSync(join(run.dir,"pid"))) {
    const dir = runDir(ctx,task.id,run.attempt);
    if (existsSync(join(dir,"takeover.json"))) return startTakeoverRun(ctx,cfg,task,{...run,dir,takeover:false},"");
  }
  // The recorded run, not today's launch mode, decides how this attempt finishes.
  cfg = {...cfg, session: existsSync(join(run.dir, "interactive.json")) ? "interactive" : "headless"};
  const result = await finishRun(ctx, cfg, task, run, "", progressPoller(ctx, task, run));
  if (!run.host || readTask(ctx, task.id)?.state === "stopped") return result;
  const host = loadStrategy(ctx).hosts[run.host];
  await receiveQuestion(ctx,task,host,run);
  if (result.exec.timedOut) return result;
  if (result.exec.code !== 0) {
    const preflight = await runRemote(ctx, host, SCRIPTS.PREFLIGHT, [run.remoteWorktree!, run.baseSha!, run.remoteBranch ?? `pacer/${task.id}`]);
    if (preflight.code || Number(preflight.stdout.match(/^commits=(\d+)$/m)?.[1] ?? 0) === 0) return result;
  }
  // A runner may die after transfer but before recording the attempt. Reuse the
  // review worktree only when its branch matches the recorded transfer.
  const top = await gitInfo(ctx.run, task.brief.repo);
  const review = "error" in top ? undefined : taskWorktreePath(ctx, top.top, task.id);
  if (await transferred(ctx, task) && review && existsSync(review)) {
    result.worktree = review;
    return result;
  }
  const transfer = await transferBack(ctx, task, host, run);
  if (!transfer.ok) {
    result.exec = { ...result.exec, code: result.exec.code || 1, stderr: `${result.exec.stderr}\n${transfer.reason}`.trim() };
    result.attempt.exitCode = result.exec.code;
    result.report = `${transfer.reason}\n\n${result.report}`;
    result.partial = transfer.reason;
  } else {
    result.worktree = transfer.reviewWorktree;
    result.report = `ran on ${host.alias}; fetched ${transfer.branch} (${transfer.commits} commits)\n\n${result.report}`;
  }
  return result;
}
