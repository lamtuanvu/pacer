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
  const prefixes: Record<string, string> = { Binary: "Agent command", CLI: "Compatibility", Login: "Sign-in indicator", Usage: "Budget", Install: "Integration", Skill: "Planner skill" };
  const match = /^(\S+) (.+)$/.exec(name);
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

/**
 * The server's remedy decides the repair. Responses without one fall back to names: only the selected
 * planner is addressable by agent.connect. Never infer an action from fix text.
 */
export function diagnosticRepair(check: Check, planner?: string): { agent: string } | undefined {
  if (check.remedy) {
    const agent = remedyAgent(check);
    return agent ? { agent } : undefined;
  }
  if (!planner || !["warn", "fail"].includes(check.level)) return;
  const agent = planner.split("#")[0]!;
  if (!REPAIR_AGENTS.includes(agent)) return;
  if (check.name === `Install ${planner}` || check.name === `Skill ${planner}` ||
      agent === "claude-code" && ["Claude hook configuration", "Legacy guard"].includes(check.name)) return { agent };
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

/**
 * Where a remedy that opens a place sends the person; repairs and agent tasks have their own actions.
 * A pacer restart is not a setup step, so internal remedies keep the check's own link.
 */
function remedySetupLink(remedy: Remedy): { href: string; label: string } | undefined {
  if (remedy.kind === "internal") return;
  const op = remedy.op ?? remedy.secondary?.op;
  if (op === "account.signin" || op === "limits.refresh" || op === "runner.block") return { href: "#/settings/accounts", label: "Review accounts" };
  if (op === "service.install") return { href: "#/setup", label: "Open setup" };
}

/**
 * A remedy's own place first. Remedies that open no place (agent tasks, reviewed repairs) keep the
 * check's setup link so no screen loses a button before it can run them.
 */
export function diagnosticSetupLink(check: Check): { href: string; label: string } | undefined {
  return (check.remedy && remedySetupLink(check.remedy)) ?? checkSetupLink(check);
}

/** The setup link a check's name implies, used before remedies existed. */
export function checkSetupLink(check: Pick<Check, "name">): { href: string; label: string } | undefined {
  if (check.name.startsWith("Usage ") || check.name.startsWith("Login ") || check.name === "Claude config folder") return { href: "#/settings/accounts", label: "Review accounts" };
  if (/^(Binary|CLI) /.test(check.name) || check.name === "Executor") return { href: "#/settings/add-executor", label: "Open executor setup" };
  if (["Service", "Strategy", "Installs"].includes(check.name)) return { href: "#/setup", label: "Open setup" };
  if (/^(Install|Skill) /.test(check.name) || check.name.startsWith("Claude ") || check.name === "Legacy guard") return { href: "#/settings/planner", label: "Review planner setup" };
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
