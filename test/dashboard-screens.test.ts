import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import taskGet from "./fixtures/ui/task-get.json";
import settingsFixture from "./fixtures/ui/tui-settings.json";
import { renderDashboard, screenItems } from "../src/dashboard/render";
import { cellWidth } from "../src/dashboard/frame";
import { setupChecklist } from "../src/setup/checklist";
import { counts, needsYou } from "../src/view-model/selectors";
import { detectTheme, PLAIN_THEME } from "../src/dashboard/theme";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { DashData, SettingsData, TaskDetail } from "../src/dashboard/screens/types";
import { initialState, reduceKey, type ScreenId, type UiState } from "../src/dashboard/state";
import { SECTIONS } from "../src/dashboard/screens/settings";
import { updateState, type UpdateState } from "../src/dashboard/screens/common";

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const detail = taskGet as unknown as TaskDetail;
const data = (): Partial<DashData> => ({
  details: new Map([
    ["t-0412", { value: detail }],
    ["t-0420", { value: { ...detail, id: "t-0420", state: "running", timeline: [{ at: 1799999160, text: "Routed to codex" }, { at: 1799999170, text: "Worktree created from main" }, { at: 1799999500, text: "Testing" }] } }],
  ]),
  settings: structuredClone(settingsFixture) as unknown as SettingsData,
});
const frame = (screen: ScreenId, width: number, height: number, extra: { state?: Partial<UiState>; theme?: typeof PLAIN_THEME } = {}) => {
  const s = snapshot();
  return renderDashboard(s, width, height, s.at, { theme: extra.theme ?? PLAIN_THEME, data: data(), state: { screen, ...extra.state }, version: "0.0.0-test" });
};
const bounded = (text: string, width: number, height: number) => {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(width);
};

describe("executor eligibility survives the screen redesign", () => {
  test("Settings accounts marks cached quota as historical", () => {
    const s = snapshot();
    s.accounts![0]!.stale = true;
    const text = renderDashboard(s, 80, 40, s.at, {
      noColor: true, data: data(), state: { screen: "settings", section: "accounts", focus: "detail" },
    });
    expect(text.replace(/\s+/g, " ")).toContain("Historical usage · Observation time unknown");
  });
  for (const screen of ["home", "settings"] as const) {
    for (const width of [80, 120]) {
      test(`${screen} at ${width} columns shows decision, evidence age and historical usage`, () => {
        const s = snapshot(), executor = s.executors![1]!;
        s.tasks = [];
        s.attention = [];
        s.executors = [{
          ...executor, state: "ready", stale: true, usedPct: 100,
          eligibility: {
            state: "uncertain", reasons: [{ code: "budget_expired_or_unknown", evidenceIds: [] }],
            evaluatedAt: s.at, validUntil: null, evidenceAgeS: 3600,
            availability: "ready", budget: "unknown", spendingRisk: "unknown",
          },
        }];
        const text = renderDashboard(s, width, 40, s.at + 3600, {
          noColor: true, state: { screen, section: "executors", focus: "detail" },
        });
        bounded(text, width, 40);
        const prose = text.replace(/\s+/g, " ");
        expect(prose).toContain("Uncertain fallback");
        expect(prose).toContain("Historical usage");
        expect(prose).toContain("Budget evidence has expired or is incomplete");
        expect(prose).toContain("observed 2h ago");
        expect(text).not.toContain("Budget exhausted");
      });
    }
    test(`${screen} shows paid eligibility independently of exhausted historical percentage`, () => {
      const s = snapshot(), executor = s.executors![1]!;
      s.tasks = [];
      s.attention = [];
      s.executors = [{
        ...executor, state: "ready", usedPct: 100,
        eligibility: {
          state: "eligible", reasons: [], evaluatedAt: s.at, validUntil: s.at + 60, evidenceAgeS: 10,
          availability: "ready", budget: "exhausted", spendingRisk: "observed",
        },
      }];
      const text = renderDashboard(s, 120, 40, s.at, {
        noColor: true, state: { screen, section: "executors", focus: "detail" },
      });
      expect(text).toContain("Eligible");
      expect(text).toContain("Paid execution allowed");
      expect(text).toContain("observed 10s ago");
    });
  }
});

describe("golden frames (NO_COLOR)", () => {
  const cases: [string, ScreenId, Partial<UiState>][] = [
    ["home", "home", {}],
    ["review", "review", {}],
    ["review detail (narrow drill-in)", "review", { focus: "detail" }],
    ["sessions", "sessions", {}],
    ["sessions detail (narrow drill-in)", "sessions", { focus: "detail" }],
    ["settings sections", "settings", {}],
    ...SECTIONS.map(s => [`settings › ${s.label}`, "settings", { section: s.id, focus: "detail" }] as [string, ScreenId, Partial<UiState>]),
  ];
  for (const [name, screen, state] of cases) {
    for (const [width, height] of [[120, 40], [80, 24]] as const) {
      if (state.focus === "detail" && screen !== "settings" && width >= 110) continue;
      test(`${name} at ${width}x${height}`, () => {
        const text = frame(screen, width, height, { state });
        bounded(text, width, height);
        expect(text).not.toContain("\x1b");
        expect(text).toMatchSnapshot();
      });
    }
  }
  test("setup replaces work screens while setup is incomplete", () => {
    const s = snapshot();
    const facts = { version: "0.3.0", planner: "codex", service: { installed: true, running: false }, link: true, agents: [{ id: "claude-code", name: "Claude Code", installed: true }], executors: { ranked: [], excluded: [] } };
    const checklist = setupChecklist(facts, s.at);
    s.setup = { ...checklist, open: checklist.items.filter(i => i.status !== "done").length };
    for (const [width, height] of [[120, 40], [80, 24]] as const) {
      const text = renderDashboard(s, width, height, s.at, { theme: PLAIN_THEME, state: { screen: "home" }, ops: ["service.install", "onboarding.skip"] });
      bounded(text, width, height);
      expect(text).toContain("[ Setup ]");
      expect(text).toContain("REQUIRED");
      expect(text).toMatchSnapshot();
    }
  });
  test("interactive sessions do not require delegated planner setup", () => {
    const s = snapshot();
    s.setup = { ready: false, complete: false, items: [], open: 1 } as any;
    const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, state: { screen: "sessions" }, ops: ["session.create"] });
    expect(text).toContain("[ Tasks ]");
    expect(text).not.toContain("[ Setup ]");
  });
  test("setup without a planner points to pacer init (the app's planner choice is not offered here)", () => {
    const s = snapshot();
    const facts = { version: "0.3.0", planner: null, service: { installed: true, running: true }, link: true, agents: [{ id: "codex", name: "Codex", installed: true, cliInstalled: true }], executors: { ranked: [], excluded: [] } };
    const checklist = setupChecklist(facts, s.at);
    const planner = checklist.items.find(i => i.id === "planner")!;
    expect(planner.action).toBe("setup.init");
    expect(planner.options).toEqual(["codex"]);
    s.setup = { ...checklist, open: checklist.items.filter(i => i.status !== "done").length };
    const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, state: { screen: "home" }, ops: ["service.install", "setup.init"] });
    bounded(text, 120, 40);
    expect(text).toContain("Choose which agent plans your work · pacer init");
  });
});

describe("color, plain and ASCII renditions", () => {
  for (const screen of ["home", "review", "sessions", "settings"] as const) {
    test(`${screen} in truecolor uses token colors`, () => {
      const text = frame(screen, 120, 40, { theme: detectTheme({ COLORTERM: "truecolor" }, true), state: screen === "settings" ? { focus: "detail" } : {} });
      bounded(text, 120, 40);
      expect(text).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
      expect(text).toMatchSnapshot();
    });
  }
  test("16-color selection uses reverse video and status tones", () => {
    const text = frame("home", 120, 40, { theme: detectTheme({ TERM: "xterm" }, true) });
    expect(text).toContain("\x1b[7m");
    expect(text).toContain("\x1b[31m✕ Unavailable");
    expect(text).toContain("\x1b[33m◐ Review requested");
  });
  test("plain mode drops glyphs and borders but keeps every label", () => {
    const text = frame("review", 80, 40, { theme: detectTheme({}, true, { plain: true }), state: { focus: "detail", selected:{review:"review:t-0412"} } });
    expect(text).not.toMatch(/[╭╮╰╯│━┃◐✓✕▶]/);
    expect(text).toContain("Review requested");
    expect(text).toContain("DONE WHEN");
    expect(text).toMatchSnapshot();
  });
  test("ASCII mode uses only ASCII", () => {
    const text = frame("home", 80, 24, { theme: { ...PLAIN_THEME, unicode: false } });
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
    expect(text).toMatchSnapshot();
  });
});

describe("frame behavior", () => {
  test("counts and order come from the shared selectors", () => {
    const s = snapshot(), text = renderDashboard(s, 120, 40, s.at, { noColor: true });
    expect(text).toContain(`NEEDS YOU  ${needsYou(s, { repo: null }).length}`);
    expect(text).toContain(`CAPACITY  ${counts(s)!.ready}/${counts(s)!.executors} executors ready`);
    const order = ["NEEDS YOU", "RUNNING", "CAPACITY", "DONE TODAY"].map(h => text.indexOf(h));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  test("the planner strip rounds fractional active hours", () => {
    const s = snapshot();
    s.planner!.activeHoursLeft = 9.6;
    const top = renderDashboard(s, 120, 40, s.at, { noColor: true }).split("\n")[1]!;
    expect(top).toContain("10 active-h");
    expect(top).not.toContain("9.6");
  });
  test("Needs you titles are not cut short at 120 columns", () => {
    const text = frame("home", 120, 40);
    expect(text).toContain("Fix flaky retry test in the payments client");
  });
  test("Updates says checks are off, and why, when the environment disables them", () => {
    const d = data();
    d.settings!.update = { value: { current: "0.3.1", latest: null, available: false, disabled: true } };
    const s = snapshot();
    const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: d, state: { screen: "settings", section: "updates", focus: "detail" } });
    const row = text.split("\n").find(line => line.includes("Check for updates"))!;
    expect(row).toContain("Off");
    expect(row).not.toMatch(/\bOn\b/);
    expect(row).toContain("PACER_NO_UPDATE_CHECK");
  });
  test("the key bar keeps the primary action and ? help at 80 columns, dropping middle hints whole", () => {
    for (const screen of ["home", "review", "sessions", "settings"] as const) {
      const lines = frame(screen, 80, 24).split("\n"), bar = lines.at(-1)!;
      expect(bar).toContain("? help");
      expect(bar).not.toMatch(/\S…/);
    }
  });
  test("an empty review queue does not offer details", () => {
    const s = snapshot();
    s.attention = s.attention!.filter(a => a.kind !== "review");
    const text = renderDashboard(s, 80, 24, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "review" } });
    expect(text.split("\n").at(-1)).not.toContain("details");
  });
  test("the page title appears once, in the top bar", () => {
    const text = frame("review", 120, 40);
    expect(text.split("\n")[0]).toContain("[ Needs you ]");
    expect(text.split("\n").slice(1).join("\n")).not.toContain("[ Needs you ]");
  });
  test("untrusted text cannot inject escapes and wide text stays bounded", () => {
    const s = snapshot();
    s.tasks[0]!.goal = "界".repeat(80) + "\x1b[2J";
    s.planner!.advice = "unsafe\x1b[7mreverse\x1b[0m";
    for (const width of [80, 120]) {
      const text = renderDashboard(s, width, 30, s.at, { noColor: true });
      expect(text).not.toContain("\x1b");
      bounded(text, width, 30);
    }
  });
  test("a small terminal gets a single instruction instead of a broken layout", () => {
    const s = snapshot(), text = renderDashboard(s, 50, 12, s.at, { noColor: true });
    expect(text).toContain("at least 60×16");
    bounded(text, 50, 12);
  });
  test("long lists scroll to keep the selection visible and mark hidden rows", () => {
    const s = snapshot();
    s.tasks = Array.from({ length: 20 }, (_, i) => ({ ...s.tasks[0]!, id: `t${i}`, goal: `goal ${i}`, title: `goal ${i}` }));
    const text = renderDashboard(s, 100, 24, s.at, { noColor: true, selected: 18 });
    expect(text).toContain("› ▶ Editing");
    expect(text).toContain("goal 14");
    expect(text).toMatch(/↑ \d+ more/);
  });
  test("an update and a message show in the footer", () => {
    const s = snapshot(), text = renderDashboard(s, 120, 40, s.at, { noColor: true, update: "available", message: { text: "Saved.", tone: "good" } });
    const lines = text.split("\n");
    expect(lines.at(-2)).toContain("✓ Saved.");
    expect(lines.at(-1)).toContain("update available");
  });
  test("waiting for service data reads as such", () => {
    const s = snapshot();
    s.planner = null;
    expect(renderDashboard(s, 100, 24, s.at, { noColor: true })).toContain("Planner · waiting for service data");
  });
});

describe("row keys never collide with navigation or global keys", () => {
  // reduceKey handles these before a row's own keys, so a row key using one would never fire. Inside a Settings
  // section, row keys are checked first, and ← → and l (open a section from the list) are free to use there.
  const GLOBAL = ["j", "k", "l", "h", "q", "?", "R", "f", "d", ".", ",", "1", "2", "3", "4", "5", "enter", "escape", "tab", "backtab", "up", "down", "pageup", "pagedown", "home", "end"];
  const s = snapshot();
  const checklist = setupChecklist({ version: "0.3.0", planner: "codex", service: { installed: false, running: false }, link: true, agents: [{ id: "codex", name: "Codex", installed: true, cliInstalled: true }], executors: { ranked: [{ id: "codex" }], excluded: [] } }, s.at);
  const withSetup = { ...s, setup: { ...checklist, open: checklist.items.filter(i => i.status !== "done").length } } as ClientSnapshot;
  const views: [string, ClientSnapshot, Partial<UiState>][] = [
    ["home", s, { screen: "home" }], ["review", s, { screen: "review" }], ["sessions", s, { screen: "sessions" }], ["setup", withSetup, { screen: "setup" }],
    ...SECTIONS.map(x => [`settings › ${x.label}`, s, { screen: "settings", section: x.id, focus: "detail" }] as [string, ClientSnapshot, Partial<UiState>]),
  ];
  for (const [name, snap, state] of views) {
    test(name, () => {
      const items = screenItems(snap, snap.at, { state, data: data(), ops: undefined });
      expect(items.length).toBeGreaterThan(0);
      const clashes = items.flatMap(item => Object.keys(item.keys).filter(k => GLOBAL.includes(k) && !(state.screen === "settings" && ["left", "right", "l"].includes(k))).map(k => `${item.id}: ${k}`));
      expect(clashes).toEqual([]);
    });
  }
});

describe("help overlay fits the terminal", () => {
  test("at 80x24 the help box is closed, marks hidden rows and scrolls to every key", () => {
    const at = (scroll?: number) => frame("review", 80, 24, { state: { overlay: { kind: "help", ...(scroll !== undefined ? { scroll } : {}) } } });
    const first = at();
    bounded(first, 80, 24);
    expect(first).toContain("╭ Keyboard shortcuts");
    expect(first).toContain("╰");
    expect(first).toMatch(/↓ \d+ more/);
    const last = at(99);
    bounded(last, 80, 24);
    expect(last).toContain("╰");
    expect(last).toMatch(/↑ \d+ more/);
    for (const key of ["Show worktree path", "Retry on another executor"]) expect(last).toContain(key);
  });
  test("help keys scroll the overlay and close it", () => {
    const ctx = { items: [], tabs: ["home", "review", "sessions", "settings"] as ScreenId[], page: 10, wide: false, hasDetail: false, repos: [], supports: () => true };
    const open = { ...initialState("review"), overlay: { kind: "help" as const } };
    expect(reduceKey(open, "down", ctx).state.overlay).toEqual({ kind: "help", scroll: 1 });
    expect(reduceKey(open, "j", ctx).state.overlay).toEqual({ kind: "help", scroll: 1 });
    expect(reduceKey(open, "pagedown", ctx).state.overlay).toEqual({ kind: "help", scroll: 10 });
    expect(reduceKey({ ...open, overlay: { kind: "help", scroll: 3 } }, "up", ctx).state.overlay).toEqual({ kind: "help", scroll: 2 });
    expect(reduceKey(open, "up", ctx).state.overlay).toEqual({ kind: "help", scroll: 0 });
    expect(reduceKey(open, "?", ctx).state.overlay).toBeNull();
  });
  test("help names the keys the TUI handles", () => {
    const text = frame("home", 120, 40, { state: { overlay: { kind: "help" } } });
    for (const key of ["1-4 / Tab Shift-Tab", "R / Ctrl-R", "PgUp PgDn"]) expect(text).toContain(key);
    expect(text).not.toContain("1-5");
  });
});

describe("footer update state agrees with Settings", () => {
  const footer = (update: UpdateState | undefined, width = 120) => {
    const s = snapshot();
    return renderDashboard(s, width, 40, s.at, { theme: PLAIN_THEME, version: "0.0.0-test", ...(update ? { update } : {}) }).split("\n").at(-1)!;
  };
  test("each state has its own words; an unchecked version claims nothing", () => {
    expect(footer("available")).toContain("pacer 0.0.0-test · update available");
    expect(footer("current")).toContain("pacer 0.0.0-test · up to date");
    expect(footer("disabled")).toContain("pacer 0.0.0-test · update checks off");
    expect(footer("failed")).toContain("pacer 0.0.0-test · update check failed");
    for (const text of [footer(undefined), footer("unchecked")]) {
      expect(text).toContain("pacer 0.0.0-test");
      expect(text).not.toContain("up to date");
    }
    expect(footer("disabled", 80)).toContain("update checks off");
  });
  test("updateState reads the same update.check result Settings shows", () => {
    expect(updateState(undefined)).toBe("unchecked");
    expect(updateState({ current: "1", latest: null, available: false, disabled: true })).toBe("disabled");
    expect(updateState({ current: "1", latest: null, available: false, error: "offline" })).toBe("failed");
    expect(updateState({ current: "1", latest: "2", available: true })).toBe("available");
    expect(updateState({ current: "1", latest: "1", available: false })).toBe("current");
    expect(updateState({ current: "1", latest: null, available: false })).toBe("unchecked");
    const d = data();
    d.settings!.update = { value: { current: "0.3.1", latest: null, available: false, disabled: true } };
    const s = snapshot();
    const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: d, state: { screen: "settings", section: "updates", focus: "detail" }, update: updateState(d.settings!.update.value) });
    expect(text).toContain("Update checking disabled");
    expect(text.split("\n").at(-1)).toContain("update checks off");
  });
});

describe("prose wraps instead of clipping (UI-11, UI-13)", () => {
  const body = (text: string) => text.split("\n").slice(3, -3);
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    for (const section of ["accounts", "executors", "hosts"]) {
      test(`Settings › ${section} at ${width}x${height} shows every reason in full`, () => {
        const text = frame("settings", width, height, { state: { section, focus: "detail" } });
        bounded(text, width, height);
        expect(body(text).filter(line => line.includes("…"))).toEqual([]);
      });
    }
  }
  test("Settings › Accounts keeps the disabled reason", () => {
    expect(frame("settings", 80, 24, { state: { section: "accounts", focus: "detail" } }).replace(/\s+/g, " ")).toContain("In use by 1 executor(s)");
  });
  test("the Sessions detail gets the larger pane and wraps its facts at 120x40", () => {
    const text = frame("sessions", 120, 40);
    const right = body(text).map(line => line.split("│")[1] ?? "");
    expect(right.filter(line => line.includes("…"))).toEqual([]);
    const divider = text.split("\n")[4]!.indexOf("│");
    expect(divider).toBeLessThan(60);
    expect(right.join(" ").replace(/\s+/g," ")).toContain("records the checks with the result.");
  });
  test("the narrow Sessions detail wraps and stops offering → details", () => {
    const text = frame("sessions", 80, 24, { state: { focus: "detail" } });
    bounded(text, 80, 24);
    expect(body(text).filter(line => line.includes("…"))).toEqual([]);
    expect(text.split("\n").at(-1)).not.toContain("→ details");
    expect(frame("sessions", 80, 24).split("\n").at(-1)).toContain("→ details");
  });
  for (const [width, height] of [[59, 20], [40, 16], [20, 6]] as const) {
    test(`the too-small message keeps "q quits" at ${width}x${height}`, () => {
      const s = snapshot();
      const text = renderDashboard(s, width, height, s.at, { theme: PLAIN_THEME });
      bounded(text, width, height);
      expect(text).toContain("q quits.");
    });
  }
});

describe("review queue rows carry a status word (UI-2)", () => {
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    test(`at ${width}x${height}, also in plain mode`, () => {
      for (const theme of [PLAIN_THEME, detectTheme({}, false, { plain: true })]) {
        // The queue is the left pane at wide sizes; the detail repeats the title, so only the list side counts.
        const queueRows = frame("review", width, height, { theme }).split("\n").slice(3).map(line => line.split(/│|\s\|\s/)[0]!).filter(line => /Fix flaky|Add dark mode/.test(line));
        expect(queueRows.length).toBeGreaterThanOrEqual(2);
        for (const row of queueRows) expect(row).toContain("Review requested");
      }
    });
  }
});

test("with NO_COLOR the Settings nav marks the open section while focus is in the section (UI-2)", () => {
  const nav = (state: Partial<UiState>) => frame("settings", 120, 40, { state }).split("\n").slice(3).map(line => line.split("│")[0]!);
  const detail = nav({ section: "executors", focus: "detail" });
  expect(detail.filter(line => line.includes("▸"))).toEqual([expect.stringContaining("▸ Executors")]);
  expect(nav({ section: "executors", focus: "list" }).some(line => line.includes("▸"))).toBe(false);
});

test("the Review detail wraps its status line and box prose at 120x40 and 80x24", () => {
  const wide = frame("review", 120, 40).split("\n").slice(3, -3).map(line => line.split("│").slice(1).join("│"));
  expect(wide.filter(line => line.includes("…"))).toEqual([]);
  const narrow = frame("review", 80, 24, { state: { focus: "detail" } }).split("\n").slice(3, -3);
  expect(narrow.filter(line => line.includes("…"))).toEqual([]);
});

test("Done when shows no dangling separator when the check has no extra facts", () => {
  const d = { ...data(), details: new Map([["t-0412", { value: { ...detail, acceptance: { cmd: "bun test", state: "passed" } } as TaskDetail }]]) };
  const s = snapshot();
  const text = renderDashboard(s, 120, 80, s.at, { theme: PLAIN_THEME, data: d, state: { screen: "review", selected:{review:"review:t-0412"} } });
  const line = text.split("\n").map(l=>l.slice(l.indexOf("│")+1)).find(l => l.includes("Tests passed"))!;
  expect(line).not.toMatch(/Tests passed ·/);
});

test("help labels line up in one column", () => {
  const rows = frame("review", 120, 40, { state: { overlay: { kind: "help" } } }).split("\n").filter(line => /Switch screen|Primary action|Mark accepted/.test(line));
  expect(rows).toHaveLength(3);
  const at = (line: string, label: string) => line.indexOf(label);
  expect(new Set([at(rows[0]!, "Switch screen"), at(rows[1]!, "Primary action"), at(rows[2]!, "Mark accepted")]).size).toBe(1);
});

test("Sessions list titles keep about 30 characters at 120x40 without shrinking the detail", () => {
  const text = frame("sessions", 120, 40);
  const lines = text.split("\n");
  const list = lines.slice(3, -3).map(line => line.split("│")[0]!);
  expect(list.some(line => line.includes("Add SSH keepalive to remote runs"))).toBe(true);
  expect(list.some(line => line.includes("Split the settings page into"))).toBe(true);
  for (const word of ["Editing", "Idle", "Queued", "Completed"]) expect(list.some(line => line.includes(word))).toBe(true);
  expect(lines[4]!.indexOf("│")).toBeLessThan(60);
});

describe("every Settings section wraps instead of clipping", () => {
  for (const [width, height] of [[120, 40], [80, 24]] as const) {
    for (const section of SECTIONS) {
      test(`${section.label} at ${width}x${height}`, () => {
        const text = frame("settings", width, height, { state: { section: section.id, focus: "detail" } });
        bounded(text, width, height);
        expect(text.split("\n").slice(3, -3).filter(line => line.includes("…"))).toEqual([]);
      });
    }
  }
});

describe("desktop updates in Settings › Updates", () => {
  test("show the desktop transaction and offer only advertised, confirmed actions", async () => {
    const { desktopStatus } = await import("./fixtures/desktop-update/status");
    const s = snapshot();
    s.desktopUpdates = [desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart", "check", "configure"] })];
    const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "settings", section: "updates", focus: "detail" } });
    expect(text).toContain("0.2.3 → 0.2.4");
    expect(text).toContain("Update ready");
    expect(text).toContain("Download automatically");
    const items = screenItems(s, s.at, { data: data(), state: { screen: "settings", section: "updates", focus: "detail" } });
    const primary = items.find(item => item.id === "desktop:desktop-fixture")!.primary!;
    expect(primary.confirm?.title).toContain("Restart to install 0.2.4");
    expect(primary.effect).toMatchObject({ type: "action", action: { op: "desktop.update.restart", params: { installationId: "desktop-fixture", version: "0.2.4", expectRevision: 1 } } });
    const limited = screenItems(s, s.at, { data: data(), ops: ["desktop.update.check"], state: { screen: "settings", section: "updates", focus: "detail" } });
    expect(limited.find(item => item.id === "desktop:desktop-fixture")?.primary?.effect).toMatchObject({ action: { op: "desktop.update.check" } });
  });
});

describe("desktop service adoption in the TUI", () => {
  test("the confirmation and service rows show complete paths, service and port", async () => {
    const { desktopStatus, adoptionStatus } = await import("./fixtures/desktop-update/status");
    const { wrapPath } = await import("../src/dashboard/screens/settings");
    const current = "/opt/homebrew/Cellar/pacer/0.2.3/libexec/bin/pacer-with-a-very-long-installation-directory-name/pacer";
    const replacement = "/Applications/pacer.app/Contents/Resources/pacer";
    const s = snapshot();
    s.desktopUpdates = [desktopStatus({ ownership: "attached", actions: ["adopt"], adoption: adoptionStatus({ currentServiceExecutable: current, replacementServiceExecutable: replacement }) })];
    const state = { screen: "settings" as const, section: "updates", focus: "detail" as const };
    const text = renderDashboard(s, 80, 40, s.at, { theme: PLAIN_THEME, data: data(), state });
    for (const line of wrapPath(current, 69)) expect(text).toContain(line);
    // The first wrapped line must fit after "  Current: " without truncation.
    expect(text).not.toMatch(/Current: [^\n]*…/);
    const primary = screenItems(s, s.at, { data: data(), state }).find(item => item.id === "desktop:desktop-fixture")!.primary!;
    expect(primary.confirm?.title).toBe("Use the desktop service?");
    const body = primary.confirm!.body!.join("\n");
    expect(body.replace(/\n\s*/g, "")).toContain(current);
    expect(body).toContain(replacement);
    expect(body).toMatch(/on port \d+/);
    expect(wrapPath(current, 30).every(line => line.length <= 30)).toBe(true);
    expect(wrapPath(current, 30).join("")).toBe(current);
  });
});
test("the settings section list flags desktop update attention", async () => {
  const { desktopStatus } = await import("./fixtures/desktop-update/status");
  const s = snapshot();
  s.desktopUpdates = [desktopStatus({ phase: "recovery-failed", actions: [] })];
  const text = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "settings", section: "updates" } });
  expect(text.split("\n").find(line => line.includes(" Updates"))).toContain("Updates failed");
  s.desktopUpdates = [desktopStatus({ phase: "ready", target: "0.6.0", actions: ["restart"] })];
  const waiting = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "settings", section: "updates" } });
  expect(waiting.split("\n").find(line => line.includes(" Updates"))).toContain("Updates ready");
  s.desktopUpdates = [desktopStatus({ phase: "restored", actions: [] })];
  const restored = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "settings", section: "updates" } });
  expect(restored.split("\n").find(line => line.includes(" Updates"))).toContain("Updates restored");
  // No update action, no "u update" hint.
  const idle = renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state: { screen: "settings", section: "updates", focus: "detail" } });
  expect(idle).not.toContain("u update");
});

test("Needs you includes problems and questions while successful work stays in Tasks",()=>{
 const s=snapshot();
 const items=screenItems(s,s.at,{state:{screen:"review"},data:data()});
 expect(items.some(i=>i.id.includes("failed:t-0409"))).toBe(true);
 const text=renderDashboard(s,120,40,s.at,{noColor:true,state:{screen:"review"},data:data()});
 expect(text).toContain("Needs you");
 expect(text).not.toContain("Mark accepted");
});

test("requested failed-check and partial results never bind the accept key in Tasks",()=>{
 for(const patch of [{state:'done',acceptanceState:'failed'},{state:'partial',acceptanceState:'none'}] as const){
  const s=snapshot();
  const t={...s.tasks.find(t=>t.id==='t-0412')!,...patch,reviewRequest:{note:'Check',at:s.at}};
  const items=screenItems({...s,tasks:[t]},s.at,{state:{screen:'sessions'},data:data()});
  expect(items.find(i=>i.id==='session:t-0412')?.keys.a).toBeUndefined();
 }
});

test("Settings › This machine toggles the task backend with ← →", () => {
  const s = snapshot(), state = { screen: "settings" as const, section: "machine", focus: "detail" as const };
  expect(renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: data(), state })).toMatch(/Task backend\s+‹ Direct ›/);
  const item = screenItems(s, s.at, { data: data(), state }).find(i => i.id === "setting:backend")!;
  for (const key of ["left", "right"]) expect(item.keys[key]?.effect).toMatchObject({ type: "action", action: { op: "config.set", params: { key: "execution.backend", value: "orca" } } });
  const d = data();
  (d.settings!.config!.value!.keys as Record<string, unknown>)["execution.backend"] = { value: "orca", source: "strategy.yaml" };
  expect(renderDashboard(s, 120, 40, s.at, { theme: PLAIN_THEME, data: d, state })).toMatch(/Task backend\s+‹ Orca ›/);
  expect(screenItems(s, s.at, { data: d, state }).find(i => i.id === "setting:backend")!.keys.right?.effect).toMatchObject({ action: { params: { value: "direct" } } });
});
