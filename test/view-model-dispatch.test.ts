import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import { glanceTiles, needsYouCards, tokenSpread, type TokenReport } from "../src/view-model/dispatch";
import type { ClientSnapshot } from "../src/view-model/snapshot";

const now = 1800000000;
const all = { repo: null };
const snapshot = () => structuredClone(fixture) as unknown as ClientSnapshot;
const report = (over: Partial<TokenReport> = {}): TokenReport => ({
  coverage: "measured", total: 1_840_000, measuredAttempts: 6, partialAttempts: 0, unknownAttempts: 0,
  byExecutor: [{ executor: "codex", tokens: 980_000, tasks: 4 }, { executor: "claude-code", tokens: 520_000, tasks: 6 }, { executor: "opencode#byteplus", tokens: 340_000, tasks: 2 }],
  ...over,
});
const texts = (tiles: ReturnType<typeof glanceTiles>) => tiles.flatMap(tile => [tile.value, tile.detail ?? ""]);

test("glance_shows_measured_counts_for_today", () => {
  const tiles = glanceTiles(snapshot(), all);
  expect(tiles.map(t => t.id)).toEqual(["finished", "accepted"]);
  expect(tiles[0]).toEqual({ id: "finished", label: "Tasks finished", value: "7", detail: "1 failed" });
  expect(tiles[1]).toEqual({ id: "accepted", label: "Accepted", value: "86%", detail: "6 of 7 reviewed" });
});

test("glance_unknown_data_shows_nothing_not_zero", () => {
  // An older service sends no daily summary and token accounting has not shipped: no tile, no "0", no "—".
  const snap = snapshot();
  delete (snap as { today?: unknown }).today;
  for (const tokens of [undefined, null, report({ coverage: "unknown", total: null }), report({ coverage: "unknown", total: 0 }), report({ coverage: "measured", total: null })]) {
    const tiles = glanceTiles(snap, all, tokens);
    expect(tiles).toEqual([]);
  }
  // Nothing reviewed yet: there is no accept rate to state.
  const quiet = snapshot();
  quiet.today = { ...quiet.today!, accepted: 0, rejected: 0, failed: 0 };
  const tiles = glanceTiles(quiet, all, null);
  expect(tiles.map(t => t.id)).toEqual(["finished"]);
  expect(texts(tiles).join(" ")).not.toMatch(/(^|\s)(0%|—)/);
  expect(tiles[0]!.detail).toBeUndefined();
});

test("glance_tokens_only_with_a_reading_and_partial_is_a_lower_bound", () => {
  expect(glanceTiles(snapshot(), all, report()).find(t => t.id === "tokens")).toEqual({ id: "tokens", label: "Tokens spent", value: "1.8M", detail: "6 attempts measured" });
  const partial = glanceTiles(snapshot(), all, report({ coverage: "partial", measuredAttempts: 2, partialAttempts: 1, unknownAttempts: 1 })).find(t => t.id === "tokens");
  expect(partial).toEqual({ id: "tokens", label: "Tokens spent", value: "≥ 1.8M", detail: "2 of 4 attempts measured" });
});

test("glance_repo_scope_uses_that_repo's_rows", () => {
  const tiles = glanceTiles(snapshot(), { repo: "github.com/acme/api" });
  expect(tiles[0]!.value).toBe("3");
});

test("token_spread_hidden_without_a_reading", () => {
  expect(tokenSpread(undefined)).toBeNull();
  expect(tokenSpread(null)).toBeNull();
  expect(tokenSpread(report({ coverage: "unknown", total: null }))).toBeNull();
  expect(tokenSpread(report({ byExecutor: [] }))).toBeNull();
  expect(tokenSpread(report({ byExecutor: [{ executor: "codex", tokens: 0, tasks: 1 }] }))).toBeNull();
});

test("token_spread_shares_add_to_100_on_chart_series", () => {
  const spread = tokenSpread(report())!;
  expect(spread.partial).toBe(false);
  expect(spread.caption).toBe("1.8M tokens");
  expect(spread.segments.map(s => [s.label, s.share, s.series])).toEqual([["Codex", 53, 1], ["Claude Code", 28, 2], ["BytePlus", 19, 3]]);
  expect(spread.segments.reduce((n, s) => n + s.share, 0)).toBe(100);
  expect(spread.segments[0]!.detail).toBe("980k tokens · 4 tasks");
  const partial = tokenSpread(report({ coverage: "partial" }))!;
  expect(partial.partial).toBe(true);
  expect(partial.caption).toBe("At least 1.8M tokens · some attempts were not measured");
});

test("token_spread_groups_beyond_five_series", () => {
  const byExecutor = ["codex", "claude-code", "cursor", "agy", "local", "opencode#a", "opencode#b"].map((executor, i) => ({ executor, tokens: 700 - i * 100, tasks: 1 }));
  const spread = tokenSpread(report({ total: 2800, byExecutor }))!;
  expect(spread.segments).toHaveLength(5);
  expect(spread.segments.at(-1)).toMatchObject({ id: "other", label: "Other agents", series: 5, detail: "600 tokens · 3 tasks" });
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
