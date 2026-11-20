import type { Status } from "../engine/status";
import { type BudgetData, LIMITS } from "./envelope";
// The legacy budget block is a protocol 2 shape: UNMETERED (a protocol 3 verdict) stays OK there.
const legacyVerdict = (verdict: string) => verdict === "UNMETERED" ? "OK" : verdict;
export function toBudget(st: Status): BudgetData {
  return { generatedAt:st.generatedAt, strategy:st.strategy, planner:st.planner, mode:st.mode,
    providers:st.providers.slice(0,LIMITS.providers).map(p=>({id:p.id,...(p.agent ? {agent:p.agent,account:p.account} : {}),...(p.agent && p.unavailableReason?{unavailableReason:p.unavailableReason}:{}),verdict:legacyVerdict(p.verdict),usedPct:p.binding?.usedPct??null,pacePct:p.binding?.pace == null ? null : Math.round(p.binding.pace*10)/10,resetsAt:p.binding?.resetsAt??null,window:p.binding?.name??null,stale:p.stale,...(p.brokenReason?{brokenReason:p.brokenReason}:{}),...(p.blockedReason?{blockedReason:p.blockedReason,blockedUntil:p.blockedUntil}: {})})),
    ranked:st.executors.ranked.slice(0,LIMITS.providers).map(r=>({id:r.id,verdict:legacyVerdict(r.verdict)})) };
}
/** Change detection: everything except generatedAt. */
export function budgetKey(b: BudgetData | null): string { return b ? JSON.stringify({...b,generatedAt:0}) : ""; }
