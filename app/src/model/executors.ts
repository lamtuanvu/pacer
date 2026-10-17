import type { Runner } from "./home";
import { clock, type Account } from "./accounts";
import type { Tone } from "../../../src/view-model/words";
export interface Rule { kinds?: string[]; executors: string[] }
export interface RoutingRules { rules: Rule[]; available: string[] }
export function runnerAccount(id: string, accounts: Account[]) { return accounts.find(a => a.runners?.includes(id) || a.name === id.split("#")[1]?.split("@")[0]); }
export function routingStatus(route?: { verdict?: string; reason?: string }): {label:string; tone:Tone} {
  const verdict=route?.verdict?.toUpperCase();
  if (verdict === "AHEAD") return {label:"Ahead of pace",tone:"warn"};
  if (verdict === "EXHAUSTED") return {label:"Out of quota",tone:"bad"};
  if (verdict === "UNKNOWN" || route?.reason?.toLowerCase() === "unknown") return {label:"Usage unknown",tone:"neutral"};
  if (route && !verdict && route.reason) {
    const reason = route.reason;
    if (reason === "not installed") return {label:"Not installed",tone:"bad"};
    if (reason === "exhausted") return {label:"Out of quota",tone:"bad"};
    if (reason === "Blocked by you") return {label:"Blocked until unblocked",tone:"neutral"};
    return {label:reason.startsWith("Not working") ? reason : `Not working · ${reason}`,tone:"bad"};
  }
  return {label:"Ready",tone:"good"};
}
export function executorStatus(runner: Runner, account?: Account, installed?: boolean, route?: {verdict?:string;reason?:string}): { label: string; tone: Tone; detail?: string } {
  if (runner.state === "blocked") return { label: runner.until ? `Blocked until ${clock(runner.until)}` : "Blocked until unblocked", tone: "neutral", detail: runner.reason ?? undefined };
  if (runner.state === "broken") return { label: `Not working${runner.reason ? ` · ${runner.reason}` : ""}`, tone: "bad", detail: runner.reason ?? undefined };
  if (runner.state === "exhausted") return { label: runner.until ? `Limited until ${clock(runner.until)}` : "Out of quota", tone: "warn" };
  if (installed === false) return {label:"Not installed",tone:"bad"};
  const state = typeof account?.state === "object" ? account.state.state : account?.state;
  if (["not_working", "broken", "failed", "key_missing", "Not working", "Key missing"].includes(state ?? "") || account?.connection?.key === "missing") {
    const detail = (typeof account?.state === "object" ? account.state.detail : account?.detail) ?? (account?.connection?.key === "missing" ? "Key missing" : undefined);
    return { label: `Not working${detail ? ` · ${detail}` : ""}`, tone: "bad", detail };
  }
  if (account?.kind !== "endpoint" && !runner.id.startsWith("opencode")) return routingStatus(route);
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
