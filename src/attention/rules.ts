import type { AccountSummary, ApiTask, ExecutorRow, HostSummary, PlannerMeter, SetupSummary } from "../api/read-model/types";
import { taskAttentionReason } from "../api/read-model/tasks";
import { awaitsAnswer } from "../tasks/types";
import { parseRunnerId } from "../config/runner-id";
import { executorName } from "../link/notification";
import { workActionRequestId } from "../work/action-id";
import type { Action, AttentionItem, AttentionKind, AttentionUnblocks, RunAttentionPriority } from "./types";
import { discoveryPrompts, type DiscoveryRuleInput } from "../discovery/prompts";

/** Stalled caller_decision older than this becomes an important (grouped) notification. */
export const CALLER_GONE_AFTER_S = 30 * 60;
/** Same attention id is not re-notified within this window after a successful delivery. */
export const NOTIFY_COOLDOWN_S = 30 * 60;

export interface RuleInput {
  now: number; tasks: ApiTask[]; executors: ExecutorRow[]; accounts: AccountSummary[];
  hosts?: HostSummary[]; planner: PlannerMeter | null; setup: SetupSummary;
  update: { latest: string; available: boolean } | null;
  retryTarget(t: ApiTask): string | null;
  /** Absent when LAN discovery is off. */
  discovery?: DiscoveryRuleInput;
}
/** The planner kind in a caller participant (`external:claude-code:<session>` → `claude-code`). */
const callerLabel = (p?: string) => /^external:([a-z-]+)/.exec(p ?? "")?.[1] ?? "the caller";
const displayName = (id: string | null) => executorName(id ? parseRunnerId(id)?.agent ?? id : null);
const open = (label: string, params: Action["params"]): Action => ({ label, op: "ui.open", params });
/** Clip by Unicode code points so a surrogate pair is never split (m4). */
const clipCodePoints = (s: string, max: number) => {
  const points = Array.from(s);
  return points.length > max ? points.slice(0, max).join("") : s;
};
const severityOrder = { blocked: 0, problem: 1, decide: 2 };
const unblocksOrder: Record<AttentionUnblocks, number> = { run: 0, branch: 1, nothing: 2 };
const priorityOrder: Record<RunAttentionPriority, number> = { urgent: 0, normal: 1, background: 2 };
const QUIET_KINDS = new Set<AttentionKind>(["stuck", "executor_down", "host_down", "discovery", "discovery-network", "setup", "update"]);
const BLOCKING_KINDS = new Set<AttentionKind>(["account_signin", "planner_quota"]);
/** Escalated liveness promotes these kinds to important. */
const ESCALATED_KINDS = new Set<AttentionKind>(["question", "failed", "limit", "message"]);
/** Human-owned roots promote these kinds to important (not bare unread messages). */
const OWNED_IMPORTANT_KINDS = new Set<AttentionKind>(["question", "failed", "limit"]);

/** Planner/agent caller ids look like `external:<agent>` or `external:<agent>:<session>`. */
export function isExternalAgentOrigin(origin?: string | null): boolean {
  return !!origin && origin.startsWith("external:");
}

/**
 * Human owns the decision on this root when they started it (not a work-tree child).
 * `source` alone is not enough: CLI `pacer delegate` from a planner session still has
 * `source:"cli"` but `origin:"external:<agent>:<session>"` — that is planner-owned.
 * Missing/unknown source is not human-owned.
 */
export function ownedByHuman(t: Pick<ApiTask, "source" | "work" | "origin">): boolean {
  if (t.work?.parentId) return false;
  if (t.work?.userStarted) return true;
  if (t.source === "ui" || t.source === "onboarding") return true;
  if (t.source === "cli") return !isExternalAgentOrigin(t.origin);
  return false;
}

function callerGoneImportant(t: ApiTask | null, now: number): boolean {
  const live = t?.liveness;
  return live?.reason === "caller_decision" && live.since !== undefined
    && now - live.since >= CALLER_GONE_AFTER_S;
}

/** Notify level for a raised attention kind on an optional task. */
export function notifyLevel(kind: AttentionKind, t: ApiTask | null, now: number): "important" | "all" {
  if (BLOCKING_KINDS.has(kind)) return "important";
  if (QUIET_KINDS.has(kind)) return "all";
  if (kind === "stalled") return callerGoneImportant(t, now) ? "important" : "all";
  if (!t) return "important";
  if (kind === "review") return "important";
  if (kind === "message" && t.messages?.question) return "important";
  if (t.liveness?.escalatedAt && ESCALATED_KINDS.has(kind)) return "important";
  if (ownedByHuman(t) && OWNED_IMPORTANT_KINDS.has(kind)) return "important";
  return "all";
}

export function sortItems(items: AttentionItem[]): AttentionItem[] {
  // Total order: ordinary items use sentinel unblocks=nothing and priority=normal
  // so mixed run/ordinary triples cannot cycle (I9).
  return items.sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity]
    || unblocksOrder[a.unblocks ?? "nothing"] - unblocksOrder[b.unblocks ?? "nothing"]
    || priorityOrder[a.run?.priority ?? "normal"] - priorityOrder[b.run?.priority ?? "normal"]
    || a.since - b.since
    || a.id.localeCompare(b.id));
}
export function deriveItems(input: RuleInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (kind: AttentionKind, key: string, title: string, detail: string, actions: Action[], extra: Partial<AttentionItem> = {}, task: ApiTask | null = null) => {
    items.push({ id: `${kind}:${key}`, kind, severity: kind === "stuck" || kind === "stalled" ? "blocked" : ["review","update","discovery","discovery-network"].includes(kind) ? "decide" : "problem",
      repo: null, title, detail, raisedAt: input.now, since: input.now, actions,
      notify: notifyLevel(kind, task, input.now), ...extra });
  };
  for (const t of input.tasks) {
    const extra = { repo: t.repo, taskId: t.id, ...(t.executor ? {executor:t.executor}:{}), ...(t.host ? {host:t.host}:{}), since:t.updatedAt, raisedAt:t.updatedAt };
    const reason = taskAttentionReason(t);
    if (awaitsAnswer(t)) {
      const q = t.question!;
      add("question",t.id,t.goal,q.text.slice(0,200),[
        {label:"Answer",op:t.work ? "dispatch.answer" : "task.answer",params:{id:t.id,...(t.work ? {expect_rev:t.rev,requestId:workActionRequestId(t.id,t.rev,"answer")} : {})}},
        {label:"Stop",op:"task.stop",params:{id:t.id},style:"danger"},
      ],{...extra,severity:"blocked",since:q.at,raisedAt:q.at},t);
    } else if (reason === "checks_failed" || reason === "incomplete") {
      const label = reason === "checks_failed" ? "Inspect failures" : "Inspect incomplete work";
      add("failed", t.id, t.goal, reason === "checks_failed" ? "Acceptance checks failed" : "Execution is incomplete",
        [open(label, {view:"task",id:t.id})], extra, t);
    } else if (reason === "review_requested") {
      add("review", t.id, t.goal, t.reviewRequest!.note,
        [open("Review changes", {view:"review",id:t.id})], {...extra, since:t.reviewRequest!.at, raisedAt:t.reviewRequest!.at}, t);
    } else if ((t.state === "failed" || t.state === "limit") && !t.retriedBy && !t.dismissed && !t.review && !t.resolved) {
      const target=t.work ? null : input.retryTarget(t);
      add(t.state,t.id,t.goal,t.work || target ? `${displayName(t.executor)} ${t.state === "limit" ? "reached its limit" : "failed"}` : "No other executor available",[
        {label:target ? `Retry on ${displayName(target)}` : "Retry",op:t.work ? "dispatch.retry" : "task.retry",params:{id:t.id,...(t.work ? {expect_rev:t.rev,requestId:workActionRequestId(t.id,t.rev,"retry")} : target ? {executor:target} : {})}},
        open("See error",{view:"task",id:t.id}),
      ],extra,t);
    } else if (t.state === "running" && t.progress?.phase === "idle") {
      add("stuck",t.id,t.goal,"Waiting for output",[open("Open task",{view:"task",id:t.id}),{label:"Stop it",op:"task.stop",params:{id:t.id},style:"danger"}],extra,t);
    }
    if (t.state === "running" && t.promptWait) {
      const raw = clipCodePoints(t.promptWait.text, 200);
      items.push({
        id: `prompt_wait:${t.id}`,
        kind: "stuck",
        severity: "blocked",
        repo: t.repo,
        taskId: t.id,
        title: t.goal,
        // UI-1: Convert sentence first, then the captured terminal text.
        detail: `Convert hands the question to the workflow planner, who answers or asks you. ${raw}`,
        raisedAt: t.promptWait.at,
        since: t.promptWait.at,
        notify: notifyLevel("stuck", t, input.now),
        actions: [
          // Convert first: Dispatch/tray show only the first action; convert_prompt
          // succeeds with { id } alone (UI evidence batch G).
          { label: "Convert to question", op: "question.convert_prompt", params: { id: t.id }, style: "primary" },
          open("Answer in terminal", { view: "task", id: t.id, tab: "terminal" }),
        ],
        ...(t.executor ? { executor: t.executor } : {}),
        ...(t.host ? { host: t.host } : {}),
      });
    }
    if (t.liveness?.stalled) {
      const detail = t.liveness.reason === "no_progress"
        ? `No progress for ${Math.max(1, Math.floor((input.now - t.liveness.since) / 60))} min`
        : t.liveness.reason === "silent_prompt"
        ? `Waiting at prompt with no open question for ${Math.max(1, Math.floor((input.now - t.liveness.since) / 60))} min`
        : t.liveness.reason === "caller_decision" ? `Waiting for ${callerLabel(t.liveness.waitingOn)} to review and decide`
        : `Conversation stalled: ${t.liveness.reason}`;
      add("stalled", t.id, t.goal, detail, [open("Open messages", { view: "task", id: t.id, tab: "messages" })],
        { ...extra, since: t.liveness.since, raisedAt: t.liveness.since, ...(t.liveness.waitingOn ? { waitingOn: t.liveness.waitingOn } : {}) }, t);
    }
    // An unanswered task question already raises the "question" item above.
    const legacyQuestion = t.state === "needs_input" && !!t.question && t.question.answer === undefined && !t.retriedBy;
    if (t.messages?.unreadForHuman && !t.dismissed && !legacyQuestion) {
      const q = t.messages.question, n = t.messages.unreadForHuman;
      // A reviewed or stopped task takes no more messages (messaging isClosed), so its question can only be read.
      const answerable = !!q && !t.review && t.state !== "stopped";
      add("message", t.id, t.goal, q ? q.text.slice(0, 200) : `${n} unread message${n === 1 ? "" : "s"}`, [
        // A question lands on the task's answer composer; other messages only open the task.
        { ...(answerable ? open("Answer", { view: "task", id: t.id, tab: "answer" }) : open("Open task", { view: "task", id: t.id })), style: "primary" },
      ], { ...extra, severity: q ? "blocked" : "decide", since: q?.at ?? t.updatedAt, raisedAt: q?.at ?? t.updatedAt }, t);
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
