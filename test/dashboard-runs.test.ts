import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { renderDashboard, screenItems } from "../src/dashboard/render";
import { cellWidth, lineText } from "../src/dashboard/frame";
import { detectTheme, PLAIN_THEME } from "../src/dashboard/theme";
import { fit, glyph, span } from "../src/dashboard/frame";
import { computeTabBudget, fitTabBar, tabs } from "../src/dashboard/screens/shell";
import { questionFromAttention } from "../src/dashboard/screens/runs";
import { homeScreen } from "../src/dashboard/screens/home";
import { reviewScreen } from "../src/dashboard/screens/review";
import { initialState } from "../src/dashboard/state";
import { RUNS_EMPTY, RUNS_UNAVAILABLE, runLetter } from "../src/view-model/runs";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { DashData, RunSummary } from "../src/dashboard/screens/types";
import type { AttentionItem } from "../src/attention/types";
import { clock } from "../src/view-model/time";

const RUN_OPS = ["run.list", "run.get", "question.answer"] as const;

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const now = () => snapshot().at;

const sampleRuns = (): RunSummary[] => [
  {
    id: "r-aaaaaaaaaa",
    workflow: "feature",
    version: 1,
    title: "Ship the frame",
    status: "running",
    rev: 3,
    createdAt: now() - 120,
    updatedAt: now(),
    priority: "normal",
    letter: "A",
  },
  {
    id: "r-bbbbbbbbbb",
    workflow: "chore",
    version: 1,
    title: "Background tidy",
    status: "paused",
    rev: 2,
    reason: "strict pacing",
    createdAt: now() - 3600,
    updatedAt: now() - 60,
    priority: "background",
    letter: "B",
  },
];

const runQuestionAttention = (): AttentionItem => ({
  id: "question:q-1",
  kind: "question",
  severity: "blocked",
  repo: null,
  title: "Approve the plan?",
  detail: "Needs you",
  raisedAt: now() - 10,
  since: now() - 10,
  actions: [],
  notify: "important",
  unblocks: "run",
  run: { id: "r-aaaaaaaaaa", letter: "A", title: "Ship the frame", priority: "normal" },
  question: {
    id: "q-1",
    text: "Approve the plan?",
    answerType: "approve_revise",
    blocks: "step",
    rev: 1,
    options: [{ value: "approve" }, { value: "revise" }],
  },
});

const data = (runs: RunSummary[] = sampleRuns()): Partial<DashData> => ({
  details: new Map(),
  settings: {},
  runs: { value: runs },
  runDetails: new Map(),
});

const bounded = (text: string, width: number, height: number) => {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  expect(lines).toHaveLength(height);
  for (const line of lines) expect(cellWidth(line)).toBeLessThanOrEqual(width);
};

describe("Runs screen list", () => {
  test("tabs place Runs after Sessions", () => {
    const order = tabs(snapshot());
    expect(order.indexOf("runs")).toBe(order.indexOf("sessions") + 1);
  });

  test("empty state copy", () => {
    const text = renderDashboard(snapshot(), 120, 40, now(), {
      theme: PLAIN_THEME, state: { screen: "runs" }, data: data([]), ops: RUN_OPS,
    });
    expect(text).toContain(RUNS_EMPTY);
  });

  test("unavailable when run.list is absent", () => {
    const text = renderDashboard(snapshot(), 120, 40, now(), {
      theme: PLAIN_THEME, state: { screen: "runs" }, data: data([]), ops: ["task.list"],
    });
    expect(text).toContain(RUNS_UNAVAILABLE);
    expect(text).not.toContain(RUNS_EMPTY);
  });

  test("attention questions rank above run rows; background is listed", () => {
    const s = snapshot();
    s.attention = [runQuestionAttention(), ...(s.attention ?? [])];
    const text = renderDashboard(s, 120, 40, now(), {
      theme: PLAIN_THEME, state: { screen: "runs" }, data: data(), ops: RUN_OPS,
    });
    expect(text).toContain("Approve the plan?");
    expect(text).toContain("Ship the frame");
    expect(text).toContain("Background tidy");
    expect(text).toContain("strict pacing");
    const prose = text.replace(/\s+/g, " ");
    expect(prose.indexOf("Approve the plan?")).toBeLessThan(prose.indexOf("Background tidy"));
  });

  test("letter prefers stored attention letter; otherwise deterministic fallback", () => {
    const items = screenItems(snapshot(), now(), {
      state: { screen: "runs" },
      data: data([{ ...sampleRuns()[0]!, letter: "Z" }]),
      ops: RUN_OPS,
    });
    expect(items[0]?.id).toBe("run:r-aaaaaaaaaa");
    const text = renderDashboard(snapshot(), 120, 40, now(), {
      theme: PLAIN_THEME, state: { screen: "runs" },
      data: data([{ ...sampleRuns()[0]!, letter: "Z" }]),
      ops: RUN_OPS,
    });
    expect(text).toContain("Z");
    const { letter: _omit, ...letterless } = sampleRuns()[0]!;
    const fallback = renderDashboard(snapshot(), 120, 40, now(), {
      theme: PLAIN_THEME, state: { screen: "runs" },
      data: data([letterless]),
      ops: RUN_OPS,
    });
    expect(fallback).toContain(runLetter("r-aaaaaaaaaa"));
  });

  test("questionFromAttention fails closed on missing rev / answerType / bad options", () => {
    const base = runQuestionAttention();
    expect(questionFromAttention(base)).toMatchObject({ id: "q-1", rev: 1, answerType: "approve_revise" });
    expect(questionFromAttention({ ...base, question: { ...base.question!, rev: undefined as unknown as number } })).toBeUndefined();
    expect(questionFromAttention({ ...base, question: { ...base.question!, answerType: "nope" } })).toBeUndefined();
    expect(questionFromAttention({ ...base, question: { ...base.question!, options: [{ value: 1 as unknown as string }] } })).toBeUndefined();
    expect(questionFromAttention({ ...base, question: { id: "q-1", answerType: "text", rev: 2 } })).toMatchObject({ answerType: "text", rev: 2 });
    // Options-less single/multi still parse so `a` can explain (N6).
    expect(questionFromAttention({ ...base, question: { id: "q-1", answerType: "single", rev: 1 } })).toMatchObject({ answerType: "single", rev: 1 });
    expect(questionFromAttention({ ...base, question: { id: "q-1", answerType: "multi", rev: 1, options: [] } })).toMatchObject({ answerType: "multi", options: [] });
    expect(questionFromAttention({
      ...base,
      question: { id: "q-1", answerType: "single", rev: 1, options: [{ value: "a" }], stepId: "ask", attempt: 2, branch: "x" },
    })).toMatchObject({ stepId: "ask", attempt: 2, branch: "x" });
  });

  for (const [width, height] of [[120, 40], [80, 24], [60, 20]] as const) {
    test(`render snapshot at ${width}x${height}`, () => {
      const s = snapshot();
      s.attention = [runQuestionAttention()];
      const text = renderDashboard(s, width, height, now(), {
        theme: PLAIN_THEME, state: { screen: "runs" }, data: data(), version: "0.0.0-test", ops: RUN_OPS,
      });
      bounded(text, width, height);
      expect(text).not.toContain("\x1b");
      expect(text).toContain("[ Runs ]");
      expect(text).toMatchSnapshot();
    });
  }

  test("tab bar at 60 columns keeps the active tab fully named (unicode and plain)", () => {
    const tabIds = ["home", "review", "sessions", "runs", "settings", "setup"] as const;
    const badge: Partial<Record<"home" | "review" | "sessions" | "runs" | "settings" | "setup", [number, "warn" | "info" | "neutral"]>> = {
      review: [4, "warn"], sessions: [2, "info"],
    };
    for (const theme of [PLAIN_THEME, detectTheme({ PACER_PLAIN: "1" }, true, { plain: true })]) {
      // Real top-bar budget for a 60-col frame (inner = width - 2), matching shell.topBar.
      const inner = 60 - 2;
      const logo = [
        span(glyph(theme, "▬┃").slice(0, -1), { fg: "ink", bold: true }),
        span(glyph(theme, "▬┃").slice(-1), { fg: "ink", bold: true }),
        span(" pacer", { fg: "ink", bold: true }),
        span(" "),
      ];
      const live = `${glyph(theme, "●")} live ${clock(now(), now(), "UTC")}`;
      const rightFitted = fit([span(live, { fg: "good" })], Math.max(0, inner - 10), theme);
      const budget = computeTabBudget(inner, logo, rightFitted);
      const fitted = fitTabBar(theme, [...tabIds], "runs", badge, budget);
      const text = lineText(fitted);
      expect(text).toContain("[ Runs ]");
      expect(text).not.toMatch(/\[\s*Ru…/);
      expect(text).not.toMatch(/\[\s*\.\s*\]/);
      // Review/Sessions/Settings use unambiguous short forms (not bare N / T / S).
      if (text.includes("Needs")) expect(text).not.toMatch(/(^| )\bN\b( |$)/);
      if (text.includes("Tsk")) expect(text).not.toMatch(/(^| )\bT\b( |$)/);
      if (text.includes("Set")) expect(text).toMatch(/\bSet\b/);
      expect(text).toMatch(/\bNeeds\b/);
      expect(text).toMatch(/\bTsk\b/);
      expect(text).toMatch(/\bSet\b/);
      // Attention count stays on the short Needs label (e.g. Needs 4 / Needs (4)).
      expect(text).toMatch(/Needs(?:\s+\(|\s+)4\)?/);
    }
    // ready=false adds the Setup tab; complete=true avoids redirecting Runs → Setup.
    const s = snapshot();
    s.setup = { ...(s.setup as object ?? {}), ready: false, complete: true } as NonNullable<ClientSnapshot["setup"]>;
    expect(tabs(s)).toContain("setup");
    const text = renderDashboard(s, 60, 20, now(), {
      theme: detectTheme({ PACER_PLAIN: "1" }, true, { plain: true }),
      state: { screen: "runs" }, data: data(), version: "0.0.0-test", ops: RUN_OPS,
    });
    expect(text.split("\n")[0]).toContain("[ Runs ]");
    expect(text).toMatchSnapshot();
  });

  test("run.list error row uses glyph and plain copy (not raw transport message)", () => {
    const text = renderDashboard(snapshot(), 120, 40, now(), {
      theme: PLAIN_THEME,
      state: { screen: "runs" },
      data: {
        ...data(),
        runs: { value: sampleRuns(), error: { message: "injected-500-secret-token", code: "internal" }, stamp: "1" },
      },
      version: "0.0.0-test",
      ops: RUN_OPS,
    });
    expect(text).toContain("Couldn't refresh runs");
    expect(text).not.toContain("injected-500-secret-token");
  });

  test("plain confirm hint spells Enter (not bare #)", () => {
    const plain = detectTheme({ PACER_PLAIN: "1" }, true, { plain: true });
    const text = renderDashboard(snapshot(), 60, 20, now(), {
      theme: plain,
      state: {
        screen: "runs",
        overlay: {
          kind: "confirm",
          title: "Stop this run?",
          body: ["The executor will stop."],
          yes: "Stop",
          act: { label: "Stop", effect: { type: "navigate", screen: "runs" } },
        },
      },
      data: data(),
      version: "0.0.0-test",
      ops: RUN_OPS,
    });
    expect(text).toMatch(/y\/Enter\s+Stop/);
    expect(text).toContain("n/Esc Cancel");
    expect(text).not.toMatch(/y\/#\s*Stop/);
    // Footer mirrors dialog keys while confirm is open — never ⏎/Enter Answer.
    const footer = text.split("\n").at(-1) ?? "";
    expect(footer).toMatch(/y\/Enter\s+Stop/);
    expect(footer).toMatch(/n\/Esc\s+Cancel/);
    expect(footer).not.toMatch(/Answer/i);
  });
});

describe("a run question from Home or Review", () => {
  const asking = (): AttentionItem => ({
    ...runQuestionAttention(),
    actions: [{ label: "Approve", op: "question.answer", params: { id: "q-1", expect_rev: 1, answer: "approve" }, style: "primary" }],
  });
  for (const screen of ["home", "review"] as const) {
    test(`Enter on ${screen} opens the answer form instead of answering`, () => {
      const s = snapshot();
      s.attention = [asking()];
      s.tasks = [];
      const ctx = {
        s, state: initialState(screen), data: data(), theme: PLAIN_THEME, width: 120, height: 40, wide: true,
        now: now(), timeZone: "UTC", supports: () => true,
      } as unknown as Parameters<typeof homeScreen>[0];
      const view = screen === "home" ? homeScreen(ctx) : reviewScreen(ctx);
      const item = view.items.find(i => i.id === "attention:question:q-1")!;
      expect(item.primary?.effect.type).toBe("answer-form");
      // The one-key answer stays available, but only as a chosen action.
      expect(item.actions.map(a => a.label)).toContain("Approve");
    });
  }
});
