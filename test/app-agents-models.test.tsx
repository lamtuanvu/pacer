import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AgentModels, pickOptions } from "../app/src/screens/settings/AgentModels";
import { createDraft, type MatrixDraft } from "../app/src/model/model-matrix";
import type { ModelDraftsState } from "../app/src/screens/settings/useModelDrafts";
import type { AvailableModels } from "../src/models/available";
import { DensityContext } from "../app/src/ds/Density";

const targets = { simple: "small", standard: "medium", complex: "frontier" } as const;
const state = (drafts: MatrixDraft[], bases: MatrixDraft[], available: Record<string, AvailableModels> = {}, extra: Partial<ModelDraftsState> = {}) => ({
  drafts, bases, available, errors: {}, busy: false, refreshing: {}, edits: {},
  draftOf: (runner: string) => drafts.find(d => d.runner === runner), baseOf: (runner: string) => bases.find(d => d.runner === runner),
  ...extra,
}) as unknown as ModelDraftsState;
const draw = (models: ModelDraftsState, runner: string, agent: string, planner = false) =>
  renderToString(<DensityContext.Provider value="settings"><AgentModels runner={runner} agent={agent} models={models} planner={planner} disabled={false} /></DensityContext.Provider>);

test("each model row has Size, Default, On and Remove, named for its model; unsaved additions are marked", () => {
  const base = createDraft("claude-code", "r1", "opus", [{ id: "opus", tier: "frontier" }], null, targets);
  const draft: MatrixDraft = { ...base, rows: [...base.rows, { id: "sonnet", on: true, tier: "unknown", isDefault: false, takes: [] }] };
  const html = draw(state([draft], [base]), "claude-code", "claude-code", true);
  for (const header of ["Model", "Size", "Default", "On"]) expect(html).toContain(`<th scope="col">${header}</th>`);
  expect(html).toContain('<th scope="col"><span class="sr-only">Remove</span></th>');
  expect(html).toContain('aria-label="Size of opus"');
  expect(html).toMatch(/data-strip-value="frontier" aria-pressed="true"/);
  // Unrated: no size is pressed and the row says what that means.
  expect(html.split('aria-label="Size of sonnet"')[1]!.split("</td>")[0]).toMatch(/data-strip-value="unknown" aria-pressed="true"/);
  expect(html).toContain("Unrated: runs for any difficulty");
  expect(html.match(/type="radio"/g)).toHaveLength(2);
  // A size can go back to Unrated (parity with the Model matrix).
  expect(html.split('aria-label="Size of opus"')[1]!.split("</td>")[0]).toContain('data-strip-value="unknown"');
  // UI-7: the model cell keeps table-cell layout; a wrapper inside it does the flex layout.
  expect(html).toContain('<td><div class="pc-agent-models__cell">');
  expect(html).toMatch(/<input[^>]*name="default-claude-code"[^>]*checked/);
  expect(html).toContain("Make default<span class=\"sr-only\">: sonnet</span>");
  expect(html).toContain('aria-label="opus on"');
  expect(html).toContain('aria-label="Remove sonnet"');
  expect(html).toContain("Alias for the newest Opus model");
  expect(html.match(/Added, not saved/g)).toHaveLength(1);
});

test("Claude Code without a listing offers its built-in choices in groups with suggested sizes", () => {
  const base = createDraft("claude-code", "r1", "opus", [{ id: "opus", tier: "frontier" }], null, targets);
  const html = draw(state([base], [base], { "claude-code": { runner: "claude-code", source: "none", models: null, fetchedAt: 1 } }), "claude-code", "claude-code");
  expect(html).toContain("From Claude Code");
  expect(html).toContain(">Aliases · always the newest model<");
  expect(html).toContain(">Pinned versions · stay on one release<");
  // Already on the agent: listed, disabled and labelled, so it is never re-added.
  expect(html).toMatch(/role="option"[^>]*aria-disabled="true"[^>]*>[\s\S]{0,300}>opus<[\s\S]{0,300}Already added/);
  expect(html).toContain("Medium, suggested");
  expect(html).toContain("Size after adding");
});

test("an endpoint lists its provider's models with facts, and a missing model says it is no longer offered", () => {
  const base = createDraft("opencode#tse", "r1", "gone", [{ id: "gone", tier: "small" }, { id: "terastor-ai", tier: "medium" }], null, targets);
  const listing: AvailableModels = { runner: "opencode#tse", source: "opencode", fetchedAt: 1, provider: "tse", models: [{ id: "terastor-ai", context: 128000, tools: true, costOut: 2 }, { id: "terastor-ai-pro", context: 1000000, tools: true, costOut: 12 }] };
  const html = draw(state([base], [base], { "opencode#tse": listing }), "opencode#tse", "opencode");
  expect(html).toContain("2 models from tse");
  expect(html).toContain("128K context · tools");
  expect(html).toContain("gone is no longer offered by tse");
  expect(html).toContain("Replace<span class=\"sr-only\"> gone</span>…");
  expect(html).toContain("terastor-ai-pro");
  expect(html).toContain("Frontier, suggested");
});

test("an agent with no models explains what that means, and the planner explains the fallback", () => {
  const empty = createDraft("codex", "r1", null, [], null, targets);
  expect(draw(state([empty], [empty]), "codex", "codex")).toContain("picks its own model and can take any task");
  // S3: a pinned default with no declared models is stated, not hidden.
  const pinned = createDraft("codex", "r1", "gpt-5", [], null, targets);
  expect(draw(state([pinned], [pinned]), "codex", "codex")).toContain("uses gpt-5 for every task");
  expect(draw(state([pinned], [pinned]), "codex", "codex")).not.toContain("picks its own model");
  expect(draw(state([empty], [empty]), "codex", "codex")).toContain("Add models");
  expect(draw(state([empty], [empty]), "codex", "codex", true)).toContain("To let the planner take complex tasks as a fallback");
  expect(draw(state([], []), "codex", "codex")).toContain("Loading models…");
  expect(draw(state([], [], {}, { errors: { codex: "Unknown executor codex" } } as never), "codex", "codex")).toContain("Unknown executor codex");
});

test("UI-2: the pick list marks the agent's own ids, listed or typed earlier, as Already added", () => {
  const listing: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: [{ id: "a", costOut: 2 }, { id: "a-pro", costOut: 9 }] };
  const options = pickOptions("opencode", listing, ["a", "custom-x"]);
  expect(options.map(option => [option.value, !!option.disabled])).toEqual([["a", true], ["a-pro", false], ["custom-x", true]]);
});

test("Cursor, Antigravity and Codex list their own models by name, named after the agent", () => {
  const cursor = createDraft("cursor", "r1", "auto", [{ id: "auto", tier: "unknown" }], null, targets);
  const listing: AvailableModels = { runner: "cursor", source: "cursor", fetchedAt: 1, provider: "cursor", models: [{ id: "auto", name: "Auto" }, { id: "gpt-5.3-codex", name: "Codex 5.3" }] };
  const html = draw(state([cursor], [cursor], { cursor: listing }), "cursor", "cursor");
  expect(html).toContain("2 models from Cursor");
  expect(html).toContain("Codex 5.3");
  expect(html).toContain("Size after adding");
  const agy = createDraft("agy", "r1", null, [], null, targets);
  expect(draw(state([agy], [agy], { agy: { runner: "agy", source: "agy", fetchedAt: 1, provider: "agy", models: [{ id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" }] } }), "agy", "agy"))
    .toContain("1 model from Antigravity");
  // Codex's saved list leaves out models Codex hides but still runs: a declared one is not flagged.
  const codex = createDraft("codex", "r1", "gpt-reserve", [{ id: "gpt-reserve", tier: "small" }], null, targets);
  const codexHtml = draw(state([codex], [codex], { codex: { runner: "codex", source: "codex", fetchedAt: 1, provider: "codex", models: [{ id: "gpt-6-luna", name: "GPT-6-Luna", context: 272000 }] } }), "codex", "codex");
  expect(codexHtml).toContain("1 model from Codex");
  // "GPT-6-Luna" only re-cases the id, so the facts stand alone.
  expect(codexHtml).toContain('pc-combobox__description">272K context<');
  expect(codexHtml).not.toContain("no longer offered");
});
