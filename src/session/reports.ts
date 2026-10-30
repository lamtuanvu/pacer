import { timingSafeEqual } from "node:crypto";
import { appendFileSync, openSync, closeSync, readSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch } from "../exec/launch";
import type { McpChoices } from "../exec/claude-trust";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { isTaskId, readTask } from "../tasks/store";
import { validateTaskId } from "./targets";

export type ReportStatus = "done" | "failed" | "needs-input" | "running" | "turn-ended";
export interface SessionReport { status: ReportStatus; summary: string; at: number; source?: "agent" | "user" }
export const cleanSummary = (summary: string) => summary.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const statuses = ["done", "failed", "needs-input", "running", "turn-ended"];
const terminal = (s: string) => s === "done" || s === "failed";
function isConversation(dir: string): boolean {
  try { return JSON.parse(readFileSync(join(dir, "interactive.json"), "utf8")).interactionMode === "conversation"; }
  catch { return false; }
}
function parseReport(value: unknown): SessionReport | null {
  const r = value as SessionReport | null;
  return r && statuses.includes(r.status) && typeof r.summary === "string" && r.summary.trim() && r.summary.length <= 16000 && Number.isFinite(r.at) ? {...r, summary: cleanSummary(r.summary)} : null;
}
export function readReport(dir: string): SessionReport | null {
  for (const name of isConversation(dir) ? ["session-status.json"] : ["report.json", "session-status.json"]) {
    try { const r = parseReport(JSON.parse(readFileSync(join(dir, name), "utf8"))); if (r) return r; } catch { /* absent or torn signal */ }
  }
  return null;
}
export function writeReport(dir: string, status: string, summary: string, source?: "agent" | "user"): void {
  summary = cleanSummary(summary);
  if (!["done", "failed", "needs-input", "running"].includes(status)) throw Error("report status must be done, failed, needs-input or running");
  if (!summary.trim() || summary.length > 16000) throw Error("report summary must contain 1–16000 characters");
  storeReport(dir, status as ReportStatus, summary, source);
}
function storeReport(dir: string, status: ReportStatus, summary: string, source?: "agent" | "user"): void {
  const prev = readReport(dir);
  const conversation = isConversation(dir);
  if (!conversation && prev && terminal(prev.status)) return;
  const value = JSON.stringify({status, summary: cleanSummary(summary).trim(), at: Date.now() / 1000, ...(source ? {source} : {})});
  // Completion has its own file so a concurrent late hook cannot overwrite it.
  if (!conversation && terminal(status)) {
    try { writeFileSync(join(dir, "report.json"), value, {mode: 0o600, flag: "wx"}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  } else {
    const tmp = join(dir, `report.${process.pid}.${crypto.randomUUID()}.tmp`);
    writeFileSync(tmp, value, {mode: 0o600}); renameSync(tmp, join(dir, "session-status.json"));
  }
}
function tailFile(path: string): string {
  const fd = openSync(path, "r");
  try { const size = statSync(path).size, start = Math.max(0, size - 256 * 1024), buf = Buffer.alloc(size - start); readSync(fd, buf, 0, buf.length, start); return buf.toString("utf8"); }
  finally { closeSync(fd); }
}
/** Read structured assistant text only; terminal rendering is never a report. */
export function transcriptReport(dir: string): string {
  try { return tailFile(join(dir, "transcript-report.md")).slice(-16000).trim(); } catch { return ""; }
}
/** Last assistant text in a Claude or Codex JSONL transcript. */
function lastAssistantText(path: string): string {
  let text = "";
  try {
    for (const line of tailFile(path).split("\n")) {
      try {
        const row = JSON.parse(line);
        const message = row.type === "assistant" ? row.message : row.type === "response_item" && row.payload?.role === "assistant" ? row.payload : null;
        if (Array.isArray(message?.content)) {
          const content = message.content.filter((c: any) => ["text", "output_text"].includes(c.type) && typeof c.text === "string").map((c: any) => c.text).join("\n");
          if (content) text = content;
        }
      } catch { /* incomplete JSONL record */ }
    }
  } catch { /* transcript may not yet exist */ }
  return text;
}
/** Take-over reports when per-run hooks did not fire: read the agent's own session file by its id. */
export function sessionTranscript(agent: string, sessionId: string, env: Record<string, string | undefined>, home: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return "";
  const [root, pattern] = agent === "codex" ? [env.CODEX_HOME ?? join(home, ".codex"), `sessions/**/rollout-*-${sessionId}.jsonl`]
    : agent === "claude-code" ? [env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), `projects/*/${sessionId}.jsonl`] : ["", ""];
  if (!root) return "";
  try { for (const file of new Bun.Glob(pattern).scanSync({cwd: root, absolute: true})) { const text = lastAssistantText(file); if (text) return text.slice(-16000).trim(); } } catch { /* no session store */ }
  return "";
}
export function agentHook(dir: string, input: unknown): void {
  if (!input || typeof input !== "object") return;
  const h = input as Record<string, unknown>;
  if (typeof h.session_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(h.session_id)) {
    const temp = join(dir, `agent-session-id.${crypto.randomUUID()}.tmp`);
    writeFileSync(temp, h.session_id, {mode: 0o600, flag: "wx"});
    renameSync(temp, join(dir, "agent-session-id"));
  }
  let text = typeof h.last_assistant_message === "string" ? h.last_assistant_message : "";
  if (!text && typeof h.transcript_path === "string") text = lastAssistantText(h.transcript_path);
  if (text) writeFileSync(join(dir, "transcript-report.md"), text.slice(-16000), {mode: 0o600});
  const event = h.hook_event_name;
  if (event === "PermissionRequest" || event === "Elicitation" || (event === "PreToolUse" && ["AskUserQuestion", "request_user_input"].includes(String(h.tool_name))) || (event === "Notification" && ["permission_prompt", "idle_prompt", "elicitation_dialog"].includes(String(h.notification_type)))) {
    writeReport(dir, "needs-input", typeof h.message === "string" && h.message.trim() ? h.message.slice(0, 16000) : "Agent is waiting for input");
  } else if (event === "Stop") {
    storeReport(dir, "turn-ended", "Agent finished its turn; attach to answer or report completion");
  } else if (["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "ElicitationResult"].includes(String(event))) {
    writeReport(dir, "running", "Agent is working");
  }
  if (typeof event === "string") appendFileSync(join(dir, "events.jsonl"), JSON.stringify({event, status: readReport(dir)?.status, at: Date.now() / 1000}) + "\n", {mode: 0o600});
}
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/**
 * Claude settings for this launch: `attended` (the user drives the session) keeps Claude's native project MCP
 * prompt; an unattended task approves project MCP servers except the ones the user rejected (`mcp`).
 * `sessionHooks: false` leaves out pacer's PTY session hooks, for a terminal another host supervises (Orca).
 */
export type InteractiveOptions = {attended?: boolean; mcp?: McpChoices; sessionHooks?: boolean};
export function prepareInteractive(agent: string, dir: string, launch: Launch, options: InteractiveOptions = {}): Launch {
  if (!["claude-code", "codex"].includes(agent)) return launch;
  if (options.sessionHooks === false && agent === "codex") return launch;
  mkdirSync(dir, {recursive: true, mode: 0o700});
  if (options.sessionHooks === false) return withClaudeSettings(dir, launch, options, undefined);
  const cli = /(^|\/)bun(?:\.exe)?$/.test(process.execPath) ? [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))] : [process.execPath];
  const script = join(dir, "report-hook.sh");
  writeFileSync(script, `#!/bin/sh\nexec ${[...cli, "_session-hook", dir].map(quote).join(" ")}\n`, {mode: 0o700});
  const command = `/bin/sh ${quote(script)}`;
  const hooks: Record<string, {matcher?: string; hooks: {type: string; command: string}[]}[]> = Object.fromEntries(["PermissionRequest", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"].map(event => [event, [{hooks: [{type: "command", command}]}]]));
  if (agent === "codex") {
    const overrides = Object.entries(hooks).flatMap(([event]) => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`]);
    return {...launch, argv: [launch.argv[0], "--dangerously-bypass-hook-trust", ...overrides, ...launch.argv.slice(1)]};
  }
  hooks.Elicitation = [{hooks: [{type: "command", command}]}];
  hooks.ElicitationResult = [{hooks: [{type: "command", command}]}];
  hooks.Notification = [{matcher: "permission_prompt|idle_prompt|elicitation_dialog", hooks: [{type: "command", command}]}];
  return withClaudeSettings(dir, launch, options, hooks);
}
function withClaudeSettings(dir: string, launch: Launch, options: InteractiveOptions, hooks: Record<string, unknown> | undefined): Launch {
  const settings = join(dir, "claude-settings.json");
  // Per launch, so the account's settings.json stays untouched: no bypass-permissions acknowledgement dialog and, for
  // unattended task-worktree runs given the source checkout's answers, no project MCP approval prompt. The answers
  // travel along because its untracked settings.local.json is not in a task worktree; Claude rejects
  // disabledMcpjsonServers before enabling all. Without them (in-place runs, unreadable answers) Claude keeps its prompt.
  const mcp = options.attended || !options.mcp ? {} : {enableAllProjectMcpServers: true,
    ...(options.mcp?.disabled.length ? {disabledMcpjsonServers: options.mcp.disabled} : {}),
    ...(options.mcp?.enabled.length ? {enabledMcpjsonServers: options.mcp.enabled} : {})};
  writeFileSync(settings, JSON.stringify({skipDangerousModePermissionPrompt: true, ...mcp, ...(hooks ? {hooks} : {})}), {mode: 0o600});
  return {...launch, argv: [launch.argv[0], "--settings", settings, ...launch.argv.slice(1)]};
}
/** Resolve a canonical runs/<task-id>/<positive attempt> without escaped layout components. */
function reportRun(path: string): {dir: string; home: string; id: string; attempt: string} {
  const invalid = () => Error("invalid PACER_RUN_DIR layout; expected <pacerHome>/runs/<task-id>/<attempt> without symlink escapes");
  let dir: string;
  try { dir = realpathSync(path); } catch { throw invalid(); }
  const attempt = basename(dir), id = basename(dirname(dir)), runs = dirname(dirname(dir)), home = dirname(runs);
  if (basename(runs) !== "runs" || !isTaskId(id) || !/^[1-9][0-9]*$/.test(attempt)) throw invalid();
  // A whole-directory alias is allowed, but components of a supplied runs layout
  // cannot redirect a run into a different home, task or attempt.
  const supplied = resolve(path), suppliedRuns = dirname(dirname(supplied));
  if (basename(suppliedRuns) === "runs") {
    const expected = join(realpathSync(dirname(suppliedRuns)), "runs", basename(dirname(supplied)), basename(supplied));
    if (dir !== expected) throw invalid();
  }
  return {dir, home, id, attempt};
}

/** Bind agent reports to the active attempt, including when --task is supplied. */
export function reportDestination(ctx: Ctx, id?: string, explicitTask = false): {dir: string; source: "agent" | "user"; note?: string} {
  const fromRun = ctx.env.PACER_RUN_DIR;
  const insideRun = fromRun !== undefined;
  if (!insideRun && (ctx.env.PACER_ROLE || ctx.env.PACER_REPORT_TOKEN !== undefined || !explicitTask)) {
    throw Error("user reports require an explicit --task from the user's own CLI; pacer report must run in the executor's launch environment for agent reports");
  }
  const launch = insideRun ? reportRun(fromRun) : undefined;
  id ??= launch?.id;
  if (!id) throw Error("report requires --task or its launch environment");
  validateTaskId(id);
  if (launch && id !== launch.id) throw Error("report task id does not match PACER_RUN_DIR's task directory; use the executor's launch environment");
  const store = launch ? {...ctx, pacerHome: launch.home} : ctx;
  const task = readTask(store, id);
  if (!task) throw Error(launch
    ? `task ${id} not found in the launch home derived from PACER_RUN_DIR; check the executor's launch environment`
    : `task ${id} not found in PACER_HOME; pacer report must run in the executor's launch environment`);
  if (task.state !== "running") throw Error(`task ${id} is not running (state: ${task.state}); report only for the active attempt`);
  if (!task.run || task.run.host) throw Error(`task ${id} has no active local run; report from its local executor`);
  const dir = realpathSync(task.run.dir);
  if (launch && (task.id !== launch.id || launch.dir !== dir || String(task.run.attempt) !== launch.attempt)) {
    throw Error("report attempt mismatch: PACER_RUN_DIR does not match the task's current attempt; use the current launch environment");
  }
  const metadata = JSON.parse(readFileSync(join(dir, "interactive.json"), "utf8"));
  if (insideRun) {
    const supplied = Buffer.from(ctx.env.PACER_REPORT_TOKEN ?? "");
    const expected = Buffer.from(typeof metadata.reportToken === "string" ? metadata.reportToken : "");
    if (!supplied.length || !expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw Error("PACER_REPORT_TOKEN mismatch or missing for this attempt; use the executor's launch token");
    }
  }
  let currentHome = resolve(ctx.pacerHome);
  try { currentHome = realpathSync(currentHome); } catch { /* An overridden home may not exist. */ }
  const note = launch && currentHome !== launch.home ? "pacer: PACER_HOME was ignored for this report; using the launch home from PACER_RUN_DIR" : undefined;
  return {dir, source: insideRun ? "agent" : "user", ...(note ? {note} : {})};
}

/** Why this Codex cannot take per-run hook overrides (codex-cli >= 0.162.1), or null when it can. */
export async function codexInteractiveGap(ctx: Ctx, env: Record<string, string | undefined>): Promise<string | null> {
  const line = (text: string) => text.trim().split("\n")[0].slice(0, 120);
  let version;
  try { version = await ctx.run(["codex", "--version"], 5000, {env}); }
  catch (e) { return `could not verify codex-cli version (${line((e as Error).message) || "codex --version failed"})`; }
  if (version.code !== 0) return `could not verify codex-cli version (codex --version exited ${version.code}${line(version.stderr) ? `: ${line(version.stderr)}` : ""})`;
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.stdout.trim());
  if (!match) return `could not verify codex-cli version (unrecognized output ${JSON.stringify(line(version.stdout).slice(0, 80))})`;
  const supported = Number(match[1]) > 0 || Number(match[2]) > 162 || (Number(match[2]) === 162 && Number(match[3]) >= 1);
  return supported ? null : `codex-cli ${match[1]}.${match[2]}.${match[3]} is below 0.162.1 and has no per-run hook overrides`;
}

/** Conservative version floor for the per-invocation hook configuration we support. */
export async function requireCodexInteractive(ctx: Ctx, env: Record<string, string | undefined>): Promise<void> {
  if (await codexInteractiveGap(ctx, env)) throw Error("Codex interactive mode requires per-run hook overrides (codex-cli >= 0.162.1); upgrade this runner or use session: headless");
}

export function reportCommand(args: string[], ctx: Ctx): Result {
  try {
    let id: string | undefined, status = "", summary = "", explicitTask = false;
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--status" || args[i] === "--outcome") && args[i + 1]) status = args[++i];
      else if (args[i] === "--summary" && args[i + 1]) summary = args[++i];
      else if (args[i] === "--task" && args[i + 1] && !id) {id = args[++i]; explicitTask = true;}
      else if (!args[i].startsWith("-") && !id) id = args[i];
      else throw Error("usage: pacer report [task-id] --status done|failed|needs-input|running --summary <text>");
    }
    const {dir, source, note} = reportDestination(ctx, id, explicitTask);
    writeReport(dir, status, summary, source);
    return {code: 0, out: `Reported ${status}`, err: note ?? ""};
  } catch (e) { return {code: 2, out: "", err: `pacer: ${(e as Error).message}`}; }
}
