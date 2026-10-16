import type { Runner } from "./home";
import { clock, type Account } from "./accounts";
import type { Tone } from "./tasks";
export interface Rule { kinds?: string[]; executors: string[] }
export interface RoutingRules { rules: Rule[]; available: string[] }
export function runnerAccount(id: string, accounts: Account[]) { return accounts.find(a => a.runners?.includes(id) || a.name === id.split("#")[1]?.split("@")[0]); }
export function executorStatus(runner: Runner, account?: Account): { label: string; tone: Tone; detail?: string } {
  if (runner.state === "blocked") return { label: "Blocked", tone: "neutral", detail: runner.reason ?? undefined };
  if (runner.state === "broken") return { label: "Not working", tone: "bad", detail: runner.reason ?? undefined };
  if (runner.state === "exhausted") return { label: runner.until ? `Limited until ${clock(runner.until)}` : "Limited until usage resets", tone: "warn" };
  const state = typeof account?.state === "object" ? account.state.state : account?.state;
  if (["not_working", "broken", "failed", "key_missing", "Not working", "Key missing"].includes(state ?? "") || account?.connection?.key === "missing") return { label: "Not working", tone: "bad", detail: typeof account?.state === "object" ? account.state.detail : account?.detail ?? (account?.connection?.key === "missing" ? "Key missing" : undefined) };
  if (state === "ready" || state === "Ready" || (!state && account?.connection?.checked_at)) return { label: "Ready", tone: "good" };
  if (account?.kind === "endpoint" && !account.connection) return { label: "External OpenCode provider", tone: "neutral" };
  return { label: "Not tested", tone: "neutral" };
}
export function reorderRules(rules: Rule[], ruleIndex: number, index: number, direction: -1 | 1): Rule[] {
  return rules.map((rule, i) => {
    if (i !== ruleIndex || index + direction < 0 || index + direction >= rule.executors.length) return rule;
    const executors = [...rule.executors];
    [executors[index], executors[index + direction]] = [executors[index + direction]!, executors[index]!];
    return { ...rule, executors };
  });
}
