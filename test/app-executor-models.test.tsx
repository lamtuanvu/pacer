import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ExecutorModels } from "../app/src/screens/settings/ExecutorModels";
import type { AvailableModels } from "../src/models/available";

const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as never;
const render = (child: unknown) => renderToString(<TaskContext.Provider value={{ state: initialState(), api }}>{child as never}</TaskContext.Provider>);

const served: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: [
  { id: "zhipu/glm-4.7", name: "GLM 4.7", context: 200000, output: 8192, costIn: 0.6, costOut: 2.2 },
  { id: "zhipu/glm-4.7-air", context: 131072, output: 8192 },
] };
const unknown: AvailableModels = { runner: "go", source: "opencode", fetchedAt: 1, models: null, note: "opencode could not list models for openrouter" };

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

test("an agent without a list offers a free-text model id", () => {
  const html = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={unknown} />);
  expect(html).toContain(">Model id</label>");
  expect(/<input[^>]*class="pc-input/.test(html)).toBe(true);
  expect(/<button[^>]*>[\s\S]*?Save model/.test(html)).toBe(true);
});

test("an unknown listing explains and still allows saving", () => {
  const html = render(<ExecutorModels runner="go" model={null} provider="Go" initialAvailable={unknown} />);
  expect(html).toContain("opencode could not list models for openrouter");
  const button = html.match(/<button[^>]*>[\s\S]*?Save model/)?.[0] ?? "";
  expect(button).not.toContain("disabled");
});
