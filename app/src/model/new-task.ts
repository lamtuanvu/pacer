import type { PlannerMeter } from "../../../src/api/read-model/types";
import { agentInfo } from "../../../src/view-model/agents";
import { executorLabel, type StatusTone } from "../../../src/view-model/words";
import type { RouteExplanation, RouteReason } from "../data/explain-route";
import type { Account } from "./accounts";
import { kinds as KINDS } from "./tasks";

/** The New task composer's draft. Every field is a string so it fits the shared session draft storage. */
export interface NewTaskDraft {
  request: string;
  repo: string;
  base: string;
  workspace: string;
  /** The kind the user picked; empty means "use the detected kind". */
  kind: string;
  /** Empty means "Let pacer decide". */
  executor: string;
  /** JSON list of AcceptanceCheck. */
  checks: string;
  /** JSON list of repository-relative paths mentioned with @. */
  mentions: string;
  draftId: string;
}
export const blankNewTask: NewTaskDraft = { request: "", repo: "", base: "", workspace: "worktree", kind: "", executor: "", checks: "[]", mentions: "[]", draftId: "" };
export const NEW_TASK_DRAFT_KEY = "pacer.new-task.v1";

export interface AcceptanceCheck { id: string; text: string; command: string; on: boolean }
export type Workspace = "worktree" | "current";
export const WORKSPACES: { id: Workspace; title: string; sub: string; tag?: { label: string; tone: StatusTone } }[] = [
  { id: "worktree", title: "New worktree", sub: "Isolated copy · your checkout stays untouched", tag: { label: "Recommended", tone: "good" } },
  { id: "current", title: "Current checkout", sub: "Writes to your checkout directly" },
];
/** The board's chips, limited to kinds the service accepts ("review" is not a task kind, so research takes its place). */
export const KIND_CHIPS = ["feature", "debug", "tests", "docs", "refactor", "research"] as const;
export const kindLabel = (kind: string) => kind === "unfamiliar-code" ? "Unfamiliar code" : kind.charAt(0).toUpperCase() + kind.slice(1);

function parseList<T>(raw: string, valid: (value: unknown) => value is T): T[] {
  try { const list = JSON.parse(raw); return Array.isArray(list) ? list.filter(valid) : []; } catch { return []; }
}
const isCheck = (value: unknown): value is AcceptanceCheck => {
  const v = value as AcceptanceCheck;
  return !!v && typeof v.id === "string" && typeof v.text === "string" && typeof v.command === "string" && typeof v.on === "boolean";
};
export const readChecks = (draft: Pick<NewTaskDraft, "checks">) => parseList(draft.checks, isCheck);
export const readMentions = (draft: Pick<NewTaskDraft, "mentions">) => parseList(draft.mentions, (v): v is string => typeof v === "string" && v.length > 0);
export const writeChecks = (checks: AcceptanceCheck[]) => JSON.stringify(checks);
export const writeMentions = (paths: string[]) => JSON.stringify([...new Set(paths)]);

/** The kind the composer sends: the user's pick, else a valid detected kind from the routing preview. */
export function effectiveKind(draft: Pick<NewTaskDraft, "kind">, explanation?: RouteExplanation | null): { value: string; detected: boolean } | null {
  if (draft.kind && KINDS.includes(draft.kind)) return { value: draft.kind, detected: false };
  const detected = explanation?.kind.source === "detected" ? explanation.kind.value : null;
  return detected && KINDS.includes(detected) ? { value: detected, detected: true } : null;
}
export function kindChips(draft: Pick<NewTaskDraft, "kind">, explanation?: RouteExplanation | null): { kind: string; label: string; on: boolean; detected: boolean }[] {
  const chosen = effectiveKind(draft, explanation);
  const list: string[] = [...KIND_CHIPS];
  if (chosen && !list.includes(chosen.value)) list.push(chosen.value);
  return list.map(kind => ({ kind, label: kindLabel(kind), on: chosen?.value === kind, detected: !!chosen?.detected && chosen.value === kind }));
}

export interface SubmitContext { requestId: string; knownRepos: string[]; attachments?: { name: string }[]; explanation?: RouteExplanation | null }
/**
 * `task.delegate` params for "Delegate task". Checks with a command become the acceptance command (all must pass);
 * the rest are written into the brief's context as "Done when" lines, since the runner runs one command.
 */
export function newTaskPayload(draft: NewTaskDraft, ctx: SubmitContext) {
  const goal = draft.request.trim();
  if (!goal) throw new Error("Write a request to continue.");
  if (!ctx.knownRepos.includes(draft.repo)) throw new Error("Choose a repository.");
  const checks = readChecks(draft).filter(check => check.on);
  const commands = checks.map(check => check.command.trim()).filter(Boolean);
  const doneWhen = checks.filter(check => check.text.trim()).map(check => `- ${check.text.trim()}${check.command.trim() ? ` (\`${check.command.trim()}\`)` : ""}`);
  const files = ctx.attachments?.map(file => `- ${file.name}`) ?? [];
  const context = [
    ...(doneWhen.length ? ["Done when:", ...doneWhen] : []),
    ...(files.length ? [...(doneWhen.length ? [""] : []), "Attached in the pacer app:", ...files] : []),
  ].join("\n");
  const mentions = readMentions(draft);
  const kind = effectiveKind(draft, ctx.explanation);
  return {
    goal, repo: draft.repo,
    ...(draft.base.trim() ? { base: draft.base.trim() } : {}),
    ...(commands.length ? { acceptance: commands.join(" && ") } : {}),
    ...(context ? { context } : {}),
    ...(mentions.length ? { scope: mentions.join(", ") } : {}),
    ...(kind ? { kind: kind.value } : {}),
    ...(draft.executor ? { executor: draft.executor } : {}),
    worktree: draft.workspace === "current" ? "current" as const : "new" as const,
    source: "ui" as const,
    request_id: ctx.requestId,
  };
}

/** What the composer may do now, and the one sentence under the primary action. */
export function submitState(input: { draft: NewTaskDraft; repoLabel?: string; busy: boolean; failed: boolean; pendingUploads: boolean }) {
  const { draft, repoLabel, busy, failed, pendingUploads } = input;
  const where = draft.workspace === "current" ? "the current checkout" : "a new worktree";
  const empty = !draft.request.trim();
  const label = busy ? "Delegating…" : failed ? (draft.workspace === "current" ? "Try again in a new worktree" : "Try again") : "Delegate task";
  const note = empty ? "Write a request to continue"
    : pendingUploads ? "Finish or remove pending attachments to continue"
    : !repoLabel ? "Choose a repository"
    : failed ? "Your request, checks and agent choice are kept"
    : `Starts in ${where} on ${repoLabel} · you can watch it in Tasks`;
  return { label, note, disabled: busy || empty || pendingUploads || !repoLabel, retryInWorktree: failed && draft.workspace === "current" };
}

/** Header note beside Save draft. */
export function savedNote(savedAt: number | null, now: number, failed: boolean): string {
  if (failed) return "Kept as a draft";
  if (savedAt === null) return "";
  const minutes = Math.floor((now - savedAt) / 60_000);
  return minutes < 1 ? "Draft saved just now" : `Draft saved ${minutes} min ago`;
}

// ---- "Will go to" card ----------------------------------------------------------------------------------------

export interface RouteAgent { executor: string; agent: string; name: string }
export interface RouteCardView {
  lead: (RouteAgent & { step: string; pill: { label: string; tone: StatusTone } }) | null;
  why: { glyph: "✓" | "✕" | "!" | "i"; tone: StatusTone; text: string }[];
  then: (RouteAgent & { excluded: boolean; reason: string | null })[];
  planner: { cost: string; note: string; used: number | null; pace: number | null; agent: string | null };
}
const agentOf = (executor: string) => executor.split("@")[0]!.split("#")[0]!;
const named = (executor: string, accounts: Account[]): RouteAgent => ({ executor, agent: agentOf(executor), name: executorLabel(executor, accounts) || agentInfo(agentOf(executor)).name });
const fact = (facts: RouteReason["facts"], key: string) => facts[key] === null || facts[key] === undefined ? "" : String(facts[key]);
const day = (unix: string) => {
  const at = Number(unix);
  if (!Number.isFinite(at) || at <= 0) return "";
  return new Date(at * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};
/** Plain copy for the documented reason codes (UI-12): the app never shows a code or the service's `text`. */
export function reasonText(reason: RouteReason, accounts: Account[] = []): string {
  const f = reason.facts, who = reason.subject ? executorLabel(reason.subject, accounts) : "";
  switch (reason.code) {
    case "quota_exhausted": { const at = day(fact(f, "resetsAt")); return `${who || "This agent"} is out of budget${at ? ` · resets ${at}` : ""}`; }
    case "capacity_comfortable": return `${who || "This agent"} has spare capacity${fact(f, "headroomPct") ? ` · ${fact(f, "headroomPct")}% headroom` : ""}${fact(f, "pacePct") ? `, pace ${fact(f, "pacePct")}%` : ""}`;
    case "step_match": return `${fact(f, "kind") ? `${kindLabel(fact(f, "kind"))} work` : "This work"} matches ladder step ${fact(f, "stepId") || "1"}`;
    case "repo_access": return `Has access to this repository${fact(f, "host") ? ` on ${fact(f, "host")}` : ""}`;
    case "host_unreachable": return `${fact(f, "host") || "The remote host"} can't be reached right now`;
    case "enforcement_uncertified": return `${agentInfo(fact(f, "agent") || "agent").name} can't be held to pacer's child rules yet`;
    case "override": return "Skips the dispatcher ladder for this task";
    case "override_unavailable": return `${executorLabel(fact(f, "requested"), accounts)} can't take it, so pacer picked another agent`;
    case "no_step_matched": return "No ladder step matches this task";
    case "paused": { const at = day(fact(f, "until")); return `Delegation is paused${at ? ` until ${at}` : ""}`; }
    default: return "Not available right now";
  }
}
const glyphFor = (outcome: RouteReason["outcome"]) => outcome === "pass" ? { glyph: "✓" as const, tone: "good" as const } : outcome === "fail" ? { glyph: "✕" as const, tone: "bad" as const } : { glyph: "!" as const, tone: "warn" as const };
const tokens = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

export function routeCard(explanation: RouteExplanation, accounts: Account[] = [], planner: PlannerMeter | null = null): RouteCardView {
  const excluded = explanation.fallbacks.filter(f => f.state === "excluded");
  const chosen = explanation.chosen;
  const step = explanation.outcome === "override" && chosen
    ? "Chosen by you · this task only"
    : explanation.step
      ? `Ladder step ${explanation.step.index + 1} · ${explanation.step.index > 0 && excluded[0] ? `${named(excluded[0].executor, accounts).name} skipped` : `strategy ${explanation.strategy.name}`}`
      : `Strategy ${explanation.strategy.name}`;
  const pill = explanation.outcome === "select" ? { label: "Ready", tone: "good" as const }
    : explanation.outcome === "override" ? { label: "Override", tone: "info" as const }
    : explanation.outcome === "queue" ? { label: "Waits in queue", tone: "warn" as const }
    : { label: "Can't start", tone: "bad" as const };
  const reasons = [...explanation.reasons, ...(explanation.outcome === "override" ? [] : excluded.slice(0, 1).map(f => f.reason).filter((r): r is RouteReason => !!r))];
  const why = reasons.map(reason => ({ ...glyphFor(reason.outcome), text: reasonText(reason, accounts) }));
  const then = explanation.fallbacks.map(f => ({ ...named(f.executor, accounts), excluded: f.state === "excluded", reason: f.reason ? reasonText(f.reason, accounts) : null }));
  const cost = explanation.planner;
  const window = cost.state === "estimate" && cost.window ? { used: cost.window.usedPct, pace: cost.window.pacePct } : { used: planner?.usedPct ?? null, pace: planner?.pacePct ?? null };
  const week = window.used === null ? "" : `Week ${Math.round(window.used)}%${window.pace === null ? "" : ` · pace ${Math.round(window.pace)}%`}`;
  return {
    lead: chosen ? { ...named(chosen.executor, accounts), step, pill } : null,
    why: chosen ? why : [{ glyph: "✕", tone: "bad", text: reasons[0] ? reasonText(reasons[0], accounts) : "No agent can take this task right now" }],
    then,
    planner: {
      agent: planner?.agent ?? null,
      cost: cost.state === "estimate" ? `≈ ${tokens(cost.tokens.median)} tokens` : "Not measured yet",
      note: [week, cost.state === "estimate" ? `median of ${cost.samples} similar tasks` : "Planner: not measured yet"].filter(Boolean).join(" · "),
      ...window,
    },
  };
}

/** The "Send to a specific agent" list from `routing.route`: ready executors, then excluded ones with their reason. */
export interface AgentOption { executor: string; agent: string; name: string; sub: string; pill: { label: string; tone: StatusTone }; available: boolean }
export function agentOptions(routing: { ranked: { id: string; reason: string }[]; excluded: { id: string; reason: string }[] } | undefined, status: (row: { id: string; reason: string }) => { label: string; tone: StatusTone }, accounts: Account[] = []): AgentOption[] {
  if (!routing) return [];
  return [
    ...routing.ranked.map(row => ({ ...named(row.id, accounts), sub: row.reason, pill: status(row), available: true })),
    ...routing.excluded.map(row => ({ ...named(row.id, accounts), sub: row.reason, pill: { label: "Unavailable", tone: "bad" as const }, available: false })),
  ];
}
