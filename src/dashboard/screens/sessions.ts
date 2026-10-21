/** Sessions: running and recently ended work, with a detail pane for watching, done-when and the timeline. */
import { running } from "../../view-model/selectors";
import { sessionTime, timelineCopy } from "../../view-model/copy";
import { displayTitle } from "../../view-model/titles";
import { ago, elapsed } from "../../view-model/time";
import { executorLabel, taskStatus, taskOutcome } from "../../view-model/words";
import type { AttentionItem } from "../../attention/types";
import type { ClientTask } from "../../view-model/snapshot";
import { cols, flex, glyph, heading, span, statusSpans, wrap } from "../frame";
import type { Act, Item } from "../state";
import { blank, defined, empty, MARK, opAct, time, wrapAfter } from "./common";
import { errorRows, reviewDetail, reviewItem } from "./review";
import type { Row, ScreenCtx, ScreenView } from "./types";

const ACTIVE = new Set(["running", "queued"]);
export const attachable = (ctx: ScreenCtx, t: ClientTask) => !!t.session && t.session.host !== "none" && ctx.supports("task.attach");
const waitingForReview = (t: ClientTask) => !!t.reviewRequest && t.state === "done" && t.acceptanceState !== "failed" && !t.review && !t.dismissed && !t.resolved && !t.retriedBy;

export function recentlyEnded(ctx: Pick<ScreenCtx, "s" | "state" | "data">): ClientTask[] {
  const scope = ctx.state.scope;
  return [...new Map([...(ctx.data?.history?.value?.tasks??[]),...ctx.s.tasks].map(t=>[t.id,t])).values()].filter(t => !t.dismissed && !ACTIVE.has(t.state) && (scope === null || !t.repo || t.repo.key === scope))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function sessionItem(ctx: ScreenCtx, t: ClientTask): Item {
  const live = attachable(ctx, t), active = ACTIVE.has(t.state);
  const watch: Act | undefined = live ? { label: active ? "Watch" : "Replay", effect: { type: "attach", id: t.id, target: "here" } } : undefined;
  const terminal: Act | undefined = live ? { label: "Open in a terminal window", effect: { type: "attach", id: t.id, target: "terminal" } } : undefined;
  const tmux: Act | undefined = live ? { label: "Open in a tmux pane", effect: { type: "attach", id: t.id, target: "tmux" } } : undefined;
  const rev = typeof t.rev === "number" ? { expect_rev: t.rev } : {};
  const stop = active || t.state === "needs_input" ? opAct(ctx, "Stop", "task.stop", { id: t.id, ...rev }, { danger: true, confirm: { title: "Stop this session and its executor?", body: [displayTitle(t)], yes: "Stop" } }) : undefined;
  const review: Act | undefined = waitingForReview(t) ? { label: "Review", effect: { type: "navigate", screen: "review", id: t.id } } : undefined;
  const detail = ctx.data.details.get(t.id)?.value;
  const verdictItem = !active && !t.review && !t.resolved && !t.dismissed && !t.retriedBy ? reviewItem(ctx,{taskId:t.id,kind:waitingForReview(t)?"review":"failed",title:displayTitle(t)} as AttentionItem,t,detail) : undefined;
  const dismiss = !active ? opAct(ctx, "Dismiss", "task.dismiss", { ids: [t.id], ...rev }) : undefined;
  return {
    id: `session:${t.id}`, primary: watch ?? review,
    actions: [...defined([watch && review, terminal, tmux, stop, dismiss]),...(verdictItem?.actions??[])],
    keys: { ...verdictItem?.keys, ...(terminal ? { t: terminal } : {}), ...(tmux ? { m: tmux } : {}), ...(stop ? { s: stop } : {}), ...(dismiss ? { x: dismiss } : {}) },
  };
}

export function sessionsScreen(ctx: ScreenCtx): ScreenView {
  const { s, theme, now } = ctx, scope = { repo: ctx.state.scope };
  // As Review: the detail gets the larger share, so its prose is not clipped.
  const listWidth = ctx.wide ? 46 : ctx.width;
  const list: Row[] = [], items: Item[] = [];
  if(ctx.data.history?.error)list.push(...errorRows(ctx,ctx.data.history.error));
  const row = (t: ClientTask, timing: string) => {
    const item = sessionItem(ctx, t);
    items.push(item);
    if (ctx.wide) {
      // Beside the detail pane, a row is two lines (title and time, then status), so titles keep their room.
      const w = flex(listWidth - MARK, [{ weight: 1, min: 8 }, { fixed: 9 }]);
      list.push({ item: item.id, line: cols([
        { content: displayTitle(t), width: w[0]!, style: { bold: true } },
        { content: timing, width: w[1]!, align: "right", style: { fg: "muted" } },
      ], 2, theme) }, { item: item.id, cont: true, line: statusSpans(theme, taskStatus(t)) });
      return;
    }
    const w = flex(listWidth - MARK, [{ fixed: 20 }, { weight: 1, min: 8 }, { fixed: 9 }]);
    list.push({ item: item.id, line: cols([
      { content: statusSpans(theme, taskStatus(t)), width: w[0]! },
      { content: displayTitle(t), width: w[1]!, style: { bold: true } },
      { content: timing, width: w[2]!, align: "right", style: { fg: "muted" } },
    ], 2, theme) });
  };
  const active = running(s, scope);
  const queued = active.filter(t => t.state === "queued").length;
  list.push({ line: heading(theme, "Running", active.length - queued, queued ? `${queued} queued` : undefined) });
  if (!active.length) list.push(empty("No running sessions."));
  for (const t of active) row(t, t.state === "queued" ? "queued" : elapsed(now - (t.attemptStartedAt ?? t.updatedAt)));
  const ended = recentlyEnded(ctx);
  list.push(blank(), { line: heading(theme, "Completed", ended.length) });
  if (!ended.length) list.push(empty("No completed tasks."));
  for (const t of ended) row(t, time(ctx, t.updatedAt));

  if(ctx.data.history?.value?.next) {
    const more: Item={id:"history-more",primary:{label:"Load older tasks",effect:{type:"history-more"}},actions:[],keys:{}};
    items.push(more);list.push({item:more.id,line:[span("Load older tasks",{fg:"secondary"})]});
  }
  const all = [...active, ...ended];
  const selected = all.find(t => `session:${t.id}` === ctx.state.selected.sessions) ?? all[0];
  const detailWidth = ctx.wide ? ctx.width - listWidth - 3 : ctx.width - MARK;
  return {
    list, items, listWidth,
    detail: selected ? sessionDetail(ctx, selected, detailWidth) : [{ line: [span("Select a session.", { fg: "muted" })] }],
    needs: selected ? [selected.id] : [],
    hints: ctx.wide || !items.length || ctx.state.focus === "detail" ? [] : [`${glyph(theme, "→")} details`],
  };
}

function sessionDetail(ctx: ScreenCtx, t: ClientTask, width: number): Row[] {
  if (!ACTIVE.has(t.state)) return reviewDetail(ctx,{taskId:t.id,title:displayTitle(t),kind:waitingForReview(t)?"review":"failed"} as AttentionItem,ctx.data.details.get(t.id),width);
  const { theme, now } = ctx, resource = ctx.data.details.get(t.id), d = resource?.value;
  const dot = ` ${glyph(theme, "·")} `;
  const rows: Row[] = wrap(displayTitle(t), width, 2).map(line => ({ line: [span(line, { bold: true })] }));
  const started = d?.startedAt ?? t.attemptStartedAt;
  rows.push(...wrapAfter([...statusSpans(theme, taskStatus(t)), span(dot, { fg: "secondary" })], [executorLabel(t.executor), t.repo?.label, d?.branch, started ? `started ${time(ctx, started)}` : "Start time unknown"].filter(Boolean).join(dot), width, { fg: "secondary" }));
  const progress = t.progress;
  rows.push(...wrapAfter([], [sessionTime(t, now), progress ? `${progress.files} files · ${progress.commits} commits` : "", progress?.lastOutputAt != null ? (progress.phase === "idle" ? `idle ${elapsed(now - progress.lastOutputAt)}` : `output ${ago(progress.lastOutputAt, now)}`) : ""].filter(Boolean).join(dot), width, { fg: progress?.phase === "idle" ? "warn" : "muted" }));

  rows.push(blank(), { line: heading(theme, "Watch") });
  if (attachable(ctx, t)) {
    rows.push({ line: [span(glyph(theme, "⏎"), { bold: true }), span(" here   "), span("t", { bold: true }), span(" terminal window   "), span("m", { bold: true }), span(" tmux pane")] });
    rows.push({ line: [span(`pacer attach ${t.id}`, { fg: "secondary" })] });
    rows.push(...wrapAfter([], "Any terminal, tmux or SSH session works. Everyone sees the same stream.", width, { fg: "muted" }));
  } else rows.push(empty(t.session?.host === "none" || !t.session ? "This run is headless; its output is in the task log." : "Watching is not offered by this pacer service."));

  rows.push(blank(), { line: heading(theme, "Done when") });
  const acceptance = (d?.acceptance ?? (t as { acceptance?: { cmd?: string } }).acceptance);
  rows.push(acceptance?.cmd ? { line: [span(acceptance.cmd)] } : empty("No done-when command."));
  if (acceptance?.cmd) rows.push(...wrapAfter([], "pacer runs it after the executor exits, records the checks with the result.", width, { fg: "muted" }));

  rows.push(blank(), { line: heading(theme, "Timeline") });
  if (resource?.error && !d) rows.push(...errorRows(ctx, resource.error));
  else if (!d) rows.push({ line: [span(ctx.spinner ? `${ctx.spinner} Loading session…` : "Loading session…", { fg: "muted" })] });
  else {
    const timeline = timelineCopy(d.timeline ?? []);
    if (!timeline.length) rows.push(empty("No timeline events yet."));
    for (const entry of timeline.slice(-12)) rows.push({ line: [span(time(ctx, entry.at).padEnd(6), { fg: "muted" }), span(entry.text)] });
  }
  return rows;
}

