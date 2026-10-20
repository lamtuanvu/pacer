import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { AddExecutor } from "../app/src/screens/settings/AddExecutor";
import { OpencodeSetup } from "../app/src/screens/settings/OpencodeSetup";
import type { Candidate, Detection } from "../src/endpoints/detect";

const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as never;
const render = (child: unknown) => renderToString(<TaskContext.Provider value={{ state: initialState(), api }}>{child as never}</TaskContext.Provider>);
const openrouter: Candidate = { group: "signed_in", provider: "openrouter", name: "OpenRouter", added: null, usage: { usage: "metered", known: true } };
const detection: Detection = {
  candidates: [
    openrouter,
    { group: "local", provider: "ollama", name: "Ollama", added: null, usage: { usage: "unmetered", known: true }, base_url: "http://127.0.0.1:11434/v1", models: 3 },
    { group: "catalog", provider: "deepseek", name: "DeepSeek", added: null, usage: { usage: "metered", known: true } },
    { group: "signed_in", provider: "zhipuai", name: "Zhipu AI", added: "zhipu", usage: { usage: "quota", known: true } },
  ],
  opencode: true, catalog: "fresh", notes: ["Using the cached models catalog."],
};
const models = { pick: { id: "qwen/qwen3-coder", context: 262144, output: 65536, tools: true, costIn: 0.22, costOut: 0.95 },
  rest: [{ id: "deepseek/deepseek-chat", context: 128000, output: 8192, tools: true, costIn: null, costOut: null }], usage: { usage: "metered" as const, known: true } };

test("groups render in order with usage pills, notes and added providers disabled with their reason", () => {
  const html = render(<OpencodeSetup onCreated={() => {}} onUseUrl={() => {}} initialDetection={detection} />);
  const at = (text: string) => html.indexOf(text);
  expect(at("Already signed in to OpenCode")).toBeGreaterThan(-1);
  expect(at("Already signed in to OpenCode")).toBeLessThan(at("Running on this machine"));
  expect(at("Running on this machine")).toBeLessThan(at("Connect a provider"));
  for (const text of ["OpenRouter", "Metered", "Free", "DeepSeek", "Added as zhipu", "Using the cached models catalog.", "Use a URL instead", "Search providers", "3 models"]) expect(html).toContain(text);
  expect(html).not.toContain("pc-card");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Zhipu AI/);
  expect((html.match(/pc-btn--primary/g) || []).length).toBe(0);
});

test("a signed-in provider preselects the recommended model and offers a spend cap and a name", () => {
  const html = render(<OpencodeSetup onCreated={() => {}} onUseUrl={() => {}} initialDetection={detection} initialChoice={openrouter} initialModels={models} />);
  expect(html).toMatch(/<option[^>]*value="qwen\/qwen3-coder"[^>]*>qwen\/qwen3-coder \(recommended\)/);
  expect(html).toContain("262K context · $0.22/$0.95 per M");
  expect(html).toContain("Weekly spend cap in $");
  expect(html).toContain("Leave blank for no cap; spend is always shown.");
  expect(html).toMatch(/value="openrouter"/);
  expect(html).toContain("Add executor");
});

test("a local server needs no cap; unknown usage asks for it", () => {
  const local = detection.candidates[1]!;
  const html = render(<OpencodeSetup onCreated={() => {}} onUseUrl={() => {}} initialDetection={detection} initialChoice={local} initialModels={{ ...models, usage: { usage: "unmetered", known: true } }} />);
  expect(html).not.toContain("Weekly spend cap");
  const unknown = render(<OpencodeSetup onCreated={() => {}} onUseUrl={() => {}} initialDetection={detection} initialChoice={openrouter} initialModels={{ ...models, usage: { usage: "metered", known: false } }} />);
  expect(unknown).toContain("Quota — a plan with limits");
});

test("a catalog provider shows the OpenCode sign-in command and asks for no key", () => {
  const html = render(<OpencodeSetup onCreated={() => {}} onUseUrl={() => {}} initialDetection={detection} initialChoice={detection.candidates[2]} />);
  expect(html).toContain("<code>opencode auth login deepseek</code>");
  expect(html).toContain("Refresh");
  expect(html).not.toMatch(/type="password"/);
  expect(html).toContain("Once it is signed in, DeepSeek appears under");
});

test("Add executor step 2 for OpenCode shows the provider picker, and the URL form keeps its clearer usage labels", () => {
  const html = render(<AddExecutor initialDraft={{ agent: "opencode", step: "2" }} initialAccounts={[]} />);
  expect(html).toContain("Use a URL instead");
  expect(html).not.toContain("Base URL");
});
