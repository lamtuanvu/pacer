/** Review: the queue on the left, the selected task's evidence and verdict on the right. */
import type { AttentionItem } from "../../attention/types";
import { reviewQueue } from "../../view-model/selectors";
import { costCopy, reasonCopy } from "../../view-model/copy";
import { displayTitle } from "../../view-model/titles";
import { elapsed } from "../../view-model/time";
import { executorLabel, taskStatus, type Status } from "../../view-model/words";
import type { ClientTask } from "../../view-model/snapshot";
import { box, cols, flex, glyph, heading, span, statusSpans, wrap, type Line } from "../frame";
import type { Act, Item } from "../state";
import { blank, defined, empty, GAP, MARK, time } from "./common";
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
  const accept: Act = { label: "Accept and bring back", effect: verdict("Accepted", "accept"), confirm: { title: `Accept "${title}"?`, body: ["Accept records the verdict; you merge the branch."], yes: "Accept" } };
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
    id: `review:${id}`, actions: defined([sendBack, reject, retry, path]),
    keys: { a: accept, s: sendBack, r: reject, ...(retry ? { t: retry } : {}), ...(path ? { o: path } : {}) },
  };
}

export function reviewScreen(ctx: ScreenCtx): ScreenView {
  const { s, theme } = ctx, queue = scopedReviewQueue(ctx);
  const listWidth = ctx.wide ? 46 : ctx.width;
  const list: Row[] = [{ line: heading(theme, "Review queue", queue.length) }];
  const items: Item[] = [];
  for (const a of queue) {
    const task = s.tasks.find(t => t.id === a.taskId), detail = ctx.data.details.get(a.taskId!)?.value;
    const item = reviewItem(ctx, a, task, detail);
    items.push(item);
    const w = flex(listWidth - MARK, [{ fixed: 1 }, { weight: 1, min: 8 }, { fixed: 5 }], 1);
    list.push({ item: item.id, line: cols([
      { content: statusSpans(theme, { ...taskStatus(task ?? { state: "done" }), label: "" }).map(x => ({ ...x, text: x.text.trimEnd() })), width: w[0]! },
      { content: task ? displayTitle(task) : a.title, width: w[1]!, style: { bold: true } },
      { content: time(ctx, a.raisedAt), width: w[2]!, align: "right", style: { fg: "muted" } },
    ], 1, theme) });
  }
  const today = s.today;
  if (!queue.length) list.push(empty("Review queue is clear"));
  list.push(blank());
  for (const text of wrap(`Accepted today ${today?.accepted ?? 0} · rejected ${today?.rejected ?? 0}. Your verdicts teach routing which executor suits which kind.`, listWidth - MARK)) list.push({ line: [span(text, { fg: "muted" })] });

  const selectedId = ctx.state.selected.review ?? items[0]?.id;
  const selected = queue.find(a => `review:${a.taskId}` === selectedId) ?? queue[0];
  const detailWidth = ctx.wide ? ctx.width - listWidth - 3 : ctx.width - MARK;
  const detail = selected ? reviewDetail(ctx, selected, ctx.data.details.get(selected.taskId!), detailWidth) : [{ line: [span("Select a task to review.", { fg: "muted" })] }];
  return {
    list, detail, listWidth, items, needs: selected?.taskId ? [selected.taskId] : [],
    hints: ctx.wide ? [] : [`${glyph(theme, "→")} details`],
  };
}

function loadingRow(ctx: ScreenCtx, text: string): Row {
  return { line: [span(ctx.spinner ? `${ctx.spinner} ${text}` : text, { fg: "muted" })] };
}
export function errorRows(ctx: ScreenCtx, error: NonNullable<Resource<unknown>["error"]>): Row[] {
  return [{ line: statusSpans(ctx.theme, { label: `${error.message}${error.hint ? ` (${error.hint})` : ""}`, tone: "bad", glyph: "✕" }) }, { line: [span("R retries", { fg: "muted" })] }];
}

function reviewDetail(ctx: ScreenCtx, a: AttentionItem, resource: Resource<TaskDetail> | undefined, width: number): Row[] {
  const { theme, s, now } = ctx, task = s.tasks.find(t => t.id === a.taskId), d = resource?.value;
  const title = task ? displayTitle(task) : d ? displayTitle(d) : a.title;
  const rows: Row[] = [];
  for (const line of wrap(title, width, 2)) rows.push({ line: [span(line, { bold: true })] });
  const status = taskStatus(d ?? task ?? { state: "done" });
  const executor = d?.executor ?? task?.executor ?? a.executor;
  const ran = d?.startedAt && d.endedAt ? `ran ${elapsed(d.endedAt - d.startedAt)}` : task?.attemptStartedAt ? `ran ${elapsed(task.updatedAt - task.attemptStartedAt)}` : "";
  const branch = d?.branch ? `${d.branch}${d.base ? ` ${glyph(theme, "→")} ${d.base}` : ""}` : "";
  const dot = ` ${glyph(theme, "·")} `;
  rows.push({ line: [...statusSpans(theme, status), span([executorLabel(executor), ran, branch].filter(Boolean).map(x => dot + x).join(""), { fg: "secondary" })] });
  const finished = d?.endedAt ?? task?.updatedAt;
  rows.push({ line: [span([a.repo?.label ?? task?.repo?.label, finished ? `finished ${time(ctx, finished)}` : ""].filter(Boolean).join(` ${glyph(theme, "·")} `), { fg: "muted" })] });
  if (resource?.loading && !d) return [...rows, blank(), loadingRow(ctx, "Loading task…")];
  if (resource?.error && !d) {
    const removed = /worktree/i.test(resource.error.message) && /removed|missing|not found/i.test(resource.error.message);
    return [...rows, blank(), ...(removed ? [{ line: statusSpans(theme, { label: "Changes unavailable · the worktree was removed after the task finished", tone: "warn", glyph: "!" }) }] : errorRows(ctx, resource.error))];
  }
  if (!d) return [...rows, blank(), loadingRow(ctx, "Loading task…")];
  if (resource?.loading) rows.push({ line: [span("Updating…", { fg: "muted" })] });

  // Done when
  rows.push(blank());
  const acc = d.acceptance ?? (task as { acceptance?: TaskDetail["acceptance"] } | undefined)?.acceptance;
  const doneWhen: Line[] = acc?.cmd
    ? [[span(acc.cmd)], [...statusSpans(theme, ACCEPTANCE[acc.state ?? ""] ?? { label: "No done-when command", tone: "neutral", glyph: "?" }), span([acc.summary, acc.durationS != null ? `checks ran ${acc.durationS} s` : "", acc.machine ? `run by pacer on ${acc.machine}` : ""].filter(Boolean).map(x => ` ${glyph(theme, "·")} ${x}`).join(""), { fg: "secondary" })]]
    : [[span("No done-when command", { fg: "muted" })]];
  rows.push(...box(theme, "Done when", doneWhen, width).map(line => ({ line })));

  // Why this executor
  const why: Line[] = [[span(reasonCopy(d.routing?.why))], ...(d.routing?.skipped ?? []).slice(0, 3).map((x): Line => [span(`Skipped ${executorLabel(x.executor)}: ${reasonCopy(x.reason)}`, { fg: "secondary" })])];
  if (d.cost?.executor) why.push([span(`Cost: ${costCopy(d.cost.executor ?? null)}`, { fg: "secondary" })]);
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

  // Executor summary
  rows.push(blank(), { line: heading(theme, "Executor summary") });
  for (const line of wrap(d.summary?.trim() || "No summary provided", width, 6)) rows.push({ line: [span(line, { fg: d.summary ? "ink" : "muted" })] });

  // Verdict
  rows.push(blank());
  const can = ctx.supports("task.review");
  const keys: Line = can
    ? [span("a", { bold: true }), span(" Accept and bring back", { fg: "ink", bold: true }), span("   s", { bold: true }), span(" Send back", { fg: "secondary" }), span("   r", { bold: true }), span(" Reject", { fg: "bad" }), ...((d.retryOptions ?? []).some(o => o.state === "ready") ? [span("   t", { bold: true }), span(" Retry on another executor", { fg: "secondary" })] : [])]
    : [span("This pacer service does not offer reviews here. Use pacer review " + d.id + ".", { fg: "muted" })];
  rows.push(...box(theme, "Your verdict", [keys, [span("Accept records the verdict; you merge the branch.", { fg: "muted" })]], width).map(line => ({ line })));
  void now;
  return rows;
}
