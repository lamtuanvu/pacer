import type { AccountSummary, ApiTask, ExecutorRow, HostSummary, PlannerMeter, SetupSummary } from "../api/read-model/types";
import { taskAttentionReason } from "../api/read-model/tasks";
import { parseRunnerId } from "../config/runner-id";
import { executorName } from "../link/notification";
import type { Action, AttentionItem, AttentionKind } from "./types";
import { discoveryPrompts, type DiscoveryRuleInput } from "../discovery/prompts";

export interface RuleInput {
  now: number; tasks: ApiTask[]; executors: ExecutorRow[]; accounts: AccountSummary[];
  hosts?: HostSummary[]; planner: PlannerMeter | null; setup: SetupSummary;
  update: { latest: string; available: boolean } | null;
  retryTarget(t: ApiTask): string | null;
  /** Absent when LAN discovery is off. */
  discovery?: DiscoveryRuleInput;
}
const displayName = (id: string | null) => executorName(id ? parseRunnerId(id)?.agent ?? id : null);
const open = (label: string, params: Action["params"]): Action => ({ label, op: "ui.open", params });
const severityOrder = { blocked: 0, problem: 1, decide: 2 };
export function sortItems(items: AttentionItem[]): AttentionItem[] {
  return items.sort((a,b) => severityOrder[a.severity]-severityOrder[b.severity] || a.since-b.since || a.id.localeCompare(b.id));
}
export function deriveItems(input: RuleInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (kind: AttentionKind, key: string, title: string, detail: string, actions: Action[], extra: Partial<AttentionItem> = {}) => {
    items.push({ id: `${kind}:${key}`, kind, severity: kind === "stuck" ? "blocked" : ["review","update","discovery","discovery-network"].includes(kind) ? "decide" : "problem",
      repo: null, title, detail, raisedAt: input.now, since: input.now, actions,
      notify: ["setup","update"].includes(kind) ? "all" : "important", ...extra });
  };
  for (const t of input.tasks) {
    const extra = { repo: t.repo, taskId: t.id, ...(t.executor ? {executor:t.executor}:{}), ...(t.host ? {host:t.host}:{}), since:t.updatedAt, raisedAt:t.updatedAt };
    const reason = taskAttentionReason(t);
    if (t.state === "needs_input" && t.question && t.question.answer === undefined && !t.retriedBy && !t.dismissed) {
      add("question",t.id,t.goal,t.question.text.slice(0,200),[
        {label:"Answer",op:"task.answer",params:{id:t.id}},
        {label:"Stop",op:"task.stop",params:{id:t.id},style:"danger"},
      ],{...extra,severity:"blocked",since:t.question.at,raisedAt:t.question.at});
    } else if (reason === "checks_failed" || reason === "incomplete") {
      const label = reason === "checks_failed" ? "Inspect failures" : "Inspect incomplete work";
      add("failed", t.id, t.goal, reason === "checks_failed" ? "Acceptance checks failed" : "Execution is incomplete",
        [open(label, {view:"task",id:t.id})], extra);
    } else if (reason === "review_requested") {
      add("review", t.id, t.goal, t.reviewRequest!.note,
        [open("Review changes", {view:"review",id:t.id})], {...extra, since:t.reviewRequest!.at, raisedAt:t.reviewRequest!.at});
    } else if ((t.state === "failed" || t.state === "limit") && !t.retriedBy && !t.dismissed && !t.review && !t.resolved) {
      const target=input.retryTarget(t);
      add(t.state,t.id,t.goal,target ? `${displayName(t.executor)} ${t.state === "limit" ? "reached its limit" : "failed"}` : "No other executor available",[
        {label:target ? `Retry on ${displayName(target)}` : "Retry",op:"task.retry",params:{id:t.id,...(target?{executor:target}:{})}},
        open("See error",{view:"task",id:t.id}),
      ],extra);
    } else if (t.state === "running" && t.progress?.phase === "idle") {
      add("stuck",t.id,t.goal,"Waiting for output",[open("Open task",{view:"task",id:t.id}),{label:"Stop it",op:"task.stop",params:{id:t.id},style:"danger"}],extra);
    }
  }
  for (const a of input.accounts) if (a.signedIn === false && input.executors.some(e=>e.account===a.name && e.enabled)) {
    add("account_signin",a.name,`Sign in to ${executorName(a.agent)}`,"Account is signed out",[{label:"Sign in",op:"account.signin",params:{name:a.name}},...input.executors.filter(e=>e.account===a.name&&e.enabled&&e.rank!=="planner").map(e=>({label:"Disable",op:"runner.set",params:{id:e.id,enabled:false}}))],{account:a.name});
  }
  // A signed-out account already raises account_signin for its executors.
  const signedOut=new Set(input.accounts.filter(a=>a.signedIn===false).map(a=>a.name));
  for (const e of input.executors) if (e.enabled && e.rank!=="planner" && !signedOut.has(e.account) && (e.state==="down"||e.lastCheck?.passed===false&&e.state!=="checking")) {
    add("executor_down",e.id,`${displayName(e.id)} needs attention`,"Executor is not working",[open("Open settings",{view:"settings",section:"executors"}),{label:"Disable",op:"runner.set",params:{id:e.id,enabled:false}}],{executor:e.id,...(e.host?{host:e.host}:{})});
  }
  for(const h of input.hosts??[])if(h.state==="down"&&input.executors.some(e=>e.host===h.alias&&e.enabled)){
    const candidates=input.executors.filter(e=>e.enabled&&e.rank!=="planner"&&e.host!==h.alias&&["ready","busy"].includes(e.state));
    const next=candidates.find(e=>e.next)??candidates[0];
    add("host_down",h.alias,`${h.alias} is down`,`${h.running} task(s) running there. New work goes to ${next?displayName(next.id):"the next available executor"} until it is back.`,[{label:"Run checks",op:"host.check",params:{alias:h.alias}},{label:"Pause host",op:"host.set",params:{alias:h.alias,paused:true}}],{host:h.alias});
  }
  const p=input.planner;
  // Pace advice stays on the planner meter; only exhausted quota needs a decision.
  if (p && !(p.modeHeldUntil && p.modeHeldUntil>input.now) && p.verdict === "out") {
    add("planner_quota",p.runner,`${displayName(p.runner)} is out of quota`,p.advice,[open("Open planner settings",{view:"settings",section:"planner"}),{label:"Keep normal",op:"mode.hold",params:{mode:"normal"}}],{executor:p.runner});
  }
  for (const s of input.setup.items) if (s.required && s.status!=="done") add("setup",s.id,s.title,"Setup required",[open("Open settings",{view:"settings",section:s.id})]);
  if (input.update?.available) add("update",input.update.latest,`Update to ${input.update.latest}`,"An update is available",[{label:"Update",op:"update.apply",params:{}},{label:"Later",op:"attention.dismiss",params:{id:`update:${input.update.latest}`}}]);
  for (const p of input.discovery ? discoveryPrompts(input.discovery) : []) add(p.kind, p.key, p.title, p.detail, p.actions, p.since === undefined ? {} : { since: p.since, raisedAt: p.since });
  return sortItems(items);
}
