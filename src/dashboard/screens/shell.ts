/** The frame: top bar, planner strip, body panes, overlays, message line and key bar. */
import type { ClientSnapshot } from "../../view-model/snapshot";
import { counts, plannerMeter } from "../../view-model/selectors";
import { meterText } from "../../view-model/format";
import { agentInfo } from "../../view-model/agents";
import { modeWords, paceStatus, type StatusTone } from "../../view-model/words";
import { clock } from "../../view-model/time";
import { box, clip, fit, glyph, heading, lineWidth, meter, pad, paint, rule, span, statusSpans, toneRole, wrap, type Line, type PaintRow } from "../frame";
import { SCREEN_LABELS, selectedItem, type Item, type Overlay, type ScreenId, type UiState } from "../state";
import type { Style, TerminalTheme } from "../theme";
import { MARK, type UpdateState } from "./common";
import { homeScreen } from "./home";
import { reviewScreen } from "./review";
import { sessionsScreen } from "./sessions";
import { settingsScreen } from "./settings";
import { setupScreen } from "./setup";
import type { DashData, Row, ScreenCtx, ScreenView } from "./types";

export interface FrameInput {
  s: ClientSnapshot;
  now: number;
  theme: TerminalTheme;
  state: UiState;
  width: number;
  height: number;
  ops?: readonly string[];
  data: DashData;
  version: string;
  update?: UpdateState;
  /** live/local: the last read succeeded; offline: it failed after an earlier success. */
  connection: "live" | "local" | "connecting" | "offline";
  /** When the last successful read finished (seconds). Shown while offline. */
  readAt?: number;
  message?: { text: string; tone: StatusTone };
  /** Spinner frame for loading states; absent when motion is off. */
  spinner?: string;
  timeZone?: string;
}

export const MIN_WIDTH = 60, MIN_HEIGHT = 16, WIDE = 110, MAX_WIDTH = 160;
/** Fixed rows: top bar, planner strip, rule above; rule, message and key bar below. */
const CHROME = 6;

export function tabs(s: ClientSnapshot): ScreenId[] {
  return ["home", "review", "sessions", "settings", ...(s.setup && s.setup.ready === false ? ["setup" as const] : [])];
}
/** While setup is incomplete, work screens show Setup, as the app redirects them to #/setup. */
export function effectiveScreen(s: ClientSnapshot, screen: ScreenId): ScreenId {
  return s.setup && s.setup.complete === false && ["home", "review", "sessions"].includes(screen) ? "setup" : screen;
}

export function screenContext(input: FrameInput): ScreenCtx {
  const width = Math.min(MAX_WIDTH, Math.max(1, input.width)) - 2;
  const supports = (op: string) => input.ops === undefined || input.ops.includes(op);
  return { s: input.s, now: input.now, theme: input.theme, state: input.state, width, height: Math.max(1, input.height - CHROME), wide: input.width >= WIDE, supports, data: input.data, timeZone: input.timeZone, ...(input.spinner ? { spinner: input.spinner } : {}) };
}
export function screenView(input: FrameInput): { ctx: ScreenCtx; view: ScreenView; screen: ScreenId } {
  const ctx = screenContext(input), screen = effectiveScreen(input.s, input.state.screen);
  const build = { home: homeScreen, review: reviewScreen, sessions: sessionsScreen, settings: settingsScreen, setup: setupScreen }[screen];
  return { ctx, view: build({ ...ctx, state: { ...ctx.state, screen } }), screen };
}

function topBar(input: FrameInput, screen: ScreenId, width: number): Line {
  const { s, theme } = input, c = counts(s);
  const left: Line = [span(glyph(theme, "▬┃").slice(0, -1), { fg: "ink", bold: true }), span(glyph(theme, "▬┃").slice(-1), { fg: "accent", bold: true }), span(" pacer", { fg: "ink", bold: true }), span(" ")];
  const badge: Partial<Record<ScreenId, [number, StatusTone]>> = c ? { home: [c.attention, "warn"], review: [c.review, "warn"], sessions: [c.running, "info"] } : {};
  for (const tab of tabs(s)) {
    const label = SCREEN_LABELS[tab], active = tab === screen || tab === "setup" && screen === "setup";
    left.push(span("  "));
    if (active) left.push(span(`[ ${label} ]`, { fg: "focus", bold: true }));
    else left.push(span(label, { fg: "secondary" }));
    const [n, tone] = badge[tab] ?? [0, "neutral"];
    if (n > 0 && !active) left.push(span(theme.plain ? ` (${n})` : ` ${n}`, { fg: toneRole(tone), bold: true }));
    if (tab === "setup" && !active) left.push(span(" !", { fg: "warn", bold: true }));
  }
  // A quiet service keeps its snapshot time, so liveness follows the dashboard's own reads.
  const readAt = input.readAt ?? s.at;
  const live = input.connection === "connecting" ? `${glyph(theme, "○")} connecting`
    : input.connection === "local" ? `${glyph(theme, "○")} local ${clock(input.now, input.now, input.timeZone)}`
    : input.connection === "live" ? `${glyph(theme, "●")} live ${clock(input.now, input.now, input.timeZone)}`
    : `${glyph(theme, "○")} not responding${readAt > 0 ? ` ${glyph(theme, "·")} updated ${clock(readAt, input.now, input.timeZone)}` : ""}`;
  const scope = input.state.scope ? s.repos?.find(r => r.key === input.state.scope)?.label ?? input.state.scope : "All repos";
  const mode = s.mode?.mode ?? s.planner?.mode;
  const liveSpan = span(live, { fg: input.connection === "live" ? "good" : input.connection === "offline" ? "warn" : "muted" });
  const right: Line = width < 100 ? [liveSpan] : [span(scope, { fg: "secondary" }), ...(mode ? [span(` ${glyph(theme, "·")} `, { fg: "muted" }), span(modeWords(mode), { fg: mode === "normal" ? "secondary" : "warn" })] : []), span(` ${glyph(theme, "·")} `, { fg: "muted" }), liveSpan];
  return ends(left, right, width, theme);
}
function ends(left: Line, right: Line, width: number, theme: TerminalTheme): Line {
  const r = fit(right, Math.max(0, width - 10), theme), l = fit(left, Math.max(0, width - lineWidth(r) - 2), theme);
  return [...l, span(" ".repeat(Math.max(1, width - lineWidth(l) - lineWidth(r)))), ...r];
}
function plannerStrip(input: FrameInput, width: number): Line {
  const { s, theme } = input, p = plannerMeter(s);
  if (!p) return [span("Planner · waiting for service data", { fg: "muted" })];
  // As the app's top bar: the planner meter and verdict on every screen. Home adds the advice (UI-15).
  const status = paceStatus(p.verdict), wide = width >= 100;
  const name = wide ? `${agentInfo(p.agent).name} planner` : agentInfo(p.agent).name;
  const line: Line = [span(name, { bold: true }), span("  "), ...meter(theme, p.usedPct, p.pacePct, wide ? 20 : 12, status.tone), span("  "), span(meterText(p.usedPct, p.pacePct, "full"), { bold: true }), span("  "), ...statusSpans(theme, status)];
  const extra = [p.activeHoursLeft !== null ? `${Math.round(p.activeHoursLeft)} active-h` : "", p.resetsAt !== null ? `resets ${clock(p.resetsAt, input.now, input.timeZone)}` : "", p.stale ? "stale reading" : ""].filter(Boolean);
  if (extra.length) line.push(span(`  ${extra.join(` ${glyph(theme, "·")} `)}`, { fg: "secondary" }));
  return line;
}

/** Keep the selected row visible; mark cut-off content. */
function viewport(rows: PaintRow[], selected: number, height: number, theme: TerminalTheme): PaintRow[] {
  if (rows.length <= height) return rows;
  const offset = selected < height - 1 ? 0 : Math.min(rows.length - height + 1, selected - (height - 2));
  const visible = rows.slice(offset, offset + height);
  const more = (n: number, up: boolean): PaintRow => ({ line: [span(`${glyph(theme, up ? "↑" : "↓")} ${n} more`, { fg: "muted" })] });
  if (offset > 0) visible[0] = more(offset + 1, true);
  if (offset + height < rows.length) visible[height - 1] = more(rows.length - offset - height + 1, false);
  return visible;
}
function listRows(rows: Row[], selectedId: string | undefined, showSelection: boolean, theme: TerminalTheme, width: number): { rows: PaintRow[]; selected: number } {
  let selected = -1;
  const painted = rows.map((row, i): PaintRow => {
    const isSelected = showSelection && !!row.item && row.item === selectedId;
    if (!isSelected) return { line: [span(" ".repeat(MARK)), ...row.line] };
    if (!row.cont) selected = i;
    // Selection: a marker that survives NO_COLOR, plus the selection surface across the pane.
    const marker = row.cont ? span(" ".repeat(MARK)) : span(`${glyph(theme, "›")} `, { fg: "focus", bold: true });
    const line = pad([marker, ...row.line], width, theme);
    return { line: line.map(s => ({ ...s, style: { ...s.style, selected: true } })) };
  });
  return { rows: painted, selected: Math.max(0, selected) };
}

function overlayLines(input: FrameInput, overlay: Overlay, view: ScreenView, width: number, height: number): Line[] {
  const { theme } = input, w = Math.min(width, 72);
  switch (overlay.kind) {
    case "help": return box(theme, "Keyboard shortcuts", scrolled(theme, helpLines(input), overlay.scroll ?? 0, Math.max(3, height - 2)), w);
    case "confirm": return box(theme, overlay.title, [
      ...overlay.body.flatMap(text => wrap(text, w - 4).map(line => [span(line, { fg: "secondary" })])), [],
      [span("y", { bold: true }), span(` ${overlay.yes}`), ...(overlay.alt ? [span("   "), span(overlay.alt.key, { bold: true }), span(` ${overlay.alt.label}`)] : []), span("   "), span("n", { bold: true }), span(" Cancel")],
    ], w);
    case "menu": return box(theme, overlay.title, [...overlay.actions.map((a, i): Line => [span(i === overlay.index ? `${glyph(theme, "›")} ` : "  ", { fg: "focus", bold: true }), span(`${i + 1}`, { bold: true }), span(` ${a.label}`, a.danger ? { fg: "bad" } : {})]), [], [span("1-9 or ⏎ choose · Esc cancel", { fg: "muted" })]], w);
    case "prompt": return box(theme, overlay.spec.title, [
      [span(overlay.spec.label, { fg: "secondary" })],
      [span(`${glyph(theme, "›")} `, { fg: "focus" }), span(clip(overlay.value, w - 8)), span(theme.unicode ? "▌" : "_", { fg: "focus" })],
      ...(overlay.error ? [statusSpans(theme, { label: overlay.error, tone: "bad", glyph: "✕" })] : []),
      ...(overlay.spec.help ? [[span(overlay.spec.help, { fg: "muted" })]] : []),
      [], [span("⏎ submit · Esc cancel", { fg: "muted" })],
    ], w);
  }
}
/** Show `rows` from `scroll` within `room` lines, marking rows hidden above and below. */
function scrolled(theme: TerminalTheme, rows: Line[], scroll: number, room: number): Line[] {
  if (rows.length <= room) return rows;
  const offset = Math.max(0, Math.min(scroll, rows.length - (room - 1)));
  const up = offset > 0;
  let shown = room - (up ? 1 : 0);
  const down = offset + shown < rows.length;
  if (down) shown -= 1;
  const marker = (arrow: string, n: number): Line => [span(`${glyph(theme, arrow)} ${n} more · j k scroll`, { fg: "muted" })];
  return [...(up ? [marker("↑", offset)] : []), ...rows.slice(offset, offset + shown), ...(down ? [marker("↓", rows.length - offset - shown)] : [])];
}
/** Help rows: [keys, label, op that must be offered]. Rows whose op is absent are hidden (UI-13). */
type HelpRow = [string, string, string?];
const HELP: HelpRow[] = [
  ["TABS", "Switch screen"], [",", "Settings"], ["j k / ↑ ↓", "Select"], ["PgUp PgDn", "Page through a list"], ["⏎", "Primary action"], [".", "All actions for the row"],
  ["d", "Delegate a task", "task.delegate"], ["f", "Repo scope"], ["R / Ctrl-R", "Refresh"], ["?", "Keyboard shortcuts"], ["Esc", "Close or go back"], ["q", "Quit"],
];
const SCREEN_HELP: Partial<Record<ScreenId, HelpRow[]>> = {
  home: [["x", "Dismiss", "attention.dismiss"], ["v", "Open in Review"], ["b", "Block or unblock an executor", "runner.block"], ["t m", "Terminal window · tmux pane", "task.attach"], ["s", "Stop", "task.stop"]],
  review: [["a", "Accept and bring back", "task.review"], ["s", "Send back with a note", "task.review"], ["r", "Reject with a note", "task.review"], ["t", "Retry on another executor", "task.review"], ["o", "Show worktree path"]],
  sessions: [["⏎", "Watch here", "task.attach"], ["t", "Open in a terminal window", "task.attach"], ["m", "Open in a tmux pane", "task.attach"], ["s", "Stop", "task.stop"], ["x", "Dismiss", "task.dismiss"]],
  settings: [["⏎ / →", "Open a section"], ["← →", "Adjust a value"], ["Esc", "Back to sections"]],
  setup: [["⏎", "Run the selected step"], ["x", "Skip first delegation", "onboarding.skip"]],
};
function helpLines(input: FrameInput): Line[] {
  const screen = effectiveScreen(input.s, input.state.screen);
  const offered = (op?: string) => !op || input.ops === undefined || input.ops.includes(op);
  const switchKeys = `1-${tabs(input.s).length} / Tab Shift-Tab`;
  const group = (title: string, rows: HelpRow[]): Line[] => [heading(input.theme, title), ...rows.filter(([, , op]) => offered(op)).map(([k, label]): Line => {
    const keys = k === "TABS" ? switchKeys : k;
    return [span(keys.padEnd(Math.max(12, keys.length + 2)), { bold: true }), span(label, { fg: "secondary" })];
  })];
  return [...group("Anywhere", HELP), [], ...group(SCREEN_LABELS[screen], SCREEN_HELP[screen] ?? [])];
}

function keyBar(input: FrameInput, item: Item | undefined, view: ScreenView, screen: ScreenId, width: number): Line {
  const { theme } = input, groups: Line[] = [];
  const add = (key: string, label: string) => { groups.push([span(key, { bold: true }), span(` ${label}`, { fg: "secondary" })]); };
  const listFocus = screen === "settings" && input.state.focus === "list";
  const enter = glyph(theme, "⏎");
  if (listFocus) { add(enter, "open section"); add("j k", "sections"); }
  else if (item) {
    if (item.primary) add(enter, item.primary.label);
    // Arrow keys are summarised by the screen hint ("← → adjust").
    for (const [key, act] of Object.entries(item.keys)) if (act !== item.primary && key !== "left" && key !== "right") add(key, act.label.toLowerCase());
    const more = item.actions.length;
    if (more) add(".", `actions (${more + (item.primary ? 1 : 0)})`);
  }
  for (const hint of view.hints ?? []) { const [key, ...label] = hint.split(" "); add(key!, label.join(" ")); }
  const help: Line = [span("?", { bold: true }), span(" help", { fg: "secondary" })];
  // Only a known state is claimed; before a check the footer shows the version alone.
  const words: Partial<Record<UpdateState, [string, Style]>> = {
    available: ["update available", { fg: "warn", bold: true }], current: ["up to date", { fg: "muted" }],
    disabled: ["update checks off", { fg: "muted" }], failed: ["update check failed", { fg: "warn" }],
  };
  const known = input.update ? words[input.update] : undefined;
  const version = span(`pacer ${input.version}`, { fg: "muted" });
  // Narrow terminals keep one item: the version, unless there is something to notice.
  const right: Line = !known ? [version]
    : width >= 100 ? [version, span(` ${glyph(theme, "·")} `, { fg: "muted" }), span(known[0], known[1])]
    : input.update === "current" ? [version] : [span(known[0], known[1])];
  // Drop whole hints from the end, never the first (the primary) or "? help", so no key is shown cut in half.
  const room = width - lineWidth(right) - 2, join = (list: Line[]) => list.flatMap((g, i) => i ? [span("  "), ...g] : g);
  while (groups.length > 1 && lineWidth(join([...groups, help])) > room) groups.splice(groups.length - 1, 1);
  return ends(join([...groups, help]), right, width, theme);
}

/** Render the whole frame as terminal text. Pure. */
export function renderFrame(input: FrameInput): string {
  const { theme } = input;
  const width = Math.max(1, Math.floor(input.width)), height = Math.max(1, Math.floor(input.height));
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    // Wrapped, not clipped, so "q quits" always shows; only a terminal too short for every line drops some.
    const lines = [...wrap(`Make the terminal at least ${MIN_WIDTH}×${MIN_HEIGHT} to use pacer dashboard.`, width), "q quits."];
    const shown = lines.length > height ? [...lines.slice(0, Math.max(0, height - 1)), "q quits."].slice(-height) : lines;
    const top = Math.max(0, Math.floor((height - shown.length) / 2));
    return paint(theme, Array.from({ length: height }, (_, i) => ({ line: i >= top && i < top + shown.length ? [span(clip(shown[i - top]!, width, theme.unicode ? "…" : "..."))] : [] })), width);
  }
  const { ctx, view, screen } = screenView(input);
  const inner = ctx.width, bodyHeight = ctx.height, state = input.state;
  const items = view.items, item = selectedItem({ ...state, screen }, items, view.initial);
  const showSelection = screen !== "settings" || state.focus === "detail";
  const out: PaintRow[] = [
    { line: [span(" "), ...topBar(input, screen, inner)] },
    { line: [span(" "), ...fit(plannerStrip(input, inner), inner, theme)] },
    { line: [span(" "), ...rule(theme, inner)] },
  ];
  let body: PaintRow[];
  if (view.detail && ctx.wide) {
    const listWidth = view.listWidth ?? 44, detailWidth = inner - listWidth - 3;
    const listSelected = screen === "settings" ? `section:${state.section}` : item?.id;
    const listPainted = listRows(view.list, listSelected, screen === "settings" ? state.focus === "list" : true, theme, listWidth);
    if (screen === "settings" && state.focus === "detail") listPainted.selected = Math.max(0, view.list.findIndex(r => r.item === listSelected));
    const left = viewport(listPainted.rows, listPainted.selected, bodyHeight, theme);
    const detailPainted = screen === "settings"
      ? listRows(view.detail, item?.id, showSelection, theme, detailWidth)
      : { rows: view.detail.slice(state.scroll).map((r): PaintRow => ({ line: r.line })), selected: 0 };
    const right = viewport(detailPainted.rows, detailPainted.selected, bodyHeight, theme);
    body = Array.from({ length: bodyHeight }, (_, i) => ({
      line: [...pad(left[i]?.line ?? [], listWidth, theme), span(` ${glyph(theme, "│")} `, { fg: "line" }), ...fit(right[i]?.line ?? [], detailWidth, theme)],
    }));
  } else if (view.detail && state.focus === "detail") {
    if (screen === "settings") {
      const painted = listRows(view.detail, item?.id, true, theme, inner);
      body = viewport(painted.rows, painted.selected, bodyHeight, theme);
    } else body = viewport(view.detail.slice(state.scroll).map((r): PaintRow => ({ line: [span(" ".repeat(MARK)), ...r.line] })), 0, bodyHeight, theme);
  } else {
    const painted = screen === "settings"
      ? listRows(view.list, `section:${state.section}`, true, theme, inner)
      : listRows(view.list, item?.id, showSelection, theme, inner);
    body = viewport(painted.rows, painted.selected, bodyHeight, theme);
  }
  while (body.length < bodyHeight) body.push({ line: [] });
  if (state.overlay) {
    const lines = overlayLines(input, state.overlay, view, inner, bodyHeight);
    const top = Math.max(0, Math.floor((bodyHeight - lines.length) / 3)), left = Math.max(0, Math.floor((inner - lineWidth(lines[0] ?? [])) / 2));
    lines.slice(0, bodyHeight).forEach((line, i) => { body[top + i] = { line: [span(" ".repeat(left)), ...line] }; });
  }
  out.push(...body.slice(0, bodyHeight).map(row => ({ ...row, line: [span(" "), ...fit(row.line, inner, theme)] })));
  out.push({ line: [span(" "), ...rule(theme, inner)] });
  const message = input.message ? statusSpans(theme, { label: input.message.text, tone: input.message.tone, glyph: input.message.tone === "bad" ? "✕" : input.message.tone === "warn" ? "!" : input.message.tone === "good" ? "✓" : "·" }) : [];
  out.push({ line: [span(" "), ...fit(message, inner, theme)] });
  out.push({ line: [span(" "), ...keyBar(input, item, view, screen, inner)] });
  return paint(theme, out.slice(0, height), width);
}
