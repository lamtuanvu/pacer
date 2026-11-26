import { expect, test } from "bun:test";
import { addModelOptions, agentCaption, CLAUDE_CODE_MODELS, listingNote, modelChanges, modelCoverage, modelNote, suggestedSize, unratedAgents } from "../app/src/model/agents";
import { createDraft, type MatrixDraft } from "../app/src/model/model-matrix";
import { unratedRunners } from "../app/src/screens/settings/DispatcherTabs";
import type { AvailableModels } from "../src/models/available";
import type { ModelRecord } from "../src/dispatch/types";

const targets = { simple: "small", standard: "medium", complex: "frontier" } as const;
const draft = (runner: string, models: { id: string; tier: "small" | "medium" | "frontier" | "unknown" }[], fallback: string | null = models[0]?.id ?? null): MatrixDraft =>
  createDraft(runner, "r1", fallback, models, null, targets);
const listing: AvailableModels = { runner: "opencode#tse", source: "opencode", fetchedAt: 1, provider: "tse", models: [
  { id: "terastor-ai", context: 128000, tools: true, costOut: 2 },
  { id: "terastor-ai-pro", context: 1000000, tools: true, costOut: 12 },
  { id: "terastor-mini", context: 32000, tools: false, costOut: 0.2 },
  { id: "terastor-x" },
] };

test("Add a model offers the live listing minus the agent's models, with facts and a suggested size", () => {
  const options = addModelOptions("opencode", listing, ["terastor-ai"]);
  expect(options.map(option => option.id)).toEqual(["terastor-ai-pro", "terastor-mini", "terastor-x"]);
  expect(options[0]).toEqual({ id: "terastor-ai-pro", note: "1M context · tools", tier: "frontier" });
  expect(options[1]).toEqual({ id: "terastor-mini", note: "32K context · no tools", tier: "small" });
  // No price in the listing: no suggestion, and no invented facts.
  expect(options[2]).toEqual({ id: "terastor-x", note: undefined, tier: null });
});

test("Claude Code without a listing offers its aliases and pinned ids; other agents offer only typing", () => {
  const none: AvailableModels = { runner: "claude-code", source: "none", models: null, fetchedAt: 1 };
  const options = addModelOptions("claude-code", none, ["opus"]);
  expect(options.map(option => option.id)).toEqual(["sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]);
  expect(new Set(CLAUDE_CODE_MODELS.map(option => option.group))).toEqual(new Set(["Aliases · always the newest model", "Pinned versions · stay on one release"]));
  expect(options.find(option => option.id === "claude-fable-5-2")?.tier).toBeNull();
  expect(addModelOptions("codex", none, [])).toEqual([]);
  expect(addModelOptions("codex", undefined, [])).toEqual([]);
  // A listing wins over the built-in choices.
  expect(addModelOptions("claude-code", { ...listing, runner: "claude-code" }, []).map(option => option.id)).toContain("terastor-ai");
});

test("a picked or typed id gets the listing's size, a built-in size, or stays unrated", () => {
  expect(suggestedSize("opencode", listing, "terastor-ai")).toBe("medium");
  expect(suggestedSize("claude-code", undefined, "haiku")).toBe("small");
  expect(suggestedSize("claude-code", undefined, "my-custom-model")).toBeNull();
  expect(suggestedSize("codex", undefined, "gpt-5")).toBeNull();
});

test("model notes come from listing facts or what a Claude Code alias means", () => {
  expect(listingNote({ context: 200000, tools: true })).toBe("200K context · tools");
  expect(listingNote({})).toBeUndefined();
  expect(modelNote("opencode", listing, "terastor-ai")).toBe("128K context · tools");
  expect(modelNote("claude-code", undefined, "opus")).toBe("Alias for the newest Opus model");
  expect(modelNote("claude-code", undefined, "claude-sonnet-5-5")).toBe("Sonnet 5.5");
  expect(modelNote("codex", undefined, "gpt-5")).toBeUndefined();
});

test("list captions summarize models in words and warn while any is unrated", () => {
  expect(agentCaption(draft("claude-code", [{ id: "opus", tier: "frontier" }]))).toEqual({ text: "opus · frontier", warn: false });
  expect(agentCaption(draft("cursor", [{ id: "auto", tier: "unknown" }]))).toEqual({ text: "auto · unrated", warn: true });
  expect(agentCaption(draft("go", [{ id: "a", tier: "small" }, { id: "b", tier: "medium" }, { id: "c", tier: "small" }]))).toEqual({ text: "3 models · small, medium", warn: false });
  expect(agentCaption(draft("go", [{ id: "a", tier: "small" }, { id: "b", tier: "unknown" }]))).toEqual({ text: "2 models · small, unrated", warn: true });
  expect(agentCaption(draft("codex", [], null))).toEqual({ text: "Picks its own model", warn: false });
  expect(agentCaption(draft("codex", [], "gpt-5"))).toEqual({ text: "gpt-5", warn: false });
  // Before the models load, the snapshot's model (or nothing) stands in.
  expect(agentCaption(undefined, "gpt-5")).toEqual({ text: "gpt-5", warn: false });
  expect(agentCaption(undefined)).toEqual({ text: "Picks its own model", warn: false });
});

test("unrated counts agents, not models; the tab pill counts runners from the inventory", () => {
  expect(unratedAgents([draft("a", [{ id: "x", tier: "unknown" }, { id: "y", tier: "unknown" }]), draft("b", [{ id: "z", tier: "small" }]), draft("c", [])])).toBe(1);
  const record = (runner: string, tier: ModelRecord["tier"], kind: "exact" | "executor-default" = "exact") => ({ runner, tier, binding: kind === "exact" ? { kind, id: "m" } : { kind } }) as unknown as ModelRecord;
  expect(unratedRunners([record("a", "unknown"), record("a", "unknown"), record("b", "small"), record("c", "unknown", "executor-default")])).toBe(1);
});

test("coverage counts executor models per difficulty; the planner counts only through the fallback", () => {
  const planner = draft("claude-code", [{ id: "opus", tier: "frontier" }]);
  const go = draft("go", [{ id: "a", tier: "small" }, { id: "b", tier: "medium" }]);
  const codex = draft("codex", [], "gpt-5");
  const coverage = modelCoverage([planner, go, codex], "claude-code", targets);
  expect(coverage.counts).toEqual({ simple: 2, standard: 1, complex: 0 });
  expect(coverage.defaultExecutors).toBe(1);
  expect(coverage.plannerFits).toBe(true);
  const freed = modelCoverage([planner, { ...go, rows: go.rows.map(row => row.id === "b" ? { ...row, tier: "frontier" as const } : row) }], "claude-code", targets);
  expect(freed.counts.complex).toBe(1);
  expect(modelCoverage([draft("claude-code", [{ id: "haiku", tier: "small" }])], "claude-code", targets).plannerFits).toBe(false);
  // A model turned off in the draft no longer covers anything.
  expect(modelCoverage([{ ...go, rows: go.rows.map(row => ({ ...row, on: false })) }], null, targets).counts.simple).toBe(0);
});

test("the save bar lists each unsaved model change in words", () => {
  const base = draft("claude-code", [{ id: "opus", tier: "medium" }, { id: "haiku", tier: "small" }]);
  const next: MatrixDraft = { ...base, default: "sonnet", rows: [
    { ...base.rows[0]!, tier: "frontier" },
    { id: "sonnet", on: true, tier: "medium", isDefault: false, takes: [] },
    { id: "fable", on: true, tier: "unknown", isDefault: false, takes: [] },
  ] };
  expect(modelChanges(next, base)).toEqual(["opus set to frontier", "sonnet added at medium", "fable added, unrated", "haiku removed", "sonnet made default"]);
  expect(modelChanges(base, base)).toEqual([]);
  expect(modelChanges({ ...base, rows: base.rows.map(row => row.id === "haiku" ? { ...row, on: false } : row) }, base)).toEqual(["haiku turned off"]);
});
