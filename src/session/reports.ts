import { appendFileSync, openSync, closeSync, readSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Launch } from "../exec/launch";
import type { Ctx } from "../types";
import type { Result } from "../commands/types";
import { readTask } from "../tasks/store";
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
export function prepareInteractive(agent: string, dir: string, launch: Launch): Launch {
  if (!["claude-code", "codex"].includes(agent)) return launch;
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const cli = /(^|\/)bun(?:\.exe)?$/.test(process.execPath) ? [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))] : [process.execPath];
  const script = join(dir, "report-hook.sh");
  writeFileSync(script, `#!/bin/sh\nexec ${[...cli, "_session-hook", dir].map(quote).join(" ")}\n`, {mode: 0o700});
  const command = `/bin/sh ${quote(script)}`;
  const hooks: Record<string, {matcher?: string; hooks: {type: string; command: string}[]}[]> = Object.fromEntries(["PermissionRequest", "Stop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure"].map(event => [event, [{hooks: [{type: "command", command}]}]]));
  if (agent === "codex") {
    const overrides = Object.entries(hooks).flatMap(([event]) => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`]);
    return {...launch, argv: [launch.argv[0], ...overrides, ...launch.argv.slice(1)]};
  }
  hooks.Elicitation = [{hooks: [{type: "command", command}]}];
  hooks.ElicitationResult = [{hooks: [{type: "command", command}]}];
  hooks.Notification = [{matcher: "permission_prompt|idle_prompt|elicitation_dialog", hooks: [{type: "command", command}]}];
  const settings = join(dir, "claude-settings.json");
  writeFileSync(settings, JSON.stringify({hooks}), {mode: 0o600});
  return {...launch, argv: [launch.argv[0], "--settings", settings, ...launch.argv.slice(1)]};
}
/** Bind agent reports to the active attempt, including when --task is supplied. */
export function reportDestination(ctx: Ctx, id?: string, explicitTask = false): {dir: string; source: "agent" | "user"} {
  const fromRun = ctx.env.PACER_RUN_DIR;
  const insideRun = fromRun !== undefined;
  if (!insideRun && (ctx.env.PACER_ROLE || ctx.env.PACER_REPORT_TOKEN !== undefined || !explicitTask)) {
    throw Error("user reports require an explicit --task from the user's own CLI");
  }
  id ??= insideRun ? basename(dirname(realpathSync(fromRun))) : undefined;
  if (!id) throw Error("report requires --task or its launch environment");
  validateTaskId(id);
  const task = readTask(ctx, id);
  if (!task?.run || task.run.host || task.state !== "running") throw Error("task has no active local run");
  const dir = realpathSync(task.run.dir);
  if (insideRun && realpathSync(fromRun) !== dir) throw Error("report run directory does not match the task's current attempt");
  const metadata = JSON.parse(readFileSync(join(dir, "interactive.json"), "utf8"));
  if (insideRun && (typeof metadata.reportToken !== "string" || !metadata.reportToken || ctx.env.PACER_REPORT_TOKEN !== metadata.reportToken)) {
    throw Error("invalid or missing PACER_REPORT_TOKEN for this attempt");
  }
  return {dir, source: insideRun ? "agent" : "user"};
}

/** Conservative version floor for the per-invocation hook configuration we support. */
export async function requireCodexInteractive(ctx: Ctx, env: Record<string, string | undefined>): Promise<void> {
  const version = await ctx.run(["codex", "--version"], 5000, {env});
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.stdout.trim());
  const supported = match && (Number(match[1]) > 0 || Number(match[2]) > 162 || (Number(match[2]) === 162 && Number(match[3]) >= 1));
  if (version.code !== 0 || !supported) throw Error("Codex interactive mode requires per-run hook overrides (codex-cli >= 0.162.1); upgrade this runner or use session: headless");
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
    const {dir, source} = reportDestination(ctx, id, explicitTask);
    writeReport(dir, status, summary, source);
    return {code: 0, out: `Reported ${status}`, err: ""};
  } catch (e) { return {code: 2, out: "", err: `pacer: ${(e as Error).message}`}; }
}
