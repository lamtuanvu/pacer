/** Pure frame rendering for a snapshot, without a service: used by tests, `--once` and other callers. */
import type { ClientSnapshot } from "../view-model/snapshot";
import { renderFrame, screenView, type FrameInput } from "./screens/shell";
import type { DashData } from "./screens/types";
import { initialState, type UiState } from "./state";
import { detectTheme, PLAIN_THEME, type TerminalTheme } from "./theme";
export { cellWidth, clip, safeText } from "./frame";

export interface RenderOptions {
  /** Index of the selected row on the current screen. */
  selected?: number;
  /** No escapes at all, as NO_COLOR. Defaults to 16 colors so tone codes are visible to tests. */
  noColor?: boolean;
  theme?: TerminalTheme;
  state?: Partial<UiState>;
  ops?: readonly string[];
  version?: string;
  data?: Partial<DashData>;
  message?: FrameInput["message"];
  update?: FrameInput["update"];
  connection?: FrameInput["connection"];
  timeZone?: string;
}

/** The selectable rows and their actions on a screen, as the TUI would offer them. */
export function screenItems(s: ClientSnapshot, now: number, options: Pick<RenderOptions, "ops" | "state" | "data"> = {}) {
  const state: UiState = { ...initialState(), ...options.state };
  return screenView({
    s, now, theme: PLAIN_THEME, state, width: 120, height: 40, ops: options.ops, version: "0.0.0-test", connection: "live",
    data: { details: options.data?.details ?? new Map(), settings: options.data?.settings ?? {} },
  }).view.items;
}

export function renderDashboard(s: ClientSnapshot, width: number, height: number, now: number, options: RenderOptions = {}): string {
  const theme = options.theme ?? (options.noColor ? PLAIN_THEME : detectTheme({ TERM: "xterm" }, true));
  let state: UiState = { ...initialState(), ...options.state };
  const input: FrameInput = {
    s, now, theme, state, width, height, ops: options.ops, version: options.version ?? "0.0.0-test",
    data: { details: options.data?.details ?? new Map(), settings: options.data?.settings ?? {} },
    connection: options.connection ?? "live", timeZone: options.timeZone ?? "UTC",
    ...(options.message ? { message: options.message } : {}), ...(options.update ? { update: options.update } : {}),
  };
  if (options.selected !== undefined) {
    const { view, screen } = screenView(input), item = view.items[options.selected];
    state = { ...state, selected: { ...state.selected, [screen]: options.selected < 0 ? "" : item?.id ?? "none" } };
  }
  return renderFrame({ ...input, state });
}
