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
  // The rated executor shows its chosen model for the simple target and, below
  // it with no configured default, that it falls back to its provider's default
  // (mirroring plain delegation) instead of "Not used".
  expect(html).toContain("small-model");
  expect(html).toContain("Uses its provider's default");
  expect(html).not.toContain("Not used");
});

test("an unsteered inventory explains why and points at the model matrix when that route exists", () => {
  const html = render(config.tierTargets, { models: [unrated, fixed] });
  expect(html).toContain("Task difficulty does not change any model yet");
  expect(html).toContain("Rate models in the model matrix");
  // The models section is now registered, so the link points at it.
  expect(html).toContain("Open model matrix");
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

test("the planner executor is excluded from the model preview counts", () => {
  // fixed (claude-code on account team) matches the config planner, so it drops out.
  const withPlanner = { strategy: "custom", source: "strategy", config, planner: "claude-code", plannerAccount: "team" } as ConfigView;
  const html = render(config.tierTargets, { models: [rated, unrated, fixed], config: withPlanner });
  expect(html).toContain("Task difficulty now steers 1 of 2 executors");
  expect(html).not.toContain("Choose their own model");
  expect(html).not.toContain("claude-code");
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
  data?: string; attrs: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>;
  onclick?: null; oninput?: null; onchange?: null; onfocus?: null; onblur?: null; onkeydown?: null; onsubmit?: null;
  addEventListener: (type: string, fn: (event?: unknown) => void) => void; removeEventListener: (type: string) => void;
  setAttribute: (name: string, value: unknown) => void; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void;
  appendChild: (child: SelElement) => SelElement; insertBefore: (child: SelElement, before: SelElement | null) => SelElement;
  removeChild: (child: SelElement) => SelElement; focus: () => void; querySelector: () => null; querySelectorAll: () => SelElement[];
};
const selElement = (tag: string): SelElement => {
  const node: SelElement = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, _listeners: {},
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

test("the preview falls back to a runner's configured default below the target, read from runner.models.get (F3)", async () => {
  // A follow runner whose only model (provider/fast) is rated below the target
  // still shows its configured default ("fast", "Smaller than the target")
  // rather than "Not used", once the wiring passes the default from
  // runner.models.get into the preview exactly as plain delegation does.
  const inventoryModels: ModelRecord[] = [
    { runner: "opencode", account: "go", executor: "opencode", binding: { kind: "exact", id: "provider/fast" }, actualModel: null, tier: "small", strengths: [], provenance: "declared" } as ModelRecord,
  ];
  await withChoice(async (getHtml, calls) => {
    // The production wiring read the runner's configured default.
    expect(calls.filter(c => c.op === "runner.models.get").length).toBeGreaterThan(0);
    const html = getHtml();
    expect(html).toContain("Follow the tier");
    expect(html).toContain("fast");
    expect(html).toContain("Smaller than the target");
    expect(html).not.toContain("Not used");
  }, {
    runnerModels: { opencode: { runner: "opencode", revision: "r1", default: "provider/fast", models: [{ id: "provider/fast", tier: "small" }] } },
    inventoryModels,
  });
});

test("the preview shows a no-default follow runner running its provider's default, not 'Not used' (F4 wiring)", async () => {
  const inventoryModels: ModelRecord[] = [
    { runner: "opencode", account: "go", executor: "opencode", binding: { kind: "exact", id: "provider/small" }, actualModel: null, tier: "small", strengths: [], provenance: "declared" } as ModelRecord,
  ];
  await withChoice(async (getHtml) => {
    const html = getHtml();
    expect(html).toContain("Uses its provider's default");
    expect(html).not.toContain("Not used");
  }, {
    runnerModels: { opencode: { runner: "opencode", revision: "r1", default: null, models: [] } },
    inventoryModels,
  });
});