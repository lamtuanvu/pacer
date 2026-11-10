import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { h, render as preactRender } from "preact";
import { act } from "preact/test-utils";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ExecutorModels, ModelFactLink, focusSection } from "../app/src/screens/settings/ExecutorModels";
import { ActionContext } from "../app/src/data/action-context";
import { createActionRunner } from "../app/src/data/actions";
import type { BrowserApi } from "../app/src/data/api";
import type { AvailableModels } from "../src/models/available";

const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as never;
const render = (child: unknown) => renderToString(<TaskContext.Provider value={{ state: initialState(), api }}>{child as never}</TaskContext.Provider>);

const served: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: [
  { id: "zhipu/glm-4.7", name: "GLM 4.7", context: 200000, output: 8192, costIn: 0.6, costOut: 2.2 },
  { id: "zhipu/glm-4.7-air", context: 131072, output: 8192 },
] };
const servedLabeled: AvailableModels = { ...served, provider: "Zhipu" };
const emptyListing: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: null, note: "opencode lists no models for zhipu; check opencode auth list" };
const unknown: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: null, note: "opencode could not list models for openrouter" };
const saveButton = (html: string) => html.match(/<button[^>]*>[\s\S]*?Save model/)?.[0] ?? "";

test("Models shows the default with a searchable picker of served models", () => {
  const html = render(<ExecutorModels runner="go" model="zhipu/glm-4.7" provider="zhipu" initialAvailable={served} />);
  expect(html).toContain('<span class="pc-choice-picker__value">glm-4.7</span>');
  expect(html).toContain("Refresh list");
});

test("a default the provider stopped serving shows the warning and Replace", () => {
  const html = render(<ExecutorModels runner="go" model="zhipu/glm-4.5" provider="Go" initialAvailable={served} />);
  expect(html).toContain("glm-4.5 is no longer offered by Go");
  expect(html).toContain("Replace…");
});

test("the warning names the listing's provider, not the account", () => {
  const html = render(<ExecutorModels runner="go" model="zhipu/glm-4.5" provider="Go" initialAvailable={servedLabeled} />);
  expect(html).toContain("glm-4.5 is no longer offered by Zhipu");
});

test("Save model is disabled while the choice equals the current model or is empty", () => {
  // The picker starts on the current default and the free-text field starts with it or empty,
  // so an unchanged render renders the disabled state; typing or picking a different id enables it.
  const unchanged = render(<ExecutorModels runner="go" model="zhipu/glm-4.7" provider="Go" initialAvailable={served} />);
  expect(saveButton(unchanged)).toContain("disabled");
  const empty = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={emptyListing} />);
  expect(saveButton(empty)).toContain("disabled");
});

test("an agent without a list offers a free-text model id", () => {
  const html = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={unknown} />);
  expect(html).toContain(">Model id</label>");
  expect(/<input[^>]*class="pc-input/.test(html)).toBe(true);
  expect(/<button[^>]*>[\s\S]*?Save model/.test(html)).toBe(true);
});

test("an unknown listing explains and keeps the save path", () => {
  const html = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={unknown} />);
  expect(html).toContain("opencode could not list models for openrouter");
  expect(saveButton(html)).toContain("Save model");
});

test("the Model fact link targets the in-page Models section", () => {
  // The app routes on location.hash, so the anchor must not navigate: the section it points at
  // carries id="models" and the link keeps href="#models".
  const section = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={unknown} />);
  expect(/<section[^>]*\bid="models"/.test(section)).toBe(true);
  const link = render(<ModelFactLink model={null} />);
  expect(link).toContain('<a href="#models"');
  expect(link).toContain("Agent default");
});

test("clicking the Model fact link focuses the Models section instead of navigating", () => {
  let prevented = false, focused = 0, scrolled: unknown = null;
  const target = { tabIndex: 0, focus: () => { focused += 1; }, scrollIntoView: (options: unknown) => { scrolled = options; } };
  const event = { preventDefault: () => { prevented = true; } };
  const saved = globalThis.document;
  globalThis.document = { getElementById: (id: string) => id === "models" ? target : null } as never;
  try { focusSection(event, "models"); }
  finally { globalThis.document = saved; }
  expect(prevented).toBe(true);
  expect(focused).toBe(1);
  expect(scrolled).toEqual({ block: "start" });
});

// ---------------------------------------------------------------------------
// A real mount runs the hooks and the save flow's callbacks; server rendering
// intentionally suppresses them, so this test renders against a minimal fake
// DOM whose elements record the props and listeners preact attaches. Only the
// plain-node surface preact touches is stubbed; the component is mounted under
// a null-models listing to keep the picker out of the exercise.
// ---------------------------------------------------------------------------
type FakeElement = {
  nodeType: number; tagName: string; childNodes: FakeElement[]; parentNode: FakeElement | null;
  data?: string; attrs: Record<string, string>; _listeners: Record<string, (event?: unknown) => void>;
  // Predefined so preact resolves the lowercase DOM event name for its handler map.
  onclick?: null; oninput?: null; onfocus?: null; onblur?: null; onkeydown?: null; onchange?: null;
  addEventListener: (type: string, fn: (event?: unknown) => void) => void; removeEventListener: (type: string) => void;
  setAttribute: (name: string, value: unknown) => void; getAttribute: (name: string) => string | null; removeAttribute: (name: string) => void;
  appendChild: (child: FakeElement) => FakeElement; insertBefore: (child: FakeElement, before: FakeElement | null) => FakeElement;
  removeChild: (child: FakeElement) => FakeElement; focus: () => void;
};

const fakeElement = (tag: string): FakeElement => {
  const node: FakeElement = {
    nodeType: 1, tagName: tag, childNodes: [], parentNode: null, attrs: {}, _listeners: {},
    // Predefine the event props preact checks with `in node` so it keys its handler map by the
    // lowercase DOM event name (its dispatch proxy then matches `this.l[type]`).
    onclick: null, oninput: null, onfocus: null, onblur: null, onkeydown: null, onchange: null,
    addEventListener(type, fn) { node._listeners[type] = fn; },
    removeEventListener(type) { delete node._listeners[type]; },
    setAttribute(name: string, value: unknown) { node.attrs[name] = String(value); },
    getAttribute(name: string) { return name in node.attrs ? node.attrs[name] : null; },
    removeAttribute(name: string) { delete node.attrs[name]; },
    appendChild(child) { insert(node, child, null); return child; },
    insertBefore(child, before) { insert(node, child, before); return child; },
    removeChild(child) { node.childNodes = node.childNodes.filter(c => c !== child); child.parentNode = null; return child; },
    focus() {},
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
/** Fires a captured preact event proxy with `this` bound to the fake element. */
const fire = (node: FakeElement, type: string, event: Record<string, unknown> = {}) => {
  const proxy = node._listeners[type];
  if (proxy) proxy.call(node, { type, ...event });
};
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
};

test("a successful save refreshes the models listing and calls onSaved afterwards", async () => {
  const previous = { document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  // Preact renders against a document; keep the stub scoped to this test.
  globalThis.document = {
    adoptedStyleSheets: [], createElement: (t: string) => fakeElement(t), createElementNS: (_ns: string, t: string) => fakeElement(t),
    createTextNode: (t: string) => { const n = fakeElement("#text"); n.nodeType = 3; n.data = t; return n; },
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false, activeElement: null,
  } as never;
  globalThis.CSSStyleSheet = class { replaceSync() {} } as never;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }) } as never;
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "0px" })) as never;
  globalThis.requestAnimationFrame = (() => 0) as never;
  try {
    const unknown = { runner: "go", source: "opencode", fetchedAt: 1, models: null, note: "opencode could not list models" };
    const calls: Array<{ op: string; params: unknown }> = [];
    const api = {
      call: async (op: string, params: unknown) => {
        calls.push({ op, params });
        if (op === "runner.models.get") return {runner: "go", revision: "v1", default: null, models: []};
        if (op === "executor.models.available") return { ...unknown, provider: "zhipu", models: [{ id: "zhipu/glm-4.7" }] };
        return {};
      },
    } as BrowserApi;
    const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch() {}, navigate() {} });
    let saved = 0;
    const container = fakeElement("div");
    const screen = h(TaskContext.Provider, { value: { state: { ...initialState(), connected: true }, api } },
      h(ActionContext.Provider, { value: runner },
        h(ExecutorModels, { runner: "go", model: null, provider: "zhipu", initialAvailable: unknown as never, onSaved: () => { saved += 1; } })));
    await act(async () => { preactRender(screen as never, container as never); });
    const input = findNode(container, (n) => n.tagName === "input");
    expect(input).toBeTruthy();
    await act(async () => { fire(input!, "input", { currentTarget: { value: "zhipu/glm-4.7" } }); });
    const button = findNode(container, (n) => n.tagName === "button" && textOf(n).includes("Save model"));
    expect(button).toBeTruthy();
    await act(async () => { fire(button!, "click"); });
    await until(() => saved > 0);
    expect(saved).toBe(1);
    expect(calls.find(c => c.op === "runner.set")).toEqual({ op: "runner.set", params: { id: "go", model: "zhipu/glm-4.7" } });
    // The stale no-longer-offered warning must not survive the save: the listing
    // is refetched with the one-shot refresh, then the check task runs.
    expect(calls.some(c => c.op === "executor.models.available" && (c.params as { refresh?: boolean }).refresh === true)).toBe(true);
    expect(calls.some(c => c.op === "runner.check")).toBe(true);
    await act(async () => { preactRender(null, container as never); });
  } finally {
    globalThis.document = previous.document; globalThis.CSSStyleSheet = previous.CSSStyleSheet;
    globalThis.window = previous.window; globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
  }
}, 15000);

const declarations = { runner: "go", revision: "v1", default: "zhipu/glm-4.7", models: [{ id: "zhipu/glm-4.7", tier: "unknown" as const }] };
test("rows show tier chips and new rows start Unrated with a suggestion", () => {
  const html = render(<ExecutorModels runner="go" model={declarations.default} provider="Go" initialAvailable={served} initialModels={declarations} />);
  expect(html).toContain("Models for tasks");
  expect(html).toContain("Unrated");
  expect(html).toContain("Suggested: Medium");
});
test("a row no longer offered shows the warning", () => {
  const html = render(<ExecutorModels runner="go" model={declarations.default} provider="Go" initialAvailable={servedLabeled} initialModels={{ ...declarations, models: [...declarations.models, { id: "zhipu/old", tier: "small" }] }} />);
  expect(html).toContain("old is no longer offered by Zhipu");
});

async function withModelScreen(run: (container: FakeElement, calls: Array<{op: string; params: any}>, saved: () => number) => Promise<void>, failure?: string, listing: AvailableModels = served) {
  const previous = { document: globalThis.document, CSSStyleSheet: globalThis.CSSStyleSheet, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle, requestAnimationFrame: globalThis.requestAnimationFrame };
  // Preact renders against a document; keep the stub scoped to this test.
  globalThis.document = {
    adoptedStyleSheets: [], createElement: (t: string) => fakeElement(t), createElementNS: (_ns: string, t: string) => fakeElement(t),
    createTextNode: (t: string) => { const n = fakeElement("#text"); n.nodeType = 3; n.data = t; return n; },
    addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, contains: () => false, activeElement: null,
  } as never;
  globalThis.CSSStyleSheet = class { replaceSync() {} } as never;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200, matchMedia: () => ({ matches: false }) } as never;
  globalThis.getComputedStyle = (() => ({ getPropertyValue: () => "0px" })) as never;
  globalThis.requestAnimationFrame = (() => 0) as never;
  const container = fakeElement("div");
  try {
    const calls: Array<{op: string; params: any}> = [];
    let saved = 0;
    const api = { call: async (op: string, params: any) => {
      calls.push({op, params});
      if (op === "executor.models.available") return listing;
      if (op === "runner.models.get") return calls.some(c => c.op === "runner.models.set") ? {...declarations, revision: "v2", models: [{id: declarations.default, tier: "small"}]} : declarations;
      if (op === "runner.models.set") {
        if (failure) throw Object.assign(new Error(failure === "conflict" ? "stale" : "Save refused"), {code: failure});
        return {runner: "go", revision: "v2", default: params.default, models: params.models, warnings: ["Example warning"]};
      }
      return {};
    }} as BrowserApi;
    const actions = createActionRunner({call: api.call, waitFor: async () => true, refetch() {}, navigate() {}});
    await act(async () => { preactRender(<TaskContext.Provider value={{state: {...initialState(), connected: true}, api}}>
      <ActionContext.Provider value={actions}><ExecutorModels runner="go" model={declarations.default} provider="Go" initialAvailable={listing} initialModels={declarations} onSaved={() => {saved++;}} /></ActionContext.Provider>
    </TaskContext.Provider>, container as never); });
    await run(container, calls, () => saved);
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
test("tier edits save once with the revision, then check and notify", async () => {
  await withModelScreen(async (container, calls, saved) => {
    await clickText(container, "Suggested: Medium");
    expect(calls.some(c => c.op === "runner.models.set")).toBe(false);
    await clickText(container, "Save model");
    expect(calls.filter(c => c.op === "runner.models.set")).toEqual([{op: "runner.models.set", params: {id: "go", expectedRevision: "v1", default: declarations.default, models: [{id: declarations.default, tier: "medium"}]}}]);
    expect(calls.some(c => c.op === "runner.set")).toBe(false);
    expect(calls.some(c => c.op === "runner.check")).toBe(true);
    expect(saved()).toBe(1);
    expect(textOf(container)).toContain("Example warning");
  });
});
test("a stale save reloads declarations and announces the conflict", async () => {
  await withModelScreen(async (container, calls, saved) => {
    await clickText(container, "Suggested: Medium");
    await clickText(container, "Save model");
    expect(textOf(container)).toContain("Changed elsewhere; reloaded");
    expect(calls.filter(c => c.op === "runner.models.get").length).toBeGreaterThan(1);
    expect(calls.some(c => c.op === "runner.check")).toBe(false);
    expect(saved()).toBe(0);
    await clickText(container, "Frontier");
    await clickText(container, "Save model");
    expect(calls.filter(c => c.op === "runner.models.set")[1].params.expectedRevision).toBe("v2");
  }, "conflict");
});
test("a failed save keeps the edited draft and reports the error", async () => {
  await withModelScreen(async (container, calls, saved) => {
    await clickText(container, "Suggested: Medium");
    await clickText(container, "Save model");
    expect(textOf(container)).toContain("Save refused");
    expect(textOf(container)).not.toContain("Suggested: Medium");
    expect(calls.some(c => c.op === "runner.check")).toBe(false);
    expect(saved()).toBe(0);
  }, "invalid_input");
});
test("removing the last declaration saves an empty list atomically", async () => {
  await withModelScreen(async (container, calls) => {
    await clickText(container, "Remove");
    await clickText(container, "Save model");
    expect(calls.find(c => c.op === "runner.models.set")?.params.models).toEqual([]);
    expect(calls.some(c => c.op === "runner.set")).toBe(false);
  });
});

test("adding a model from an unknown listing starts Unrated and stays local until save", async () => {
  await withModelScreen(async (container, calls) => {
    const input = findNode(container, n => n.tagName === "input");
    expect(input).toBeTruthy();
    await act(async () => { fire(input!, "input", {currentTarget: {value: "custom/new"}}); });
    await clickText(container, "Add model");
    expect(textOf(container)).toContain("newSmallMediumFrontierUnrated");
    expect(calls.some(c => c.op === "runner.models.set")).toBe(false);
    await clickText(container, "Save model");
    expect(calls.find(c => c.op === "runner.models.set")?.params.models).toEqual([...declarations.models, {id: "custom/new", tier: "unknown"}]);
  }, undefined, unknown);
});
