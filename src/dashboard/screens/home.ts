/** Home: the app's Overview — Needs you, Running, Capacity, Done today, in that order. */
import { capacity, counts, doneToday, needsYou, otherReposNeedingYou, reviewQueue, running } from "../../view-model/selectors";
import { attentionStatus, taskStatus, taskOutcome } from "../../view-model/words";
import { executorEligibility, executorPace, queueWait } from "../../view-model/capacity";
import { displayTitle } from "../../view-model/titles";
import { ago, elapsed } from "../../view-model/time";
import type { ClientTask } from "../../view-model/snapshot";
import { cols, flex, glyph, heading, meter, span, statusSpans, wrap, type Line } from "../frame";
import type { Act, Item } from "../state";
import { blank, defined, empty, executorName, GAP, MARK, opAct, serviceAct, time } from "./common";
import type { Row, ScreenCtx, ScreenView } from "./types";

export function homeScreen(ctx: ScreenCtx): ScreenView {
  const { s, theme } = ctx, scope = { repo: ctx.state.scope };
  const rows: Row[] = [], items: Item[] = [];
  const width = ctx.width - MARK, wide = ctx.width >= 100;
  const add = (item: Item, line: Line) => { items.push(item); rows.push({ line, item: item.id }); };
  const c = counts(s);

  // The planner answer leads the screen, as the app's Overview strip.
  if (s.planner?.advice) rows.push({ line: [span(s.planner.advice, { bold: true })] }, blank());

  // NEEDS YOU
  const attention = needsYou(s, scope), others = otherReposNeedingYou(s, scope);
  rows.push({ line: heading(theme, "Needs you", attention.length, others ? `+${others} in other repos` : undefined) });
  if (!attention.length) rows.push(empty("Nothing needs you."));
  const reviewIds = new Set(reviewQueue(s).map(a => a.taskId));
  for (const a of attention) {
    const task = s.tasks.find(t => t.id === a.taskId);
    // As the app: the task's complete title, else the attention item's own. Titles get the larger share of the row.
    const title = task?.fullTitle?.trim() || (a as { fullTitle?: string }).fullTitle?.trim() || a.title;
    const acts = defined(a.actions.map(action => serviceAct(ctx, action, title)));
    const dismiss = opAct(ctx, "Dismiss", "attention.dismiss", { id: a.id });
    const review: Act | undefined = a.kind === "review" && a.taskId ? { label: "Review changes", effect: { type: "navigate", screen: "review", id: a.taskId } } : undefined;
    const item: Item = { id: `attention:${a.id}`, primary: acts[0], actions: [...acts.slice(1), ...defined([review, dismiss])], keys: { ...(dismiss ? { x: dismiss } : {}), ...(review ? { v: review } : {}) } };
    const w = wide ? flex(width, [{ fixed: 20 }, { weight: 3, min: 16 }, { fixed: 10 }, { weight: 2, min: 10 }, { fixed: 5 }]) : flex(width, [{ fixed: 20 }, { weight: 1, min: 12 }, { weight: 1, min: 8 }]);
    const cells = wide
      ? [{ content: statusSpans(theme, attentionStatus(a, s.tasks)), width: w[0]! }, { content: title, width: w[1]!, style: { bold: true } }, { content: a.repo?.label ?? "", width: w[2]!, style: { fg: "muted" as const } }, { content: a.detail, width: w[3]!, style: { fg: "secondary" as const } }, { content: time(ctx, a.raisedAt), width: w[4]!, align: "right" as const, style: { fg: "muted" as const } }]
      : [{ content: statusSpans(theme, attentionStatus(a, s.tasks)), width: w[0]! }, { content: title, width: w[1]!, style: { bold: true } }, { content: a.detail, width: w[2]!, style: { fg: "secondary" as const } }];
    add(item, cols(cells, GAP, theme));
  }

  // RUNNING
  rows.push(blank());
  const active = running(s, scope), queued = active.filter(t => t.state === "queued").length;
  const runningCount = ctx.state.scope ? c?.byRepo?.[ctx.state.scope]?.running ?? active.length - queued : c?.running ?? active.length - queued;
  rows.push({ line: heading(theme, "Running", runningCount, queued ? `${queued} queued` : undefined) });
  if (!active.length) rows.push(empty("Nothing running. Delegate a task, or ask your planner to."));
  for (const t of active) {
    const [first, second] = runningLines(ctx, t, width, wide), item = taskItem(ctx, t);
    add(item, first);
    rows.push({ line: second, item: item.id, cont: true });
  }

  // CAPACITY
  rows.push(blank());
  const executors = capacity(s);
  rows.push({ line: heading(theme, "Capacity", c ? `${c.ready}/${c.executors}` : executors.length, c ? "executors ready" : "executors", false) });
  if (!executors.length) rows.push(empty("No executors yet. Add one in Settings › Executors."));
  else {
    const w = capacityWidths(width, wide);
    rows.push({ line: [...cols(wide ? [{ content: "#", width: w[0]! }, { content: "EXECUTOR", width: w[1]! }, { content: "STATUS", width: w[2]! }, { content: "", width: w[3]! }, { content: "PACE", width: w[4]! }, { content: "USAGE", width: w[5]! }, { content: "USED", width: w[6]!, align: "right" }, { content: "TASKS", width: w[7]!, align: "right" }] : [{ content: "#", width: w[0]! }, { content: "EXECUTOR", width: w[1]! }, { content: "STATUS", width: w[2]! }, { content: "USED", width: w[3]!, align: "right" }, { content: "TASKS", width: w[4]!, align: "right" }], GAP, theme).map(x => ({ ...x, style: { fg: "muted" as const } }))] });
  }
  for (const e of executors) {
    const planner = e.rank === "planner";
    const block = planner ? undefined : opAct(ctx, e.state === "blocked" ? "Unblock" : "Block", e.state === "blocked" ? "runner.unblock" : "runner.block", { id: e.id });
    const open: Act = { label: "Open in Settings", effect: { type: "navigate", screen: "settings", section: "executors", id: `executor:${e.id}` } };
    const item: Item = { id: `executor:${e.id}`, primary: open, actions: defined([block]), keys: block ? { b: block } : {} };
    const off = ["down", "failing", "disabled", "blocked", "exhausted"].includes(e.state) || !e.enabled;
    const pace = executorPace(e, s), status = executorEligibility(e, ctx.now), w = capacityWidths(width, wide);
    const used = e.usedPct === null ? "—" : `${Math.round(e.usedPct)}%`, slots = `${e.slots.used}/${e.slots.max}`;
    const name = executorName(theme, e.id, s.accounts?.map(a => ({ name: a.name, runners: a.executors, source: a.source })));
    const muted = off ? { fg: "muted" as const } : undefined;
    const line = wide
      ? cols([
        { content: planner ? "P" : String(e.rank), width: w[0]!, style: { fg: "muted" } },
        { content: name, width: w[1]! },
        { content: statusSpans(theme, status), width: w[2]! },
        { content: e.next ? "next" : "", width: w[3]!, style: { fg: "info", bold: true } },
        { content: `${pace.label}${e.reason ?? e.paceReason ? ` · ${e.reason ?? e.paceReason}` : ""}`, width: w[4]!, style: { fg: "secondary" } },
        { content: e.paceReason === "unmetered" ? [span("unmetered", { fg: "muted" })] : meter(theme, e.usedPct, e.pacePct, w[5]!, pace.tone), width: w[5]! },
        { content: used, width: w[6]!, align: "right", ...(muted ? { style: muted } : {}) },
        { content: slots, width: w[7]!, align: "right", ...(muted ? { style: muted } : {}) },
      ], GAP, theme)
      : cols([
        { content: planner ? "P" : String(e.rank), width: w[0]!, style: { fg: "muted" } },
        { content: name, width: w[1]! },
        { content: statusSpans(theme, status), width: w[2]! },
        { content: used, width: w[3]!, align: "right" },
        { content: slots, width: w[4]!, align: "right" },
      ], GAP, theme);
    add(item, line);
    if (e.eligibility || e.stale) {
      const detail = [e.stale ? "Historical usage" : null, status.detail, status.age].filter(Boolean).join(" · ");
      for (const text of wrap(detail, width)) rows.push({ item: item.id, cont: true, line: [span(text, { fg: "secondary" })] });
    }
  }

  // DONE TODAY
  rows.push(blank());
  const done = doneToday(s, scope), today = s.today;
  rows.push({ line: heading(theme, "Done today", today?.done ?? done.length, today ? `${today.accepted} accepted` : undefined) });
  if (!done.length) rows.push(empty("Nothing finished yet today."));
  for (const t of done) {
    const item=doneItem(ctx,t,reviewIds.has(t.id));
    add(item,doneLine(ctx,t,width,wide));
    if(t.review)rows.push({item:item.id,cont:true,line:statusSpans(theme,taskOutcome(t))});
  }

  return { list: rows, items, hints: ["f repo scope", "d delegate"] };
}

function capacityWidths(width: number, wide: boolean): number[] {
  return wide
    ? flex(width, [{ fixed: 2 }, { fixed: 26 }, { fixed: 22 }, { fixed: 4 }, { weight: 1, min: 12 }, { fixed: 14 }, { fixed: 4 }, { fixed: 5 }])
    : flex(width, [{ fixed: 2 }, { weight: 1, min: 12 }, { fixed: 22 }, { fixed: 4 }, { fixed: 5 }]);
}

/** Running rows: Watch when a session can be attached, otherwise open the session details. Stop always confirms. */
export function taskItem(ctx: ScreenCtx, t: ClientTask): Item {
  const attachable = !!t.session && t.session.host !== "none" && ctx.supports("task.attach");
  const details: Act = { label: "Open in Tasks", effect: { type: "navigate", screen: "sessions", id: t.id } };
  const watch: Act | undefined = attachable ? { label: "Watch", effect: { type: "attach", id: t.id, target: "here" } } : undefined;
  const terminal: Act | undefined = attachable ? { label: "Open in a terminal window", effect: { type: "attach", id: t.id, target: "terminal" } } : undefined;
  const tmux: Act | undefined = attachable ? { label: "Open in a tmux pane", effect: { type: "attach", id: t.id, target: "tmux" } } : undefined;
  const conversation = t.interactionMode === "conversation" && ctx.supports("session.end");
  const stop = opAct(ctx, conversation ? "End session" : "Stop", conversation ? "session.end" : "task.stop", { id: t.id, ...(typeof t.rev === "number" ? { expect_rev: t.rev } : {}) },
    { danger: true, confirm: { title: "Stop this session and its executor?", body: [displayTitle(t)], yes: "Stop" } });
  return {
    id: `task:${t.id}`, primary: watch ?? details,
    actions: defined([watch ? details : undefined, terminal, tmux, stop]),
    keys: { ...(terminal ? { t: terminal } : {}), ...(tmux ? { m: tmux } : {}), ...(stop ? { s: stop } : {}) },
  };
}
function doneItem(ctx: ScreenCtx, t: ClientTask, waiting: boolean): Item {
  const review: Act | undefined = waiting ? { label: "Review", effect: { type: "navigate", screen: "review", id: t.id } } : undefined;
  const details: Act = { label: "Open in Tasks", effect: { type: "navigate", screen: "sessions", id: t.id } };
  const dismiss = opAct(ctx, "Dismiss", "task.dismiss", { ids: [t.id], ...(typeof t.rev === "number" ? { expect_rev: t.rev } : {}) });
  return { id: `task:${t.id}`, primary: review ?? details, actions: defined([review ? details : undefined, dismiss]), keys: dismiss ? { x: dismiss } : {} };
}

/** Two lines, as the app's rows: status, title, repo and executor; then timing, changes and output. */
export function runningLines(ctx: ScreenCtx, t: ClientTask, width: number, wide: boolean): [Line, Line] {
  const { s, now, theme } = ctx, queued = t.state === "queued";
  const last = t.progress?.lastOutputAt;
  const idle = t.progress?.phase === "idle" && last != null;
  const started = t.attemptStartedAt ?? t.updatedAt;
  const status = statusSpans(theme, taskStatus(t));
  const w = wide ? flex(width, [{ fixed: 16 }, { weight: 1, min: 14 }, { fixed: 12 }, { fixed: 24 }]) : flex(width, [{ fixed: 16 }, { weight: 1, min: 10 }, { fixed: 18 }]);
  const name = executorName(theme, t.executor, s.accounts?.map(a => ({ name: a.name, runners: a.executors, source: a.source })));
  const first = cols(wide
    ? [{ content: status, width: w[0]! }, { content: displayTitle(t), width: w[1]!, style: { bold: true } }, { content: t.repo?.label ?? "", width: w[2]!, style: { fg: "muted" } }, { content: name, width: w[3]! }]
    : [{ content: status, width: w[0]! }, { content: displayTitle(t), width: w[1]!, style: { bold: true } }, { content: name, width: w[2]! }], GAP, theme);
  const dot = ` ${glyph(theme, "·")} `;
  const meta: Line = queued
    ? [span(queueWait(t, s), { fg: "secondary" })]
    : [
      span(`running ${elapsed(now - started)}`, { fg: "secondary" }),
      span(dot, { fg: "muted" }),
      span(t.progress ? `${t.progress.files} files · ${t.progress.commits} commits` : "Changes and output pending", { fg: "secondary" }),
      ...(t.progress ? [span(dot, { fg: "muted" }), last == null ? span("output pending", { fg: "muted" }) : idle ? span(`idle ${elapsed(now - last)}`, { fg: "warn", bold: true }) : span(`output ${ago(last, now)}`, { fg: "secondary" })] : []),
    ];
  return [first, [span(" ".repeat(w[0]! + GAP)), ...meta]];
}
function doneLine(ctx: ScreenCtx, t: ClientTask, width: number, wide: boolean): Line {
  const { theme, s } = ctx;
  const status = statusSpans(theme, taskStatus(t));
  const ran = t.attemptStartedAt == null ? "" : `ran ${elapsed(t.updatedAt - t.attemptStartedAt)}`;
  if (!wide) {
    const w = flex(width, [{ fixed: 5 }, { fixed: 20 }, { weight: 1, min: 10 }]);
    return cols([{ content: time(ctx, t.updatedAt), width: w[0]!, style: { fg: "muted" } }, { content: status, width: w[1]! }, { content: displayTitle(t), width: w[2]!, style: { bold: true } }], GAP, theme);
  }
  const w = flex(width, [{ fixed: 5 }, { fixed: 20 }, { weight: 1, min: 14 }, { fixed: 12 }, { fixed: 24 }, { fixed: 10 }]);
  const name = executorName(theme, t.executor, s.accounts?.map(a => ({ name: a.name, runners: a.executors, source: a.source })));
  return cols([
    { content: time(ctx, t.updatedAt), width: w[0]!, style: { fg: "muted" } },
    { content: status, width: w[1]! },
    { content: displayTitle(t), width: w[2]!, style: { bold: true } },
    { content: t.repo?.label ?? "", width: w[3]!, style: { fg: "muted" } },
    { content: name, width: w[4]! },
    { content: ran, width: w[5]!, style: { fg: "muted" } },
  ], GAP, theme);
}
