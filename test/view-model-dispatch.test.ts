import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { explainRepo, nextFromExplanation, queueReason, kpiTiles, plannerCaption, needsYouCards, periodHeading, periodRange, tokenSpread, type InsightsSummary, type RouteExplanationView } from "../src/view-model/dispatch";
import type { ClientSnapshot } from "../src/view-model/snapshot";

import { clock } from "../src/view-model/time";

const now = 1800000000;
const all = { repo: null };
const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
type Tokens = InsightsSummary["tokens"];
const summary = (tokens: Partial<Tokens> = {}, over: Partial<InsightsSummary> = {}): InsightsSummary => ({
  rootTasksHandled: 42, acceptedFirstTry: 31, reviewedRoots: 40, acceptedFirstTryRate: 31 / 40, retryAttempts: 6,
  tokens: { total: 1_840_000, measuredAttempts: 6, partialAttempts: 0, unknownAttempts: 0, attempts: 6, lowerBound: false, ...tokens },
  spread: [{ agent: "codex", total: 980_000, tasks: 4 }, { agent: "claude-code", total: 520_000, tasks: 6 }, { agent: "opencode#byteplus", total: 340_000, tasks: 2 }],
  planner: { coverage: "unknown" }, ranOutsidePlanner: null, previous: { rootTasksHandled: 34 },
  ...over,
});
const texts = (tiles: ReturnType<typeof kpiTiles>) => tiles.flatMap(tile => [tile.value, tile.delta?.text ?? "", tile.note ?? ""]).join(" ");
const unknownTokens = { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 3, attempts: 3, lowerBound: true };

test("kpi_strip_states_the_week's_root_tasks_tokens_and_first-try_acceptance", () => {
  const tiles = kpiTiles(summary(), "7d", { today: summary({}, { rootTasksHandled: 9 }) });
  expect(tiles.map(t => t.id)).toEqual(["handled", "tokens", "accepted"]);
  expect(tiles[0]).toEqual({ id: "handled", label: "Root tasks handled", value: "42", delta: { text: "+8", tone: "good" }, note: "vs last week · 9 today" });
  expect(tiles[1]).toEqual({ id: "tokens", label: "Tokens spent", value: "1.8M", delta: { text: "43.8k", tone: "neutral" }, note: "per root task" });
  expect(tiles[2]).toEqual({ id: "accepted", label: "Accepted first try", value: "78%", delta: { text: "31 of 40", tone: "neutral" }, note: "· 6 retried" });
  expect(periodHeading("7d")).toBe("This week at a glance");
});

test("kpi_strip_ran_outside_planner_only_with_planner_attribution", () => {
  // Today's service reports planner coverage unknown and ranOutsidePlanner null.
  expect(kpiTiles(summary(), "7d").some(t => t.id === "outside")).toBe(false);
  expect(kpiTiles(summary({}, { ranOutsidePlanner: 0.81 }), "7d").some(t => t.id === "outside")).toBe(false);
  const tiles = kpiTiles(summary({}, { planner: { coverage: "partial" }, ranOutsidePlanner: 0.81 }), "7d");
  expect(tiles.find(t => t.id === "outside")).toEqual({ id: "outside", label: "Ran outside planner", value: "81%", delta: { text: "1.5M", tone: "good" }, note: "tokens on 3 executors" });
});

test("kpi_strip_unknown_data_shows_no_zero_or_dash", () => {
  // Nothing measured and nothing reviewed: only the root count, with no invented token figure, rate or change.
  for (const tokens of [unknownTokens, { ...unknownTokens, total: 5, unknownAttempts: 1 }]) {
    const tiles = kpiTiles(summary(tokens, { rootTasksHandled: 0, acceptedFirstTry: 0, reviewedRoots: 0, acceptedFirstTryRate: null, retryAttempts: 0, previous: null }), "7d");
    expect(tiles.map(t => t.id)).toEqual(["handled"]);
    expect(tiles[0]).toEqual({ id: "handled", label: "Root tasks handled", value: "0" });
    expect(texts(tiles)).not.toMatch(/—|0%|tokens/);
  }
  // A lower bound is shown as one, never as an exact figure.
  const partial = kpiTiles(summary({ lowerBound: true, partialAttempts: 1 }), "today").find(t => t.id === "tokens")!;
  expect(partial.value).toBe("≥ 1.8M");
  expect(partial.delta!.text).toBe("≥ 43.8k");
  // Today has no "N today" note, and a drop is stated without a good tone.
  expect(kpiTiles(summary({}, { previous: { rootTasksHandled: 50 } }), "today", { today: summary() })[0]).toMatchObject({ delta: { text: "−8", tone: "neutral" }, note: "vs the hours before" });
});

test("period_ranges_cover_today_and_rolling_windows", () => {
  const r = periodRange("7d", now);
  expect([r.from, r.to]).toEqual([now - 7 * 86400, now]);
  expect(periodRange("30d", now).from).toBe(now - 30 * 86400);
  const t = periodRange("today", now);
  expect(t.from).toBe(t.today.from);
  expect(new Date(t.from * 1000).getHours()).toBe(0);
});

test("token_spread_hidden_without_a_reading", () => {
  expect(tokenSpread(undefined)).toBeNull();
  expect(tokenSpread(null)).toBeNull();
  expect(tokenSpread(summary(unknownTokens))).toBeNull();
  expect(tokenSpread(summary({}, { spread: [] }))).toBeNull();
  expect(tokenSpread(summary({}, { spread: [{ agent: "codex", total: 0, tasks: 1 }] }))).toBeNull();
});

test("token_spread_shares_add_to_100_on_chart_series", () => {
  const spread = tokenSpread(summary())!;
  expect(spread.partial).toBe(false);
  expect(spread.caption).toBe("1.8M tokens on 42 root tasks");
  expect(spread.segments.map(s => [s.label, s.share, s.series])).toEqual([["Codex", 53, 1], ["Claude Code", 28, 2], ["BytePlus", 19, 3]]);
  expect(spread.segments.reduce((n, s) => n + s.share, 0)).toBe(100);
  expect(spread.segments[0]).toMatchObject({ tasks: 4, tokens: "980k", role: "executor" });
  const partial = tokenSpread(summary({ lowerBound: true, partialAttempts: 1 }))!;
  expect(partial.partial).toBe(true);
  expect(partial.caption).toBe("At least 1.8M tokens on 42 root tasks · some attempts were not measured");
  expect(tokenSpread(summary({}, { planner: { coverage: "measured" }, ranOutsidePlanner: 0.84 }))!.caption).toBe("1.8M tokens on 42 root tasks · 84% ran outside the planner");
});

test("token_spread_groups_beyond_five_series", () => {
  const spread = tokenSpread(summary({ total: 2800 }, { spread: ["codex", "claude-code", "cursor", "agy", "local", "opencode#a", "opencode#b"].map((agent, i) => ({ agent, total: 700 - i * 100, tasks: 1 })) }))!;
  expect(spread.segments).toHaveLength(5);
  expect(spread.segments.at(-1)).toMatchObject({ id: "other", label: "Other agents", series: 5, tasks: 3, tokens: "600" });
  expect(spread.segments.at(-1)!.agent).toBeUndefined();
});

test("needs_you_orders_bad_before_warn_then_severity_then_oldest", () => {
  const cards = needsYouCards(snapshot(), all, { now });
  // Host down and the failed task are both bad problems, so the older one leads; then the two reviews (warn, decide), oldest first.
  expect(cards.map(c => c.id)).toEqual(["host_down:buildbox", "t-0409", "t-0412", "t-0415"]);
  expect(cards[0]).toMatchObject({ kind: "item", level: "bad" });
  expect(cards[1]).toMatchObject({ kind: "task", node: { attention: "bad" } });
  expect(cards[2]).toMatchObject({ kind: "task", node: { attention: "warn" } });
  // A blocked warn item still follows every bad card: tint first, then severity.
  const snap = snapshot();
  snap.attention!.push({ ...snap.attention!.find(a => a.id === "review:t-0415")!, id: "stuck:t-0415", kind: "stuck", severity: "blocked" });
  const order = needsYouCards(snap, all, { now }).map(c => c.id);
  expect(order.indexOf("t-0415")).toBeGreaterThan(order.indexOf("t-0409"));
  expect(order.indexOf("t-0415")).toBeLessThan(order.indexOf("t-0412"));
  expect(cards.filter(c => c.kind === "task").every(c => c.kind === "task" && c.node.attention !== "none" && !!c.node.attentionLabel)).toBe(true);
});

test("needs_you_groups_a_root's_items_and_leads_with_the_most_urgent", () => {
  const snap = snapshot();
  const review = snap.attention!.find(a => a.id === "review:t-0412")!;
  snap.attention!.push({ ...review, id: "stuck:t-0412", kind: "stuck", severity: "blocked", raisedAt: review.raisedAt + 60 });
  const card = needsYouCards(snap, all, { now }).find(c => c.id === "t-0412")!;
  expect(card.kind).toBe("task");
  if (card.kind === "task") expect(card.items.map(i => i.id)).toEqual(["stuck:t-0412", "review:t-0412"]);
});

test("needs_you_respects_repo_scope_and_keeps_repo-less_items", () => {
  const cards = needsYouCards(snapshot(), { repo: "github.com/acme/web" }, { now });
  expect(cards.some(c => c.id === "host_down:buildbox")).toBe(true);
  for (const card of cards) if (card.kind === "task") expect(snapshot().tasks.find(t => t.id === card.id)!.repo!.key).toBe("github.com/acme/web");
});

test("needs_you_item_for_an_unloaded_task_stays_a_row", () => {
  const snap = snapshot();
  snap.attention!.push({ ...snap.attention![0]!, id: "failed:gone", kind: "failed", severity: "problem", taskId: "t-gone", repo: null });
  const card = needsYouCards(snap, all, { now }).find(c => c.id === "failed:gone");
  expect(card?.kind).toBe("item");
});

test("planner caption states each measured part and the 5-hour window once", () => {
  const meter = { usedPct: 16, pacePct: 38, window: "weekly", resetsAt: null };
  expect(plannerCaption(meter, now, 4)).toBe("16% of week used · pace 38% · 5h window 4%");
  expect(plannerCaption({ ...meter, window: "5H" }, now, 4)).toBe("16% of the 5H window used · pace 38%");
  expect(plannerCaption({ usedPct: null, pacePct: null, window: null, resetsAt: null }, now)).toBe("");
});

test("the next-task explanation keeps the dispatcher's order and drops excluded and repeated runners", () => {
  const e = { outcome: "select" as const, strategy: { name: "default" }, engine: { id: "ladder" }, chosen: { runner: "codex" }, step: { id: "cheap", index: 2 },
    fallbacks: [{ runner: "codex", state: "eligible" as const }, { runner: "agy", state: "excluded" as const }, { runner: "cursor", state: "eligible" as const }, { runner: "cursor", state: "eligible" as const }],
    reasons: [] };
  expect(nextFromExplanation(e)).toEqual({ next: "codex", step: "Ladder step 3 · cheap", then: ["cursor"], strategy: "default" });
  expect(nextFromExplanation({ ...e, step: null })?.step).toBeNull();
  expect(nextFromExplanation({ ...e, outcome: "fail" })).toBeNull();
  expect(nextFromExplanation({ ...e, chosen: null })).toBeNull();
});

test("the explanation is asked for the active repository, or the only registered one", () => {
  expect(explainRepo("github.com/acme/web", [])).toBe("github.com/acme/web");
  expect(explainRepo(null, [{ key: "github.com/acme/api" }])).toBe("github.com/acme/api");
  expect(explainRepo(null, [{ key: "a" }, { key: "b" }])).toBeNull();
  expect(explainRepo(null, undefined)).toBeNull();
});

test("queue reasons skip structural exclusions, use failing reasons and format pause times", () => {
  const e: RouteExplanationView = { outcome: "queue", strategy: { name: "default" }, engine: { id: "ladder" }, chosen: null, step: null,
    fallbacks: ["planner_account", "local_grant_required", "needs_new_worktree", "executor_busy"].map(code => ({ runner: "codex", state: "excluded", reason: { code, facts: {} } })),
    reasons: [{ outcome: "fail", code: "no_step_matched", facts: {} }] };
  expect(queueReason(e, now)).toBe("Codex is busy with other work.");
  expect(queueReason({ ...e, fallbacks: e.fallbacks.slice(0, 3) }, now)).toBe("No agent qualifies for any step of the strategy.");
  expect(queueReason({ ...e, fallbacks: [], reasons: [{ outcome: "fail", code: "paused", facts: { until: now + 3600 } }] }, now)).toBe(`Dispatch is paused until ${clock(now + 3600, now)}.`);
  expect(queueReason({ ...e, fallbacks: [], reasons: [] }, now)).toBeNull();
});

test("step copy uses plain words and reserves numbered ladder prefixes for ladder steps", () => {
  const e: RouteExplanationView = { outcome: "select", engine: { id: "ladder" }, strategy: { name: "default" }, chosen: { runner: "codex" }, step: { id: "capable-with_spare-capacity", index: 0 }, fallbacks: [], reasons: [] };
  expect(nextFromExplanation(e)?.step).toBe("Ladder step 1 · capable with spare capacity");
  expect(nextFromExplanation({ ...e, step: { ...e.step!, index: -1 } })?.step).toBe("capable with spare capacity");
  expect(nextFromExplanation({ ...e, engine: { id: "plugin:custom" } })?.step).toBe("capable with spare capacity");
});

test("a paused dispatcher outranks a busy executor as the reason work waits", () => {
  const e = { outcome: "queue" as const, strategy: { name: "default" }, engine: { id: "ladder" }, chosen: null, step: null,
    fallbacks: [{ runner: "codex", state: "excluded" as const, reason: { code: "executor_busy", facts: {} } }],
    reasons: [{ outcome: "fail" as const, code: "paused", facts: {} }] };
  expect(queueReason(e, 1_800_000_000)).toBe("Dispatch is paused.");
});
