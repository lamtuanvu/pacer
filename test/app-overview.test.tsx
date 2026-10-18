import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import type { ActivityEntry } from "../src/api/read-model/types";
import { createActionRunner } from "../app/src/data/actions";
import { OverviewView } from "../app/src/screens/Overview";

const snap = fixture as unknown as ClientSnapshot;
const runner = createActionRunner({ call: async <T,>() => ({} as T), waitFor: async () => true, refetch: () => {}, navigate: () => {} });
const activity: ActivityEntry[] = [{ id: "a1", at: snap.at - 600, kind: "mode", level: "info", text: "Mode Normal → Relaxed · planner behind pace" }];
const view = (repo: string | null = null, s: ClientSnapshot = snap) =>
  renderToString(<OverviewView snapshot={s} query={{ repo, scope: null }} now={snap.at} runner={runner} activity={activity} ops={new Set(["attention.dismiss", "task.stop"])} />);
const order = (html: string, words: string[]) => words.map(w => html.indexOf(w));

test("sections appear in the fixed order", () => {
  const html = view();
  const at = order(html, [">Needs you<", ">Running<", ">Capacity<", ">Done today<", ">Activity<"]);
  expect(at.every(i => i >= 0)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test("repo chips show counts, pressed state and the shared-budget note", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("All repos");
  expect(html).toMatch(/aria-pressed="true"[^>]*>acme\/api <span[^>]*>3</);
  expect(html).toMatch(/aria-pressed="false"[^>]*>All repos/);
  expect(html).toContain("Budgets are shared across repos; the filter only narrows work.");
});

test("a repo scope filters Needs you and Running but never Capacity", () => {
  const html = view("github.com/acme/api");
  expect(html).toContain("Retry budget refresh on 429");
  expect(html).not.toContain("Add dark mode to the web header");
  expect(html).toContain("Add SSH keepalive to remote runs");
  expect(html).not.toContain("Split the settings page into sections");
  expect(html).toContain("LM Studio is not running");
  expect(html).toContain("+1 in other repos");
});

test("a failed card has the bad tint, the glyph, the service's words and exactly its actions", () => {
  const html = view();
  // The card is the span between its own opening tag and the next card's.
  const cards = [...html.matchAll(/class="pc-attn(?: [^"]*)?"/g)].map(m => m.index!);
  const title = html.indexOf("Retry budget refresh on 429"), start = cards.filter(i => i < title).at(-1)!;
  const card = html.slice(start, cards.find(i => i > title) ?? html.length);
  expect(card).toContain("pc-attn--bad");
  expect(card).toContain("✕");
  expect(card).toContain("Failed twice on Antigravity · test timed out after 120 s");
  expect(card).toContain(">Retry on Codex<");
  expect(card).toContain(">See error<");
  expect(html.match(/>Retry on [A-Z]/g)?.length).toBe(1);
});

test("running rows show phase words, idle warning and queue reason", () => {
  const html = view();
  expect(html).toContain(">Editing<");
  expect(html).toMatch(/pc-warn-text[^>]*>idle 6m</);
  expect(html).toContain("6 files · 2 commits");
  expect(html).toContain("waiting for a slot");
  expect(html).toContain('href="#/sessions/t-0420"');
  expect(html).toContain(">Stop<");
});

test("capacity dims a down executor and gives its reason; header counts ready executors", () => {
  const html = view();
  expect(html).toContain("2/4 executors ready");
  expect(html).toMatch(/pc-cap--off[\s\S]*LM Studio is not running/);
  expect(html).toContain('href="#/settings/executors"');
  expect(html).toContain("on pace · this Mac + devbox");
});

test("done today and activity use absolute times and the service's sentences", () => {
  const html = view();
  expect(html).toContain("7 · 6 accepted");
  expect(html).toContain(">Accepted<");
  expect(html).toContain(">Rejected<");
  expect(html).toContain("Mode Normal → Relaxed · planner behind pace");
});

test("empty states say what to do next", () => {
  const empty = { ...snap, attention: [], executors: [], counts: { ...snap.counts!, attention: 0 } };
  const html = view(null, empty);
  expect(html).toContain("Nothing needs you.");
  expect(html).toContain("No executors yet.");
  expect(html).toContain('href="#/settings/add-executor"');
});
