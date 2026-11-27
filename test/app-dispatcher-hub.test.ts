import { expect, test } from "bun:test";
import type { ModelRecord, TierTargets } from "../src/dispatch/types";
import { canTakeWork, compareProfiles, joinNames, listAvailability, overviewModel, profileAbout, profileFacts, rulesSummary, type HubAgent } from "../app/src/model/dispatcher-hub";

const targets: TierTargets = { simple: "small", standard: "medium", complex: "frontier" };
const record = (runner: string, id: string | null, tier: ModelRecord["tier"]): ModelRecord => ({
  runner, account: runner.split("#")[1] ?? runner, executor: runner.split("#")[0]!, binding: id ? { kind: "exact", id } : { kind: "executor-default" },
  actualModel: null, tier, strengths: [], provenance: "declared",
}) as ModelRecord;
const ready = (runner: string, name: string): HubAgent => ({ runner, name, readiness: { label: "Ready", tone: "good", reason: "Ready to take work" } });
const off = (runner: string, name: string): HubAgent => ({ runner, name, readiness: { label: "Off", tone: "neutral", reason: "Takes work is turned off" } });
const quota = (runner: string, name: string): HubAgent => ({ runner, name, readiness: { label: "Cannot take work", tone: "bad", reason: "Out of quota" } });

// The design canvas case: only the planner has a frontier model.
const planner = record("claude-code", "opus", "frontier");
const tse = record("opencode#tse", "terastor-ai", "medium");
const goSmall = record("opencode#go", "iceman", "small"), goMedium = record("opencode#go", "hy4-flash", "medium");
const local = record("opencode#local", "qwen3.6", "unknown");
const codex = record("codex", null, "unknown");
const agents = [ready("claude-code", "Claude Code"), ready("opencode#tse", "tse"), ready("opencode#go", "oc-go"), ready("opencode#local", "Local model"), quota("codex", "Codex")];

test("Right now says complex work goes to the planner when no other agent has a frontier model", () => {
  const model = overviewModel({ records: [planner, tse, goSmall, goMedium, local, codex], targets, agents, plannerRunner: "claude-code", fallbackOn: true });
  expect(model.summary.headline).toBe("Complex tasks go to the planner, because no other agent that can take work has a frontier model.");
  expect(model.summary.consequence).toBe("Claude Code runs them on opus and spends planner quota. Give another agent a frontier model to keep the planner free.");
  expect(model.summary.action).toEqual({ label: "Add a frontier model", agent: "opencode#tse" });
  expect(model.summary.secondary).toEqual({ label: "Planner fallback settings", agent: "claude-code" });
  const [simple, standard, complex] = model.tiles;
  expect(simple).toMatchObject({ count: "2 agents", agents: ["opencode#go", "opencode#tse"] });
  expect(simple!.who).toBe("oc-go matches. tse steps in when nothing smaller is free. 1 agent with an unrated model also takes it.");
  expect(standard!.count).toBe("2 agents");
  expect(standard!.who).toBe("tse and oc-go match. 1 agent with an unrated model also takes it.");
  expect(complex).toMatchObject({ count: "Planner", planner: true, agents: ["claude-code"], who: "Claude Code on opus, through the tier fallback. Uses planner quota." });
  // Codex is out of quota: it is left out of every count but still has a table row.
  expect(model.rows.map(row => row.runner)).toEqual(["claude-code", "opencode#tse", "opencode#go", "opencode#local", "codex"]);
  expect(model.counts).toEqual({ all: 5, follow: 3, unrated: 1, fixed: 1 });
  expect(model.coverage).toEqual({ simple: "2 agents have a small or larger model", standard: "2 agents have a medium or larger model", complex: "Only the planner has a frontier model" });
});

test("the agents table says what each agent runs for each difficulty, in plain words", () => {
  const model = overviewModel({ records: [planner, tse, goSmall, goMedium, local, codex], targets, agents, plannerRunner: "claude-code", fallbackOn: true, defaults: { codex: "gpt-5.5" } });
  const row = (runner: string) => model.rows.find(item => item.runner === runner)!;
  expect(row("claude-code").cells!.map(cell => [cell.model, cell.note])).toEqual([
    ["—", "Not used: another agent has a small or larger model"], ["—", "Not used: another agent has a medium or larger model"], ["opus", "Fallback: no other agent has a frontier model"]]);
  expect(row("opencode#tse").cells!.map(cell => [cell.model, cell.note])).toEqual([
    ["terastor-ai", "Larger than needed, used when nothing smaller is free"], ["terastor-ai", "Matches"], ["Skipped", "No frontier or larger model; runs its default only if picked directly"]]);
  expect(row("opencode#tse").models).toEqual([{ id: "terastor-ai", tier: "medium" }]);
  expect(row("opencode#local")).toMatchObject({ behavior: "unrated", canRate: true, flat: { pill: "Unrated", tone: "warn", text: "Runs qwen3.6 for every difficulty" } });
  expect(row("codex")).toMatchObject({ behavior: "fixed", canTake: false, canRate: false, flat: { pill: "Picks its own", text: "Uses its default model, gpt-5.5, for every difficulty" } });
});

test("a planner fallback that is off, or a planner without a sized model, never takes work", () => {
  const offModel = overviewModel({ records: [planner, tse], targets, agents, plannerRunner: "claude-code", fallbackOn: false });
  expect(offModel.tiles[2]).toMatchObject({ nobody: true, count: "Nobody" });
  expect(offModel.rows[0]!.cells![2]!.note).toBe("Not used: the planner fallback is off");
  expect(offModel.summary.headline).toBe("Complex tasks wait in the queue, because no agent that can take work has a frontier model.");
  const unsized = overviewModel({ records: [record("claude-code", "opus", "unknown"), tse], targets, agents, plannerRunner: "claude-code", fallbackOn: true });
  expect(unsized.rows[0]).toMatchObject({ planner: true, behavior: "unrated" });
  expect(unsized.tiles[2]!.planner).toBe(false);
});

test("Right now covers no agents, no sizes, unsized-only work and the steered case", () => {
  expect(overviewModel({ records: [], targets, agents: [], plannerRunner: null, fallbackOn: true }).summary)
    .toEqual({ headline: "No agent can take delegated work yet.", consequence: "Add an agent so Pacer has someone to hand tasks to.", action: { label: "Add an agent", addAgent: true } });
  const unsteered = overviewModel({ records: [local, codex], targets, agents: [ready("opencode#local", "Local model"), ready("codex", "Codex")], plannerRunner: null, fallbackOn: true }).summary;
  expect(unsteered.headline).toBe("Every task gets the same model, whatever its difficulty.");
  expect(unsteered.consequence).toBe("1 agent runs a model without a size, and 1 agent picks its own model. Set a size on a model so difficulty can steer it.");
  expect(unsteered.action).toEqual({ label: "Set model sizes", agent: "opencode#local" });
  const loose = overviewModel({ records: [goSmall, local], targets, agents: [ready("opencode#go", "oc-go"), ready("opencode#local", "Local model")], plannerRunner: null, fallbackOn: true });
  expect(loose.summary.headline).toBe("Standard and complex tasks go to agents without a sized model, because no agent that can take work has a medium or larger model.");
  expect(loose.tiles[1]).toMatchObject({ unsized: true, count: "1 agent", who: "No agent that can take work has a medium or larger model. 1 agent with an unrated model takes it." });
  const steered = overviewModel({ records: [goSmall, goMedium, record("opencode#tse", "big", "frontier"), local], targets, agents: [ready("opencode#go", "oc-go"), ready("opencode#tse", "tse"), ready("opencode#local", "Local model")], plannerRunner: null, fallbackOn: true }).summary;
  expect(steered.headline).toBe("Simple tasks run on small models, standard on medium and complex on frontier.");
  expect(steered.consequence).toBe("Local model runs one model for every difficulty until you set its size.");
  expect(steered.action).toEqual({ label: "Set its size", agent: "opencode#local" });
  // An agent the snapshot does not list keeps its readable name, never its raw id.
  const unnamed = overviewModel({ records: [record("claude-code#claude1", null, "unknown")], targets, agents: [], plannerRunner: null, fallbackOn: true });
  expect(unnamed.rows[0]!.name).toBe("Claude Code · claude1");
});

test("Who can run what explains the default list, why others cannot take work and who is not listed", () => {
  const people = [quota("codex", "Codex"), quota("cursor", "Cursor"), off("agy", "Antigravity"), off("opencode#byteplus", "BytePlus"), ready("opencode#local", "Local model"), ready("opencode#tse", "tse"), ready("opencode#go", "oc-go"), ready("claude-code", "Claude Code")];
  const summary = rulesSummary({ list: ["codex", "cursor", "agy", "opencode#byteplus", "opencode#local"], agents: people, available: ["codex", "cursor", "agy", "opencode#byteplus", "opencode#local", "opencode#tse", "opencode#go", "claude-code", "opencode#gone"], plannerRunner: "claude-code", repoLists: 1 });
  expect(summary.headline).toBe("Only 1 agent of 5 in the default list can take work.");
  expect(summary.consequence).toBe("Codex and Cursor are out of quota and Antigravity and BytePlus are off, so tasks outside repositories with their own list go to Local model. tse and oc-go can take work but aren't in this list.");
  expect(summary.add).toEqual(["opencode#tse", "opencode#go"]);
  expect(summary.action).toEqual({ label: "Add tse and oc-go" });
  const all = rulesSummary({ list: ["opencode#tse", "opencode#go"], agents: people, available: ["opencode#tse", "opencode#go"] });
  expect(all.headline).toBe("All 2 agents in the default list can take work.");
  expect(all.consequence).toBe("Tasks go to tse and oc-go, in the order Pacer chooses.");
  expect(all.action).toBeUndefined();
  const none = rulesSummary({ list: ["codex"], agents: people, available: ["codex"] });
  expect(none.headline).toBe("No agent in the default list can take work.");
  expect(none.consequence).toBe("Codex is out of quota, so tasks wait in the queue.");
  expect(rulesSummary({ list: [], agents: people, available: [] }).consequence).toBe("Add an agent to it, or tasks wait in the queue.");
  expect(rulesSummary({ list: ["a", "b", "c", "d", "e"].map(id => `x#${id}`), agents: [], available: [] }).headline).toBe("All 5 agents in the default list can take work.");
  expect(rulesSummary({ list: [], agents: ["a", "b", "c", "d"].map(id => ready(id, id.toUpperCase())), available: ["a", "b", "c", "d"] }).action).toEqual({ label: "Add 4 agents" });
});

test("repository lists count who can take work; Skipped still counts, Off and Cannot take work do not", () => {
  const people = [ready("a", "A"), off("b", "B"), quota("c", "C"), { runner: "d", name: "D", readiness: { label: "Skipped", tone: "warn", reason: "Refresh to confirm availability" } }];
  expect(listAvailability(["a", "b", "c", "d"], people)).toEqual({ text: "2 of 4 can take work", tone: "warn" });
  expect(listAvailability(["b"], people)).toEqual({ text: "0 of 1 can take work", tone: "bad" });
  expect(listAvailability(["a"], people)).toEqual({ text: "1 of 1 can take work", tone: "good" });
  expect(canTakeWork(undefined)).toBe(true);
});

const normalized = (pacing: string, extra = "") => `planner: claude-code\npacing: \n${pacing}routing: \n  - executors: \n      - codex\n${extra}`;
test("profile facts read the normalized strategy.preview YAML and fall back to the service defaults", () => {
  expect(profileFacts(normalized("  policy: cheapest-first\n  planner_reserve: 30\n  planner_tier_fallback: off\n  order: \n    - codex\n", "dispatch: \n  tierTargets: \n    simple: medium\n    standard: frontier\n    complex: frontier\n")))
    .toEqual({ planner: "claude-code", policy: "cheapest-first", reserve: 30, fallback: "off", targets: { simple: "medium", standard: "frontier", complex: "frontier" } });
  expect(profileFacts("planner: \"codex\"\nproviders: \n  codex: \n    policy: nested-not-pacing\n"))
    .toEqual({ planner: "codex", policy: "priority", reserve: 15, fallback: "on", targets: { simple: "small", standard: "medium", complex: "frontier" } });
});

test("the comparison lists only what switching changes, and what stays", () => {
  const active = profileFacts(normalized("  policy: priority\n  planner_reserve: 15\n"));
  const target = profileFacts(normalized("  policy: cheapest-first\n  planner_reserve: 15\n"));
  const result = compareProfiles({ active, target, label: id => ({ codex: "Codex", "opencode#local": "Local model", cursor: "Cursor" })[id] ?? id, preview: {
    ranking: { current: ["codex", "cursor"], draft: ["opencode#local", "codex"] },
    routing: { current: [{ kinds: ["docs"], executors: ["codex"] }, { executors: ["codex", "cursor"] }], draft: [{ kinds: ["docs"], executors: ["codex"] }, { executors: ["opencode#local", "codex"] }] },
  } });
  expect(result.changes).toEqual([
    { what: "Default list", from: "Codex, Cursor", to: "Local model, Codex" },
    { what: "Pacing", from: "Priority: Codex, Cursor", to: "Cheapest first: Local model, Codex" },
  ]);
  expect(result.unchanged).toEqual(["the planner (claude-code)", "the planner keeps 15% back", "the task-kind lists", "model sizes for each difficulty", "the planner fallback (on)", "repository lists"]);
  expect(joinNames(result.unchanged.slice(0, 2))).toBe("the planner (claude-code) and the planner keeps 15% back");
});

test("profile summaries name the policy in plain words", () => {
  expect(profileAbout("Codex first, Claude Code keeps 15%; burn-before-reset policy")).toBe("Codex first, Claude Code keeps 15% · Burn before reset");
  expect(profileAbout("Codex first, Claude Code keeps 15%")).toBe("Codex first, Claude Code keeps 15%");
  expect(profileAbout("Configured executors, Codex keeps 10%; odd policy")).toBe("Configured executors, Codex keeps 10% · Custom");
  expect(joinNames([])).toBe("");
  expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
});
