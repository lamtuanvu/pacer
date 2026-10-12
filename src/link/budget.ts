import type { Status } from "../engine/status";
import { type BudgetData, LIMITS } from "./envelope";
export function toBudget(st: Status): BudgetData {
  return { generatedAt:st.generatedAt, strategy:st.strategy, planner:st.planner, mode:st.mode,
    providers:st.providers.slice(0,LIMITS.providers).map(p=>({id:p.id,verdict:p.verdict,usedPct:p.binding?.usedPct??null,resetsAt:p.binding?.resetsAt??null,window:p.binding?.name??null,stale:p.stale})),
    ranked:st.executors.ranked.slice(0,LIMITS.providers).map(r=>({id:r.id,verdict:r.verdict})) };
}
/** Change detection: everything except generatedAt. */
export function budgetKey(b: BudgetData | null): string { return b ? JSON.stringify({...b,generatedAt:0}) : ""; }
