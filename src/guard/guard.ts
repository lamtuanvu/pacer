import { accountFolder, isExecutorSession, plannerPolicyApplies, plannerSessionStatus } from "../install/role";
import { guardEventId, stateHash } from "../classify/state";
import { appendLabel } from "../tasks/labels";
import { activeHooks } from "../classify/active";
import type { DecisionHooks, GuardInput } from "../classify/hooks";
import { displayName, type Status } from "../engine/status";
import { loadStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { isObj } from "../util";
import { HttpClient } from "../api/http-client";
import { DEFAULT_PORT } from "../serve/constants";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const GUARD_PLANNERS = ["claude-code", "codex", "cursor"] as const;
const ALLOW_TYPES = ["Explore", "Plan", "claude-code-guide", "statusline-setup",
  "*reviewer*", "*analyzer*", "pr-review-toolkit:*", "pacer-*", "pacer:*"];

/** CLIs the shell guard recognizes as pacer-managed executors (issue #451). */
const EXECUTOR_CLIS = ["claude", "codex", "pi", "opencode"] as const;
/** Only claude and codex accounts have a config-folder env var worth matching against a managed home. */
const DIR_VARIABLE: Partial<Record<(typeof EXECUTOR_CLIS)[number], "CLAUDE_CONFIG_DIR" | "CODEX_HOME">> = {
  claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME",
};

export interface GuardDeps {
  hooks?: DecisionHooks;
  status?: (ctx: Ctx) => Promise<Status>;
  timeoutMs?: number;
}
export interface GuardDecision { allow: boolean; reason?: string; source?: string }

/** Only * is a wildcard; all other regexp characters in agent names are literal. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "i").test(value);
}

export function parseGuardInput(planner: string, raw: unknown): GuardInput | null {
  if (!isObj(raw)) return null;
  if (planner === "cursor") {
    return {
      subagentType: typeof raw.subagent_type === "string" ? raw.subagent_type : "generalPurpose",
      prompt: typeof raw.task === "string" ? raw.task : "",
      ...(typeof raw.subagent_model === "string" ? { model: raw.subagent_model } : {}),
    };
  }
  const tools = planner === "claude-code" ? ["Agent", "Task"] : planner === "codex" ? ["spawn_agent", "Agent"] : [];
  if (typeof raw.tool_name !== "string" || !tools.includes(raw.tool_name)) return null;
  const fields = isObj(raw.tool_input) ? raw.tool_input : {};
  const type = planner === "codex" ? fields.agent_type : fields.subagent_type;
  const prompt = planner === "codex" ? fields.message : fields.prompt;
  return {
    subagentType: typeof type === "string" ? type : planner === "codex" ? "default" : "general-purpose",
    prompt: typeof prompt === "string" ? prompt : "",
  };
}

export async function decideGuard(ctx: Ctx, input: GuardInput, deps: GuardDeps = {}): Promise<GuardDecision> {
  if (isExecutorSession(ctx) || (ctx.env.PACER ?? "").toLowerCase() === "off") return { allow: true };
  const id = guardEventId(input);
  const verdict = (decision: GuardDecision, source: string): GuardDecision => {
    try {
      appendLabel(ctx, { type: "guard_verdict", event_id: id, blocked: !decision.allow, source });
    } catch {
      // Ground-truth logging must never change the guard's decision.
    }
    return decision;
  };
  const opinion = await (deps.hooks ?? activeHooks).guard(ctx, input).catch(() => null);
  if (opinion?.allow) return verdict({ allow: true, source: "classifier" }, "classifier");
  if (!opinion && ALLOW_TYPES.some((pattern) => globMatch(pattern, input.subagentType))) return verdict({ allow: true }, "rules");

  const st = await (deps.status ? deps.status(ctx) : plannerSessionStatus(ctx));
  if (!opinion && st.providers.some((provider) =>
    input.subagentType.toLowerCase() === `${provider.id}-executor`.toLowerCase())) return verdict({ allow: true }, "rules");
  const plannerStatus = st.providers.find(p => p.id === st.planner);
  if (!plannerStatus || plannerStatus.verdict === "UNKNOWN") return verdict({ allow: true }, "rules");
  const alternative = st.executors.ranked.find(e => e.eligibility?.state === "eligible");
  if (st.mode === "relaxed" || !alternative) return verdict({ allow: true }, "rules");

  const planner = displayName(st.planner);
  let reason = `pacer: '${input.subagentType}' is a ${planner} subagent, so it spends ${planner}'s own quota (mode: ${st.mode}). Delegate execution work with \`pacer delegate --brief-file - --json\` (top executor now: ${alternative.id}) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.`;
  if (opinion?.reason) reason += ` (${opinion.reason})`;
  reason += ` (pacer event ${id}: if this block was wrong, ask the user to start the session with PACER=off; with the pacer MCP tools connected, call guard_feedback with event_id "${id}" and correct=false)`;
  return verdict({ allow: false, reason }, opinion ? "classifier" : "rules");
}

/** Strips a leading path so `/usr/local/bin/claude` still matches `claude`. */
function cliBaseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** One shell word with quoting removed. `assign` is the index of a `=` that makes the word a `NAME=value`
 * assignment (the name and the `=` were unquoted), or -1. */
interface ShellWord { text: string; assign: number }
type ShellToken = ShellWord | { op: ";" | "&&" | "||" | "|" | "&" };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Splits a command into words and control operators, honouring single/double quotes, backslash escapes and
 * `#` comments, so that operators and comments inside quoted text stay part of a word. Redirections such as
 * `2>&1`, `&>file` and `>|file` stay inside their word. Best effort: no expansion, heredocs or grouping. */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word: ShellWord | null = null;
  let quoted = false;
  const push = (ch: string) => {
    word ??= { text: "", assign: -1 };
    if (ch === "=" && !quoted && word.assign === -1 && NAME.test(word.text)) word.assign = word.text.length;
    word.text += ch;
  };
  const end = () => { if (word) tokens.push(word); word = null; quoted = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!, next = command[i + 1];
    if (ch === "'") {
      const close = command.indexOf("'", i + 1), stop = close === -1 ? command.length : close;
      word ??= { text: "", assign: -1 };
      quoted = true;
      word.text += command.slice(i + 1, stop);
      i = stop;
    } else if (ch === '"') {
      word ??= { text: "", assign: -1 };
      quoted = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const escaped = command[i + 1];
        if (command[i] === "\\" && escaped !== undefined && '$`"\\\n'.includes(escaped)) {
          i++;
          if (escaped !== "\n") word.text += escaped;
        } else word.text += command[i];
      }
    } else if (ch === "\\") {
      if (next === "\n") { i++; continue; }
      if (next !== undefined) { word ??= { text: "", assign: -1 }; quoted = true; word.text += next; i++; }
    } else if (ch === "#" && !word) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (ch === " " || ch === "\t") {
      end();
    } else if (ch === "\n" || ch === ";") {
      end(); tokens.push({ op: ";" });
    } else if (ch === "&" && next === "&") {
      end(); tokens.push({ op: "&&" }); i++;
    } else if (ch === "|" && next === "|") {
      end(); tokens.push({ op: "||" }); i++;
    } else if ((ch === "&" || ch === "|") && word && /[<>]$/.test(word.text)) {
      push(ch);
    } else if (ch === "&" && next === ">") {
      push(ch);
    } else if (ch === "|") {
      end(); tokens.push({ op: "|" });
      if (next === "&") i++;
    } else if (ch === "&") {
      end(); tokens.push({ op: "&" });
    } else push(ch);
  }
  end();
  return tokens;
}

/** A simple command's leading `NAME=value` assignments and program, skipping a bare `env`/`exec` prefix with
 * no flags (so `env PACER_ROLE=executor claude ...` reads the same as the bare form). */
function parseSimpleCommand(words: ShellWord[]): { assignments: Record<string, string>; program: number } {
  const assignments: Record<string, string> = {};
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if (w.assign !== -1) { assignments[w.text.slice(0, w.assign)] = w.text.slice(w.assign + 1); continue; }
    if ((w.text === "env" || w.text === "exec") && w.assign === -1 && words[i + 1] && !words[i + 1]!.text.startsWith("-")) continue;
    break;
  }
  return { assignments, program: i };
}

function expandHome(value: string, home: string): string {
  if (value === "~" || value === "$HOME" || value === "${HOME}") return home;
  if (value.startsWith("~/")) return home + value.slice(1);
  if (value.startsWith("$HOME/")) return home + value.slice(5);
  if (value.startsWith("${HOME}/")) return home + value.slice(7);
  return value;
}

/** Resolved folders of this account kind's non-default accounts: only pacer is meant to use them (docs/accounts.md). */
function managedHomes(ctx: Ctx, kind: "claude" | "codex"): string[] {
  let strategy;
  try { strategy = loadStrategy(ctx); } catch { return []; }
  const homes: string[] = [];
  for (const account of Object.values(strategy.accounts)) {
    if (account.kind !== kind) continue;
    const folder = accountFolder(ctx, account);
    if (folder) homes.push(resolve(folder));
  }
  return homes;
}

export interface ShellLaunch { cli: string }
const MAX_SHELL_DEPTH = 8;
/**
 * Detects a command that starts one of the known executor CLIs (claude, codex, pi, opencode) while either
 * setting PACER_ROLE=executor, or pointing CLAUDE_CONFIG_DIR/CODEX_HOME at a pacer-managed (non-default) account
 * home — the shell-tool equivalent of the Agent/Task subagent guard (issue #451). An inline assignment,
 * `env`/`exec`, an `export` earlier in the same command, and `bash -c '...'`/`sh -c "..."`/`zsh -c` (which
 * inherit the environment in effect where they start) are all recognized; quoted and commented text is inert.
 * Best effort, not a shell parser: a variable exported in an *earlier, separate* Bash tool call, a launch hidden
 * behind a script file, variable expansion, `env`/`bash -c` with other flags in front, parenthesized/subshell
 * grouping (e.g. `(export ... && claude ...)`), `unset`, and heredoc bodies (which can false-positive, since they
 * are not recognized as inert text) are not caught here.
 */
export function detectShellExecutorLaunch(ctx: Ctx, command: string, inherited: Record<string, string> = {}, depth = 0): ShellLaunch | null {
  if (depth > MAX_SHELL_DEPTH) return null;
  // Exported variables (inherited by child processes) and plain shell variables of this shell.
  const exported: Record<string, string> = { ...inherited };
  const shellVars: Record<string, string> = { ...inherited };
  const tokens = tokenizeShell(command);
  let start = 0;
  while (start < tokens.length) {
    // One pipeline: commands joined by `|`, ended by `;`, `&&`, `||`, `&` or a newline.
    const stages: ShellWord[][] = [[]];
    let i = start;
    for (; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (!("op" in t)) { stages[stages.length - 1]!.push(t); continue; }
      if (t.op === "|") { stages.push([]); continue; }
      break;
    }
    const terminator = tokens[i] as { op: string } | undefined;
    start = i + 1;
    // A multi-stage pipeline or a background job runs in a subshell: its exports do not reach later commands.
    const persists = stages.length === 1 && terminator?.op !== "&";
    for (const words of stages) {
      if (words.length === 0) continue;
      const env = persists ? exported : { ...exported };
      const vars = persists ? shellVars : { ...shellVars };
      if (words[0]!.text === "export" && words[0]!.assign === -1) {
        for (const w of words.slice(1)) {
          if (w.assign !== -1) { const name = w.text.slice(0, w.assign); env[name] = vars[name] = w.text.slice(w.assign + 1); }
          else if (NAME.test(w.text) && vars[w.text] !== undefined) env[w.text] = vars[w.text]!;
        }
        continue;
      }
      const { assignments, program } = parseSimpleCommand(words);
      const programWord = words[program];
      if (!programWord) {
        // A bare `NAME=value` statement sets a shell variable, and updates it in the environment if exported.
        for (const [name, value] of Object.entries(assignments)) {
          vars[name] = value;
          if (env[name] !== undefined) env[name] = value;
        }
        continue;
      }
      const merged = { ...env, ...assignments };
      const name = cliBaseName(programWord.text);
      if (["bash", "sh", "zsh"].includes(name)) {
        const script = words[program + 1]?.text === "-c" ? words[program + 2]?.text : undefined;
        const nested = script !== undefined ? detectShellExecutorLaunch(ctx, script, merged, depth + 1) : null;
        if (nested) return nested;
        continue;
      }
      if (!(EXECUTOR_CLIS as readonly string[]).includes(name)) continue;
      if ((merged.PACER_ROLE ?? "").trim() === "executor") return { cli: name };
      const dirVariable = DIR_VARIABLE[name as (typeof EXECUTOR_CLIS)[number]];
      if (!dirVariable || merged[dirVariable] === undefined) continue;
      const target = resolve(expandHome(merged[dirVariable], ctx.home));
      if (managedHomes(ctx, name as "claude" | "codex").includes(target)) return { cli: name };
    }
  }
  return null;
}

/** The shell-tool counterpart of decideGuard: blocks a planner's Bash tool from starting a pacer-managed executor
 * CLI directly, so that work still goes through pacer's routing, review and budget. Same exemptions as the
 * subagent guard (PACER=off, executor sessions, relaxed mode, no eligible alternative executor). */
export async function decideShellGuard(ctx: Ctx, command: string, deps: GuardDeps = {}): Promise<GuardDecision> {
  if (isExecutorSession(ctx) || (ctx.env.PACER ?? "").toLowerCase() === "off") return { allow: true };
  const launch = detectShellExecutorLaunch(ctx, command);
  if (!launch) return { allow: true };
  const id = stateHash(JSON.stringify({ shell_cli: launch.cli, command: command.slice(0, 4000) }));
  const verdict = (decision: GuardDecision): GuardDecision => {
    try {
      appendLabel(ctx, { type: "guard_verdict", event_id: id, blocked: !decision.allow, source: "rules" });
    } catch {
      // Ground-truth logging must never change the guard's decision.
    }
    return decision;
  };

  const st = await (deps.status ? deps.status(ctx) : plannerSessionStatus(ctx));
  const plannerStatus = st.providers.find(p => p.id === st.planner);
  if (!plannerStatus || plannerStatus.verdict === "UNKNOWN") return verdict({ allow: true });
  const alternative = st.executors.ranked.find(e => e.eligibility?.state === "eligible");
  if (st.mode === "relaxed" || !alternative) return verdict({ allow: true });

  const planner = displayName(st.planner);
  const reason = `pacer: this shell command starts '${launch.cli}' as a pacer-managed executor, so it would spend ${planner}'s own quota outside pacer's routing, review and budget (mode: ${st.mode}). Delegate execution work with \`pacer delegate --brief-file - --json\` (top executor now: ${alternative.id}) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.`
    + ` (pacer event ${id}: if this block was wrong, ask the user to start the session with PACER=off; with the pacer MCP tools connected, call guard_feedback with event_id "${id}" and correct=false)`;
  return verdict({ allow: false, reason });
}

export function renderGuard(planner: string, decision: GuardDecision): string {
  if (planner === "cursor") return JSON.stringify(decision.allow
    ? { permission: "allow" }
    : { permission: "deny", user_message: decision.reason });
  if (decision.allow) return "";
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason,
  } });
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort peek at the hook payload's tool name, tolerant of malformed stdin (fails closed below). */
function peekToolName(stdin: string): string | null {
  try {
    const raw = JSON.parse(stdin);
    return isObj(raw) && typeof raw.tool_name === "string" ? raw.tool_name : null;
  } catch { return null; }
}

export async function runGuard(ctx: Ctx, planner: string, stdin: string, deps: GuardDeps = {}): Promise<string> {
  if (!(GUARD_PLANNERS as readonly string[]).includes(planner)) return "";
  // The strict-executor native-child guard (dispatch/enforcement.ts) covers Agent/Task-style subagent entry
  // points only; a Bash call falls through to the ordinary flow below, where an executor session is exempt
  // from the delegation guard anyway. Malformed/unreadable stdin stays fail-closed, as before.
  if (ctx.env.PACER_ROLE === "executor" && ctx.env.PACER_ENFORCEMENT_MODE === "strict" && peekToolName(stdin) !== "Bash") {
    const reason = "pacer: native subagents are blocked for this managed attempt. Request child work with `pacer dispatch child --goal ... --request-id ...`.";
    if(ctx.env.PACER_CANARY_MARKER){
      try {writeFileSync(ctx.env.PACER_CANARY_MARKER, "native-child.denied", {flag:"wx",mode:0o600});}
      catch { /* A canary marker must not change the deny result. */ }
    }
    try {
      const token=ctx.env.PACER_ENFORCEMENT_TOKEN??"";
      if(!/^pet_[0-9a-f]{64}$/.test(token))throw Error("Invalid enforcement identity");
      const client=new HttpClient(`http://127.0.0.1:${ctx.env.PACER_PORT??DEFAULT_PORT}`,token,{protocol:3,timeoutMs:1500});
      try {await client.call("dispatch.enforcement.denied",{agent:planner});}
      finally {client.close();}
    } catch {
      const marker=ctx.env.PACER_GUARD_FAILURE_MARKER;
      if(marker)try{writeFileSync(marker,"guard-report-failed",{flag:"wx",mode:0o600});}catch{}
      // Missing or invalid enforcement identity also denies.
    }
    return renderGuard(planner,{allow:false,reason});
  }
  const allow: GuardDecision = { allow: true };
  try {
    const raw = JSON.parse(stdin);
    if (!plannerPolicyApplies(ctx, planner, raw)) return renderGuard(planner, allow);
    if (planner === "claude-code" && isObj(raw) && raw.tool_name === "Bash") {
      const command = isObj(raw.tool_input) && typeof raw.tool_input.command === "string" ? raw.tool_input.command : "";
      const decision = command
        ? await withTimeout(decideShellGuard(ctx, command, deps), deps.timeoutMs ?? 10000, allow)
        : allow;
      return renderGuard(planner, decision);
    }
    const input = parseGuardInput(planner, raw);
    const decision = input
      ? await withTimeout(decideGuard(ctx, input, deps), deps.timeoutMs ?? 10000, allow)
      : allow;
    return renderGuard(planner, decision);
  } catch {
    return renderGuard(planner, allow);
  }
}
