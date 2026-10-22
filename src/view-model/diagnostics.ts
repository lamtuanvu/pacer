import type { Check } from "../install/doctor";
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

/** Only the selected planner is addressable by agent.connect. Never infer an action from fix text. */
export function diagnosticRepair(check: Check, planner?: string): { agent: string } | undefined {
  if (!planner || !["warn", "fail"].includes(check.level)) return;
  const agent = planner.split("#")[0]!;
  if (!["claude-code", "codex", "cursor", "opencode"].includes(agent)) return;
  if (check.name === `Install ${planner}` || check.name === `Skill ${planner}` ||
      agent === "claude-code" && ["Claude hook configuration", "Legacy guard"].includes(check.name)) return { agent };
}

export function diagnosticGuidance(check: Check): string {
  if (check.evidence === "unverified" && check.level === "info") return "This check needs confirmation in the agent’s own session.";
  if (check.name.startsWith("Login ")) return "Review this account and complete sign-in in its own agent.";
  if (check.name.startsWith("Binary ")) return "The agent command is missing. Open executor setup to review installation.";
  if (check.name.startsWith("Usage ")) return "Budget information needs a fresh reading from this integration.";
  if (/^(Install|Skill) /.test(check.name) || check.name === "Claude hook configuration" || check.name === "Legacy guard") return "Integration files need review. Reconnect the selected planner to restore supported files.";
  if (check.name === "Orca") return "The host is unavailable. Tasks can use the direct backend; inspect the host for details.";
  if (check.name === "macOS code signing") return "The installed Pacer command’s signature needs review. Inspect the signing details before reinstalling.";
  return "Review setup and the technical details for this check.";
}

export function diagnosticSetupLink(check: Check): { href: string; label: string } | undefined {
  if (check.name.startsWith("Usage ") || check.name.startsWith("Login ") || check.name === "Claude config folder") return { href: "#/settings/accounts", label: "Review accounts" };
  if (/^(Binary|CLI) /.test(check.name) || check.name === "Executor") return { href: "#/settings/add-executor", label: "Open executor setup" };
  if (["Service", "Strategy", "Installs"].includes(check.name)) return { href: "#/setup", label: "Open setup" };
  if (/^(Install|Skill) /.test(check.name) || check.name.startsWith("Claude ") || check.name === "Legacy guard") return { href: "#/settings/planner", label: "Review planner setup" };
}
