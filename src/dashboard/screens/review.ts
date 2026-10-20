/** Review: the queue on the left, the selected task's evidence and verdict on the right. */
import type { AttentionItem } from "../../attention/types";
import { reviewQueue, needsYou } from "../../view-model/selectors";
import { costCopy, reasonCopy } from "../../view-model/copy";
import { displayTitle } from "../../view-model/titles";
import { elapsed } from "../../view-model/time";
import { executorLabel, taskStatus, taskOutcome, attentionStatus, type Status } from "../../view-model/words";
import type { ClientTask } from "../../view-model/snapshot";
import { box, cols, flex, glyph, heading, span, statusSpans, wrap, type Line, lineWidth } from "../frame";
import type { Act, Item } from "../state";
import { blank, defined, empty, GAP, MARK, time, wrapLines, serviceAct } from "./common";
import type { Resource, Row, ScreenCtx, ScreenView, TaskDetail } from "./types";

export const KINDS = ["boilerplate", "tests", "docs", "rename", "migration", "feature", "debug", "refactor", "performance", "unfamiliar-code", "research"];

/** Review items in scope: oldest first, with a task, not snoozed. */
export function scopedReviewQueue(ctx: Pick<ScreenCtx, "s" | "state">): AttentionItem[] {
  const { s, state } = ctx;
  return reviewQueue(s).filter(a => a.taskId && !(a.snoozedUntil && a.snoozedUntil > s.at) && (state.scope === null || !a.repo || a.repo.key === state.scope));
}

const ACCEPTANCE: Record<string, Status> = {
  passed: { label: "Tests passed", tone: "good", glyph: "✓" },
  failed: { label: "Failed", tone: "bad", glyph: "✕" },
  pending: { label: "Waiting for tests", tone: "neutral", glyph: "…" },
  running: { label: "Testing", tone: "info", glyph: "▶" },
};

export function reviewItem(ctx: ScreenCtx, a: AttentionItem, task?: ClientTask, detail?: TaskDetail): Item {
  const id = a.taskId!, title = task ? displayTitle(task) : a.title;
  const rev = typeof task?.rev === "number" ? task.rev : detail?.rev;
  const base = { id, ...(typeof rev === "number" ? { expect_rev: rev } : {}) };
  const verdict = (label: string, verdict: string, extra: Record<string, unknown> = {}) =>
    ({ type: "action" as const, action: { label, op: "task.review", params: { ...base, verdict, ...extra } } });
  if (!ctx.supports("task.review")) return { id: `review:${id}`, actions: [], keys: {} };
  const acceptAllowed = a.kind === "review" && (task ?? detail)?.state === "done" && task?.acceptanceState !== "failed" && detail?.acceptance?.state !== "failed";
  const accept: Act = { label: "Mark accepted", effect: verdict("Accepted", "accept"), confirm: { title: `Accept "${title}"?`, body: ["Accept records the verdict; you merge the branch."], yes: "Accept" } };
  const note = (label: string, verdictName: string, title: string): Act => ({
    label, danger: verdictName === "reject",
    effect: { type: "prompt", prompt: { title, label: "Note for the executor and your planner", required: "Add a note first.", submit: value => verdict(verdictName === "reject" ? "Rejected" : "Sent back", verdictName, { note: value }) } },
  });
  const sendBack = note("Send back", "send_back", "Send back with a note");
  const reject = note("Reject", "reject", "Reject with a note");
  const options = (detail?.retryOptions ?? []).filter(o => o.state === "ready");
  const retry: Act | undefined = options.length ? {
    label: "Retry on another executor",
    effect: { type: "choose", title: "Retry on", options: options.map(o => ({ label: `${executorLabel(o.id)} · ${reasonCopy(o.reason)}`, effect: verdict("Retry requested", "retry", { executor: o.id }) })) },
  } : undefined;
  const path: Act | undefined = detail?.worktree ? { label: "Show worktree path", effect: { type: "local", label: `Worktree: ${detail.worktree}`, run: () => {} } } : undefined;
  return {
    id: `review:${id}`, actions: defined([
      a.kind !== "review" && (task ?? detail)?.state === "done" && task?.acceptanceState !== "failed" && detail?.acceptance?.state !== "failed" ? {...accept,label:"Mark accepted (optional verdict)"} : undefined,
      sendBack, reject, retry, path]),
    keys: { ...(acceptAllowed ? {a:accept} : {}), s: sendBack, r: reject, ...(retry ? { t: retry } : {}), ...(path ? { o: path } : {}) },
  };
}

export function reviewScreen(ctx: ScreenCtx): ScreenView {
  const {s,theme} = ctx;
  const queue = needsYou(s,{repo:ctx.state.scope});
  const listWidth = ctx.wide ? 52 : ctx.width;
  const list: Row[] = [{line:heading(theme,"Decisions and problems")}];
  const items: Item[] = [];
  for (const a of queue) {
    const task = s.tasks.find(t=>t.id===a.taskId);
    const item = a.kind === "review" && a.taskId ? reviewItem(ctx,a,task,ctx.data.details.get(a.taskId)?.value) : {
      id:`attention:${a.id}`, primary:a.actions[0]?serviceAct(ctx,a.actions[0],a.title):undefined,
      actions:defined(a.actions.slice(1).map(action=>serviceAct(ctx,action,a.title))), keys:{},
    };
    items.push(item);
    const w=flex(listWidth-MARK,[{fixed:20},{weight:1,min:8}],1);
    list.push({item:item.id,line:cols([{content:statusSpans(theme,attentionStatus(a,s.tasks)),width:w[0]!},{content:task?displayTitle(task):a.title,width:w[1]!,style:{bold:true}}],1,theme)});
    for(const line of wrap(a.detail,listWidth-MARK,2)) list.push({item:item.id,cont:true,line:[span(line,{fg:"secondary"})]});
    list.push(blank());
  }
  if(!queue.length) list.push(empty("Nothing needs your attention. See Tasks for completed work."));
  const index = items.findIndex(i=>i.id===ctx.state.selected.review);
  const selected = queue[index < 0 ? 0 : index];
  const width = ctx.wide ? ctx.width-listWidth-3 : ctx.width-MARK;
  return {list,items,listWidth,detail:selected?.taskId ? reviewDetail(ctx,selected,ctx.data.details.get(selected.taskId),width)
    : selected ? wrap(selected.detail,width).map(line=>({line:[span(line)]})) : [], needs:selected?.taskId?[selected.taskId]:[]};
}

function loadingRow(ctx: ScreenCtx, text: string): Row {
  return { line: [span(ctx.spinner ? `${ctx.spinner} ${text}` : text, { fg: "muted" })] };
}
export function errorRows(ctx: ScreenCtx, error: NonNullable<Resource<unknown>["error"]>): Row[] {
  return [{ line: statusSpans(ctx.theme, { label: `${error.message}${error.hint ? ` (${error.hint})` : ""}`, tone: "bad", glyph: "✕" }) }, { line: [span("R retries", { fg: "muted" })] }];
}

export function reviewDetail(ctx: ScreenCtx, a: AttentionItem, resource: Resource<TaskDetail> | undefined, width: number): Row[] {
  const { theme, s, now } = ctx, task = s.tasks.find(t => t.id === a.taskId), d = resource?.value;
  const title = task ? displayTitle(task) : d ? displayTitle(d) : a.title;
  const rows: Row[] = [];
  for (const line of wrap(title, width, 2)) rows.push({ line: [span(line, { bold: true })] });
  const status = taskStatus(d ?? task ?? { state: "done" });
  const executor = d?.executor ?? task?.executor ?? a.executor;
  const ran = d?.startedAt && d.endedAt ? `ran ${elapsed(d.endedAt - d.startedAt)}` : task?.attemptStartedAt ? `ran ${elapsed(task.updatedAt - task.attemptStartedAt)}` : "";
  const branch = d?.branch ? `${d.branch}${d.base ? ` ${glyph(theme, "→")} ${d.base}` : ""}` : "";
  const dot = ` ${glyph(theme, "·")} `;
  /** A status, then its facts after a separator, wrapped; no separator when there are no facts. */
  const facts = (status: Line, parts: (string | null | undefined)[], room: number): Line[] => {
    const text = parts.filter(Boolean).join(dot);
    return text ? wrapLines([...status, span(dot, { fg: "secondary" })], text, room, { fg: "secondary" }) : [status];
  };
  rows.push(...facts(statusSpans(theme, status), [executorLabel(executor), ran, branch], width).map(line => ({ line })));
  const finished = d?.endedAt ?? task?.updatedAt;
  rows.push({ line: [span([a.repo?.label ?? task?.repo?.label, finished ? `finished ${time(ctx, finished)}` : ""].filter(Boolean).join(` ${glyph(theme, "·")} `), { fg: "muted" })] });
  if (resource?.loading && !d) return [...rows, blank(), loadingRow(ctx, "Loading task…")];
  if (resource?.error && !d) {
    const removed = /worktree/i.test(resource.error.message) && /removed|missing|not found/i.test(resource.error.message);
    return [...rows, blank(), ...(removed ? [{ line: statusSpans(theme, { label: "Changes unavailable · the worktree was removed after the task finished", tone: "warn", glyph: "!" }) }] : errorRows(ctx, resource.error))];
  }
  if (!d) return [...rows, blank(), loadingRow(ctx, "Loading task…")];
  if (resource?.loading) rows.push({ line: [span("Updating…", { fg: "muted" })] });

  rows.push(blank(), {line:heading(theme,"Result")});
  const summary = d.summary?.trim();
  const concise = summary && summary.split("\n").length <= 8 && !/I'll start|Let me (?:read|look|check|explore)/i.test(summary);
  rows.push(...wrapLines([],concise?summary:"Execution ended. Inspect checks and changes.",width,{}).map(line=>({line})));
  rows.push({line:statusSpans(theme,taskOutcome(d))});
  rows.push(...wrapLines([],d.reviewRequest ? `Review requested: ${d.reviewRequest.note}` : "",width,{}).map(line=>({line})));
  rows.push(blank(),{line:heading(theme,"Delivery")},{line:[span("Integration not recorded",{fg:"muted"})]});

  // Done when
  rows.push(blank());
  const acc = d.acceptance ?? (task as { acceptance?: TaskDetail["acceptance"] } | undefined)?.acceptance;
  const doneWhen: Line[] = acc?.cmd
    ? [[span(acc.cmd)], ...facts(statusSpans(theme, ACCEPTANCE[acc.state ?? ""] ?? { label: "No done-when command", tone: "neutral", glyph: "?" }), [acc.summary, acc.durationS != null ? `checks ran ${acc.durationS} s` : "", acc.machine ? `run by pacer on ${acc.machine}` : ""], width - 4)]
    : [[span("No done-when command", { fg: "muted" })]];
  rows.push(...box(theme, "Done when", doneWhen, width).map(line => ({ line })));

  // Why this executor
  const why: Line[] = [...wrapLines([], reasonCopy(d.routing?.why), width - 4, {}), ...(d.routing?.skipped ?? []).slice(0, 3).flatMap(x => wrapLines([], `Skipped ${executorLabel(x.executor)}: ${reasonCopy(x.reason)}`, width - 4, { fg: "secondary" }))];
  if (d.cost?.executor) why.push(...wrapLines([], `Cost: ${costCopy(d.cost.executor ?? null)}`, width - 4, { fg: "secondary" }));
  rows.push(...box(theme, `Why ${executorLabel(executor)}`, why, width).map(line => ({ line })));

  // Changes
  rows.push(blank());
  const files = d.files ?? [];
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0), removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  rows.push({ line: heading(theme, "Changes", `${files.length} ${files.length === 1 ? "file" : "files"}`, files.length ? `+${added} −${removed}` : undefined) });
  if (!files.length) rows.push(empty("No changes recorded."));
  const w = flex(width, [{ fixed: 1 }, { weight: 1, min: 10 }, { fixed: 6 }, { fixed: 6 }]);
  for (const f of files.slice(0, 12)) {
    rows.push({ line: cols([
      { content: (f.status[0] ?? "?").toUpperCase(), width: w[0]!, style: { fg: "muted" } },
      { content: f.path, width: w[1]! },
      { content: f.binary ? "binary" : `+${f.added ?? 0}`, width: w[2]!, align: "right", style: { fg: "good" } },
      { content: f.binary ? "" : `−${f.removed ?? 0}`, width: w[3]!, align: "right", style: { fg: "bad" } },
    ], GAP, theme) });
  }
  if (files.length > 12) rows.push(empty(`+${files.length - 12} more files · pacer review ${d.id} shows the diff`));

  // Verdict
  rows.push(blank());
  const can = a.kind === "review" && ctx.supports("task.review") && !d.review && !d.resolved && !d.dismissed && !d.retriedBy;
  // Each verdict key stays whole; groups move to the next line when the box is narrow.
  const groups: Line[] = can
    ? [[span("a", { bold: true }), span(" Mark accepted", { fg: "ink", bold: true })], [span("s", { bold: true }), span(" Send back", { fg: "secondary" })], [span("r", { bold: true }), span(" Reject", { fg: "bad" })],
      ...((d.retryOptions ?? []).some(o => o.state === "ready") ? [[span("t", { bold: true }), span(" Retry on another executor", { fg: "secondary" })]] : [])]
    : [];
  const keyLines: Line[] = [];
  for (const group of groups) {
    const last = keyLines.at(-1);
    if (last && lineWidth(last) + 3 + lineWidth(group) <= width - 4) last.push(span("   "), ...group);
    else keyLines.push([...group]);
  }
  const body: Line[] = can ? keyLines : wrapLines([], `This pacer service does not offer reviews here. Use pacer review ${d.id}.`, width - 4, { fg: "muted" });
  if (a.kind === "review" && !ctx.supports("task.review")) rows.push(empty("This service does not offer reviews here."));
  if (can) rows.push(...box(theme, "Your verdict", [...body, ...wrapLines([], "Accept records the verdict; you merge the branch.", width - 4, { fg: "muted" })], width).map(line => ({ line })));
  void now;
  return rows;
}
