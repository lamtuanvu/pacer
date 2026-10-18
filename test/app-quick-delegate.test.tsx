import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { initialState, reduceStore } from "../app/src/data/store";
import { TaskContext } from "../app/src/screens/task-shared";
import { QuickDelegate } from "../app/src/screens/QuickDelegate";

const snap = fixture as unknown as ClientSnapshot;
const state = reduceStore(reduceStore(initialState(), { type: "hello", hello: { pacer: "0.3.0", protocol: "2.8.0", ops: ["repo.list", "routing.route"], events: ["attention"] } }), { type: "snapshot", snapshot: snap });
const api = { hello: async () => ({}) as never, snapshot: async () => ({}) as never, call: async <T,>() => ({}) as T };
const render = (repo: string | null) => renderToString(<TaskContext.Provider value={{ state, api }}><QuickDelegate filterRepo={repo} /></TaskContext.Provider>);

test("quick delegate asks what should be done, with a repo picker and one button", () => {
  const html = render(null);
  expect(html).toContain("What should be done?");
  expect(html).toContain('id="qd-goal"');
  expect(html).toContain(">acme/api<");
  expect(html).toContain(">Delegate<");
  expect(html).not.toContain("pc-btn--primary");
});

test("quick delegate starts on the filtered repo", () => {
  expect(render("github.com/acme/web")).toMatch(/<option value="github.com\/acme\/web" selected/);
});
