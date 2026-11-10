import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { DispatcherModelChoice, saveTierTargets } from "../app/src/screens/settings/DispatcherModelChoice";
import { tierSummary } from "../app/src/model/executor-models";
import { dispatchConfigSchema, type ModelRecord } from "../src/dispatch/types";

const config = dispatchConfigSchema.parse({});
const view = { strategy: "custom", config };
const models: ModelRecord[] = (["small", "medium", "frontier"] as const).map(tier => ({
  runner: "opencode-go", executor: "opencode", account: "go", binding: { kind: "exact", id: `provider/${tier}-model` },
  actualModel: null, tier, strengths: [], provenance: "declared",
}));
const api = { call: async () => ({}) } as never;
const render = (targets = config.tierTargets) => renderToString(<TaskContext.Provider value={{ state: initialState(), api }}>
  <DispatcherModelChoice initialConfig={view} initialInventory={{ models, advertised: [], observedAt: null }} initialTargets={targets} />
</TaskContext.Provider>);

test("Model choice previews each difficulty with the shared tier selection", () => {
  const html = render();
  for (const text of ["Model choice", "Simple", "Standard", "Complex", "small-model", "medium-model", "frontier-model", "opencode-go"]) expect(html).toContain(text);
});
test("tier summary selects declared models and handles executor defaults", () => {
  expect(tierSummary(models.map(m => ({ id: m.binding.kind === "exact" ? m.binding.id : "", tier: m.tier, strengths: [] })), config.tierTargets))
    .toBe("Simple → small-model · Standard → medium-model · Complex → frontier-model");
  expect(tierSummary([], config.tierTargets)).toBe("Always uses the default model");
});
test("decreasing mappings are visible and blocked before any write", async () => {
  const targets = { simple: "frontier", standard: "medium", complex: "small" } as const;
  expect(render(targets)).toContain("dispatch.tierTargets must not decrease from simple to complex");
  const calls: string[] = [];
  await expect(saveTierTargets(async (op: string) => { calls.push(op); return {} as never; }, view, targets)).rejects.toThrow("dispatch.tierTargets must not decrease from simple to complex");
  expect(calls).toEqual([]);
});
test("save checks concurrent edits, previews then saves and activates the profile", async () => {
  const calls: { op: string; params: unknown }[] = [];
  const targets = { simple: "medium", standard: "medium", complex: "frontier" } as const;
  await saveTierTargets(async (op, params) => { calls.push({ op, params }); return (op === "dispatch.config.get" ? view : { ok: true }) as never; }, view, targets);
  expect(calls.map(c => c.op)).toEqual(["dispatch.config.get", "strategy.preview", "strategy.save", "strategy.use"]);
  expect(calls[1]!.params).toEqual({ draft: { from: "custom", set: { dispatch: { ...config, tierTargets: targets } } } });
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

test("unrated and fixed-default executors are explained", () => {
  const html = renderToString(<TaskContext.Provider value={{ state: initialState(), api }}><DispatcherModelChoice initialConfig={view}
    initialInventory={{ models: [{ ...models[0]!, binding: { kind: "executor-default" }, tier: "unknown" }], advertised: [], observedAt: null }} /></TaskContext.Provider>);
  expect(html).toContain("Always uses the default model");
  expect(html).toContain("Unrated");
});

test("validation failure never writes or activates", async () => {
  const calls: string[] = [];
  await expect(saveTierTargets(async (op) => { calls.push(op); return (op === "dispatch.config.get" ? view : { ok: false, errors: ["Invalid mapping"] }) as never; }, view, config.tierTargets)).rejects.toThrow("Invalid mapping");
  expect(calls).toEqual(["dispatch.config.get", "strategy.preview"]);
});

test("preview keeps separate runners of the same agent in separate rows", () => {
  const html = renderToString(<TaskContext.Provider value={{ state: initialState(), api }}><DispatcherModelChoice initialConfig={view}
    initialInventory={{ models: [{ ...models[0]!, runner: "codex#team", executor: "codex" }, { ...models[1]!, runner: "codex#personal", executor: "codex" }], advertised: [], observedAt: null }} /></TaskContext.Provider>);
  expect(html).toContain("codex#team");
  expect(html).toContain("codex#personal");
});
