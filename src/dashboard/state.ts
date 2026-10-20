/** Navigation, selection and overlays for the TUI. Pure: keys become a new state and, at most, one effect. */
import type { Action } from "../attention/types";

export type ScreenId = "home" | "review" | "sessions" | "settings" | "setup";
export const SCREEN_LABELS: Record<ScreenId, string> = { home: "Home", review: "Review", sessions: "Sessions", settings: "Settings", setup: "Setup" };
export const SCREEN_KEYS: Record<string, ScreenId> = { "1": "home", "2": "review", "3": "sessions", "4": "settings", "5": "setup" };

/** What an action does. The controller executes effects; screens only describe them. */
export type Effect =
  | { type: "action"; action: Action }
  | { type: "navigate"; screen: ScreenId; id?: string; section?: string }
  | { type: "attach"; id: string; target: "here" | "terminal" | "tmux" }
  | { type: "prompt"; prompt: PromptSpec }
  | { type: "choose"; title: string; options: Act[] }
  | { type: "handoff"; argv: string[]; label: string }
  /** Controller flows that need a read before asking, such as an integration preview. */
  | { type: "flow"; name: string; params: Record<string, unknown> }
  | { type: "local"; label: string; run: () => void | Promise<void> };
export interface Act {
  label: string;
  effect: Effect;
  /** Destructive or consequential actions ask first (TD-6). */
  confirm?: Confirm;
  danger?: boolean;
  /** What the act is about, such as a task title; shown in a confirmation the TUI adds. */
  subject?: string;
}
/** A consent question. `alt` offers a second answer, such as "Change only" beside "Change and connect". */
export interface Confirm { title: string; body?: string[]; yes?: string; alt?: { key: string; label: string; act: Act } }
/** A selectable row. `primary` is the region's one primary action (UI-14); `keys` are screen keys such as x, b, a. */
export interface Item { id: string; primary?: Act; actions: Act[]; keys: Record<string, Act> }

export interface PromptSpec {
  title: string;
  label: string;
  help?: string;
  value?: string;
  required?: string;
  submit(value: string): Effect | undefined;
}
export type Overlay =
  | { kind: "help" }
  | { kind: "menu"; title: string; actions: Act[]; index: number }
  | { kind: "confirm"; title: string; body: string[]; yes: string; act: Act; alt?: Confirm["alt"] }
  | { kind: "prompt"; spec: PromptSpec; value: string; error?: string };

export interface UiState {
  screen: ScreenId;
  /** Selected item id per screen; ids survive refreshes, unlike indexes. */
  selected: Partial<Record<ScreenId, string>>;
  /** Settings: section id, and whether the keys move within the section. */
  section: string;
  focus: "list" | "detail";
  /** Detail scroll for narrow drill-in and long detail panes. */
  scroll: number;
  scope: string | null;
  overlay: Overlay | null;
}
export const initialState = (screen: ScreenId = "home"): UiState => ({ screen, selected: {}, section: "planner", focus: "list", scroll: 0, scope: null, overlay: null });

export interface KeyContext {
  /** Selectable rows of the visible list, in order. */
  items: Item[];
  tabs: ScreenId[];
  /** Settings sections, when on Settings. */
  sections?: string[];
  /** Body lines per page, for PgUp/PgDn. */
  page: number;
  /** Narrow layouts drill into a detail view. */
  wide: boolean;
  /** Screens with a detail pane. */
  hasDetail: boolean;
  repos: string[];
  /** Ops offered by the service; global keys whose ops are absent do nothing. */
  supports(op: string): boolean;
  /** The row selected when nothing is. */
  initial?: string;
}
export interface KeyResult { state: UiState; effect?: Effect; quit?: boolean; refresh?: boolean; act?: Act }

const index = (items: Item[], id: string | undefined) => Math.max(0, items.findIndex(i => i.id === id));
/** The selected row, else the screen's suggested row (such as the next setup step), else the first. */
export function selectedItem(state: UiState, items: Item[], initial?: string): Item | undefined {
  const id = state.selected[state.screen];
  if (id === "") return undefined; // explicitly nothing selected
  return items.find(i => i.id === id) ?? items.find(i => i.id === initial) ?? items[0];
}
const select = (state: UiState, items: Item[], i: number): UiState => {
  const item = items[Math.max(0, Math.min(items.length - 1, i))];
  return item ? { ...state, selected: { ...state.selected, [state.screen]: item.id }, scroll: 0 } : state;
};
const go = (state: UiState, screen: ScreenId): UiState => ({ ...state, screen, focus: "list", scroll: 0, overlay: null });

/** Accept and reject verdicts, stops, removals, updates and danger-style service actions always confirm in the TUI, whichever
 * screen or menu offers them (TD-6). Acts that bring their own wording keep it. */
export function consequential(action: Action): boolean {
  return action.op === "task.review" && ["accept", "reject"].includes(String(action.params.verdict)) || action.op === "task.stop" || /\.remove$/.test(action.op) || action.op === "update.apply" || action.style === "danger";
}
const VERDICT_WORDS: Record<string, string> = { accept: "Accept", reject: "Reject" };
function guardConfirm(act: Act): Confirm | undefined {
  if (act.confirm || act.effect.type !== "action" || !consequential(act.effect.action)) return act.confirm;
  const { action } = act.effect, verdict = action.op === "task.review" ? VERDICT_WORDS[String(action.params.verdict)] : undefined;
  return { title: `${verdict ?? act.label}?`, ...(act.subject ? { body: [act.subject] } : {}), yes: verdict ?? act.label };
}

/** Run an act: confirm first when it asks to, or when it is consequential. `confirmed` skips the question. */
export function trigger(state: UiState, act: Act | undefined, confirmed = false): KeyResult {
  if (!act) return { state };
  if (!confirmed) {
    const confirm = guardConfirm(act);
    if (confirm) return { state: { ...state, overlay: { kind: "confirm", title: confirm.title, body: confirm.body ?? [], yes: confirm.yes ?? act.label, act: { ...act, confirm }, ...(confirm.alt ? { alt: confirm.alt } : {}) } } };
  }
  if (act.effect.type === "prompt") return { state: { ...state, overlay: { kind: "prompt", spec: act.effect.prompt, value: act.effect.prompt.value ?? "" } } };
  if (act.effect.type === "choose") return { state: { ...state, overlay: { kind: "menu", title: act.effect.title, actions: act.effect.options, index: 0 } } };
  return { state, effect: act.effect, act };
}

function overlayKey(state: UiState, overlay: Overlay, key: string): KeyResult {
  const close = { ...state, overlay: null };
  switch (overlay.kind) {
    case "help":
      return { state: key === "?" || key === "escape" || key === "q" || key === "enter" ? close : state };
    case "confirm":
      if (key === "y" || key === "Y" || key === "enter") {
        const { confirm: _, ...act } = overlay.act;
        return trigger(close, act, true);
      }
      if (overlay.alt && key === overlay.alt.key) return trigger(close, overlay.alt.act, true);
      return { state: key === "n" || key === "N" || key === "escape" ? close : state };
    case "menu": {
      if (key === "escape") return { state: close };
      if (/^[1-9]$/.test(key)) return trigger(close, overlay.actions[Number(key) - 1]);
      if (key === "enter") return trigger(close, overlay.actions[overlay.index]);
      const move = key === "up" || key === "k" ? -1 : key === "down" || key === "j" ? 1 : 0;
      return { state: move ? { ...state, overlay: { ...overlay, index: Math.max(0, Math.min(overlay.actions.length - 1, overlay.index + move)) } } : state };
    }
    case "prompt": {
      if (key === "escape") return { state: close };
      if (key === "backspace") return { state: { ...state, overlay: { ...overlay, value: Array.from(overlay.value).slice(0, -1).join(""), error: undefined } } };
      if (key === "enter") {
        const value = overlay.value.trim();
        if (!value && overlay.spec.required) return { state: { ...state, overlay: { ...overlay, error: overlay.spec.required } } };
        const effect = overlay.spec.submit(value);
        // Submitting a prompt (such as a reject note) is the confirmation.
        return effect ? trigger(close, { label: overlay.spec.title, effect }, true) : { state: close };
      }
      if (key.length && !["up", "down", "left", "right", "tab", "backtab", "pageup", "pagedown"].includes(key) && !/[\x00-\x1f\x7f]/.test(key)) {
        return { state: { ...state, overlay: { ...overlay, value: overlay.value + key, error: undefined } } };
      }
      return { state };
    }
  }
}

/** Global and list keys. Screen keys come from the selected item's `keys`. */
export function reduceKey(state: UiState, key: string, ctx: KeyContext): KeyResult {
  if (key === "interrupt") return { state, quit: true };
  if (state.overlay) return overlayKey(state, state.overlay, key);
  const item = selectedItem(state, ctx.items, ctx.initial);
  const detail = state.focus === "detail";

  // Inside a settings section, row keys (including ← → for values) win over navigation.
  if (state.screen === "settings" && detail && item?.keys[key]) return trigger(state, item.keys[key]);
  // Settings section navigation: the list of sections is the outer level.
  if (state.screen === "settings" && ctx.sections && !detail) {
    const i = Math.max(0, ctx.sections.indexOf(state.section));
    if (key === "up" || key === "k") return { state: { ...state, section: ctx.sections[Math.max(0, i - 1)]!, scroll: 0 } };
    if (key === "down" || key === "j") return { state: { ...state, section: ctx.sections[Math.min(ctx.sections.length - 1, i + 1)]!, scroll: 0 } };
    if (key === "enter" || key === "right" || key === "l") return { state: { ...state, focus: "detail", scroll: 0 } };
  }
  if (key === "escape" || key === "left" || key === "h" && detail) {
    if (detail) return { state: { ...state, focus: "list", scroll: 0 } };
    if (key === "escape" && state.screen === "settings") return { state: go(state, "home") };
    if (key === "escape") return { state };
  }
  if (key === "q") return { state, quit: true };
  if (key === "?") return { state: { ...state, overlay: { kind: "help" } } };
  if (SCREEN_KEYS[key] && ctx.tabs.includes(SCREEN_KEYS[key]!)) return { state: go(state, SCREEN_KEYS[key]!) };
  if (key === "tab" || key === "backtab") {
    const i = ctx.tabs.indexOf(state.screen), step = key === "tab" ? 1 : -1;
    return { state: go(state, ctx.tabs[(i + step + ctx.tabs.length) % ctx.tabs.length]!) };
  }
  if (key === ",") return { state: go(state, "settings") };
  if (key === "R" || key === "\x12") return { state, refresh: true };
  if (key === "f" && state.screen !== "settings") {
    const scopes: (string | null)[] = [null, ...ctx.repos], i = scopes.indexOf(state.scope);
    return { state: { ...state, scope: scopes[(i + 1) % scopes.length] ?? null, selected: {} } };
  }

  // Narrow detail drill-in scrolls; wide detail is always visible.
  if (detail && state.screen !== "settings") {
    if (key === "up" || key === "k") return { state: { ...state, scroll: Math.max(0, state.scroll - 1) } };
    if (key === "down" || key === "j") return { state: { ...state, scroll: state.scroll + 1 } };
  }
  const i = index(ctx.items, item?.id);
  if (key === "up" || key === "k") return { state: select(state, ctx.items, i - 1) };
  if (key === "down" || key === "j") return { state: select(state, ctx.items, i + 1) };
  if (key === "pageup") return { state: select(state, ctx.items, i - Math.max(1, ctx.page)) };
  if (key === "pagedown") return { state: select(state, ctx.items, i + Math.max(1, ctx.page)) };
  if (key === "home") return { state: select(state, ctx.items, 0) };
  if (key === "end") return { state: select(state, ctx.items, ctx.items.length - 1) };
  if ((key === "right" || key === "l") && ctx.hasDetail && !ctx.wide && item) return { state: { ...state, focus: "detail", scroll: 0 } };
  if (key === ".") {
    const actions = item ? [...(item.primary ? [item.primary] : []), ...item.actions] : [];
    return actions.length ? { state: { ...state, overlay: { kind: "menu", title: "Actions", actions, index: 0 } } } : { state };
  }
  if (key === "enter") {
    if (ctx.hasDetail && !ctx.wide && !detail && item && !item.primary) return { state: { ...state, focus: "detail", scroll: 0 } };
    return trigger(state, item?.primary);
  }
  if (item?.keys[key]) return trigger(state, item.keys[key]);
  return { state };
}
