import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import taskGet from "./fixtures/ui/task-get.json";
import settingsFixture from "./fixtures/ui/tui-settings.json";
import { renderDashboard } from "../src/dashboard/render";
import { cellWidth } from "../src/dashboard/frame";
import { setupChecklist } from "../src/setup/checklist";
import { counts, needsYou } from "../src/view-model/selectors";
import { detectTheme, PLAIN_THEME } from "../src/dashboard/theme";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { DashData, SettingsData, TaskDetail } from "../src/dashboard/screens/types";
import type { ScreenId, UiState } from "../src/dashboard/state";
import { SECTIONS } from "../src/dashboard/screens/settings";

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
    const facts = { version: "0.3.0", planner: "codex", service: { installed: true, running: false }, link: true, live: true, agents: [{ id: "claude-code", name: "Claude Code", installed: true }], executors: { ranked: [], excluded: [] } };
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
  test("setup without a planner points to pacer init (the app's planner choice is not offered here)", () => {
    const s = snapshot();
    const facts = { version: "0.3.0", planner: null, service: { installed: true, running: true }, link: true, live: true, agents: [{ id: "codex", name: "Codex", installed: true, cliInstalled: true }], executors: { ranked: [], excluded: [] } };
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
    expect(text).toContain("\x1b[33m◐ Waiting for review");
  });
  test("plain mode drops glyphs and borders but keeps every label", () => {
    const text = frame("review", 80, 40, { theme: detectTheme({}, true, { plain: true }), state: { focus: "detail" } });
    expect(text).not.toMatch(/[╭╮╰╯│━┃◐✓✕▶]/);
    expect(text).toContain("Waiting for review");
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
    expect(text.split("\n")[0]).toContain("[ Review ]");
    expect(text.split("\n").slice(1).join("\n")).not.toContain("[ Review ]");
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
