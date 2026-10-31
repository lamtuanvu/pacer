import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Ctx } from "../types";
import type { Strategy } from "../config/strategy";
import type { Status } from "../engine/status";
import type { Check } from "./doctor";
import { accountFolder } from "./role";
import { parseJsonc } from "./jsonc";
import { readText, shellCommand } from "./fsx";
import { readManifest } from "./manifest";
import { isObj } from "../util";
import { defaultHooks } from "../classify/hooks";
import { runGuard } from "../guard/guard";
import { renderHook } from "../render/hook";
import { sessionHook } from "../messaging/identity";
import { promptHook, stopHook } from "../messaging/hooks";
import { insertMessage } from "../messaging/store";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { readScheduleState, attemptHold, plannerScheduleKey } from "../dispatch/certification-schedule";

/** A different planner does not require Claude hooks unless a Claude integration remains installed. */
export function claudeHooksApplicable(ctx: Ctx, strategy?: Strategy): boolean {
  if (strategy?.planner.agent === "claude-code") return true;
  try { return Object.values(readManifest(ctx).planners).some(record => record.planner.startsWith("claude-code")); }
  catch { return false; } // The manifest check reports malformed records separately.
}

function executablePresent(ctx: Ctx, command: string): boolean {
  if (!command.includes("/")) return ctx.which(command) !== null;
  try { accessSync(command, constants.X_OK); return statSync(command).isFile(); }
  catch { return false; }
}

/** Inspect only integration settings. Never evaluate command strings or expose their contents. */
export function claudeHookChecks(ctx: Ctx, strategy?: Strategy): Check[] {
  if (strategy && strategy.planner.agent !== "claude-code") return [{
    name: "Claude hook configuration", level: "info", evidence: "unverified",
    detail: "UNVERIFIED: Claude Code is not selected as the planner. Installed Claude integrations were not inspected; default account settings were not used.",
    fix: "To inspect a Claude integration, select its Claude Code planner account and run diagnostics again.",
  }];
  const account = strategy?.planner.agent === "claude-code" ? strategy.accounts[strategy.planner.account] : undefined;
  const expected = account ? accountFolder(ctx, account) : null;
  if (account && account.source !== "default" && !expected) return [
    { name: "Claude config folder", level: "warn", evidence: "unverified", detail: `Selected account ${account.name} has no resolved configuration folder.`, fix: "Restore the selected account home or select an available planner account." },
    { name: "Claude hook configuration", level: "warn", evidence: "unverified", detail: "Selected account settings could not be inspected. Default account settings were not used." },
    { name: "Claude host invocation", level: "info", evidence: "unverified", detail: "UNVERIFIED: selected account folder is unavailable; no host invocation evidence collected." },
  ];
  const folder = expected ?? join(ctx.home, ".claude");
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  const mismatch = !!override && resolve(override) !== resolve(folder);
  const prefixes = new Map<string, boolean>([["pacer", executablePresent(ctx, "pacer")]]);
  try {
    for (const record of Object.values(readManifest(ctx).planners)) {
      if (record.planner.startsWith("claude-code")) prefixes.set(shellCommand(record.pacerArgv), executablePresent(ctx, record.pacerArgv[0] ?? ""));
    }
  } catch { /* The manifest diagnostic reports malformed install records separately. */ }
  const checks: Check[] = [{ name: "Claude config folder", level: mismatch ? "warn" : "info", evidence: "configured",
    detail: `Selected account settings: ${folder}/settings.json${override ? `; service CLAUDE_CONFIG_DIR: ${override}` : "; service has no CLAUDE_CONFIG_DIR override"}. The Claude session may use different project or launch settings.`,
    ...(mismatch ? { fix: "Launch Claude with the selected account folder, or select the matching planner account. Restart the service after changing its environment." } : {}) }];
  let configured = false;
  let messageHooks = false;
  let missingExecutable = false;
  let issue = "Settings are missing. Reconnect Claude Code after reviewing the integration preview.";
  const text = readText(join(folder, "settings.json"));
  if (text !== null) {
    try {
      const settings = parseJsonc(text);
      const groups = (event: string): unknown[] => isObj(settings.hooks) && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      const has = (event: string, suffix: string, matcher?: string) => groups(event).some(group =>
        isObj(group) && (matcher ? group.matcher === matcher : group.matcher === undefined || group.matcher === "" || group.matcher === "*") && Array.isArray(group.hooks) && group.hooks.some(hook =>
          isObj(hook) && hook.type === "command" && hook.async !== true && typeof hook.command === "string" &&
          [...prefixes].some(([prefix, available]) => {
            if (hook.command !== `${prefix} ${suffix}`) return false;
            if (!available) missingExecutable = true;
            return available;
          })));
      const session = has("SessionStart", "status --hook claude-code") || has("SessionStart", "msg hook session --planner claude-code");
      const guard = has("PreToolUse", "guard --planner claude-code", "Agent|Task|Bash");
      configured = settings.disableAllHooks !== true && session && guard && !missingExecutable;
      messageHooks = settings.disableAllHooks !== true && has("Stop", "msg hook stop --planner claude-code") &&
        has("UserPromptSubmit", "msg hook prompt --planner claude-code") && !missingExecutable;
      issue = missingExecutable ? "A registered hook command executable is missing or not executable. Reconnect the selected integration after restoring the command. No settings commands were executed."
        : settings.disableAllHooks === true ? "All Claude hooks are disabled in the selected account settings."
        : !session || !guard ? "Missing or unsupported session-start command or synchronous Agent|Task|Bash guard. Custom commands and matchers are not certified by this check."
        : "Session-start context and synchronous Agent|Task|Bash guard are configured. Configuration is not evidence of live invocation.";
      if (settings.disableAllHooks !== undefined && typeof settings.disableAllHooks !== "boolean") {
        configured = false; issue = "The disableAllHooks setting has an invalid type.";
      }
    } catch { issue = "Settings JSON is malformed; repair it before reconnecting. No settings contents were executed."; }
  }
  checks.push({ name: "Claude hook configuration", level: configured && !mismatch ? "ok" : "warn", evidence: configured ? "configured" : "unverified", detail: issue,
    ...(!configured ? { fix: "Review disabled hooks and settings in Claude. Preview and reconnect the selected Claude Code integration in Setup; preserve other hooks. Use pacer install claude-code only for the default account, or append #account for a named account." } : {}) });
  checks.push({ name: "Claude message hooks", level: messageHooks && !mismatch ? "ok" : "warn", evidence: messageHooks ? "configured" : "unverified",
    detail: messageHooks ? "Stop and UserPromptSubmit message hooks are configured." : "Stop or UserPromptSubmit message hook is missing or disabled.",
    ...(!messageHooks ? { fix: "Reconnect the Claude Code integration to install message hooks." } : {}) });
  checks.push({ name: "Claude guard scope", level: "info", detail: "The delegation guard covers Agent and Task subagents, plus a Bash command that starts a known executor CLI (claude, codex, pi, opencode) with PACER_ROLE=executor or a pacer-managed CLAUDE_CONFIG_DIR/CODEX_HOME, including via env/exec, an export earlier in the same command, or bash -c/sh -c. It does not intercept normal direct edits or other shell commands, and it misses a variable exported in an earlier, separate Bash call, a launch hidden behind a script file, env/bash -c used with other flags, parenthesized/subshell grouping, or heredoc bodies (which can also false-positive, since they are not recognized as inert text); it runs an extra process on every Bash call. Executor sessions, PACER=off, another selected planner, relaxed mode, unknown planner usage, or no available executor can allow calls." });
  checks.push({ name: "Claude host invocation", level: "info", evidence: "unverified", detail: "UNVERIFIED: no Claude host invocation evidence is collected. File integrity and fixture probes cannot prove Claude fired these hooks.",
    fix: "In the intended Claude account, inspect /hooks and disabled hooks, project settings and launch overrides. Start a new session with debug logging and inspect SessionStart and PreToolUse Agent or Task invocation and output. Do not share credentials or full session logs." });
  return checks;
}

/** Fixed in-process handler probes: isolated state, synthetic status, no CLI/config command execution or provider calls. */
export async function probeClaudeHandlers(): Promise<Check> {
  const home = mkdtempSync(join(tmpdir(), "pacer-doctor-"));
  try {
    const ctx: Ctx = { home, pacerHome: join(home, ".pacer"), now: 0, env: {}, which: () => null,
      run: async () => { throw Error("External commands are forbidden in handler probes"); } };
    const status: Status = { generatedAt: 0, strategy: "doctor-fixture", planner: "claude-code", mode: "normal", disabled: false,
      paused: null, modeHold: null, calendarPace: true,
      providers: [{ id: "claude-code", usage: "quota", windows: [], binding: null, verdict: "OK", installed: true, stale: false }],
      executors: { ranked: [{ id: "codex", verdict: "OK", score: 1, reason: "fixture", eligibility: {
        state: "eligible", reasons: [], evaluatedAt: 0, validUntil: null, evidenceAgeS: null,
        availability: "ready", budget: "permitted", spendingRisk: "unknown",
      } }], excluded: [] } };
    const deps = { status: async () => status, hooks: defaultHooks };
    for (const tool_name of ["Agent", "Task"]) {
      const result = JSON.parse(await runGuard(ctx, "claude-code", JSON.stringify({ tool_name, tool_input: { subagent_type: "general-purpose", prompt: "Implement a fixture" } }), deps));
      if (result.hookSpecificOutput?.permissionDecision !== "deny") throw Error("guard deny probe failed");
    }
    for (const payload of [{ tool_name: "Edit", tool_input: {} }, { tool_name: "Agent", tool_input: { subagent_type: "Explore" } }]) {
      if (await runGuard(ctx, "claude-code", JSON.stringify(payload), deps) !== "") throw Error("guard allow probe failed");
    }
    const denyBash = JSON.parse(await runGuard(ctx, "claude-code", JSON.stringify({ tool_name: "Bash", tool_input: { command: "PACER_ROLE=executor claude --model sonnet" } }), deps));
    if (denyBash.hookSpecificOutput?.permissionDecision !== "deny") throw Error("bash guard deny probe failed");
    if (await runGuard(ctx, "claude-code", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), deps) !== "") throw Error("bash guard allow probe failed");
    status.executors.ranked[0]!.eligibility = { ...status.executors.ranked[0]!.eligibility!,
      state: "uncertain", budget: "unknown", reasons: [{ code: "budget_missing", evidenceIds: [] }] };
    if (await runGuard(ctx, "claude-code", JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "general-purpose" } }), deps) !== "") {
      throw Error("uncertain alternative allow probe failed");
    }
    const session = JSON.parse((await sessionHook(ctx, "claude-code", { session_id: "probe" }, async () => renderHook(status, "claude-code"))).out);
    if (session.hookSpecificOutput?.hookEventName !== "SessionStart" || !session.hookSpecificOutput.additionalContext.includes("Subscription budget")) throw Error("session context probe failed");
    insertMessage(ctx, { taskId: "t-20261029-000000-aaaa", rootId: "task:t-20261029-000000-aaaa", from: "task:t-20261029-000000-aaaa",
      to: "external:claude-code:probe", kind: "message", body: "fixture message", replyTo: null, requestId: null });
    const stop = JSON.parse(await stopHook(ctx, "claude-code", { session_id: "probe" }));
    if (stop.decision !== "block" || !stop.reason.includes("fixture message")) throw Error("Stop block probe failed");
    const prompt = JSON.parse(await promptHook(ctx, "claude-code", { session_id: "probe" }));
    if (prompt.hookSpecificOutput?.hookEventName !== "UserPromptSubmit" || !prompt.hookSpecificOutput.additionalContext.includes("fixture message")) throw Error("UserPromptSubmit probe failed");
    return { name: "Claude handler probes", level: "ok", evidence: "tested", detail: "Tested working in isolated fixtures: Agent and Task deny, a Bash executor-launch deny, exploration and direct-edit allow, session context JSON, Stop block and UserPromptSubmit context. Tests this build’s handlers only; installed command launch and Claude host firing remain unverified." };
  } catch {
    return { name: "Claude handler probes", level: "fail", evidence: "unverified", detail: "A fixed handler fixture failed.", fix: "Run the doctor-hook tests from this build and report the failure before reconnecting." };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Enforcement probe schedule doctor check. Reports mode, consent, last probe, expiry, next eligible time and measured cost.
 * level: "info" when scheduling is healthy OR deliberately off;
 * level: "warn" only when consent was declined or a maximum-length pause is in effect.
 */
export function enforcementProbeScheduleCheck(ctx: Ctx): Check {
  let strategy: Strategy;
  try {
    strategy = loadStrategy(ctx);
  } catch (e) {
    if (e instanceof MissingStrategyError) {
      return { name: "Enforcement probe schedule", level: "info", detail: "No strategy configured: certification probes are not applicable." };
    }
    return { name: "Enforcement probe schedule", level: "info", detail: `Strategy unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const mode = strategy.pacing.plannerProbe;
  const state = readScheduleState(ctx);

  // Mode "off" is a deliberate choice, not a fault - info level
  if (mode === "off") {
    return { name: "Enforcement probe schedule", level: "info", detail: "Certification probing is turned off. No probes will run automatically." };
  }

  const consent = state.consent[strategy.planner.account];
  // Only the planner's own attempt: another repository's runner keeps its own
  // record, and its figures would be misreported as this schedule's.
  const key = plannerScheduleKey(strategy);
  const attempt = key ? state.attempts[key] : undefined;
  const hold = attempt ? attemptHold(attempt, ctx.now) : null;

  // Build detail message
  const details: string[] = [];
  details.push(`mode: ${mode}`);

  if (consent === "granted") {
    details.push("consent: granted");
  } else if (consent === "declined") {
    details.push("consent: declined");
  } else {
    details.push("consent: not yet asked");
  }

  if (attempt) {
    if (attempt.nextEligibleAt > 0) {
      details.push(`next eligible: in ${Math.max(0, Math.round((attempt.nextEligibleAt - ctx.now) / 60))} minutes`);
    }
    if (attempt.probesToday > 0) {
      details.push(`probes today: ${attempt.probesToday}`);
    }
    if (attempt.lastCostPct !== null) {
      details.push(`last probe cost: ${attempt.lastCostPct}% of account window`);
    }
    if (attempt.failures > 0) {
      details.push(`consecutive failures: ${attempt.failures}`);
    }
  }

  // A pause is a considered stop, but a person has to know probing stopped
  // and why; a short backoff or the daily ceiling clears on its own.
  let level: "info" | "warn" = "info";
  if (consent === "declined") {
    level = "warn";
  } else if (hold?.paused) {
    level = "warn";
    details.push(`probing paused: ${hold.reason}`);
  } else if (hold) {
    details.push(`not probing now: ${hold.reason}`);
  }

  return {
    name: "Enforcement probe schedule",
    level,
    detail: details.join("; "),
  };
}
