/** The frame: top bar, planner strip, body panes, overlays, message line and key bar. */
import type { ClientSnapshot } from "../../view-model/snapshot";
import { counts, plannerMeter } from "../../view-model/selectors";
import { agentInfo } from "../../view-model/agents";
import { compactPolicyWords, policyWords, modeWords, paceStatus, type StatusTone } from "../../view-model/words";
import { clock } from "../../view-model/time";
import { captionReset, usageView } from "../../view-model/usage";
import { box, clip, clipEnd, fit, glyph, heading, lineWidth, meter, pad, paint, rule, span, statusSpans, toneRole, wrap, type Line, type PaintRow } from "../frame";
import { QUESTION_ANSWER_MAX, QUESTION_NOTE_MAX } from "./answer-encoding";
import { SCREEN_KEYS, SCREEN_LABELS, selectedItem, type Item, type Overlay, type ScreenId, type UiState } from "../state";
import type { Style, TerminalTheme } from "../theme";
import { MARK, type UpdateState } from "./common";
import { homeScreen } from "./home";
import { reviewScreen } from "./review";
import { runsScreen } from "./runs";
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
  return ["home", "review", "sessions", "runs", "settings", ...(s.setup && s.setup.ready === false ? ["setup" as const] : [])];
}
/** While setup is incomplete and the install is not yet onboarded, work screens show Setup, as the app redirects them to #/setup. */
export function effectiveScreen(s: ClientSnapshot, screen: ScreenId, ops?: readonly string[]): ScreenId {
  if (screen === "sessions" && ops?.includes("session.create")) return screen;
  const open = s.setup && !(s.setup.onboarded || s.setup.complete);
  return open && ["home", "review", "sessions", "runs"].includes(screen) ? "setup" : screen;
}

export function screenContext(input: FrameInput): ScreenCtx {
  const width = Math.min(MAX_WIDTH, Math.max(1, input.width)) - 2;
  const supports = (op: string) => {
    if (input.ops === undefined) {
      if (op.startsWith("run.") || op.startsWith("question.")) return false;
      return true;
    }
    return input.ops.includes(op);
  };
  return { s: input.s, now: input.now, theme: input.theme, state: input.state, width, height: Math.max(1, input.height - CHROME), wide: input.width >= WIDE, supports, data: input.data, timeZone: input.timeZone, ...(input.spinner ? { spinner: input.spinner } : {}) };
}
export function screenView(input: FrameInput): { ctx: ScreenCtx; view: ScreenView; screen: ScreenId } {
  const ctx = screenContext(input), screen = effectiveScreen(input.s, input.state.screen, input.ops);
  const build = { home: homeScreen, review: reviewScreen, sessions: sessionsScreen, runs: runsScreen, settings: settingsScreen, setup: setupScreen }[screen];
  return { ctx, view: build({ ...ctx, state: { ...ctx.state, screen } }), screen };
}

/** Unambiguous short forms when the bar is tight (bare "N"/"T"/"S" collide). */
const SHORT_LABELS: Partial<Record<ScreenId, string>> = {
  review: "Needs",
  sessions: "Tsk",
  settings: "Set",
};

/** Build one tab's spans. `mode` shortens inactive labels when the bar is tight. */
function tabSpans(
  theme: TerminalTheme,
  tab: ScreenId,
  active: boolean,
  badge: Partial<Record<ScreenId, [number, StatusTone]>>,
  mode: "full" | "short" | "omit",
): Line {
  if (mode === "omit") return [];
  const label = SCREEN_LABELS[tab];
  const shown = mode === "short" && !active ? (SHORT_LABELS[tab] ?? label.slice(0, 1)) : label;
  const out: Line = [span("  ")];
  if (active) out.push(span(`[ ${shown} ]`, { fg: "focus", bold: true }));
  else out.push(span(shown, { fg: "secondary" }));
  const [n, tone] = badge[tab] ?? [0, "neutral"];
  // Full width: every badge. Short width: keep Needs attention only (`Needs 15`), drop Tsk/Runs counts.
  if (n > 0 && !active && (mode === "full" || (mode === "short" && tab === "review"))) {
    out.push(span(theme.plain ? ` (${n})` : ` ${n}`, { fg: toneRole(tone), bold: true }));
  }
  if (tab === "setup" && !active) out.push(span(" !", { fg: "warn", bold: true }));
  return out;
}

/** Prefer dropping Setup/Home before Needs/Tsk/Set so short labels stay unambiguous at 60 cols. */
function omitPreference(tab: ScreenId): number {
  if (tab === "setup") return 0;
  if (tab === "home") return 1;
  return 2;
}

/** Prefer a full active tab; abbreviate then drop inactive tabs when width is tight (UI-11). */
export function fitTabBar(
  theme: TerminalTheme,
  tabIds: ScreenId[],
  screen: ScreenId,
  badge: Partial<Record<ScreenId, [number, StatusTone]>>,
  budget: number,
): Line {
  const isActive = (tab: ScreenId) => tab === screen || (tab === "setup" && screen === "setup");
  const modes = new Map<ScreenId, "full" | "short" | "omit">(tabIds.map(t => [t, "full"]));
  const render = () => tabIds.flatMap(tab => tabSpans(theme, tab, isActive(tab), badge, modes.get(tab)!));
  if (lineWidth(render()) <= budget) return render();
  for (const tab of [...tabIds].reverse()) {
    if (isActive(tab)) continue;
    modes.set(tab, "short");
    if (lineWidth(render()) <= budget) return render();
  }
  const omitOrder = [...tabIds].sort((a, b) => omitPreference(a) - omitPreference(b) || tabIds.indexOf(a) - tabIds.indexOf(b));
  for (const tab of omitOrder) {
    if (isActive(tab)) continue;
    modes.set(tab, "omit");
    if (lineWidth(render()) <= budget) return render();
  }
  // Last resort: active tab alone (may still clip via ends/fit if logo+active exceed budget).
  return render();
}

function topBar(input: FrameInput, screen: ScreenId, width: number): Line {
  const { s, theme } = input, c = counts(s);
  // Logo uses ink (not accent/track): light-theme track fails 4.5:1 on the page surface (UI-2).
  const logo: Line = [span(glyph(theme, "▬┃").slice(0, -1), { fg: "ink", bold: true }), span(glyph(theme, "▬┃").slice(-1), { fg: "ink", bold: true }), span(" pacer", { fg: "ink", bold: true }), span(" ")];
  const runAttention = (input.s.attention ?? []).filter(a => a.run && a.kind === "question").length;
  const badge: Partial<Record<ScreenId, [number, StatusTone]>> = c
    ? { review: [c.attention, "warn"], sessions: [c.running, "info"], runs: [runAttention, "warn"] }
    : { runs: [runAttention, "warn"] };
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
  const rightFitted = fit(right, Math.max(0, width - 10), theme);
  const tabBudget = computeTabBudget(width, logo, rightFitted);
  const left: Line = [...logo, ...fitTabBar(theme, tabs(s), screen, badge, tabBudget)];
  return ends(left, right, width, theme);
}

/** Tab-bar column budget for a given chrome width (logo + right chrome already measured). */
export function computeTabBudget(width: number, logo: Line, rightFitted: Line): number {
  return Math.max(0, width - lineWidth(logo) - lineWidth(rightFitted) - 2);
}
function ends(left: Line, right: Line, width: number, theme: TerminalTheme): Line {
  const r = fit(right, Math.max(0, width - 10), theme), l = fit(left, Math.max(0, width - lineWidth(r) - 2), theme);
  return [...l, span(" ".repeat(Math.max(1, width - lineWidth(l) - lineWidth(r)))), ...r];
}
/** Legacy planner caption when the row has no usageState yet (ADR 0030 dual-path until every fixture carries a record). */
function legacyMeterText(used: number | null, pace: number | null): string {
  if (used === null) return "usage unknown";
  const u = Math.round(used), p = pace === null ? null : Math.round(pace);
  return p === null ? `${u}% used` : `${u}% used · pace ${p}%`;
}

function plannerStrip(input: FrameInput, width: number): Line {
  const { s, theme } = input, p = plannerMeter(s);
  if (!p) return [span("Planner · waiting for service data", { fg: "muted" })];
  // As the app's top bar: the planner meter and verdict on every screen. Home adds the advice (UI-15).
  // When usageState is present, every label comes from usageView (ADR 0030 decision 7).
  const view = usageView(p.usageState, input.now, input.timeZone);
  const status = p.usageState
    ? { ...paceStatus(p.usageState.verdict), label: view.verdictLabel, tone: view.tone }
    : paceStatus(p.verdict);
  const usedPct = p.usageState ? view.meter : p.usedPct;
  const pacePct = p.usageState && view.meter === null ? null : p.pacePct;
  const caption = p.usageState
    ? [view.meter !== null ? view.summaryUsed : view.figure, pacePct !== null ? `pace ${Math.round(pacePct)}%` : null].filter(Boolean).join(" · ")
    : legacyMeterText(p.usedPct, p.pacePct);
  const wide = width >= 100;
  const name = wide ? `${agentInfo(p.agent).name} planner` : agentInfo(p.agent).name;
  const line: Line = [span(name, { bold: true }), span("  "), ...meter(theme, usedPct, pacePct, wide ? 20 : 12, status.tone), span("  "), span(caption, { bold: true }), span("  "), ...statusSpans(theme, status)];
  const extra = [
    p.activeHoursLeft !== null ? `${Math.round(p.activeHoursLeft)} active-h` : "",
    ...(p.usageState
      ? [captionReset(view.reset) ?? "", p.usageState.freshness === "historical" ? "Historical usage" : ""].filter(Boolean)
      : [p.resetsAt !== null ? `resets ${clock(p.resetsAt, input.now, input.timeZone)}` : "", p.stale ? "stale reading" : ""]),
  ].filter(Boolean);
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
      // Enter confirms and Esc cancels for every confirm (same as y/n); document both so the hint matches keys.
      // Use glyph() so plain/ASCII themes show "Enter", not a bare "#" from ascii transliteration.
      [span(`y/${glyph(theme, "⏎")}`, { bold: true }), span(` ${overlay.yes}`), ...(overlay.alt ? [span(" · "), span(overlay.alt.key, { bold: true }), span(` ${overlay.alt.label}`)] : []), span(" · "), span("n/Esc", { bold: true }), span(" Cancel")],
    ], w);
    case "menu": return box(theme, overlay.title, [...overlay.actions.map((a, i): Line => [span(i === overlay.index ? `${glyph(theme, "›")} ` : "  ", { fg: "focus", bold: true }), span(`${i + 1}`, { bold: true }), span(` ${a.label}`, a.danger ? { fg: "bad" } : {})]), [], [span("1-9 or ⏎ choose · Esc cancel", { fg: "muted" })]], w);
    case "prompt": {
      const max = overlay.spec.maxLength;
      const promptLines: Line[] = [
        [span(overlay.spec.label, { fg: "secondary" })],
        [span(`${glyph(theme, "›")} `, { fg: "focus" }), span(clipEnd(overlay.value, w - 8)), span(theme.unicode ? "▌" : "_", { fg: "focus" })],
      ];
      if (max !== undefined) {
        promptLines.push([span(`${overlay.value.length}/${max}`, { fg: overlay.value.length > max ? "bad" : "muted" })]);
      }
      if (overlay.error) promptLines.push(statusSpans(theme, { label: overlay.error, tone: "bad", glyph: "✕" }));
      if (overlay.spec.help) promptLines.push([span(overlay.spec.help, { fg: "muted" })]);
      promptLines.push([], [span("⏎ submit · Esc cancel", { fg: "muted" })]);
      return box(theme, overlay.spec.title, promptLines, w);
    }
    case "answer": {
      const lines: Line[] = [];
      // Question body in the box (title alone is clipped); bound wrap depth (N6).
      const bodyLines = wrap(overlay.title, w - 4, 6).map((wline): Line => [span(wline, { fg: "secondary" })]);
      if (overlay.recommended) lines.push([span(`Recommended: ${overlay.recommended}`, { fg: "good" })]);
      if (overlay.phase === "text" || overlay.phase === "note") {
        const max = overlay.phase === "note" ? QUESTION_NOTE_MAX : QUESTION_ANSWER_MAX;
        lines.push(...bodyLines, []);
        lines.push([span(overlay.phase === "note" ? "Revision note" : "Your answer", { fg: "secondary" })]);
        lines.push([span(`${glyph(theme, "›")} `, { fg: "focus" }), span(clipEnd(overlay.note, w - 8)), span(theme.unicode ? "▌" : "_", { fg: "focus" })]);
        lines.push([span(`${overlay.note.length}/${max}`, { fg: overlay.note.length > max ? "bad" : "muted" })]);
        if (overlay.error) lines.push(statusSpans(theme, { label: overlay.error, tone: "bad", glyph: "✕" }));
        lines.push([], [span("⏎ submit · Esc cancel", { fg: "muted" })]);
        return box(theme, "Answer", lines, w);
      }
      if (overlay.mode === "yes_no") {
        lines.push(...bodyLines, []);
        lines.push([span("y", { bold: true }), span(" Yes   "), span("n", { bold: true }), span(" No")]);
        if (overlay.recommended) lines.push([span(`Recommended: ${overlay.recommended}`, { fg: "muted" })]);
        if (overlay.error) lines.push(statusSpans(theme, { label: overlay.error, tone: "bad", glyph: "✕" }));
        lines.push([], [span("y / n · Esc cancel", { fg: "muted" })]);
        return box(theme, "Answer", lines, w);
      }
      lines.push(...bodyLines);
      if (bodyLines.length) lines.push([]);
      for (const [i, option] of overlay.options.entries()) {
        const on = overlay.selected.includes(option.value);
        const focused = i === overlay.index;
        const cursor = focused ? `${glyph(theme, "›")} ` : "  ";
        // Multi keeps › with the checkbox so PLAIN_THEME/NO_COLOR still marks focus.
        const mark = overlay.mode === "multi"
          ? `${cursor}${on ? "[x]" : "[ ]"} `
          : cursor;
        const rec = option.value === overlay.recommended ? " · recommended" : "";
        const note = option.note ? ` · ${option.note}` : "";
        lines.push([
          span(mark, { fg: "focus", bold: true }),
          span(`${i + 1} ${option.label}${rec}${note}`, focused ? { bold: true } : {}),
        ]);
      }
      if (!overlay.options.length) {
        // Wrap so the question id and `pacer answer … "<your answer>"` stay fully visible (N6).
        const hint = overlay.emptyHint ?? 'This question has no options; answer it with pacer answer "<your answer>"';
        lines.push(...wrap(hint, w - 4).map((line): Line => [span(line, { fg: "warn" })]));
      }
      if (overlay.error) lines.push(statusSpans(theme, { label: overlay.error, tone: "bad", glyph: "✕" }));
      const hint = !overlay.options.length
        ? "Esc cancel"
        : overlay.mode === "multi"
          ? "space toggle · ⏎ submit · Esc cancel"
          : overlay.index < 0 ? "↑↓ then ⏎, or 1-9, choose · Esc cancel" : "1-9 or ⏎ choose · Esc cancel";
      lines.push([], [span(hint, { fg: "muted" })]);
      return box(theme, "Answer", lines, w);
    }
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
  ["n", "Start interactive session", "session.create"], ["d", "Delegate a task", "task.delegate"], ["f", "Repo scope"], ["R / Ctrl-R", "Refresh"], ["?", "Keyboard shortcuts"], ["Esc", "Close or go back"], ["q", "Quit"],
];
const SCREEN_HELP: Partial<Record<ScreenId, HelpRow[]>> = {
  home: [["x", "Dismiss", "attention.dismiss"], ["v", "Open in Review"], ["b", "Block or unblock an executor", "runner.block"], ["t m", "Terminal window · tmux pane", "task.attach"], ["s", "Stop", "task.stop"]],
  review: [["a", "Mark accepted", "task.review"], ["s", "Send back with a note", "task.review"], ["r", "Reject with a note", "task.review"], ["t", "Retry on another executor", "task.review"], ["o", "Show worktree path"]],
  sessions: [["⏎", "Watch here", "task.attach"], ["t", "Open in a terminal window", "task.attach"], ["m", "Open in a tmux pane", "task.attach"], ["s", "Stop", "task.stop"], ["x", "Dismiss", "task.dismiss"]],
  runs: [
    ["⏎", "Open run / task"], ["a", "Answer", "question.answer"], ["p", "Pause or resume", "run.pause"],
    ["s", "Stop", "run.stop"], ["P", "Cycle priority", "run.set_priority"], ["A", "Toggle auto", "run.set_auto"],
    ["m", "Message orchestrator", "msg.send"], ["Esc", "Back to run list"],
  ],
  settings: [["⏎ / →", "Open a section"], ["← →", "Adjust a value"], ["Esc", "Back to sections"]],
  setup: [["⏎", "Run the selected step"], ["x", "Skip first delegation", "onboarding.skip"]],
};
function helpLines(input: FrameInput): Line[] {
  const screen = effectiveScreen(input.s, input.state.screen, input.ops);
  const offered = (op?: string) => !op || input.ops === undefined || input.ops.includes(op);
  // Number shortcuts are not positional (Runs is 6; Settings stays 4), so the help
  // shows the highest offered digit rather than the tab count.
  const switchKeys = `1-${Math.max(0, ...Object.entries(SCREEN_KEYS).filter(([, id]) => tabs(input.s).includes(id)).map(([k]) => Number(k)))} / Tab Shift-Tab`;
  const keysOf = (k: string) => k === "TABS" ? switchKeys : k;
  // One key column for the whole overlay, as wide as its longest key.
  const column = Math.max(12, ...[...HELP, ...(SCREEN_HELP[screen] ?? [])].map(([k]) => keysOf(k).length + 2));
  const group = (title: string, rows: HelpRow[]): Line[] => [heading(input.theme, title), ...rows.filter(([, , op]) => offered(op)).map(([k, label]): Line => [span(keysOf(k).padEnd(column), { bold: true }), span(label, { fg: "secondary" })])];
  return [...group("Anywhere", HELP), [], ...group(SCREEN_LABELS[screen], SCREEN_HELP[screen] ?? [])];
}

/** Footer while a confirm overlay is open: dialog keys only — never `⏎ Answer` while Enter means Stop. */
function confirmKeyBar(
  input: FrameInput,
  overlay: Extract<Overlay, { kind: "confirm" }>,
  width: number,
): Line {
  const { theme } = input;
  const enter = glyph(theme, "⏎");
  const groups: Line[] = [
    [span(`y/${enter}`, { bold: true }), span(` ${overlay.yes}`, { fg: "secondary" })],
  ];
  if (overlay.alt) groups.push([span(overlay.alt.key, { bold: true }), span(` ${overlay.alt.label}`, { fg: "secondary" })]);
  groups.push([span("n/Esc", { bold: true }), span(" Cancel", { fg: "secondary" })]);
  const help: Line = [span("?", { bold: true }), span(" help", { fg: "secondary" })];
  const version = span(`pacer ${input.version}`, { fg: "muted" });
  const join = (list: Line[]) => list.flatMap((g, i) => i ? [span("  "), ...g] : g);
  return ends(join([...groups, help]), [version], width, theme);
}

function keyBar(input: FrameInput, item: Item | undefined, view: ScreenView, screen: ScreenId, width: number): Line {
  const { theme } = input, groups: Line[] = [];
  // Dedupe by key+label: rebound acts are new objects, so referential `!== primary` fails.
  const seen = new Set<string>();
  const add = (key: string, label: string) => {
    const id = `${key}\0${label}`;
    if (seen.has(id)) return;
    seen.add(id);
    groups.push([span(key, { bold: true }), span(` ${label}`, { fg: "secondary" })]);
  };
  const listFocus = screen === "settings" && input.state.focus === "list";
  const enter = glyph(theme, "⏎");
  if (listFocus) { add(enter, "open section"); add("j k", "sections"); }
  else if (item) {
    if (item.primary) add(enter, item.primary.label);
    // Arrow keys are summarised by the screen hint ("← → adjust").
    const primaryLabel = item.primary?.label;
    for (const [key, act] of Object.entries(item.keys)) {
      if (key === "left" || key === "right") continue;
      if (primaryLabel && act.label === primaryLabel) continue;
      add(key, act.label.toLowerCase());
    }
    const more = item.actions.length;
    if (more) add(".", `actions (${more + (item.primary ? 1 : 0)})`);
  }
  for (const hint of view.hints ?? []) { const [key, ...label] = hint.split(" "); add(key!, label.join(" ")); }
  const help: Line = [span("?", { bold: true }), span(" help", { fg: "secondary" })];
  const words: Partial<Record<UpdateState, [string, Style]>> = {
    available: ["update available", { fg: "warn", bold: true }], current: ["up to date", { fg: "muted" }],
    disabled: ["update checks off", { fg: "muted" }], failed: ["update check failed", { fg: "warn" }],
  };
  const known = input.update ? words[input.update] : undefined;
  const policy = span(policyWords(input.s.policy), { fg: "muted" });
  const compactPolicy = span(compactPolicyWords(input.s.policy), { fg: "muted" });
  const version = span(`pacer ${input.version}`, { fg: "muted" });
  const separator = span(` ${glyph(theme, "·")} `, { fg: "muted" });
  const join = (list: Line[]) => list.flatMap((g, i) => i ? [span("  "), ...g] : g);
  // Narrow terminals keep one item: the version, unless there is something to notice.
  const plain: Line = !known ? [version]
    : width >= 100 ? [version, separator, span(known[0], known[1])]
    : input.update === "current" ? [version] : [span(known[0], known[1])];
  // Drop whole hints from the end, never the first (the primary) or "? help", so no key is shown cut in half.
  const kept = (right: Line) => {
    const room = width - lineWidth(right) - 2;
    let n = groups.length;
    while (n > 1 && lineWidth(join([...groups.slice(0, n), help])) > room) n--;
    return n;
  };
  // Key hints outrank the policy token: it shows, shortened if need be, only where it costs no hint.
  // To make room for it the version gives way first, then a muted update notice. A warn-toned notice
  // ("update available", "update check failed") outranks the policy token and never gives way to it.
  const shown = kept(plain), notice: Line = known && input.update !== "current" ? [span(known[0], known[1])] : [];
  const warns = known?.[1].fg === "warn";
  const options: Line[] = [[policy, separator, ...plain], [compactPolicy, separator, ...plain],
    ...(notice.length ? [[policy, separator, ...notice], [compactPolicy, separator, ...notice]] : []), ...(warns ? [] : [[policy], [compactPolicy]])];
  const right = options.find(line => kept(line) >= shown) ?? plain;
  groups.splice(kept(right));
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
  const footer = state.overlay?.kind === "confirm"
    ? confirmKeyBar(input, state.overlay, inner)
    : keyBar(input, item, view, screen, inner);
  out.push({ line: [span(" "), ...footer] });
  return paint(theme, out.slice(0, height), width);
}
