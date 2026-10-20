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
  const match = /^(Binary|CLI|Login|Usage|Install|Skill) (.+)$/.exec(name);
  if (match) return `${prefixes[match[1]]} · ${displayName(match[2])}`;
  return name.replace("handler probes", "handler tests").replace("guard scope", "delegation coverage");
}
