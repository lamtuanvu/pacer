import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { h, render as preactRender } from "preact";
import { act } from "preact/test-utils";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState, type StoreState } from "../app/src/data/store";
import { ApiError, type BrowserApi } from "../app/src/data/api";
import { DispatcherModelChoice, saveTierTargets, saveTierTargetsInPlace } from "../app/src/screens/settings/DispatcherModelChoice";
import { tierSummary } from "../app/src/model/executor-models";
import { dispatchConfigSchema, type ModelRecord, type TierTargets } from "../src/dispatch/types";
import { plannerRunner, withoutPlanner } from "../app/src/model/planner";
import type { RunnerModels } from "../src/core/runner-models";

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

test("Model size for each difficulty renders three arrow-key radio groups with presets", () => {
  const html = render(config.tierTargets);
  for (const text of ["Model size for each difficulty", "Simple", "Standard", "Complex", "Small", "Medium", "Frontier",
    "Economical", "Balanced", "Quality first", "Frontier only", "Harder tasks never get a smaller model"]) expect(html).toContain(text);
  expect(html).toContain(`role="radiogroup" aria-label="Simple tasks"`);
  expect(html).toContain(`role="radiogroup" aria-label="Standard tasks"`);
  expect(html).toContain(`role="radiogroup" aria-label="Complex tasks"`);
  expect(html).toContain('role="radio"');
  expect(html).toContain('pc-radio-group');
});

test("each difficulty row puts its label before its radio group and says how many agents have a model that size", () => {
  const html = render(config.tierTargets);
  expect((html.match(/class="pc-hub-sizes__row"/g) ?? []).length).toBe(3);
  for (const d of ["Simple", "Standard", "Complex"]) {
    const label = html.indexOf(`<strong>${d}</strong>`);
    const group = html.indexOf(`role="radiogroup" aria-label="${d} tasks"`);
    expect(label).toBeGreaterThan(-1);
    expect(group).toBeGreaterThan(label);
  }
  expect(html).toContain("1 agent has a small or larger model");
  expect(html).toContain("No agent has a medium or larger model");
});

test("Right now, the difficulty strip and the agents table come from the inventory", () => {
  const html = render(config.tierTargets);
  // Headings are real h2s; the callout names where work goes.
  for (const heading of ["Right now", "Model size for each difficulty", "Agents and models"]) expect(html).toMatch(new RegExp(`<h2[^>]*>${heading}</h2>`));
  expect(html).toContain("Standard and complex tasks go to agents without a sized model, because no agent that can take work has a medium or larger model.");
  expect(html).toContain("Add a medium model");
  expect(html).toContain('aria-label="Who gets each difficulty"');
  // Each runner keeps its own row with its runner id in mono, and the chosen model per difficulty.
  for (const id of ["opencode-go", "codex", "claude-code"]) expect(html).toContain(`<code>${id}</code>`);
  expect(html).toContain("small-model");
  expect(html).toContain("Runs gpt-5 for every difficulty");
  expect(html).toContain("chooses a model itself, so it can take any difficulty");
  // Below its target the rated executor is skipped by automatic dispatch.
  expect(html).toContain(">Skipped</code>");
  expect(html).toContain("No medium or larger model; runs its default only if picked directly");
  // Actions go to the agent's own page; the unrated model offers Set its size.
  expect(html).toContain('href="#/settings/agents?agent=codex"');
  expect(html).toContain("Set its size");
  expect(html).toContain('aria-label="Open Codex"');
  expect(html).toContain("Sizes are what you declared. Pacer never guesses a model's size");
  // Filter chips carry their counts.
  expect(html).toMatch(/Follow the size <span class="pc-hub-chip-count">1<\/span>/);
  expect(html).toMatch(/Unrated <span class="pc-hub-chip-count">1<\/span>/);
  expect(html).toMatch(/Pick their own <span class="pc-hub-chip-count">1<\/span>/);
});

test("an unsteered inventory explains why and points at an agent to size", () => {
  const html = render(config.tierTargets, { models: [unrated, fixed] });
  expect(html).toContain("Every task gets the same model, whatever its difficulty.");
  expect(html).toContain("Set model sizes");
  expect(html).toContain('href="#/settings/agents?agent=codex"');
});

test("an empty inventory offers to add an agent", () => {
  const html = render(config.tierTargets, { models: [] });
  expect(html).toContain("No agent can take delegated work yet.");
  expect(html).toContain('href="#/settings/add-executor"');
  expect(html).toContain("No agents in the model inventory yet.");
});

test("a non-matching mapping shows the Custom preset as a non-interactive marker", () => {
  const custom: TierTargets = { simple: "medium", standard: "medium", complex: "medium" };
  const html = render(custom);
  expect(html).toContain("Custom");
  expect(html).not.toContain('pc-chip pc-chip--selected">Balanced');
  // The marker is not a button or filter chip with aria-pressed: it has no action.
  expect(html).toContain('class="pc-model-choice__preset-note">Custom</span>');
  expect(html).not.toContain(">Custom</button>");
  const buttonChips = html.match(/<button[^>]*>Custom<\/button>/g) ?? [];
  expect(buttonChips).toEqual([]);
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

test("the in-place Save appears for every setup, including built-in default, when the set operation exists", () => {
  const dirty: TierTargets = { simple: "medium", standard: "medium", complex: "frontier" };
  const html = render(dirty, { state: withSet, config: { strategy: "default", source: "built-in", config } });
  expect(html).toContain(">Save</button>");
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
  // A draft that diverged from the base the draft started with is reported as a conflict without writing.
  const divergentCalls: { op: string; params: unknown }[] = [];
  const changed: TierTargets = { simple: "small", standard: "small", complex: "small" };
  const divergent = await saveTierTargetsInPlace((async (op: string, params: unknown) => { divergentCalls.push({ op, params }); return { revision: "r1", targets: changed } as never; }) as never, view, targets);
  expect(divergent).toEqual({ ok: false, conflict: true });
  expect(divergentCalls).toEqual([{ op: "dispatch.tierTargets.get", params: {} }]);
});

test("the planner row says when it takes work through the tier fallback and when it does not", () => {
  const plannerModel: ModelRecord = { runner: "claude-code", executor: "claude-code", account: "team", binding: { kind: "exact", id: "opus" }, actualModel: null, tier: "frontier", strengths: [], provenance: "declared" } as ModelRecord;
  const withPlanner = { strategy: "custom", source: "strategy", config, planner: "claude-code", plannerAccount: "team" } as ConfigView;
  const html = render(config.tierTargets, { models: [rated, plannerModel], config: withPlanner });
  expect(html).toContain("Standard and complex tasks go to the planner, because no other agent that can take work has a medium or larger model.");
  expect(html).toContain("Planner fallback settings");
  expect(html).toContain('href="#/settings/agents?agent=claude-code"');
  expect(html).toContain("Fallback: no other agent has a frontier model");
  expect(html).toContain("Not used: another agent has a small or larger model");
  // The planner is listed first with the Planner pill, and its models are not counted as executor coverage.
  expect(html.indexOf("<code>claude-code</code>")).toBeLessThan(html.indexOf("<code>opencode-go</code>"));
  expect(html).toContain("Only the planner has a frontier model");
});

test("the planner helper finds the planner record and excludes only its runner", () => {
  // The planner is the record whose account and executor match the config with no host.
  expect(plannerRunner([fixed], "claude-code", "team")).toBe("claude-code");
  expect(plannerRunner([fixed], "claude-code", "work")).toBeNull();
  expect(plannerRunner([fixed], undefined, undefined)).toBeNull();
  // A host-based runner (e.g. "claude-code@mac") is not the planner.
  const hosted: ModelRecord = { ...fixed, runner: "claude-code@mac" };
  expect(plannerRunner([hosted], "claude-code", "team")).toBeNull();
  const dropped = withoutPlanner([rated, unrated, fixed], "claude-code", "team");
  expect(dropped.map(r => r.runner)).toEqual(["opencode-go", "codex"]);
});

// ---------------------------------------------------------------------------
// Stateful render so effects (reading runner.models.get defaults for the preview)
// run; mirrors app-model-matrix-screen.test.tsx. This is how the production
// wiring that pulls each runner's configured default into the preview is tested.
// ---------------------------------------------------------------------------
type SelElement = {
  nodeType: number; tagName: string; childNodes: SelElement[]; parentNode: SelElement | null;
  data?: string; attrs: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>; style: { setProperty: () => void; removeProperty: () => void };
  onclick?: null; oninput?: null; onchange?: null; onfocus?: null; onblur?: null; onkeydown?: null; onsubmit?: null;
  addEventListener: (type: string, fn: (event?: unknown) => void) => void; removeEventListener: (type: string) => void;
  setAttribute: (name: string, value: unknown) => void; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void;
  appendChild: (child: SelElement) => SelElement; insertBefore: (child: SelElement, before: SelElement | null) => SelElement;
  removeChild: (child: SelElement) => SelElement; focus: () => void; querySelector: () => null; querySelectorAll: () => SelElement[];
};
const selElement = (tag: string): SelElement => {
  const node: SelElement = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, _listeners: {}, style: { setProperty() {}, removeProperty() {} },
    onclick: null, oninput: null, onchange: null, onfocus: null, onblur: null, onkeydown: null, onsubmit: null,
    addEventListener(type, fn) { node._listeners[type] = fn; },
    removeEventListener(type) { delete node._listeners[type]; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return name in node.attrs ? node.attrs[name] : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    appendChild(child) { insertSel(node, child, null); return child; },
    insertBefore(child, before) { insertSel(node, child, before); return child; },
    removeChild(child) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    focus() { (document as unknown as { activeElement: SelElement }).activeElement = node; }, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return node;
};
const insertSel = (parent: SelElement, child: SelElement, before: SelElement | null) => {
  if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
  const at = before ? parent.childNodes.indexOf(before) : -1;
  if (at < 0) parent.childNodes.push(child); else parent.childNodes.splice(at, 0, child);
  child.parentNode = parent;
};
const selText = (node: SelElement): string => node.nodeType === 3 ? node.data ?? "" : node.childNodes.map(selText).join("");
const untilSel = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
};

async function withChoice(run: (getHtml: () => string, calls: Array<{ op: string }>) => Promise<void>, opts: {
  runnerModels?: Record<string, RunnerModels>;
  inventoryModels: ModelRecord[];
}) {
  const previous = { document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.document = {
    adoptedStyleSheets: [], createElement: (t: string) => selElement(t), createElementNS: (_n: string, t: string) => selElement(t),
    createTextNode: (t: string) => { const n = selElement("#text"); n.nodeType = 3; n.data = t; return n; },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false, activeElement: null,
  } as never;
  globalThis.CSSStyleSheet = class { replaceSync() {} } as never;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }) } as never;
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "0px" })) as never;
  globalThis.requestAnimationFrame = (() => 0) as never;
  const container = selElement("div");
  const calls: Array<{ op: string }> = [];
  const api = {
    hello: async () => ({} as never),
    snapshot: async () => ({} as never),
    async call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ op });
      switch (op) {
        case "dispatch.config.get": return view as T;
        case "dispatch.models": return { models: opts.inventoryModels, advertised: [], observedAt: null } as T;
        case "runner.models.get": return (opts.runnerModels?.[String(params.id)] ?? { runner: String(params.id), default: null, models: [] }) as T;
        default: return {} as T;
      }
    },
  } as BrowserApi;
  const holder = { state: { ...initialState(), connected: true }, api };
  const node = () => <TaskContext.Provider value={{ state: holder.state as never, api }}>
    <DispatcherModelChoice initialConfig={view as never} initialInventory={{ models: opts.inventoryModels, advertised: [], observedAt: null }} initialTargets={config.tierTargets} />
  </TaskContext.Provider>;
  try {
    await act(async () => { preactRender(node(), container as never); });
    // Wait for the defaults-loading effect (runner.models.get per runner) to run.
    const runnerCount = opts.inventoryModels.length;
    if (runnerCount) {
      await untilSel(() => calls.filter(c => c.op === "runner.models.get").length >= runnerCount);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await run(() => selText(container), calls);
  } finally {
    await act(async () => { preactRender(null as never, container as never); });
    globalThis.document = previous.document; globalThis.CSSStyleSheet = previous.CSSStyleSheet;
    globalThis.window = previous.window; globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  }
}

test("the table skips a below-target follow runner by automatic dispatch (F3)", async () => {
  // A follow runner whose only model (provider/fast) is rated below the standard and complex targets is shown as
  // skipped by automatic dispatch, with a note that it runs its default only when picked directly.
  const inventoryModels: ModelRecord[] = [
    { runner: "opencode", account: "go", executor: "opencode", binding: { kind: "exact", id: "provider/fast" }, actualModel: null, tier: "small", strengths: [], provenance: "declared" } as ModelRecord,
  ];
  await withChoice(async (getHtml, calls) => {
    expect(calls.filter(c => c.op === "runner.models.get").length).toBeGreaterThan(0);
    const html = getHtml();
    expect(html).toContain("fast");
    expect(html).toContain("Skipped");
    expect(html).toContain("No medium or larger model; runs its default only if picked directly");
    expect(html).not.toContain("Not used");
  }, {
    runnerModels: { opencode: { runner: "opencode", revision: "r1", default: "provider/fast", models: [{ id: "provider/fast", tier: "small" }] } },
    inventoryModels,
  });
});

test("an agent that picks its own model names its configured default (runner.models.get wiring)", async () => {
  const inventoryModels: ModelRecord[] = [
    { runner: "codex", account: "work", executor: "codex", binding: { kind: "executor-default" }, actualModel: null, tier: "unknown", strengths: [], provenance: "declared" } as ModelRecord,
  ];
  await withChoice(async (getHtml) => {
    await untilSel(() => getHtml().includes("Uses its default model"));
    expect(getHtml()).toContain("Uses its default model, gpt-5.5, for every difficulty");
  }, {
    runnerModels: { codex: { runner: "codex", revision: "r1", default: "gpt-5.5", models: [] } },
    inventoryModels,
  });
});
