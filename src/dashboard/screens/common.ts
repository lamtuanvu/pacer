import type { Action } from "../../attention/types";
import { agentInfo, runnerAgent } from "../../view-model/agents";
import { executorLabel, type AccountLike } from "../../view-model/words";
import { clock } from "../../view-model/time";
import { glyph, span, type Line } from "../frame";
import type { Act, ScreenId } from "../state";
import type { TerminalTheme } from "../theme";
import type { Row, ScreenCtx } from "./types";

export const GAP = 2;
/** The selection gutter at the start of every list row. */
export const MARK = 2;

/** Agent identity: a colored dot from the agent token where color exists, then the shared label. */
export function executorName(theme: TerminalTheme, id: string | null | undefined, accounts: AccountLike[] = []): Line {
  const label = executorLabel(id, accounts);
  if (!id || theme.depth === "none" || theme.depth === "16") return [span(label)];
  const agent = runnerAgent(id), info = agentInfo(agent);
  return [span(`${glyph(theme, "●")} `, info.color === "ink" ? { fg: "secondary" } : { agent }), span(label)];
}

export const empty = (text: string): Row => ({ line: [span(text, { fg: "muted" })] });
export const blank = (): Row => ({ line: [] });
export const time = (ctx: ScreenCtx, at: number) => clock(at, ctx.now, ctx.timeZone);

/** Service settings sections → TUI section ids. */
const SECTION_IDS: Record<string, string> = {
  planner: "planner", pacing: "planner", accounts: "accounts", executors: "executors", routing: "routing",
  strategies: "strategies", updates: "updates", notifications: "notifications", appearance: "appearance", hosts: "hosts",
};
/** Service actions become TUI acts. `ui.open` navigates inside the TUI; unknown ops are hidden (UI-13). */
export function serviceAct(ctx: ScreenCtx, action: Action, subject?: string): Act | undefined {
  if (action.op === "ui.open") {
    const view = String(action.params.view ?? ""), id = typeof action.params.id === "string" ? action.params.id : undefined;
    const screen: ScreenId | undefined = view === "review" ? "review" : view === "task" || view === "session" ? "sessions" : view === "settings" ? "settings" : undefined;
    if (!screen) return undefined;
    const section = typeof action.params.section === "string" ? SECTION_IDS[action.params.section] : undefined;
    return { label: action.label, effect: { type: "navigate", screen, ...(id ? { id } : {}), ...(section ? { section } : {}) } };
  }
  if (!ctx.supports(action.op)) return undefined;
  return {
    label: action.label,
    effect: { type: "action", action },
    ...(action.confirm ? { confirm: { title: action.confirm } } : {}),
    ...(action.style === "danger" ? { danger: true } : {}),
    ...(subject ? { subject } : {}),
  };
}
export const opAct = (ctx: ScreenCtx, label: string, op: string, params: Record<string, unknown>, extra: Partial<Act> = {}): Act | undefined =>
  ctx.supports(op) ? { label, effect: { type: "action", action: { label, op, params } }, ...extra } : undefined;
export const defined = <T>(values: (T | undefined | false | null)[]): T[] => values.filter((v): v is T => !!v);
