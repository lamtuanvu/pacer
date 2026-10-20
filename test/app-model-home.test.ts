import { expect, test } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { homeModel } from "../app/src/model/home";

test("home derives planner pace without treating missing quota as zero", () => {
  expect(homeModel(emptySnapshot(), []).planner).toBeNull();
  const snapshot = { ...emptySnapshot(), budget: { generatedAt: 1, planner: "claude-code", strategy: "default", mode: "strict", providers: [{ id: "claude-code", verdict: "AHEAD", usedPct: 70, pacePct: 40, resetsAt: 900, window: "weekly", stale: false }], ranked: [] } };
  const model = homeModel(snapshot, []);
  expect(model.planner).toMatchObject({ used: 70, pace: 40, tone: "warn", resetsAt: 900 });
  expect(model.mode).toBe("strict");
  expect(model.headline).toContain("ahead of pace");
});

test("attention includes unreviewed work, limits and broken runners once; running excludes dismissed", () => {
  const task = { reviewRequest:{note:"Check",at:1}, id: "t1", goal: "Review me", state: "done", executor: "codex", backend: null, worktree: null, updatedAt: 1 };
  const snapshot = { ...emptySnapshot(), tasks: [task, { ...task, id: "t2", review: { accepted: true, kind: null, note: null, at: 1 } }, { ...task, id: "t3", state: "running" }] };
  const model = homeModel(snapshot, [{ id: "cursor", state: "exhausted", until: 900, reason: null }, { id: "local", state: "broken", until: null, reason: "Key rejected" }]);
  expect(model.attention.map(a => a.label)).toEqual(["Review", "Limit", "Not working"]);
  expect(model.attention[0]?.href).toBe("#/tasks/t1");
  expect(model.attention[2]?.detail).toContain("Key rejected");
  expect(model.running.map(t => t.id)).toEqual(["t3"]);
});

test("planner tone comes from the service verdict, not from used minus pace", () => {
  const snapshot = { ...emptySnapshot(), budget: { generatedAt: 1, planner: "claude-code", strategy: "default", mode: "normal", providers: [{ id: "claude-code", verdict: "ON_PACE", usedPct: 70, pacePct: 40, resetsAt: 900, window: "weekly", stale: false }], ranked: [] } };
  expect(homeModel(snapshot, []).planner).toMatchObject({ tone: "good", label: "On pace" });
});

test("planner label uses the verdict's own words", () => {
  const at = (verdict: string) => homeModel({ ...emptySnapshot(), budget: { generatedAt: 1, planner: "claude-code", strategy: "default", mode: "normal", providers: [{ id: "claude-code", verdict, usedPct: 70, pacePct: 40, resetsAt: 900, window: "weekly", stale: false }], ranked: [] } }, []).planner?.label;
  expect([at("NEAR_LIMIT"), at("AHEAD"), at("EXHAUSTED"), at("ON_PACE"), at("WEIRD")]).toEqual(["Near limit", "Ahead of pace", "Out of quota", "On pace", "Usage unknown"]);
});

test("service attention preserves order and text and suppresses local heuristics", () => {
  const item = { id: "update:2", kind: "update" as const, severity: "decide" as const, repo: null, title: "Install update", detail: "From service", raisedAt: 1, since: 1, notify: "all" as const, actions: [{ label: "Settings", op: "ui.open", params: { view: "settings" } }] };
  const snapshot = { ...emptySnapshot(), attention: [item, { ...item, id: "setup:x", title: "Finish setup" }] };
  const runners = [{ id: "local", state: "broken" as const, until: null, reason: "Broken" }];
  expect(homeModel(snapshot, runners).attention.map(a => a.key)).toEqual(["update:2", "setup:x"]);
  expect(homeModel(snapshot, runners).attention[0]).toMatchObject({ title: item.title, detail: item.detail, href: "#/settings", actions: item.actions });
  expect(homeModel({ ...snapshot, attention: [] }, runners).attention).toEqual([]);
});

test("home reads the planner meter from a 2.x service and needs no budget", () => {
  const planner = { runner: "claude-code", agent: "claude-code", usedPct: 63, pacePct: 77, deltaPts: -14, verdict: "behind" as const, activeHoursLeft: 10, resetsAt: 900, window: "weekly", stale: false, advice: "14 pts under pace — spend it.", mode: "relaxed" };
  const model = homeModel({ ...emptySnapshot(), budget: null, mode: null, planner }, []);
  expect(model.planner).toMatchObject({ name: "Claude Code", used: 63, pace: 77, resetsAt: 900, window: "weekly", tone: "good", label: "Behind pace" });
  expect(model.mode).toBe("relaxed");
  expect(model.headline).toBe("You're on pace. Room for normal planning.");
  const out = homeModel({ ...emptySnapshot(), budget: null, planner: { ...planner, verdict: "out" as const } }, []);
  expect(out.planner).toMatchObject({ tone: "bad", label: "Out of quota" });
  expect(homeModel({ ...emptySnapshot(), budget: null, planner: { ...planner, usedPct: null, verdict: "unknown" as const } }, []).planner).toMatchObject({ tone: "neutral", label: "Usage unknown" });
});

test("home prefers the planner meter over the old budget when a service sends both", () => {
  const budget = { generatedAt: 1, planner: "codex", strategy: "default", mode: "strict", providers: [{ id: "codex", verdict: "AHEAD", usedPct: 90, pacePct: 40, resetsAt: 1, window: "5h", stale: false }], ranked: [] };
  const planner = { runner: "claude-code", agent: "claude-code", usedPct: 20, pacePct: 30, deltaPts: -10, verdict: "on_pace" as const, activeHoursLeft: 1, resetsAt: 2, window: "weekly", stale: true, advice: "", mode: "normal" };
  expect(homeModel({ ...emptySnapshot(), budget, planner }, []).planner).toMatchObject({ name: "Claude Code", used: 20, stale: true, tone: "good" });
});
