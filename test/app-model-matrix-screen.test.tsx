import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ModelMatrix } from "../app/src/screens/settings/ModelMatrix";
import { dispatchConfigSchema } from "../src/dispatch/types";

const config = dispatchConfigSchema.parse({});
const view = { strategy: "custom", planner: "opencode", plannerAccount: "go", source: "strategy" as const, config };

const inventory = {
  models: [
    { runner: "opencode#oc-glm", account: "go", executor: "opencode", binding: { kind: "exact", id: "glm" }, actualModel: null, tier: "small", strengths: [], tools: true, context: 200000, provenance: "declared" },
    { runner: "opencode#oc-glm", account: "go", executor: "opencode", binding: { kind: "exact", id: "glm2" }, actualModel: null, tier: "unknown", strengths: [], tools: false, context: 128000, provenance: "declared" },
  ],
  advertised: [],
  observedAt: null,
} as any;

const api = { call: async () => ({}), hello: async () => ({}), snapshot: async () => ({}) } as never;

const render = () => renderToString(
  <TaskContext.Provider value={{ state: initialState(), api }}>
    <ModelMatrix initialConfig={view as any} initialInventory={inventory} />
  </TaskContext.Provider>
);

test("Model matrix screen renders", () => {
  const html = render();
  expect(html).toContain("Model matrix");
  expect(html).toContain("Suggest from listings");
});