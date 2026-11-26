import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { AgentModels } from "../app/src/screens/settings/AgentModels";
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
  expect(html.split('aria-label="Size of sonnet"')[1]!.split("</td>")[0]).not.toContain('aria-pressed="true"');
  expect(html).toContain("Unrated: runs for any difficulty");
  expect(html.match(/type="radio"/g)).toHaveLength(2);
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
  expect(html).not.toMatch(/role="option"[^>]*>[\s\S]{0,200}>opus</); // already on the agent
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
  expect(html).toContain("terastor-ai-pro");
  expect(html).toContain("Frontier, suggested");
});

test("an agent with no models explains what that means, and the planner explains the fallback", () => {
  const empty = createDraft("codex", "r1", null, [], null, targets);
  expect(draw(state([empty], [empty]), "codex", "codex")).toContain("picks its own model and can take any task");
  expect(draw(state([empty], [empty]), "codex", "codex")).toContain("Add models");
  expect(draw(state([empty], [empty]), "codex", "codex", true)).toContain("To let the planner take complex tasks as a fallback");
  expect(draw(state([], []), "codex", "codex")).toContain("Loading models…");
  expect(draw(state([], [], {}, { errors: { codex: "Unknown executor codex" } } as never), "codex", "codex")).toContain("Unknown executor codex");
});
