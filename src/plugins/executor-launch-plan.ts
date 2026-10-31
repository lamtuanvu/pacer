import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderCfg } from "../config/strategy";
import type { ExecutionCfg } from "../config/execution";
import { parseRunnerId } from "../config/runner-id";
import { STRICT_INTERACTIVE_REASON, planStrictClaudeLaunch } from "../dispatch/enforcement";
import { mcpNotApproved, preapproveClaudeTrust, projectMcpAnswers } from "../exec/direct";
import { headlessTurnPath, INTERACTIVE_PROMPT_BYTES, launchFor, launchModeFor, promptFileInstruction,
  providerEnv, resumeHeadlessFor, type Launch, type LaunchModeChoice } from "../exec/launch";
import { executorEnv, execProcess } from "../exec/process";
import { profileColor, profileKeys, strictServiceEnv, terminalEnv, terminalEnvNote, terminalUmask } from "../exec/login-env";
import { recordDefaultFolder } from "../exec/account-folder";
import type { McpChoices } from "../exec/claude-trust";
import { claimTurnMessages, renderReplayThread, renderTurnPrompt } from "../messaging/turns";
import { parseOpencodeSessions } from "../session/takeover";
import { codexInteractiveGap, planInteractive, requireCodexInteractive } from "../session/reports";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import type { ExecutorLaunchFile } from "./authority";

export type OwnedLaunchPlan = { refused: string; cfg: ProviderCfg } | {
  refused?: undefined; cfg: ProviderCfg; interactive: boolean; note: string; launch: Launch;
  files: ExecutorLaunchFile[]; env: Record<string, string>; umask?: string; keepColor?: string[];
  agentSession?: NonNullable<RunRef["agentSession"]>; turnResume?: "replayed" };

/**
 * The host-side launch for a provider-owned local attempt, built as src/exec/direct.ts builds it: launch mode,
 * terminal environment, message turn and native session, strict guard and interactive settings. Run files are
 * returned for host publication after the empty run-directory claim; nothing is written into the run directory here.
 */
export async function planOwnedLaunch(ctx: Ctx, input: { cfg: ProviderCfg; task: TaskRecord;
  execution: ExecutionCfg; placement: "current" | "new"; workdir: string; dir: string; brief: string;
  repoRoots: string[]; trustRoot?: string }): Promise<OwnedLaunchPlan> {
  const { task, workdir, dir, brief } = input;
  const strict = ctx.env.PACER_ENFORCEMENT_MODE === "strict";
  let choice: LaunchModeChoice = launchModeFor(input.cfg, input.execution, { managed: strict });
  // A message turn runs headless: one prompt in, one report out, then the run settles.
  if (task.pendingTurn && choice.mode === "interactive" && headlessTurnPath(input.cfg))
    choice = { mode: "headless", explicit: false, fallback: "message turns run headless" };
  let cfg: ProviderCfg = { ...input.cfg, session: choice.mode };
  // Certification covers headless launches only; an explicit interactive runner set after admission must not slip through.
  if (strict && choice.mode === "interactive") return { refused: STRICT_INTERACTIVE_REASON, cfg };
  // A new worktree does not exist until the provider's placement effect, so only an existing folder adds its tools.
  const base = strict ? strictServiceEnv(ctx.env)
    : await terminalEnv(ctx.env, { cwd: ctx.home, ...(existsSync(workdir) ? { workdir } : {}) });
  let note = terminalEnvNote(base);
  const account = await providerEnv(ctx, cfg);
  const env = executorEnv(base.env, account, task.id, profileKeys(base));
  const agent = parseRunnerId(cfg.id)?.agent ?? cfg.id;
  if (cfg.via !== "opencode") recordDefaultFolder(ctx, agent, account, base);
  if (choice.mode === "interactive" && !choice.explicit && agent === "codex" && cfg.via !== "opencode") {
    const gap = await codexInteractiveGap(ctx, env);
    if (gap) { choice = { mode: "headless", explicit: false, fallback: gap }; cfg = { ...cfg, session: "headless" }; }
  }
  if (choice.fallback) note += `launch mode: headless (${choice.fallback})\n\n`;
  const interactive = cfg.session === "interactive";
  const pendingTurn = task.pendingTurn;
  // Claiming is idempotent for one turn id, so a restart before START sends the same messages once.
  const turn = !interactive && pendingTurn ? claimTurnMessages(ctx, task) : null;
  const prompt = turn ? renderTurnPrompt(ctx, task, turn.messages) : brief;
  const instructions = interactive ? `\n\nInteractive pacer session: completion requires running pacer report --task ${task.id} --outcome done --summary "<result>" (or --outcome failed). Run pacer report with the launch environment unchanged; do not override PACER_HOME or HOME for it. Before asking the user, run pacer report --status needs-input --summary "<question>"; when resuming use --status running. Do not infer completion from the terminal. PACER_RUN_DIR identifies this attempt. You may write a longer Markdown result to $PACER_TRANSCRIPT_REPORT.\n` : "";
  // The session captured when the turn started; the runner has already cleared task.run.
  const priorSession = turn && !pendingTurn?.replay
    ? (pendingTurn?.executor === cfg.id ? pendingTurn.session : undefined) ??
      (task.run?.executor === cfg.id ? task.run.agentSession : undefined) : undefined;
  let agentSession: RunRef["agentSession"];
  if (!interactive && cfg.via !== "opencode") {
    if (priorSession) agentSession = priorSession;
    else if (agent === "claude-code") agentSession = { id: randomUUID(), source: "assigned" };
    else if (agent === "cursor") {
      try {
        const chat = await execProcess({ argv: ["cursor-agent", "create-chat"], cwd: workdir, env, timeoutMs: 5000 });
        const id = chat.stdout.trim();
        if (chat.code === 0 && id && !/\s|[\x00-\x1f\x7f]/.test(id)) agentSession = { id, source: "assigned" };
      } catch { /* best effort: launch unchanged */ }
    }
  }
  if (turn && !pendingTurn?.replay && !agentSession && cfg.via === "opencode") {
    if (priorSession) agentSession = priorSession;
    else {
      const list = await execProcess({ argv: ["opencode", "session", "list", "--standalone", "--format", "json", "-n", "20"],
        cwd: workdir, env, timeoutMs: 5000 });
      const sid = list.code === 0 ? parseOpencodeSessions(list.stdout, task.id) : undefined;
      if (sid) agentSession = { id: sid, source: "lookup" };
    }
  }
  // Only a stored or discovered session resumes; a freshly assigned one replays the brief.
  let resumeSession = turn ? (priorSession ?? (agentSession?.source === "lookup" ? agentSession : undefined)) : undefined;
  let launch: Launch | undefined;
  if (resumeSession) {
    // No headless resume for this agent: replay the thread in a fresh session instead.
    try { launch = resumeHeadlessFor(cfg, resumeSession.id, prompt, workdir, dir, task.id); }
    catch { if (agentSession === resumeSession) agentSession = undefined; resumeSession = undefined; }
  }
  const files: ExecutorLaunchFile[] = [];
  if (!launch) {
    let text = turn ? [brief, renderReplayThread(ctx, task, turn.messages), prompt].filter(Boolean).join("\n\n") : prompt + instructions;
    if (interactive && Buffer.byteLength(text, "utf8") > INTERACTIVE_PROMPT_BYTES) {
      files.push({ name: "prompt.md", content: text, mode: 0o600 });
      text = promptFileInstruction(join(dir, "prompt.md"));
    }
    launch = launchFor(cfg, text, workdir, dir, task.id, agentSession?.id, input.trustRoot ?? workdir);
  }
  if (strict && agent === "claude-code") {
    const guarded = planStrictClaudeLaunch(ctx, launch.argv, dir);
    launch = { ...launch, argv: guarded.argv };
    files.push(guarded.file);
  }
  if (interactive) {
    if (agent === "codex" && choice.explicit) await requireCodexInteractive(ctx, env);
    // A delegated interactive lane runs unattended, as a task does.
    let mcp: McpChoices | undefined;
    if (agent === "claude-code") {
      note += await preapproveClaudeTrust(ctx, env, input.placement, launch.cwd, input.trustRoot);
      const answers = projectMcpAnswers(ctx, env, input.placement, launch.cwd, input.repoRoots);
      if ("reason" in answers) note += `${mcpNotApproved(answers.reason)}\n\n`;
      else mcp = answers;
    }
    const planned = planInteractive(agent, dir, launch, { attended: false, ...(mcp ? { mcp } : {}) });
    launch = planned.launch;
    files.push(...planned.files);
    env.PACER_HOME = ctx.pacerHome;
    env.PACER_RUN_DIR = dir;
    env.PACER_TRANSCRIPT_REPORT = join(dir, "transcript-report.md");
  }
  const umask = terminalUmask(base), keepColor = profileColor(base);
  return { cfg, interactive, note, launch, files,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...(umask ? { umask } : {}), ...(keepColor.length ? { keepColor } : {}),
    ...(agentSession ? { agentSession } : {}), ...(turn && !resumeSession ? { turnResume: "replayed" as const } : {}) };
}
