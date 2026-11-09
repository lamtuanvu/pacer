import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ExecutorModels, ModelFactLink, focusSection } from "../app/src/screens/settings/ExecutorModels";
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
