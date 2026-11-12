import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState, type StoreState } from "../app/src/data/store";
import { ApiError } from "../app/src/data/api";
import { DispatcherModelChoice, saveTierTargets, saveTierTargetsInPlace } from "../app/src/screens/settings/DispatcherModelChoice";
import { tierSummary } from "../app/src/model/executor-models";
import { dispatchConfigSchema, type ModelRecord, type TierTargets } from "../src/dispatch/types";

const config = dispatchConfigSchema.parse({});
const view = { strategy: "custom", source: "strategy" as const, config };
const api = { call: async () => ({}) } as never;

const rated: ModelRecord = {
  runner: "opencode-go", executor: "opencode", account: "go",
  binding: { kind: "exact", id: "provider/small-model" }, actualModel: null, tier: "small",
  strengths: [], provenance: "declared",
} as ModelRecord;
const unrated: ModelRecord = {
  runner: "codex", executor: "codex", account: "work",
  binding: { kind: "exact", id: "gpt-5" }, actualModel: null, tier: "unknown",
  strengths: [], provenance: "declared",
} as ModelRecord;
const fixed: ModelRecord = {
  runner: "claude-code", executor: "claude-code", account: "team",
  binding: { kind: "executor-default" }, actualModel: null, tier: "unknown",
  strengths: [], provenance: "declared",
} as ModelRecord;

type ConfigView = { strategy: string; source?: "built-in" | "strategy"; config: typeof config };
const render = (targets: TierTargets | undefined, over: { state?: StoreState; models?: ModelRecord[]; config?: ConfigView } = {}) =>
  renderToString(<TaskContext.Provider value={{ state: over.state ?? initialState(), api }}>
    <DispatcherModelChoice initialConfig={over.config ?? view}
      initialInventory={{ models: over.models ?? [rated, unrated, fixed], advertised: [], observedAt: null }}
      initialTargets={targets} />
  </TaskContext.Provider>);
const withSet = { ...initialState(), features: { readModel: false, ops: new Set(["dispatch.tierTargets.config", "dispatch.tierTargets.set"]) } };
const withSetConfig = { ...initialState(), features: { readModel: false, ops: new Set(["dispatch.tierTargets.set"]) } };

test("Model choice renders the tier grid as three arrow-key radio groups with presets", () => {
  const html = render(config.tierTargets);
  for (const text of ["Model choice", "Simple", "Standard", "Complex", "Small", "Medium", "Frontier",
    "Economical", "Balanced", "Quality first", "Frontier only"]) expect(html).toContain(text);
  expect(html).toContain(`role="radiogroup" aria-label="Simple tasks"`);
  expect(html).toContain(`role="radiogroup" aria-label="Standard tasks"`);
  expect(html).toContain(`role="radiogroup" aria-label="Complex tasks"`);
  expect(html).toContain('role="radio"');
  expect(html).toContain('pc-radio-group');
});

test("the answer card reports steered executors and the preview groups by behavior", () => {
  const html = render(config.tierTargets);
  expect(html).toContain("Task difficulty now steers 1 of 3 executors");
  expect(html).toContain("Follow the tier"); expect(html).toContain("Unrated · tier ignored"); expect(html).toContain("Choose their own model");
  // Each runner keeps its own row or chip, and the chosen model and eligible count are shown.
  expect(html).toContain("opencode-go"); expect(html).toContain("codex"); expect(html).toContain("claude-code");
  expect(html).toContain("gpt-5"); expect(html).toContain("for every difficulty");
  expect(html).toContain("can take it");
  // The rated executor shows its chosen model for the simple target and "Not used" below it.
  expect(html).toContain("small-model"); expect(html).toContain("Not used");
});

test("an unsteered inventory explains why and points at the model matrix when that route exists", () => {
  const html = render(config.tierTargets, { models: [unrated, fixed] });
  expect(html).toContain("Task difficulty does not change any model yet");
  expect(html).toContain("Rate models in the model matrix");
  // The models section is not registered yet, so the link stays away (TODO-free feature check).
  expect(html).not.toContain("Open model matrix");
});

test("a non-matching mapping shows the Custom preset", () => {
  const custom: TierTargets = { simple: "medium", standard: "medium", complex: "medium" };
  const html = render(custom);
  expect(html).toContain("Custom");
  expect(html).not.toContain('pc-chip pc-chip--selected">Balanced');
});

test("the save bar appears only when dirty and saves as a new setup without the set operation", () => {
  const dirty: TierTargets = { simple: "medium", standard: "medium", complex: "frontier" };
  const html = render(dirty);
  expect(html).toContain("unsaved change"); expect(html).toContain("Discard"); expect(html).toContain("Save as new setup…");
  // Without dispatch.tierTargets.set only the new-setup path is offered.
  expect(html).not.toContain(">Save</button>");
  expect(render(config.tierTargets)).not.toContain("unsaved change");
});

test("the in-place Save appears when the set operation exists on a strategy setup", () => {
  const dirty: TierTargets = { simple: "medium", standard: "medium", complex: "frontier" };
  const html = render(dirty, { state: withSet });
  expect(html).toContain(">Save</button>");
  expect(html).toContain("Save as new setup…");
});

test("the built-in default setup never offers the in-place Save", () => {
  const dirty: TierTargets = { simple: "medium", standard: "medium", complex: "frontier" };
  const html = render(dirty, { state: withSet, config: { strategy: "default", source: "built-in", config } });
  expect(html).not.toContain(">Save</button>");
  expect(html).toContain("Save as new setup…");
});

test("tier summary selects declared models and handles executor defaults", () => {
  expect(tierSummary([{ id: "provider/small-model", tier: "small", strengths: [] }, { id: "provider/medium-model", tier: "medium", strengths: [] }, { id: "provider/frontier-model", tier: "frontier", strengths: [] }], config.tierTargets))
    .toBe("Simple → small-model · Standard → medium-model · Complex → frontier-model");
  expect(tierSummary([], config.tierTargets)).toBe("Always uses the default model");
});
test("executor summary uses its configured default below target", () => {
  expect(tierSummary([{ id: "only-small", tier: "small", strengths: [] }], config.tierTargets, "only-small"))
    .toBe("Simple → only-small · Standard → only-small · Complex → only-small");
});

test("decreasing mappings are blocked before any write", async () => {
  const targets = { simple: "frontier", standard: "medium", complex: "small" } as const;
  const calls: string[] = [];
  await expect(saveTierTargets(async (op: string) => { calls.push(op); return {} as never; }, view, targets)).rejects.toThrow("dispatch.tierTargets must not decrease from simple to complex");
  expect(calls).toEqual([]);
});
test("save checks concurrent edits, previews then saves and activates the profile", async () => {
  const calls: { op: string; params: unknown }[] = [];
  const targets = { simple: "medium", standard: "medium", complex: "frontier" } as const;
  await saveTierTargets(async (op, params) => { calls.push({ op, params }); return (op === "dispatch.config.get" ? view : { ok: true }) as never; }, view, targets);
  expect(calls.map(c => c.op)).toEqual(["dispatch.config.get", "strategy.preview", "strategy.save", "strategy.use"]);
  expect(calls[1]!.params).toEqual({ draft: { from: "custom", set: { "dispatch.tierTargets": targets } } });
  await expect(saveTierTargets(async () => ({ ...view, strategy: "changed" }) as never, view, targets)).rejects.toThrow("changed in another client");
});
test("default setup is protected and a named copy is saved without overwrite", async () => {
  const base = { ...view, strategy: "default" };
  await expect(saveTierTargets(async () => base as never, base, config.tierTargets, "default")).rejects.toThrow("default is protected");
  const calls: { op: string; params: unknown }[] = [];
  await saveTierTargets(async (op, params) => { calls.push({ op, params }); return (op === "dispatch.config.get" ? base : { ok: true }) as never; }, base, config.tierTargets, "my-choices");
  expect(calls[2]!.params).toMatchObject({ name: "my-choices" });
  expect(calls[2]!.params).not.toHaveProperty("overwrite");
});
test("validation failure never writes or activates", async () => {
  const calls: string[] = [];
  await expect(saveTierTargets(async (op) => { calls.push(op); return (op === "dispatch.config.get" ? view : { ok: false, errors: ["Invalid mapping"] }) as never; }, view, config.tierTargets)).rejects.toThrow("Invalid mapping");
  expect(calls).toEqual(["dispatch.config.get", "strategy.preview"]);
});

test("in-place save uses the fetched revision and reports conflicts", async () => {
  const calls: { op: string; params: unknown }[] = [];
  const targets = { simple: "medium", standard: "medium", complex: "frontier" } as const;
  const ok = await saveTierTargetsInPlace((async (op: string, params: unknown) => { calls.push({ op, params }); return (op === "dispatch.tierTargets.get" ? { revision: "r1", targets: config.tierTargets } : { revision: "r2" }) as never; }) as never, view, targets);
  expect(ok).toEqual({ ok: true });
  expect(calls).toEqual([
    { op: "dispatch.tierTargets.get", params: {} },
    { op: "dispatch.tierTargets.set", params: { expectedRevision: "r1", targets } },
  ]);
  const conflict = await saveTierTargetsInPlace((async (op: string) => { if (op === "dispatch.tierTargets.get") return { revision: "r1", targets: config.tierTargets } as never; throw new ApiError("conflict", "changed"); }) as never, view, targets);
  expect(conflict).toEqual({ ok: false, conflict: true });
});