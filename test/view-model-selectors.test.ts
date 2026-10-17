import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { AttentionItem } from "../src/api/read-model/types";
import type { ClientSnapshot as SnapshotV2 } from "../src/view-model/snapshot";
import { emptySnapshot } from "../src/link/envelope";
import { attentionOrder, capacity, counts, doneToday, needsYou, otherReposNeedingYou, plannerMeter, repos, reviewQueue, running } from "../src/view-model/selectors";

const s = fixture as unknown as SnapshotV2;
const api = { repo: "github.com/acme/api" }, all = { repo: null };

test("needsYou with a repo scope returns its items plus repo-less items", () => {
  expect(needsYou(s, api).map(a => a.id)).toEqual(["host_down:buildbox", "failed:t-0409", "review:t-0412"]);
  expect(needsYou(s, all).length).toBe(4);
});

test("attention order: blocked, then problems, then decisions, oldest first", () => {
  const item = (id: string, severity: AttentionItem["severity"], raisedAt: number) => ({ id, severity, raisedAt }) as AttentionItem;
  expect([item("d", "decide", 1), item("p2", "problem", 9), item("b", "blocked", 50), item("p1", "problem", 3)].sort(attentionOrder).map(a => a.id)).toEqual(["b", "p1", "p2", "d"]);
});

test("snoozed items are hidden until the snooze ends", () => {
  const snoozed = { ...s, attention: [{ ...s.attention![0]!, snoozedUntil: s.at + 60 }, { ...s.attention![1]!, snoozedUntil: s.at - 60 }] };
  expect(needsYou(snoozed, all).map(a => a.id)).toEqual(["failed:t-0409"]);
});

test("otherReposNeedingYou counts what the filter hides", () => {
  expect(otherReposNeedingYou(s, api)).toBe(1);
  expect(otherReposNeedingYou(s, all)).toBe(0);
});

test("running excludes settled, dismissed and other repos", () => {
  expect(running(s, all).map(t => t.id)).toEqual(["t-0420", "t-0421", "t-0422"]);
  expect(running(s, api).map(t => t.id)).toEqual(["t-0420"]);
  const dismissed = { ...s, tasks: s.tasks.map(t => t.id === "t-0421" ? { ...t, dismissed: true } : t) };
  expect(running(dismissed, all).map(t => t.id)).toEqual(["t-0420", "t-0422"]);
});

test("capacity is never filtered and keeps the service's order", () => {
  expect(capacity(s).map(e => e.id)).toEqual(["claude-code", "codex#team@devbox", "cursor", "agy", "local"]);
});

test("doneToday is settled work since local midnight, newest first", () => {
  expect(doneToday(s, all).map(t => t.id)).toEqual(["t-0409", "t-0415", "t-0412", "t-0405", "t-0403"]);
  expect(doneToday(s, api).map(t => t.id)).toEqual(["t-0409", "t-0412"]);
});

test("reviewQueue is review items, oldest first", () => {
  expect(reviewQueue(s).map(a => a.id)).toEqual(["review:t-0412", "review:t-0415"]);
});

test("counts, repos and planner pass through", () => {
  expect(counts(s)?.review).toBe(2);
  expect(repos(s).map(r => r.label)).toEqual(["acme/api", "acme/web", "pacer"]);
  expect(plannerMeter(s)?.verdict).toBe("behind");
});

test("selectors return empty results for a 2.0 snapshot", () => {
  const old = emptySnapshot() as unknown as SnapshotV2;
  expect([needsYou(old, all), capacity(old), doneToday(old, all), reviewQueue(old), repos(old)]).toEqual([[], [], [], [], []]);
  expect([counts(old), plannerMeter(old), otherReposNeedingYou(old, api)]).toEqual([null, null, 0]);
});

test("selectors are memoised per snapshot and scope", () => {
  expect(needsYou(s, { repo: "x" })).toBe(needsYou(s, { repo: "x" }));
  expect(running(s, all)).toBe(running(s, { repo: null }));
  expect(needsYou(s, api)).not.toBe(needsYou({ ...s }, api));
});
