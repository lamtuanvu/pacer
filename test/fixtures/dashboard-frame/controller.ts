/**
 * Recorder for the dashboard reducer + controller goldens consumed by
 * `crates/tui/tests/controller.rs`. It replays key scripts over the fixture
 * snapshot with the TypeScript `reduceKey` / `Dashboard`-equivalent inputs and
 * records `{ state, effect, quit, refresh }` after each key, plus frames from
 * the TS renderer. Keys are sorted for a stable cross-runtime boundary.
 *
 * Explicit regeneration only: `bun test/fixtures/dashboard-frame/generate.ts`.
 */
import snapshot from "../ui/snapshot.json";
import taskGet from "../ui/task-get.json";
import settings from "../ui/tui-settings.json";
import { renderDashboard } from "../../../src/dashboard/render";
import { initialState, reduceKey, type Act, type Item, type KeyContext, type UiState } from "../../../src/dashboard/state";
import { PLAIN_THEME } from "../../../src/dashboard/theme";
import { withUsageState } from "../../usage-fixtures";

const OPS = ["host.check", "host.set", "task.retry", "task.review", "task.get", "task.stop", "task.attach", "task.session", "task.delegate", "task.list", "config.get", "config.set", "account.list", "session.create", "task.dismiss"];

const actionAct = (label: string, op: string, params: Record<string, unknown> = {}, extra: Partial<Act> = {}): Act =>
  ({ label, effect: { type: "action", action: { label, op, params } }, ...extra });

const item = (id: string, primary?: Act, actions: Act[] = [], keys: Record<string, Act> = {}): Item => ({ id, primary, actions, keys });

const baseItems: Item[] = [
  item("a", actionAct("first", "op.first"), [actionAct("second", "op.second")], { x: actionAct("dismiss", "op.dismiss") }),
  item("b"),
  item("c", actionAct("stop", "task.stop", { id: "t-1" }, { subject: "Fix flaky retry test" })),
];

const context = (extra: Record<string, unknown> = {}): KeyContext => ({
  items: baseItems,
  tabs: ["home", "review", "sessions", "settings", "setup"],
  page: 10,
  wide: true,
  hasDetail: false,
  repos: ["r1", "r2"],
  ops: [],
  supports: (op: string) => true,
  ...extra,
}) as unknown as KeyContext;

interface ReducerCase { name: string; state: UiState; ctx: KeyContext; keys: string[] }
const reducerCases: ReducerCase[] = [
  {
    name: "navigation",
    state: initialState(),
    ctx: context(),
    keys: ["2", "3", "4", "5", "tab", "tab", "backtab", "1", ","],
  },
  {
    name: "selection",
    state: initialState(),
    ctx: context(),
    keys: ["j", "j", "j", "down", "k", "up", "up", "pagedown", "end", "home"],
  },
  {
    name: "review-confirm-accept",
    state: initialState("review"),
    ctx: context(),
    keys: ["j", "j", "enter", "y"],
  },
  {
    name: "review-confirm-reject-cancel",
    state: initialState("review"),
    ctx: context(),
    keys: ["j", "j", "enter", "n"],
  },
  {
    name: "choose-overlay",
    state: initialState(),
    ctx: context(),
    keys: [".", "2", ".", "j", "enter", ".", "escape"],
  },
  {
    name: "prompt-overlay",
    state: initialState(),
    ctx: context({
      items: [item("a", {
        label: "ask",
        effect: { type: "prompt", prompt: { title: "Add a note", label: "Note", required: "Add a note first.", submit: () => undefined } },
      })],
    }),
    keys: ["enter", "enter", "h", "i", "x", "backspace", "escape", "enter", "h", "i", "enter"],
  },
  {
    name: "settings-machine-step",
    state: initialState("settings"),
    ctx: context({ sections: ["planner", "machine", "notifications"], items: [item("row", undefined, [], { left: actionAct("adjust", "config.set"), right: actionAct("adjust", "config.set") })] }),
    keys: ["j", "j", "enter", "right", "left", "escape", "escape"],
  },
  {
    name: "history-more-and-effects",
    state: initialState(),
    ctx: context({
      items: [item("h", undefined, [], {
        "H": { label: "more", effect: { type: "history-more" } },
        "a": { label: "attach", effect: { type: "attach", id: "t-1", target: "tmux" } },
        "o": { label: "handoff", effect: { type: "handoff", argv: ["pacer", "account", "add"], label: "Add account" } },
        "v": { label: "flow", effect: { type: "flow", name: "machine-step", params: { key: "execution.local_max_tasks" } } },
        "l": { label: "local", effect: { type: "local", run: () => {} } },
      })],
    }),
    keys: ["H", "a", "o", "v", "l"],
  },
  {
    name: "quit-with-and-without-overlay",
    state: initialState(),
    ctx: context(),
    keys: ["?", "q", "q"],
  },
];

function replayReducer(c: ReducerCase) {
  let state = c.state;
  const steps: Record<string, unknown>[] = [];
  for (const key of c.keys) {
    const result = reduceKey(state, key, c.ctx);
    state = result.state;
    steps.push({ key, state, effect: result.effect ?? null, quit: !!result.quit, refresh: !!result.refresh });
  }
  return { name: c.name, state: c.state, ctx: c.ctx, keys: c.keys, steps };
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
};

export function controllerGolden() {
  const s = withUsageState(structuredClone(snapshot) as never) as typeof snapshot;
  const detail = { ...structuredClone(taskGet), messages: { value: [] } };
  const details = Object.fromEntries([["t-0412", { value: detail }]]);
  const data = { details: new Map(Object.entries(details)), settings: structuredClone(settings), history: undefined };
  const controller = [
    { name: "home-live", state: { screen: "home" }, ops: OPS, connection: "live" },
    { name: "review-selected", state: { screen: "review", selected: { review: "review:t-0412" } }, ops: OPS, connection: "live" },
    { name: "sessions-detail", state: { screen: "sessions", selected: { sessions: "session:t-0412" }, focus: "detail" }, ops: OPS, connection: "live" },
    { name: "settings-accounts", state: { screen: "settings", section: "accounts", focus: "detail" }, ops: OPS, connection: "live" },
    { name: "home-message", state: { screen: "home" }, ops: OPS, connection: "live", message: { text: "Saved. Undo: pacer config set planner codex", tone: "good" } },
    { name: "home-offline", state: { screen: "home" }, ops: OPS, connection: "offline", message: { text: "Service unavailable. R retries.", tone: "bad" } },
    { name: "home-local", state: { screen: "home" }, ops: OPS, connection: "local" },
  ].map((c) => {
    const frame = renderDashboard(s as never, 120, 40, Number(s.at), {
      theme: PLAIN_THEME, state: c.state as never, ops: c.ops, version: "0.0.0-test",
      timeZone: "UTC", data: data as never, connection: c.connection as never,
      ...("message" in c ? { message: c.message as never } : {}),
    });
    return { ...c, width: 120, height: 40, now: Number(s.at), timeZone: "UTC", version: "0.0.0-test", frame };
  });
  return sortKeys({
    schema: 1,
    snapshot: s,
    details,
    settings: data.settings,
    reducer: reducerCases.map(replayReducer),
    controller,
  });
}

if (import.meta.main) {
  await Bun.write(new URL("controller.json", import.meta.url), JSON.stringify(controllerGolden(), null, 2) + "\n");
}
