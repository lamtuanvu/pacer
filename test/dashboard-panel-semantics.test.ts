import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot, ClientTask } from "../src/view-model/snapshot";
import type { AttentionItem } from "../src/attention/types";
import { renderDashboard } from "../src/dashboard/render";
import { board } from "../orca-plugin/src/panel/board";

const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const review = (accepted: boolean, at: number) => ({ accepted, at, kind: null, note: null });
const doneCases = [
  { state: "done", label: "Waiting for review", glyph: "◐", tone: "warn", code: 33 },
  { state: "done", accepted: true, label: "Accepted", glyph: "✓", tone: "good", code: 32 },
  { state: "done", accepted: false, label: "Rejected", glyph: "✕", tone: "bad", code: 31 },
  { state: "failed", label: "Failed", glyph: "✕", tone: "bad", code: 31 },
  { state: "needs_input", label: "Needs your answer", glyph: "!", tone: "warn", code: 33 },
  { state: "limit", label: "Out of quota", glyph: "!", tone: "bad", code: 31 },
  { state: "future-state", label: "Unknown", glyph: "?", tone: "neutral", code: 2 },
] as const;

for (const item of doneCases) test(`TUI and panel preserve ${item.label} in completed rows`, () => {
  const s = snapshot();
  const task: ClientTask = { ...s.tasks[3]!, id: "semantic-task", title: "Semantic task", goal: "Semantic task", state: item.state, review: "accepted" in item ? review(item.accepted, s.at) : undefined, updatedAt: s.at, dismissed: false, resolved: undefined, retriedBy: undefined };
  s.tasks = [task]; s.attention = []; s.executors = [];
  const plain = renderDashboard(s, 100, 25, s.at, { selected: -1, noColor: true });
  const line = plain.split("\n").find(line => line.includes("Semantic task"))!;
  expect(line).toContain(`${item.glyph} Semantic task`);
  expect(line).toContain(item.label);
  expect(plain).not.toContain("\x1b");
  const colored = renderDashboard(s, 100, 25, s.at, { selected: -1 });
  expect(colored).toContain(`\x1b[${item.code}m${item.glyph} `);
  const html = board(s, null);
  expect(html).toContain(`class="row done ${item.tone}"`);
  expect(html).toContain(`aria-label="${item.label}">${item.glyph}</span>`);
});

const attentionCases = [
  { kind: "review", label: "Waiting for review", glyph: "◐", tone: "warn", code: 33 },
  { kind: "question", label: "Needs your answer", glyph: "!", tone: "warn", code: 33 },
  { kind: "failed", label: "Failed", glyph: "✕", tone: "bad", code: 31 },
  { kind: "limit", label: "Out of quota", glyph: "!", tone: "bad", code: 31 },
  { kind: "future-attention", label: "Needs attention", glyph: "!", tone: "warn", code: 33 },
] as const;
for (const item of attentionCases) test(`attention renders ${item.kind} with the canonical glyph and tone`, () => {
  const s = snapshot(); s.tasks = []; s.executors = [];
  s.attention = [{ ...s.attention![0]!, id: "semantic-attention", kind: item.kind as AttentionItem["kind"], title: "Attention task", detail: "Please check", actions: [], taskId: undefined, executor: undefined, host: undefined }];
  const plain = renderDashboard(s, 100, 25, s.at, { selected: -1, noColor: true });
  expect(plain.split("\n").find(line => line.includes("Attention task"))).toContain(`${item.glyph} Attention task`);
  const colored = renderDashboard(s, 100, 25, s.at, { selected: -1 });
  expect(colored).toContain(`\x1b[${item.code}m${item.glyph} `);
  const html = board(s, null);
  expect(html).toContain(`class="card stack ${item.tone}"`);
  expect(html).toContain(`aria-label="${item.label}">${item.glyph}</span>`);
});

test("attention linked to an unknown task uses its task status", () => {
  const s = snapshot();
  s.tasks = [{ ...s.tasks[3]!, state: "future-state", review: undefined }];
  s.attention = [{ ...s.attention![0]!, kind: "review", taskId: s.tasks[0]!.id, title: "Unknown task", actions: [] }];
  expect(renderDashboard(s, 100, 30, s.at, { selected: -1, noColor: true })).toContain("? Unknown task");
  expect(board(s, null)).toContain('class="neutral" title="Unknown" aria-label="Unknown">?</span>');
});

test("panel keeps full escaped display titles for running and attention rows", () => {
  const s = snapshot(), fullTitle = `Complete <title> ${"with a long phrase ".repeat(12)}finish`;
  s.tasks = [{ ...s.tasks[0]!, fullTitle, title: "Compact title", goal: "Raw goal" }];
  s.attention = [{ ...s.attention![0]!, fullTitle, title: "Compact attention" } as AttentionItem];
  const html = board(s, null), escaped = fullTitle.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  expect(html).toContain(`class="grow task-title" title="${escaped}">${escaped}</strong>`);
  expect(html).toContain(`class="task-title" title="${escaped}">${escaped}</strong>`);
  expect(html).not.toContain("Compact title");
  expect(html).not.toContain("Compact attention");
  expect(html).not.toMatch(/<script\b|\son[a-z]+\s*=/i);
});

test("legacy panel keeps the full running title with canonical phase text", async () => {
  const { renderStatusPage } = await import("../orca-plugin/src/panel");
  const s = snapshot(), fullTitle = `Legacy ${"complete phrase ".repeat(12)}title`;
  s.planner = undefined;
  s.tasks = [{ ...s.tasks[0]!, title: "Compact", fullTitle, goal: "Legacy raw goal", progress: { ...s.tasks[0]!.progress!, phase: "working" } }];
  const html = renderStatusPage(s, { nowS: s.at, reachable: true, transport: "api" });
  expect(html).toContain(`class="task-title" title="${fullTitle}">${fullTitle}</strong>`);
  expect(html).toContain(" · Editing · started ");
  expect(html).not.toContain(" · running · ");
});


test("legacy review rows retain full titles and pending review semantics", async () => {
  const { renderStatusPage } = await import("../orca-plugin/src/panel");
  const s = snapshot(), fullTitle = `Review ${"complete phrase ".repeat(12)}title`;
  s.planner = undefined;
  s.tasks = [{ ...s.tasks[3]!, title: "Compact", fullTitle, goal: "Raw review goal", state: "done", review: undefined }];
  const html = renderStatusPage(s, { nowS: s.at, reachable: true, transport: "api" });
  expect(html).toContain(`class="task-title" title="${fullTitle}">${fullTitle}</strong>`);
  expect(html).toContain('aria-label="Waiting for review">◐</span> Waiting for review');
});
