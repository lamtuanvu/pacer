import { expect, test } from "bun:test";
import type { ModelRecord, TierTargets } from "../src/dispatch/types";
import { fallbackTier } from "../src/dispatch/tier-fallback";
import { addLabel, canTakeWork, compareProfiles, isRankable, joinNames, listAvailability, overviewModel, profileFacts, profileRowFacts, profileSide, rulesSummary, type HubAgent, type ProfilePreview } from "../app/src/model/dispatcher-hub";

const targets: TierTargets = { simple: "small", standard: "medium", complex: "frontier" };
const record = (runner: string, id: string | null, tier: ModelRecord["tier"]): ModelRecord => ({
  runner, account: runner.split("#")[1] ?? runner, executor: runner.split("#")[0]!, binding: id ? { kind: "exact", id } : { kind: "executor-default" },
  actualModel: null, tier, strengths: [], provenance: "declared",
}) as ModelRecord;
const agent = (runner: string, name: string, availability: "takes" | "skipped" | "off" | "blocked" = "takes", reason = "Ready to take work"): HubAgent =>
  ({ runner, name, readiness: { label: { takes: "Ready", skipped: "Skipped", off: "Off", blocked: "Cannot take work" }[availability], tone: "good", reason, availability } });
const ready = (runner: string, name: string) => agent(runner, name);
const off = (runner: string, name: string) => agent(runner, name, "off", "Takes work is turned off");
const quota = (runner: string, name: string) => agent(runner, name, "blocked", "Out of quota");

const planner = record("claude-code", "opus", "frontier");
const tse = record("opencode#tse", "terastor-ai", "medium");
const goSmall = record("opencode#go", "iceman", "small"), goMedium = record("opencode#go", "hy4-flash", "medium");
const local = record("opencode#local", "qwen3.6", "unknown");
const codex = record("codex", null, "unknown");
const agents = [ready("claude-code", "Claude Code"), ready("opencode#tse", "tse"), ready("opencode#go", "oc-go"), ready("opencode#local", "Local model"), quota("codex", "Codex")];

test("B1: the planner fallback covers complex tasks only, as fallbackTier says; standard below target goes to the small executor", () => {
  expect(fallbackTier("standard", targets)).toBeUndefined();
  expect(fallbackTier("complex", targets)).toBe("frontier");
  const model = overviewModel({ records: [planner, goSmall], targets, agents: [ready("claude-code", "Claude Code"), ready("opencode#go", "oc-go")], plannerRunner: "claude-code", fallbackOn: true, defaults: { "opencode#go": "iceman" } });
  const [simple, standard, complex] = model.tiles;
  expect(simple).toMatchObject({ planner: false, count: "1 agent", agents: ["opencode#go"], who: "oc-go (iceman)" });
  expect(standard).toMatchObject({ planner: false, below: true, count: "1 agent", agents: ["opencode#go"], who: "oc-go (iceman, smaller than medium)" });
  expect(complex).toMatchObject({ planner: true, count: "Planner", agents: ["claude-code"], who: "Claude Code on opus, through the planner fallback" });
  expect(model.summary.headline).toBe("Complex tasks go to the planner.");
  expect(model.summary.consequence).toBe("Claude Code runs them on opus and spends planner quota. Give an agent in the default list a frontier model to keep the planner free.");
  expect(model.summary.action).toEqual({ label: "Add a frontier model", agent: "opencode#go" });
  expect(model.summary.secondary).toEqual({ label: "Planner fallback settings", agent: "claude-code" });
  const plannerRow = model.rows.find(row => row.planner)!;
  expect(plannerRow.cells.map(cell => cell.note)).toEqual(["Not used: the planner fallback covers complex tasks only", "Not used: the planner fallback covers complex tasks only", "Fallback: no agent in the default list has a frontier model"]);
  const go = model.rows.find(row => row.runner === "opencode#go")!;
  expect(go.cells.map(cell => [cell.model, cell.note])).toEqual([["iceman", "Matches"], ["iceman", "Smaller than medium: runs its default"], ["iceman", "Smaller than frontier: runs its default"]]);
});

test("F4: a below-target agent without a configured default still names its default model", () => {
  const model = overviewModel({ records: [goSmall], targets, agents: [ready("opencode#go", "oc-go")], plannerRunner: null, fallbackOn: true });
  const go = model.rows[0]!;
  expect(go.cells[1]).toEqual({ difficulty: "standard", model: "default model", note: "Smaller than medium: runs its default", muted: true });
  expect(model.summary.headline).toBe("Standard and complex tasks run on models smaller than they need.");
});

test("S3: only the default list counts; an agent outside it is marked and never covers a difficulty", () => {
  const cursor = record("cursor", "big", "frontier");
  const model = overviewModel({ records: [planner, goSmall, cursor], targets, agents: [ready("claude-code", "Claude Code"), ready("opencode#go", "oc-go"), ready("cursor", "Cursor")], plannerRunner: "claude-code", fallbackOn: true, defaultList: ["opencode#go"] });
  expect(model.tiles[2]).toMatchObject({ planner: true });
  expect(model.rows.find(row => row.runner === "cursor")).toMatchObject({ listed: false, canTake: false });
  expect(model.coverage.complex).toBe("Only the planner has a frontier model");
  expect(model.coverage.simple).toBe("1 agent in the default list has a small or larger model");
  // With the list unknown (an older service), every agent counts as listed.
  expect(overviewModel({ records: [planner, goSmall, cursor], targets, agents: [], plannerRunner: "claude-code", fallbackOn: true }).tiles[2]!.planner).toBe(false);
});

test("the agents table and tiles name who gets each difficulty and on which model", () => {
  const model = overviewModel({ records: [planner, tse, goSmall, goMedium, local, codex], targets, agents, plannerRunner: "claude-code", fallbackOn: true, defaults: { codex: "gpt-5.5" } });
  expect(model.tiles.map(tile => tile.who)).toEqual([
    "oc-go (iceman), tse (terastor-ai), Local model (qwen3.6, unrated)",
    "tse (terastor-ai), oc-go (hy4-flash), Local model (qwen3.6, unrated)",
    "Claude Code on opus, through the planner fallback",
  ]);
  expect(model.tiles[0]!.count).toBe("2 agents");
  const row = (runner: string) => model.rows.find(item => item.runner === runner)!;
  expect(row("opencode#tse").cells.map(cell => [cell.model, cell.note])).toEqual([
    ["terastor-ai", "Larger than needed, used when nothing smaller is free"], ["terastor-ai", "Matches"], ["default model", "Smaller than frontier: runs its default"]]);
  expect(row("opencode#local")).toMatchObject({ behavior: "unrated", canRate: true, flat: { pill: "Unrated", tone: "warn" } });
  expect(row("opencode#local").cells.map(cell => cell.model)).toEqual(["qwen3.6", "qwen3.6", "qwen3.6"]);
  expect(row("opencode#local").cells[0]!.note).toBe("Same for every difficulty");
  expect(row("codex")).toMatchObject({ behavior: "fixed", canTake: false, canRate: false, flat: { pill: "Picks its own" } });
  expect(row("codex").cells[0]!.model).toBe("gpt-5.5");
  expect(model.counts).toEqual({ all: 5, follow: 3, unrated: 1, fixed: 1 });
  expect(model.coverage).toEqual({ simple: "2 agents in the default list have a small or larger model", standard: "2 agents in the default list have a medium or larger model", complex: "Only the planner has a frontier model" });
});

test("S7: a Skipped agent is ranked for the planner fallback but not counted as taking work", () => {
  const skipped = agent("opencode#go", "oc-go", "skipped", "Usage reading needs refreshing");
  expect(canTakeWork(skipped)).toBe(false);
  expect(isRankable(skipped)).toBe(true);
  expect(canTakeWork(undefined)).toBe(true);
  const model = overviewModel({ records: [planner, record("opencode#go", "big", "frontier")], targets, agents: [ready("claude-code", "Claude Code"), skipped], plannerRunner: "claude-code", fallbackOn: true });
  // The engine ranks the skipped frontier agent, so the planner does not take complex work; the work goes to the
  // skipped agent as an unconfirmed fallback rather than waiting (as `pacer route` shows).
  expect(model.tiles[2]).toMatchObject({ planner: false, nobody: false, count: "1 agent", who: "oc-go (big, unconfirmed)" });
  expect(rulesSummary({ list: ["opencode#go"], agents: [skipped], available: [], repoLists: 0 }).consequence)
    .toBe("oc-go is skipped until its usage reading is refreshed, so tasks go to oc-go as an unconfirmed fallback.");
});

test("a planner fallback that is off, or a planner without a sized model, never takes work", () => {
  const offModel = overviewModel({ records: [planner, tse], targets, agents, plannerRunner: "claude-code", fallbackOn: false });
  expect(offModel.tiles[2]).toMatchObject({ planner: false, below: true });
  expect(offModel.rows[0]!.cells[2]!.note).toBe("Not used: the planner fallback is off");
  const unsized = overviewModel({ records: [record("claude-code", "opus", "unknown"), tse], targets, agents, plannerRunner: "claude-code", fallbackOn: true });
  expect(unsized.rows[0]).toMatchObject({ planner: true, behavior: "unrated" });
  expect(unsized.tiles[2]!.planner).toBe(false);
});

test("Right now covers no agents, no sizes, waiting work and the steered case", () => {
  expect(overviewModel({ records: [], targets, agents: [], plannerRunner: null, fallbackOn: true }).summary)
    .toEqual({ headline: "No agent can take delegated work yet.", consequence: "Add an agent so Pacer has someone to hand tasks to.", action: { label: "Add an agent", addAgent: true } });
  const unsteered = overviewModel({ records: [local, codex], targets, agents: [ready("opencode#local", "Local model"), ready("codex", "Codex")], plannerRunner: null, fallbackOn: true }).summary;
  expect(unsteered.headline).toBe("Every task gets the same model, whatever its difficulty.");
  expect(unsteered.consequence).toBe("1 agent runs a model without a size, and 1 agent picks its own model. Set a size on a model so difficulty can steer it.");
  expect(unsteered.action).toEqual({ label: "Set model sizes", agent: "opencode#local" });
  const steered = overviewModel({ records: [goSmall, goMedium, record("opencode#tse", "big", "frontier"), local], targets, agents: [ready("opencode#go", "oc-go"), ready("opencode#tse", "tse"), ready("opencode#local", "Local model")], plannerRunner: null, fallbackOn: true }).summary;
  expect(steered.headline).toBe("Each difficulty gets a model of the size it needs.");
  expect(steered.consequence).toBe("Local model runs one model for every difficulty until you set its size.");
  expect(steered.action).toEqual({ label: "Set its size", agent: "opencode#local" });
  const waiting = overviewModel({ records: [goSmall], targets, agents: [off("opencode#go", "oc-go")], plannerRunner: null, fallbackOn: true }).summary;
  expect(waiting).toMatchObject({ headline: "Simple, standard and complex tasks wait in the queue.", action: { label: "Open Who can run what", rules: true } });
  // An agent the snapshot does not list keeps its readable name, never its raw id.
  expect(overviewModel({ records: [record("claude-code#claude1", null, "unknown")], targets, agents: [], plannerRunner: null, fallbackOn: true }).rows[0]!.name).toBe("Claude Code · claude1");
});

test("Who can run what explains the default list, why others are not taking work and who is not listed", () => {
  const people = [quota("codex", "Codex"), quota("cursor", "Cursor"), off("agy", "Antigravity"), off("opencode#byteplus", "BytePlus"), ready("opencode#local", "Local model"), ready("opencode#tse", "tse"), ready("opencode#go", "oc-go"), ready("claude-code", "Claude Code"),
    agent("opencode#slow", "slow", "skipped", "Usage reading is 3h old")];
  const summary = rulesSummary({ list: ["claude-code", "codex", "cursor", "agy", "opencode#byteplus", "opencode#local", "opencode#slow"], agents: people, available: ["codex", "cursor", "agy", "opencode#byteplus", "opencode#local", "opencode#tse", "opencode#go", "claude-code", "opencode#gone"], plannerRunner: "claude-code", repoLists: 1 });
  // The planner is left out: it takes work only through the fallback.
  expect(summary.headline).toBe("Only 1 agent of 6 in the default list can take work.");
  expect(summary.consequence).toBe("Codex and Cursor are out of quota, Antigravity and BytePlus are off and slow is skipped until its usage reading is refreshed, so tasks outside repositories with their own list go to Local model. tse and oc-go can take work but aren't in this list.");
  expect(summary).toMatchObject({ add: ["opencode#tse", "opencode#go"], skipped: ["opencode#slow"], action: { label: "Add tse and oc-go" } });
  const all = rulesSummary({ list: ["opencode#tse", "opencode#go"], agents: people, available: ["opencode#tse", "opencode#go"], repoLists: 0 });
  expect(all.headline).toBe("All 2 agents in the default list can take work.");
  expect(all.consequence).toBe("Tasks go to tse and oc-go, in the order Pacer chooses.");
  // S5: while the repository lists are unknown the qualifier stays.
  expect(rulesSummary({ list: ["opencode#tse"], agents: people, available: [] }).consequence).toBe("Tasks outside repositories with their own list go to tse.");
  const none = rulesSummary({ list: ["codex"], agents: people, available: ["codex"], repoLists: 0 });
  expect(none.headline).toBe("No agent in the default list can take work right now.");
  expect(none.consequence).toBe("Codex is out of quota, so tasks wait in the queue.");
  expect(rulesSummary({ list: [], agents: people, available: [], repoLists: 0 }).consequence).toBe("Add an agent to it, or tasks wait in the queue.");
  expect(addLabel(["A", "B", "C", "D"])).toBe("Add 4 agents");
  expect(addLabel(["oc-go"])).toBe("Add oc-go");
});

test("repository lists count who is taking work; Skipped, Off and Cannot take work do not count", () => {
  const people = [ready("a", "A"), off("b", "B"), quota("c", "C"), agent("d", "D", "skipped", "Refresh to confirm availability")];
  expect(listAvailability(["a", "b", "c", "d"], people)).toEqual({ text: "1 of 4 can take work", tone: "warn" });
  expect(listAvailability(["b"], people)).toEqual({ text: "0 of 1 can take work", tone: "bad" });
  expect(listAvailability(["a"], people)).toEqual({ text: "1 of 1 can take work", tone: "good" });
});

// Profiles read the YAML strategy.preview returns (Bun.YAML.stringify(raw, null, 2) in src/strategy/service.ts).
const yaml = (raw: Record<string, unknown>) => Bun.YAML.stringify(raw, null, 2);
const base = { planner: "claude-code", pacing: { policy: "priority", planner_reserve: 15 }, routing: [{ kinds: ["docs"], executors: ["codex", "cursor"] }, { executors: ["codex", "cursor"] }],
  runners: { "claude-code": { models: [{ id: "opus", tier: "frontier" }, { id: "sonnet", tier: "medium" }] } } };
const side = (raw: Record<string, unknown>, ranking: string[] = ["codex", "cursor"]) => profileSide({ ok: true, yaml: yaml(raw), ranking: { current: [], draft: ranking }, routing: { current: [], draft: raw.routing as never } })!;
const label = (id: string) => ({ codex: "Codex", cursor: "Cursor", "opencode#local": "Local model", "claude-code": "Claude Code", "claude-code#claude1": "Claude Code · claude1" })[id] ?? id;

test("S1: profile facts come from a real YAML parse, for string and object planners and the defaults", () => {
  expect(profileFacts(yaml({ ...base, pacing: { policy: "cheapest-first", planner_reserve: 30, planner_tier_fallback: "off" }, dispatch: { tierTargets: { simple: "medium", standard: "frontier", complex: "frontier" } } })))
    .toMatchObject({ planner: "claude-code", policy: "cheapest-first", reserve: 30, fallback: "off", targets: { simple: "medium", standard: "frontier", complex: "frontier" },
      method: "A capable model with spare capacity, then Any usable fallback; if nobody fits, waits", models: { "claude-code": "opus (frontier), sonnet (medium)" } });
  expect(profileFacts(yaml({ planner: { agent: "claude-code", account: "claude1" } }))!.planner).toBe("claude-code#claude1");
  expect(profileFacts(yaml({ planner: { agent: "codex", account: "codex" } }))!.planner).toBe("codex");
  expect(profileFacts("planner: codex\npacing: {policy: even, planner_reserve: 20}\n")).toMatchObject({ planner: "codex", policy: "even", reserve: 20, fallback: "on", targets });
  expect(profileFacts("planner: [unterminated")).toBeNull();
});

test("B2/S2: the comparison covers the lists by name, the choice method and each agent's models", () => {
  const cheap = { ...base, pacing: { policy: "cheapest-first", planner_reserve: 15 }, routing: [{ kinds: ["docs"], executors: ["opencode#local", "cursor"] }, { executors: ["opencode#local", "codex"] }] };
  const result = compareProfiles({ active: side(base), target: side(cheap, ["opencode#local", "codex"]), label });
  expect(result.changes).toEqual([
    { what: "Default list", from: "Codex, Cursor", to: "Local model, Codex" },
    { what: "Task-kind lists", from: "docs: Codex, Cursor", to: "docs: Local model, Cursor" },
    { what: "Pacing", from: "Priority: Codex, Cursor", to: "Cheapest first: Local model, Codex" },
  ]);
  expect(result.unchanged).toEqual(["the planner (Claude Code)", "the planner keeps 15% back", "the choice method", "model sizes for each difficulty", "the planner fallback (on)", "each agent's models", "repository lists"]);
  // A profile made with Edit choice method differs only in its ladder.
  const ladder = compareProfiles({ active: side(base), target: side({ ...base, dispatch: { steps: [{ id: "usable-fallback" }, { id: "capable-with-headroom" }], onNoMatch: "fail" } }), label });
  expect(ladder.changes).toEqual([{ what: "Choice method", from: "A capable model with spare capacity, then Any usable fallback; if nobody fits, waits", to: "Any usable fallback, then A capable model with spare capacity; if nobody fits, reports it" }]);
  // A profile that differs only in an agent's models.
  const models = compareProfiles({ active: side(base), target: side({ ...base, runners: { "claude-code": { models: [{ id: "opus", tier: "frontier" }] } } }), label });
  expect(models.changes).toEqual([{ what: "Claude Code models", from: "opus (frontier), sonnet (medium)", to: "opus (frontier)" }]);
  expect(models.unchanged).not.toContain("each agent's models");
  // Nothing differs: no change rows at all.
  expect(compareProfiles({ active: side(base), target: side(base), label }).changes).toEqual([]);
  expect(profileSide({ ok: false, errors: ["bad"], yaml: "", ranking: { current: [], draft: [] }, routing: { current: [], draft: [] } } as ProfilePreview)).toBeNull();
});

test("S6: profile rows split the summary into First, the planner reserve and the policy, with agent names", () => {
  expect(profileRowFacts("Codex (team) first, Claude Code keeps 15%; burn-before-reset policy")).toEqual({ first: "Codex · team", reserve: 15, policy: "Burn before reset" });
  expect(profileRowFacts("Codex first, Codex keeps 30%")).toEqual({ first: "Codex", reserve: 30, policy: "Priority" });
  expect(profileRowFacts("Configured executors, Codex keeps 10%; odd policy")).toEqual({ reserve: 10, policy: "Custom" });
  expect(profileRowFacts("Invalid or missing strategy")).toBeNull();
  expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
});

test("NEW-1: a listed frontier agent that is exhausted with a stale reading does not stop the planner fallback", async () => {
  const { executorReadiness } = await import("../src/view-model/capacity");
  const eligibility = { state: "ineligible", reasons: [{ code: "budget_exhausted", evidenceIds: [] }], evaluatedAt: 0, validUntil: null, evidenceAgeS: null, availability: "unavailable", budget: "exhausted", spendingRisk: "unknown" };
  const row = { id: "cursor", agent: "cursor", account: "cursor", host: null, model: null, rank: 1, enabled: true, state: "exhausted", stale: true, tone: "bad", sub: "", usedPct: null, pacePct: null, slots: { used: 0, max: 1 }, lastCheck: null, recentFailures: 0, next: false, eligibility };
  const readiness = executorReadiness(row as never, { at: 1800000000, executors: [row], accounts: [] } as never);
  expect(readiness.availability).toBe("blocked");
  const model = overviewModel({ records: [planner, record("cursor", "big", "frontier")], targets, agents: [ready("claude-code", "Claude Code"), { runner: "cursor", name: "Cursor", readiness }], plannerRunner: "claude-code", fallbackOn: true, defaultList: ["cursor"] });
  expect(model.tiles[2]).toMatchObject({ planner: true, count: "Planner" });
  expect(model.tiles.map(tile => tile.who).join(" ")).not.toContain("unconfirmed");
  expect(rulesSummary({ list: ["cursor"], agents: [{ runner: "cursor", name: "Cursor", readiness }], available: [], repoLists: 0 }).skipped).toEqual([]);
});
