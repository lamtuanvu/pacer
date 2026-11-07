import type { Check, Remedy } from "../install/doctor";
import { displayName } from "./format";
/** Diagnostic vocabulary shared by clients; technical details stay in disclosures. */
export const diagnosticLevel = {
  ok: { label: "Passed", tone: "good" },
  warn: { label: "Needs attention", tone: "warn" },
  fail: { label: "Failed", tone: "bad" },
  info: { label: "Information", tone: "neutral" },
} as const;
export const diagnosticEvidence = { configured: "Configured", tested: "Tested working · fixture", unverified: "Unverified" } as const;
export function diagnosticTitle(name: string): string {
  const prefixes: Record<string, string> = { Binary: "Agent command", CLI: "Compatibility", Login: "Sign-in indicator", Usage: "Budget", Install: "Integration", Skill: "Planner skill",
    "Integration freshness": "Integration freshness", "Planner check": "Planner check" };
  const match = /^(Integration freshness|Planner check|\S+) (.+)$/.exec(name);
  if (match && Object.hasOwn(prefixes, match[1])) return `${prefixes[match[1]]} · ${displayName(match[2])}`;
  return name.replace("handler probes", "handler tests").replace("guard scope", "delegation coverage");
}


/** Each check belongs to exactly one bucket; an issue can also lack runtime evidence. */
export function diagnosticGroups(checks: Check[]) {
  const groups = new Map<string, Check[]>();
  const passed: Check[] = [], unverified: Check[] = [], information: Check[] = [];
  let issueCount = 0;
  for (const check of checks) {
    if (check.level === "fail" || check.level === "warn") {
      const title = diagnosticGroup(check.name);
      groups.set(title, [...(groups.get(title) ?? []), check]);
      issueCount++;
    } else if (check.evidence === "unverified") unverified.push(check);
    else if (check.level === "ok") passed.push(check);
    else information.push(check);
  }
  return { issues: [...groups].map(([title, checks]) => ({ title, checks })), issueCount, unverifiedCount: checks.filter(check => check.evidence === "unverified").length, passed, unverified, information };
}

function diagnosticGroup(name: string): string {
  const match = /^(?:Binary|CLI|Login|Usage|Install|Skill) (.+)$/.exec(name);
  if (match) return displayName(match[1]!);
  if (name.startsWith("Claude ") || name === "Legacy guard") return "Claude";
  return "Pacer";
}

const REPAIR_AGENTS = ["claude-code", "codex", "cursor", "opencode"];

/** The agent a `review` (or file-updating `auto`) remedy previews and reconnects. */
export function remedyAgent(check: Check): string | undefined {
  const { remedy } = check;
  if (!remedy || !["warn", "fail"].includes(check.level) || !["agent.preview", "agent.connect"].includes(remedy.op ?? "")) return;
  const agent = remedy.params?.agent;
  return typeof agent === "string" && REPAIR_AGENTS.includes(agent) ? agent : undefined;
}

/** The pill naming who does the fix. Internal remedies are grouped apart and never get a row pill. */
export const remedyKindLabel: Record<Remedy["kind"], string> = {
  auto: "Automatic", review: "Review changes", user: "Needs you", agent: "Agent", internal: "Couldn’t check",
};

/** What the person reads about a remedy before clicking; the button itself is the remedy's label. */
const REMEDY_HINT: Record<Remedy["kind"], string> = {
  auto: "Pacer can fix this by itself.",
  review: "You see each file before anything changes.",
  user: "Only you can do this. Pacer rechecks when you come back.",
  agent: "Pacer has no built-in fix, so an agent can investigate and fix it. You review the result.",
  internal: "Pacer itself could not run this check.",
};

/** Remedy links may only open web pages over https or a System Settings pane. */
export function remedyUrl(url: string | undefined): string | undefined {
  return url && /^(?:https:\/\/|x-apple\.systempreferences:)/.test(url) ? url : undefined;
}

export interface RemedyConsent { title: string; message: string; confirmLabel: string }
/** One step a remedy takes. `consent` is shown and confirmed before the operation receives `consent: true`. */
export type RemedyPlan =
  | { kind: "run"; op: string; params: Record<string, unknown>; consent?: RemedyConsent }
  | { kind: "review"; agent: string }
  | { kind: "signin"; op: string; params: Record<string, unknown>; consent?: RemedyConsent }
  | { kind: "open"; url: string }
  | { kind: "delegate"; check: string };

/** Params as the server sent them, minus any consent: only the person's click grants consent. */
function remedyParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const { consent: _consent, ...rest } = params ?? {};
  return rest;
}

/** The confirmation a consent-gated operation needs; agent.connect adds the files from its preview. */
export function remedyConsent(remedy: Pick<Remedy, "kind" | "label" | "op" | "params">, files: string[] = []): RemedyConsent {
  if (remedy.op === "agent.connect") {
    const agent = typeof remedy.params?.agent === "string" ? displayName(remedy.params.agent) : "this agent";
    return {
      title: `Update pacer’s files for ${agent}`,
      message: files.length
        ? `Pacer updates only its own files and keeps your edits. ${files.length === 1 ? "This file changes" : `These ${files.length} files change`}:`
        : "Pacer updates only its own files and keeps your edits.",
      confirmLabel: remedy.label,
    };
  }
  if (remedy.op === "service.install") return {
    title: remedy.kind === "internal" ? "Restart the pacer service" : remedy.label,
    message: "Pacer reinstalls and restarts its background service. The app reconnects when the service is back.",
    confirmLabel: remedy.kind === "internal" ? "Restart" : remedy.label,
  };
  return { title: remedy.label, message: "Pacer asks before it changes anything.", confirmLabel: remedy.label };
}

/** The step a remedy takes, decided only by its kind and operation. Unknown shapes get no action. */
export function remedyPlan(remedy: Remedy): RemedyPlan | undefined {
  const params = remedyParams(remedy.params);
  if (remedy.kind === "auto" || remedy.kind === "internal")
    return remedy.op ? { kind: "run", op: remedy.op, params, ...(remedy.consent ? { consent: remedyConsent(remedy) } : {}) } : undefined;
  if (remedy.kind === "review") {
    const agent = params.agent;
    return remedy.op === "agent.preview" && typeof agent === "string" && REPAIR_AGENTS.includes(agent) ? { kind: "review", agent } : undefined;
  }
  if (remedy.kind === "user") {
    if (remedy.op) return { kind: "signin", op: remedy.op, params, ...(remedy.consent ? { consent: remedyConsent(remedy) } : {}) };
    const url = remedyUrl(remedy.url);
    return url ? { kind: "open", url } : undefined;
  }
  if (remedy.kind === "agent")
    return remedy.op === "doctor.fix.delegate" && typeof params.check === "string" ? { kind: "delegate", check: params.check } : undefined;
}

/** The quieter alternative a remedy may offer, such as turning an account off. */
export function secondaryPlan(remedy: Remedy): RemedyPlan | undefined {
  const second = remedy.secondary;
  if (!second) return;
  if (second.op) return { kind: "run", op: second.op, params: remedyParams(second.params),
    ...(second.consent ? { consent: remedyConsent({ kind: remedy.kind, label: second.label, op: second.op, params: second.params }) } : {}) };
  const url = remedyUrl(second.url);
  return url ? { kind: "open", url } : undefined;
}

/** In-place progress while a remedy runs. */
export function remedyProgress(remedy: Pick<Remedy, "kind" | "label" | "op" | "url">): string {
  switch (remedy.op) {
    case "limits.refresh": return "Refreshing usage…";
    case "agent.connect": return "Updating pacer files…";
    case "agent.preview": return "Loading the changes…";
    case "service.install": return remedy.kind === "internal" || /restart/i.test(remedy.label) ? "Restarting the pacer service…" : "Installing the pacer service…";
    case "account.signin": return "Waiting for you to sign in · rechecking when you return…";
    case "runner.block": return "Turning it off…";
    case "doctor.fix.delegate": return "Starting a fix task…";
  }
  return remedy.url ? "Opened · rechecking when you return…" : `${remedy.label}…`;
}

const describeParams = (params: Record<string, unknown> | undefined) =>
  Object.entries(remedyParams(params)).map(([key, value]) => ` ${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("");

/** What the fix runs, for the Technical details disclosure only. */
export function remedyRuns(remedy: Remedy): string {
  const lines: string[] = [];
  if (remedy.kind === "review") lines.push(`fix runs: ${remedy.op ?? "agent.preview"}${describeParams(remedy.params)}, then agent.connect after you apply`);
  else if (remedy.op) lines.push(`fix runs: ${remedy.op}${describeParams(remedy.params)}${remedy.consent ? " (asks you first)" : ""}`);
  else if (remedy.url) lines.push(`fix opens: ${remedy.url}`);
  if (remedy.secondary) lines.push(`or: ${remedy.secondary.op ? `${remedy.secondary.op}${describeParams(remedy.secondary.params)}` : remedy.secondary.url ?? remedy.secondary.label}`);
  if (remedy.kind === "auto" || remedy.kind === "user") lines.push("then: reruns the checks");
  return lines.join("\n");
}

/** A task started by doctor.fix.delegate, as task reads expose it. */
export interface DiagnosticTask {
  id: string; state: string; updatedAt?: number; dismissed?: boolean;
  review?: { accepted: boolean } | null;
  diagnosticCheck?: string;
  diagnosticRecheck?: { at: number; passed: boolean; level: Check["level"] | null; detail: string };
}
export interface DiagnosticTaskStatus { taskId: string; label: string; tone: "info" | "warn" | "good" | "bad"; open: boolean; detail?: string }

/** The latest fix task for a check. A rejected or ended-without-result task leaves the check's own remedy. */
export function diagnosticTaskStatus(tasks: readonly DiagnosticTask[], check: string): DiagnosticTaskStatus | undefined {
  const task = tasks.filter(item => item.diagnosticCheck === check && !item.dismissed)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
  if (!task) return;
  const recheck = task.diagnosticRecheck;
  if (recheck) return recheck.passed
    ? { taskId: task.id, label: "Fixed and rechecked", tone: "good", open: false }
    : { taskId: task.id, label: "Still failing", tone: "bad", open: false, detail: recheck.detail };
  if (task.review?.accepted === false) return;
  if (task.review?.accepted) return { taskId: task.id, label: "Rechecking", tone: "info", open: true };
  if (task.state === "queued" || task.state === "running") return { taskId: task.id, label: "Fix task running", tone: "info", open: true };
  if (task.state === "needs_input") return { taskId: task.id, label: "Needs your answer", tone: "warn", open: true };
  if (task.state === "done" || task.state === "partial") return { taskId: task.id, label: "Waiting for your review", tone: "warn", open: true };
}

/** Per-row progress the page tracks while a remedy runs; the current report decides fixed or still failing. */
export type DiagnosticRowOutcome =
  | { phase: "running" | "waiting"; text: string }
  | { phase: "rechecked" }
  | { phase: "error"; message: string };

export interface DiagnosticFixRow {
  check: Check;
  title: string;
  /** Pill text: the remedy kind, or "Fixed". */
  kind?: string;
  tone: "warn" | "bad" | "good";
  glyph: string;
  /** Status in words, so the glyph is never the only signal. */
  status: string;
  detail: string;
  technical: string;
  remedy?: Remedy;
  plan?: RemedyPlan;
  secondary?: { label: string; plan: RemedyPlan };
  fixed: boolean;
  progress?: string;
  /** A failed fix attempt or a recheck that still fails. */
  problem?: string;
  task?: DiagnosticTaskStatus;
}

const FIX_GLYPHS = { warn: "!", bad: "✕", good: "✓" } as const;

/** A summary as a sentence, so the remedy's own sentence can follow it. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}

function technicalText(check: Check): string {
  return [check.detail, check.fix ? `Reported hint: ${check.fix}` : "", check.remedy ? remedyRuns(check.remedy) : ""].filter(Boolean).join("\n");
}

function fixRow(check: Check, outcome: DiagnosticRowOutcome | undefined, task: DiagnosticTaskStatus | undefined): DiagnosticFixRow {
  const { remedy } = check;
  const plan = remedy && remedyPlan(remedy);
  const secondary = remedy?.secondary && secondaryPlan(remedy);
  const tone = check.level === "fail" ? "bad" : "warn";
  return {
    check, title: diagnosticTitle(check.name), tone, glyph: FIX_GLYPHS[tone], status: diagnosticLevel[check.level].label,
    ...(remedy ? { kind: remedyKindLabel[remedy.kind], remedy } : {}),
    detail: [sentence(diagnosticSummary(check)), remedy ? REMEDY_HINT[remedy.kind] : ""].filter(Boolean).join(" "),
    technical: technicalText(check),
    ...(plan ? { plan } : {}),
    ...(secondary ? { secondary: { label: remedy!.secondary!.label, plan: secondary } } : {}),
    fixed: false,
    ...(outcome?.phase === "running" || outcome?.phase === "waiting" ? { progress: outcome.text } : {}),
    ...(outcome?.phase === "error" ? { problem: outcome.message } : outcome?.phase === "rechecked" ? { problem: "Still failing after the fix. The check’s new result is above." } : {}),
    ...(task ? { task } : {}),
  };
}

function fixedRow(check: Check): DiagnosticFixRow {
  return { check, title: diagnosticTitle(check.name), kind: "Fixed", tone: "good", glyph: FIX_GLYPHS.good, status: "Fixed",
    detail: "Fixed and rechecked just now.", technical: technicalText(check), fixed: true };
}

const isIssue = (check: Check) => check.level === "warn" || check.level === "fail";

/**
 * The Diagnostics page: rows that need a fix (in the order of the last full run, so a fixed row stays in place),
 * one group for checks pacer could not run, and collapsed passed and informational results.
 */
export function diagnosticsPage(input: {
  checks: Check[];
  /** Issue names from the last full run; rows that have since passed show as fixed. */
  baseline?: readonly string[];
  outcomes?: Readonly<Record<string, DiagnosticRowOutcome>>;
  tasks?: readonly DiagnosticTask[];
}) {
  const { checks, outcomes = {}, tasks = [] } = input;
  const byName = new Map(checks.map(check => [check.name, check]));
  const internal = checks.filter(check => isIssue(check) && check.remedy?.kind === "internal");
  const issueNames = checks.filter(check => isIssue(check) && check.remedy?.kind !== "internal").map(check => check.name);
  const names = [...new Set([...(input.baseline ?? []), ...issueNames])];
  const rows: DiagnosticFixRow[] = [];
  for (const name of names) {
    const current = byName.get(name);
    if (current && isIssue(current)) {
      if (current.remedy?.kind !== "internal") rows.push(fixRow(current, outcomes[name], diagnosticTaskStatus(tasks, name)));
    } else if (input.baseline?.includes(name)) rows.push(fixedRow(current ?? { name, level: "ok", detail: "The check no longer reports a problem." }));
  }
  const open = rows.filter(row => !row.fixed);
  const autoLeft = open.filter(row => row.remedy?.kind === "auto" && row.plan && !row.progress && !row.task?.open);
  const passed = checks.filter(check => check.level === "ok" && check.evidence !== "unverified");
  const information = checks.filter(check => !isIssue(check) && !passed.includes(check));
  return {
    rows, openCount: open.length, autoLeft,
    fixAllLabel: autoLeft.length === 1 ? "Fix 1 issue automatically" : `Fix ${autoLeft.length} issues automatically`,
    headline: diagnosticsHeadline(open.length, autoLeft.length, internal.length, rows.length > 0),
    support: open.length ? "Each problem below has one fix. Pacer fixes what it safely can, shows you the changes before it touches your files, and hands the rest to an agent." : undefined,
    internal: internal.length ? internalGroup(internal) : undefined,
    passed, passedSummary: namesSummary(passed),
    information,
  };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function diagnosticsHeadline(open: number, auto: number, internal: number, hadRows: boolean): string {
  if (!open) {
    if (internal) return `Pacer couldn’t run ${plural(internal, "check")}. Nothing else needs a fix.`;
    return hadRows ? "Everything that can be fixed is fixed." : "No problems found.";
  }
  const lead = `${plural(open, "problem")}.`;
  if (!auto) return `${lead} Each one takes one click.`;
  if (auto === open) return `${lead} Pacer can fix ${open === 1 ? "it" : "all of them"} by itself.`;
  return `${lead} Pacer can fix ${auto} by itself; the rest take one click each.`;
}

/** Checks pacer itself could not run share one cause and one remedy. */
function internalGroup(checks: Check[]) {
  const details = [...new Set(checks.map(check => check.detail))];
  return {
    checks,
    titles: checks.map(check => diagnosticTitle(check.name)),
    remedy: checks[0]!.remedy!,
    title: `A pacer problem stopped ${plural(checks.length, "check")}. Your setup wasn’t tested.`,
    cause: "Pacer itself could not run these checks, so they say nothing about your setup, and reinstalling your agents won’t change them. Restarting the pacer service usually clears this. If it doesn’t, copy the report and send it to pacer; the checks stay marked as not checked.",
    technical: [...details, `Raised by pacer itself, not by an agent.${details.length === 1 && checks.length > 1 ? ` Same cause for all ${checks.length} checks.` : ""}`, remedyRuns(checks[0]!.remedy!)].join("\n"),
  };
}

function namesSummary(checks: Check[]): string {
  const titles = [...new Set(checks.map(check => diagnosticTitle(check.name)))];
  if (titles.length <= 4) return titles.join(", ");
  return `${titles.slice(0, 4).join(", ")} and ${titles.length - 4} more`;
}

export function diagnosticGuidance(check: Check): string {
  if (['Claude hook configuration', 'Claude message hooks'].includes(check.name) && check.level === 'warn' && check.evidence === 'configured')
    return 'Launch Claude Code with the selected account folder, or select the matching planner account. Restart the service after changing its environment.';
  if (check.evidence === "unverified" && check.level === "info") return "This check needs confirmation in the agent’s own session.";
  if (check.name.startsWith("CLI ")) return /missing launch flags/.test(check.detail)
    ? "Update this agent to a version supporting the required launch options, then run checks again."
    : "Run the agent’s help command locally and resolve its reported error. See Technical details for the command and error.";
  if (check.name === "Removable volume access") return "Review the macOS permission prompt or System Settings → Privacy & Security → Files and Folders for the app that runs pacer.";
  if (check.name.startsWith("Login ")) return "Review this account and complete sign-in in its own agent.";
  if (check.name.startsWith("Binary ")) return "The agent command is missing. Open executor setup to review installation.";
  if (check.name.startsWith("Usage ")) return "Open Accounts, test this account’s connection and refresh its usage reading. Complete sign-in in the agent if requested.";
  if (/^(Install|Skill) /.test(check.name) || check.name === "Claude hook configuration" || check.name === "Legacy guard") return "Integration files need review. Reconnect the selected planner to restore supported files.";
  if (check.name === "Orca") return "The host is unavailable. Tasks can use the direct backend; inspect the host for details.";
  if (check.name === "macOS code signing") return "The installed Pacer command’s signature needs review. Inspect the signing details before reinstalling.";
  return "Review setup and the technical details for this check.";
}

/** Keep outcome, runtime evidence and remediation separate from raw diagnostic output. */
export function diagnosticSummary(check: Pick<Check, 'name' | 'detail' | 'level' | 'evidence'>): string {
  const {name, detail, level} = check;
  if (name === 'Service' && /installed: (true|false)/.test(detail)) {
    const problems = [
      ['installed: false', 'The service is not installed'],
      ['running: false', 'The service is not running'],
      ['healthy: false', 'The service did not pass its health check'],
      ['binary matches current: false', 'The service uses a different installed version'],
    ].filter(([flag]) => detail.includes(flag!)).map(([, message]) => message);
    return problems.length ? `${problems.join('. ')}.` : 'The installed service is running, healthy and uses the current version.';
  }
  if (name.startsWith('CLI ')) {
    if (/missing launch flags/.test(detail)) return 'The installed agent does not advertise required launch options.';
    if (/--help failed/.test(detail)) return 'The agent’s help command failed, so launch compatibility could not be checked.';
  }
  if (/^(Install|Skill) /.test(name)) return level === 'ok'
    ? 'Managed integration files are intact. This does not verify a live agent session.'
    : 'Managed integration files are missing or changed.';
  // Freshness details are usually plain sentences; only a raw state dump needs a summary.
  if (name.startsWith('Integration freshness ') && /installed: (true|false)/.test(detail)) return level === 'ok'
    ? 'Installed integration files match this version of Pacer.'
    : /installed: false/.test(detail)
      ? 'The integration is not installed.'
      : 'The installed integration files are out of date or changed.';
  if (name === 'Claude config folder' && /Selected account settings:/.test(detail)) return level === 'warn'
    ? 'The service’s account folder differs from the selected planner account.'
    : 'The selected account folder was found. A planner session may use different settings.';
  if (name === 'Claude guard scope') return 'The delegation guard covers supported agent launches. Direct edits and some indirect launches are outside its coverage.';
  if (name === 'Claude handler probes' && level === 'ok') return 'The built-in handler tests passed in isolated fixtures. Live planner invocation remains unverified.';
  if (name === 'Claude host invocation') return 'No live planner invocation evidence was collected. Configuration and fixture tests cannot confirm it.';
  if (['Claude hook configuration', 'Claude message hooks'].includes(name) && level === 'warn' && check.evidence === 'configured')
    return 'The hooks are configured, but the service’s account folder differs from the selected planner account.';
  if (name === 'Claude hook configuration' && /SessionStart|PreToolUse/.test(detail)) return level === 'ok'
    ? 'Session context and delegation hooks are configured. Live invocation remains unverified.'
    : 'Required planner hooks are missing, disabled or point to a different integration.';
  if (name === 'Claude message hooks') return check.evidence === 'configured' || /message hooks are configured/.test(detail) ? 'Planner message hooks are configured.' : 'A planner message hook is missing or disabled.';
  if (name === 'Link latency' && /max ([\d.]+) ms/.test(detail)) {
    const milliseconds = /max ([\d.]+) ms/.exec(detail)![1];
    return `The slowest of three service reads took ${milliseconds} ms (target: under 50 ms).`;
  }
  if (name === 'macOS code signing' && /code object is not signed/i.test(detail)) return 'The installed Pacer command has no code signature.';
  if (name === 'Removable volume access') {
    if (/timed out|permission.*pending/i.test(detail)) return 'The volume access check timed out. A macOS permission prompt may be waiting.';
    if (/access denied|operation not permitted|permission denied/i.test(detail)) return 'macOS denied access to a registered repository on a removable volume.';
    if (/accessible$/.test(detail)) return 'The registered repository on the removable volume is accessible.';
  }
  if (name.startsWith('Usage ')) {
    if (detail === 'UNKNOWN') return 'No usable budget reading is available.';
    if (/stale usage/i.test(detail)) return 'The last budget reading is out of date.';
    if (['OK', 'AHEAD', 'BEHIND', 'EXHAUSTED'].includes(detail)) return 'A budget reading is available.';
  }
  // Plain messages are already useful. Preserve their cause; only raw implementation
  // output needs a summary, with the complete original available in Technical details.
  if (/--[\w-]+|\/v\d\/|\b[A-Z_]+=[^ ]|\/(?:Users|Volumes|home)\/|\b\w*Error:/.test(detail)) {
    if (/permission|access denied/i.test(detail)) return 'Access was denied while running this check.';
    if (/not found|ENOENT|missing/i.test(detail)) return 'A required file or command could not be found.';
    if (/timeout|timed out/i.test(detail)) return 'The check timed out before it could confirm the result.';
    if (/connection refused|unavailable/i.test(detail)) return 'The service or integration could not be reached.';
    return 'The check returned technical output. Open Technical details for the reported result.';
  }
  return detail;
}

export function diagnosticRemediation(fix: string): string {
  if (fix === 'pacer service restart') return 'Restart the local service, then run checks again.';
  if (fix === 'pacer service install') return 'Install the current service version, then run checks again.';
  if (/^pacer install \S+$/.test(fix)) return 'Reconnect this planner account from Budget & pacing after reviewing the repair preview.';
  if (fix === 'pacer init') return 'Open Setup to create the missing strategy.';
  if (/^install \S+ or remove providers\./.test(fix)) return 'Install the missing agent command, or remove the unused agent from your setup.';
  if (/^install an executor CLI/.test(fix)) return 'Open executor setup and add an installed agent to run delegated work.';
  if (/^pacer install claude-code, then use Claude Code once/.test(fix)) return 'Reconnect the Claude Code integration, then use that account once to collect a budget reading.';
  if (/^pacer install claude-code migrates/.test(fix)) return 'Reconnect the Claude Code integration to migrate the legacy guard.';
  if (/^For source builds, run bun scripts\/sign-local/.test(fix)) return 'For a source build, create a stable local signing identity and rebuild and reinstall the signed app. See Technical details for the exact commands.';
  if (/\/hooks|SessionStart|PreToolUse/.test(fix)) return 'In the intended planner account, inspect enabled hooks and project settings. Start a new session with debug logging and confirm the context and delegation hooks ran. Keep credentials and full session logs private.';
  if (/Use pacer install/.test(fix)) return 'Review disabled hooks in the selected planner account. Preview and reconnect that account in Setup, preserving unrelated hooks.';
  if (/--[\w-]+|pacer |bun |\/v\d|\b[A-Z_]+=/.test(fix)) return 'Follow the reported recovery instructions in Technical details, then run this check again.';
  return fix;
}

export function diagnosticCategory(check: Check, planner?: string): string {
  if (check.name.startsWith('Claude ') || check.name === 'Legacy guard' ||
      ['Install', 'Skill', 'Integration freshness', 'Planner check'].some(prefix => check.name === `${prefix} ${planner}`)) return 'Planner';
  if (/^(Binary|CLI|Login|Usage|Install|Skill|Integration freshness|Planner check) /.test(check.name) || check.name === 'Executor') return 'Executors';
  return 'Service';
}
export function diagnosticBucket(check: Check): 'failed' | 'attention' | 'passed' | 'unchecked' | 'information' {
  if (check.level === 'fail') return 'failed';
  if (check.level === 'warn') return 'attention';
  if (check.evidence === 'unverified') return 'unchecked';
  return check.level === 'ok' ? 'passed' : 'information';
}
