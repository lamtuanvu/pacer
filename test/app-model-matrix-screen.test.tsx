import { dispatchConfigSchema, type ModelRecord } from "../src/dispatch/types";
import { expect, test } from "bun:test";
import { h, render as preactRender } from "preact";
import { act } from "preact/test-utils";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ApiError, type BrowserApi } from "../app/src/data/api";
import { ModelMatrix } from "../app/src/screens/settings/ModelMatrix";
import type { AvailableModels } from "../src/models/available";
import type { RunnerModels } from "../src/core/runner-models";

const configView = (planner = "winston") => ({
  strategy: "custom", planner, plannerAccount: planner === "winston" ? "go" : planner,
  source: "strategy" as const, config: dispatchConfigSchema.parse({}),
});

const servedGo: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, provider: "Zhipu", models: [
  { id: "zhipu/glm", context: 200000, tools: true, costOut: 2.2 },
] };
const unknown: AvailableModels = { runner: "none", source: "none", fetchedAt: 1, models: null };

const declarationsGo: RunnerModels = { runner: "go", revision: "r-go", default: "zhipu/glm", models: [{ id: "zhipu/glm", tier: "unknown" }] };
const declarationsCodex: RunnerModels = { runner: "codex", revision: "r-none", default: null, models: [] };
const declarationsPlanner: RunnerModels = { runner: "claude-code", revision: "r-planner", default: "default-model", models: [{ id: "default-model", tier: "small" }] };

const record = (runner: string, account: string, executor: string, id: string, binding?: ModelRecord["binding"]): ModelRecord => ({
  runner, account, executor, binding: binding ?? { kind: "exact", id }, actualModel: null, tier: "unknown", strengths: [], tools: false, context: 0, provenance: "declared",
});
const inventory = (models: ModelRecord[]) => ({ models, advertised: [], observedAt: null } as { models: ModelRecord[]; advertised: { runner: string; account: string; model: { id: string }; authorized: boolean }[]; observedAt: number | null });

// ---------------------------------------------------------------------------
// A minimal fake DOM so preact's hooks and event handlers run; model after
// test/app-executor-models.test.tsx, which is how this repo exercises stateful
// settings screens.
// ---------------------------------------------------------------------------
type FakeElement = {
  nodeType: number; tagName: string; childNodes: FakeElement[]; parentNode: FakeElement | null;
  data?: string; attrs: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>;
  onclick?: null; oninput?: null; onchange?: null; onfocus?: null; onblur?: null; onkeydown?: null;
  addEventListener: (type: string, fn: (event?: unknown) => void) => void; removeEventListener: (type: string) => void;
  setAttribute: (name: string, value: unknown) => void; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void;
  appendChild: (child: FakeElement) => FakeElement; insertBefore: (child: FakeElement, before: FakeElement | null) => FakeElement;
  removeChild: (child: FakeElement) => FakeElement; focus: () => void; querySelector: () => null; querySelectorAll: () => FakeElement[];
};

const fakeElement = (tag: string): FakeElement => {
  const node: FakeElement = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, _listeners: {},
    onclick: null, oninput: null, onchange: null, onfocus: null, onblur: null, onkeydown: null,
    addEventListener(type, fn) { node._listeners[type] = fn; },
    removeEventListener(type) { delete node._listeners[type]; },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return name in node.attrs ? node.attrs[name] : null; },
    removeAttribute(name) { delete node.attrs[name]; },
    appendChild(child) { insert(node, child, null); return child; },
    insertBefore(child, before) { insert(node, child, before); return child; },
    removeChild(child) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    focus() { (document as unknown as { activeElement: FakeElement }).activeElement = node; }, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return node;
};
const insert = (parent: FakeElement, child: FakeElement, before: FakeElement | null) => {
  if (child.parentNode) child.parentNode.childNodes = child.parentNode.childNodes.filter(c => c !== child);
  const at = before ? parent.childNodes.indexOf(before) : -1;
  if (at < 0) parent.childNodes.push(child); else parent.childNodes.splice(at, 0, child);
  child.parentNode = parent;
};
const textOf = (node: FakeElement): string => node.nodeType === 3 ? node.data ?? "" : node.childNodes.map(textOf).join("");
const findNode = (node: FakeElement, match: (n: FakeElement) => boolean): FakeElement | null => {
  for (const child of node.childNodes) {
    if (match(child)) return child;
    const found = findNode(child, match);
    if (found) return found;
  }
  return null;
};
const allNodes = (node: FakeElement, match: (n: FakeElement) => boolean): FakeElement[] => {
  const out: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (match(child)) out.push(child);
    out.push(...allNodes(child, match));
  }
  return out;
};
const fire = (node: FakeElement, type: string, event: Record<string, unknown> = {}) => {
  const proxy = node._listeners[type];
  if (proxy) proxy.call(node, { type, ...event });
};
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
};

interface MatrixApi {
  calls: Array<{ op: string; params: Record<string, unknown> }>;
  api: BrowserApi;
}

function makeApi(opts: {
  models?: Record<string, RunnerModels>;
  available?: Record<string, AvailableModels>;
  config: ReturnType<typeof configView>;
  inventory: ReturnType<typeof inventory>;
  setMany?: { throw?: ApiError; warnings?: string[] };
}): MatrixApi {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  let saved = 0;
  return {
    calls,
    api: {
      hello: async () => ({} as never),
      snapshot: async () => ({} as never),
      async call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push({ op, params });
        switch (op) {
          case "dispatch.config.get": return opts.config as T;
          case "dispatch.models": return opts.inventory as T;
          case "executor.models.available":
            return (opts.available?.[String(params.runner)] ?? { ...unknown, runner: String(params.runner) }) as T;
          case "runner.models.get":
            return (opts.models?.[String(params.id)] ?? { runner: String(params.id), revision: "r-default", default: null, models: [] }) as T;
          case "runner.models.set_many":
            if (opts.setMany?.throw) throw opts.setMany.throw;
            saved += 1;
            return { revision: `r-saved-${saved}`, runners: params.runners, warnings: opts.setMany?.warnings ?? [] } as T;
          default: return {} as T;
        }
      },
    },
  };
}

async function withMatrix(run: (container: FakeElement, api: MatrixApi, rerender: (nextState: unknown) => Promise<void>) => Promise<void>, opts: {
  config: ReturnType<typeof configView>;
  inventory: ReturnType<typeof inventory>;
  models?: Record<string, RunnerModels>;
  available?: Record<string, AvailableModels>;
  setMany?: { throw?: ApiError; warnings?: string[] };
}) {
  const previous = { document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  globalThis.document = {
    adoptedStyleSheets: [], createElement: (t: string) => fakeElement(t), createElementNS: (_ns: string, t: string) => fakeElement(t),
    createTextNode: (t: string) => { const n = fakeElement("#text"); n.nodeType = 3; n.data = t; return n; },
    dispatchEvent() {}, addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false, activeElement: null,
  } as never;
  globalThis.CSSStyleSheet = class { replaceSync() {} } as never;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }) } as never;
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "0px" })) as never;
  globalThis.requestAnimationFrame = (() => 0) as never;
  const container = fakeElement("div");
  const api = makeApi(opts);
  const holder = { state: { ...initialState(), connected: true } };
  const view = () => <TaskContext.Provider value={{ state: holder.state, api: api.api }}>
    <ModelMatrix initialConfig={opts.config as never} initialInventory={opts.inventory} />
  </TaskContext.Provider>;
  const rerender = async (nextState: unknown) => {
    holder.state = nextState as never;
    await act(async () => { preactRender(view(), container as never); });
  };
  try {
    await act(async () => {
      preactRender(view(), container as never);
    });
    // Wait for the async draft load (runner.models.get per executor) before the
    // test interacts; otherwise a clicked handler sees an empty draft set.
    const runnerCount = opts.inventory.models.length;
    if (runnerCount) {
      await until(() => api.calls.filter(c => c.op === "runner.models.get").length >= runnerCount);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await run(container, api, rerender);
  } finally {
    await act(async () => { preactRender(null, container as never); });
    globalThis.document = previous.document; globalThis.CSSStyleSheet = previous.CSSStyleSheet;
    globalThis.window = previous.window; globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  }
}

const clickText = async (container: FakeElement, label: string) => {
  const button = findNode(container, n => n.tagName === "button" && textOf(n) === label);
  expect(button).toBeTruthy();
  await act(async () => { fire(button!, "click"); await new Promise(resolve => setTimeout(resolve, 0)); });
};

const clickRadioText = async (container: FakeElement, label: string) => {
  const radio = allNodes(container, n => n.tagName === "button" && n.attrs.role === "radio" && textOf(n).trim() === label);
  expect(radio.length).toBeGreaterThan(0);
  await act(async () => { fire(radio[0]!, "click"); await new Promise(resolve => setTimeout(resolve, 0)); });
};

test("an unknown-listing executor with no models shows the Add model field", async () => {
  await withMatrix(async (container, _api) => {
    expect(textOf(container)).toContain("Add model");
    expect(findNode(container, n => n.tagName === "input")).toBeTruthy();
    expect(textOf(container)).toContain("Uses its default and can take any difficulty");
  }, {
    config: configView(),
    inventory: inventory([record("codex", "work", "codex", "codex-default", { kind: "executor-default" })]),
    models: { codex: declarationsCodex },
    available: { codex: { ...unknown, runner: "codex" } },
  });
});

test("the planner executor renders switches disabled with the planner note", async () => {
  await withMatrix(async (container, _api) => {
    const text = textOf(container);
    expect(text).toContain("Planner. Pacer does not dispatch tasks to it");
    expect(text).not.toContain("Add model");
    const switches = allNodes(container, n => n.tagName === "input" && (n.attrs.class ?? "").includes("pc-switch"));
    expect(switches.length).toBeGreaterThan(0);
    for (const sw of switches) expect(sw.attrs.disabled).toBeDefined();
  }, {
    config: configView("claude-code"),
    inventory: inventory([record("claude-code", "claude-code", "claude-code", "default-model", { kind: "executor-default" })]),
    models: { "claude-code": declarationsPlanner },
    available: { "claude-code": { ...unknown, runner: "claude-code" } },
  });
});

test("clicking Suggest highlights rows but shows no Unsaved changes region", async () => {
  await withMatrix(async (container, _api) => {
    await clickText(container, "Suggest");
    expect(textOf(container)).toContain("Suggestions applied");
    expect(textOf(container)).toContain("Suggested:");
    expect(textOf(container)).not.toContain("Unsaved changes");
    expect(textOf(container)).not.toContain("Save matrix");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  });
});

test("Accept all then Save matrix writes set_many once with the load revision and only changed runners", async () => {
  await withMatrix(async (container, api) => {
    await clickText(container, "Suggest");
    await clickText(container, "Accept all");
    await clickText(container, "Save matrix");
    await until(() => api.calls.some(c => c.op === "runner.models.set_many"));
    const setMany = api.calls.filter(c => c.op === "runner.models.set_many");
    expect(setMany).toHaveLength(1);
    expect(setMany[0]!.params.expectedRevision).toBe("r-go");
    expect(setMany[0]!.params.runners).toEqual([
      { id: "go", default: "zhipu/glm", models: [{ id: "zhipu/glm", tier: "medium" }] },
    ]);
    expect(textOf(container)).toContain("Saved.");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  });
});

test("a successful save reloads dispatch.models for the coverage", async () => {
  await withMatrix(async (container, api) => {
    await clickText(container, "Suggest");
    await clickText(container, "Accept all");
    await clickText(container, "Save matrix");
    await until(() => api.calls.some(c => c.op === "runner.models.set_many"));
    expect(api.calls.filter(c => c.op === "runner.models.set_many")).toHaveLength(1);
    // dispatch.models is refetched after a save so other screens reflect the change.
    const setManyIndex = api.calls.findIndex(c => c.op === "runner.models.set_many");
    expect(api.calls.slice(setManyIndex).some(c => c.op === "dispatch.models")).toBe(true);
    expect(textOf(container)).toContain("Saved.");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  });
});

test("a conflicting set_many keeps the draft and asks to Discard", async () => {
  await withMatrix(async (container, api) => {
    await clickText(container, "Suggest");
    await clickText(container, "Accept all");
    await clickText(container, "Save matrix");
    await until(() => api.calls.some(c => c.op === "runner.models.set_many"));
    expect(textOf(container)).toContain("Model settings changed elsewhere. Discard to load them.");
    // The draft is kept: the dirtied save bar and its Discard action remain.
    expect(textOf(container)).toContain("1 model changed");
    expect(textOf(container)).toContain("Save matrix");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
    setMany: { throw: new ApiError("conflict", "Executor settings changed elsewhere.") },
  });
});

test("save warnings are shown in plain words and the routine ones are hidden", async () => {
  await withMatrix(async (container, api) => {
    await clickText(container, "Suggest");
    await clickText(container, "Accept all");
    await clickText(container, "Save matrix");
    await until(() => api.calls.some(c => c.op === "runner.models.set_many"));
    expect(textOf(container)).toContain("Saved.");
    // The unrated-model routine warning is folded into the save, the real one stays readable.
    expect(textOf(container)).toContain("x could not be checked: offline");
    expect(textOf(container)).not.toContain("is unrated");
    expect(textOf(container)).not.toContain("runners.");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
    setMany: { warnings: ["runners.go: model \"x\" is unrated (tier unknown)", "x could not be checked: offline"] },
  });
});

test("a config event while the page is dirty keeps the draft and asks to Discard", async () => {
  const options = {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  };
  await withMatrix(async (container, _api, rerender) => {
    // Make the page dirty by turning the only model off.
    const sw = findNode(container, n => n.tagName === "input" && (n.attrs["aria-label"] ?? "") === "Use zhipu/glm");
    expect(sw).toBeTruthy();
    await act(async () => { fire(sw!, "change", { currentTarget: { checked: false } }); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(textOf(container)).toContain("1 model changed");
    // A config change elsewhere (new tier targets) is then observed while dirty.
    options.config = { ...options.config, config: { ...options.config.config, tierTargets: { simple: "medium", standard: "medium", complex: "frontier" } } };
    await rerender({ ...initialState(), connected: true, invalidations: { config: 1 } });
    // The draft is kept and the conflict is surfaced instead of silently discarded.
    await until(() => textOf(container).includes("Model settings changed elsewhere. Discard to load them."));
    expect(textOf(container)).toContain("Model settings changed elsewhere. Discard to load them.");
    expect(textOf(container)).toContain("1 model changed");
    expect(textOf(container)).toContain("Save matrix");
  }, options);
});

test("rating a row updates its Takes text to match the coverage cards (B1)", async () => {
  await withMatrix(async (container) => {
    // The model starts unrated: no difficulty it can take.
    expect(textOf(container)).toContain("Any, unrated");
    await clickRadioText(container, "Medium");
    // Medium covers simple and standard for the default small/medium/frontier mapping.
    expect(textOf(container)).toContain("Simple, Standard");
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  });
});

test("adding the first model marks it Default and the add field is a form so Enter works", async () => {
  await withMatrix(async (container) => {
    expect(textOf(container)).toContain("Add model");
    // The add field is wrapped in a form so pressing Enter submits it (task #8).
    const form = findNode(container, n => n.tagName === "form");
    expect(form).toBeTruthy();
    const input = findNode(container, n => n.tagName === "input");
    expect(input).toBeTruthy();
    await act(async () => { fire(input!, "input", { currentTarget: { value: "gpt-5.5" } }); await new Promise(r => setTimeout(r, 0)); });
    await clickText(container, "Add");
    expect(textOf(container)).toContain("gpt-5.5");
    // The tag mirrors the draft default, not the loaded flag.
    expect(textOf(container)).toContain("Default");
  }, {
    config: configView(),
    inventory: inventory([record("codex", "work", "codex", "codex-default", { kind: "executor-default" })]),
    models: { codex: declarationsCodex },
    available: { codex: { ...unknown, runner: "codex" } },
  });
});

test("the matrix grid carries table semantics so cells relate to their headers", async () => {
  await withMatrix(async (container) => {
    expect(findNode(container, n => n.attrs.role === "table")).toBeTruthy();
    expect(findNode(container, n => n.attrs.role === "rowgroup")).toBeTruthy();
    expect(allNodes(container, n => n.attrs.role === "columnheader").length).toBeGreaterThan(0);
    expect(allNodes(container, n => n.attrs.role === "row").length).toBeGreaterThan(0);
    expect(allNodes(container, n => n.attrs.role === "cell").length).toBeGreaterThan(0);
  }, {
    config: configView(),
    inventory: inventory([record("go", "zhipu", "opencode", "zhipu/glm")]),
    models: { go: declarationsGo },
    available: { go: servedGo },
  });
});

test("the coverage cards exclude the planner executor", async () => {
  // go is rated small; claude-code is the planner (executor-default, account team);
  // codex has no model. Only go and codex are dispatch targets.
  const goRated: RunnerModels = { runner: "go", revision: "r-go", default: "zhipu/glm", models: [{ id: "zhipu/glm", tier: "small" }] };
  await withMatrix(async (container) => {
    const text = textOf(container);
    // go can take Simple (1 model); codex is the only target that uses its default model.
    expect(text).toContain("1 model");
    expect(text).toContain("Plus 1 executor that use their default model.");
  }, {
    config: configView("claude-code"),
    inventory: inventory([
      record("go", "zhipu", "opencode", "zhipu/glm"),
      record("claude-code", "team", "claude-code", "default-model", { kind: "executor-default" }),
      record("codex", "work", "codex", "codex-default", { kind: "executor-default" }),
    ]),
    models: {
      go: goRated,
      "claude-code": declarationsPlanner,
      codex: declarationsCodex,
    },
    available: {
      go: servedGo,
      "claude-code": { ...unknown, runner: "claude-code" },
      codex: { ...unknown, runner: "codex" },
    },
  });
});