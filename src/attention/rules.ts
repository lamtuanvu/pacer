import type { AccountSummary, ApiTask, ExecutorRow, PlannerMeter, SetupSummary } from "../api/read-model/types";
import { needsReview } from "../api/read-model/tasks";
import { parseRunnerId } from "../config/runner-id";
import { executorName } from "../link/notification";
import type { Action, AttentionItem, AttentionKind } from "./types";

export interface RuleInput {
  now: number; tasks: ApiTask[]; executors: ExecutorRow[]; accounts: AccountSummary[];
  planner: PlannerMeter | null; setup: SetupSummary;
  update: { latest: string; available: boolean } | null;
  retryTarget(t: ApiTask): string | null;
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
    items.push({ id: `${kind}:${key}`, kind, severity: kind === "stuck" ? "blocked" : ["review","update"].includes(kind) ? "decide" : "problem",
      repo: null, title, detail, raisedAt: input.now, since: input.now, actions,
      notify: ["setup","update"].includes(kind) ? "all" : "important", ...extra });
  };
  for (const t of input.tasks) {
    const extra = { repo: t.repo, taskId: t.id, ...(t.executor ? {executor:t.executor}:{}), ...(t.host ? {host:t.host}:{}), since:t.updatedAt, raisedAt:t.updatedAt };
    if (needsReview(t) && (t.source !== "planner" || input.now-t.updatedAt >= 600)) {
      add("review",t.id,t.goal,"Waiting for review",[open("Review",{view:"review",id:t.id}),{label:"Accept",op:"task.review",params:{id:t.id,verdict:"accept"}}],extra);
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
    add("account_signin",a.name,`Sign in to ${executorName(a.agent)}`,"Account is signed out",[open("Sign in",{view:"settings",section:"accounts"})],{account:a.name});
  }
  for (const e of input.executors) if (e.enabled && e.rank!=="planner" && e.state==="down") {
    add("executor_down",e.id,`${displayName(e.id)} needs attention`,"Executor is not working",[open("Open settings",{view:"settings",section:"executors"}),{label:"Disable",op:"runner.block",params:{id:e.id}}],{executor:e.id,...(e.host?{host:e.host}:{})});
  }
  const p=input.planner;
  if (p && (p.verdict === "out" || p.verdict === "ahead" && ["strict","emergency"].includes(p.mode))) {
    add("planner_quota",p.runner,`${displayName(p.runner)} ${p.verdict === "out" ? "is out of quota" : "is ahead of pace"}`,p.advice,[open("Open planner settings",{view:"settings",section:"planner"})],{executor:p.runner});
  }
  for (const s of input.setup.items) if (s.required && s.status!=="done") add("setup",s.id,s.title,"Setup required",[open("Open settings",{view:"settings",section:s.id})]);
  if (input.update?.available) add("update",input.update.latest,`Update to ${input.update.latest}`,"An update is available",[{label:"Update",op:"update.apply",params:{}},{label:"Later",op:"attention.dismiss",params:{id:`update:${input.update.latest}`}}]);
  return sortItems(items);
}
