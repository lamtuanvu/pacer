import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { ApiError, type BrowserApi } from "../app/src/data/api";
import { useModelDrafts, type ModelDraftsState } from "../app/src/screens/settings/useModelDrafts";
import { useExecutorSettings, type ExecutorSettingsState } from "../app/src/screens/settings/useExecutorSettings";
import type { ExecutorSettings } from "../app/src/model/executor-settings";
import type { RunnerModels } from "../src/core/runner-models";
import type { AvailableModels } from "../src/models/available";
import { fakeElement, installFakeDom, until } from "./fixtures/fake-dom";

// Dispatcher › Agents keeps two page drafts: every agent's models (runner.models.set_many) and the executor
// order/limits (runner.settings.save). Both are revision-checked against the one strategy revision. These tests
// carry over the Model matrix and Executors draft guarantees to the hooks the Agents tab uses.
const targets = { simple: "small", standard: "medium", complex: "frontier" } as const;
let restore: () => void;
beforeEach(() => { restore = installFakeDom(); });
afterEach(() => restore());

interface Server {
  revision: string;
  models: Record<string, RunnerModels>;
  available: Record<string, AvailableModels>;
  settings: ExecutorSettings;
  calls: { op: string; params: Record<string, unknown> }[];
  gate?: Promise<void>;
  fail?: unknown;
  /** Commit the next settings save, then lose its response. */
  lose?: boolean;
  warnings?: string[];
}
const server = (models: Record<string, Omit<RunnerModels, "revision" | "runner">>, available: Record<string, AvailableModels> = {}): Server => ({
  revision: "r1", available, calls: [],
  models: Object.fromEntries(Object.entries(models).map(([runner, value]) => [runner, { runner, revision: "r1", ...value }])),
  settings: { revision: "r1", order: ["codex", "go"], runners: [{ id: "codex", enabled: true, maxTasks: 1 }, { id: "go", enabled: true, maxTasks: 2 }] },
});
const bump = (s: Server) => {
  s.revision = `r${Number(s.revision.slice(1)) + 1}`;
  for (const runner of Object.values(s.models)) runner.revision = s.revision;
  s.settings = { ...s.settings, revision: s.revision };
};
const apiFor = (s: Server): BrowserApi => ({
  hello: async () => ({}) as never, snapshot: async () => ({}) as never,
  async call<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    s.calls.push({ op, params });
    switch (op) {
      case "executor.models.available": return (s.available[String(params.runner)] ?? { runner: String(params.runner), source: "none", models: null, fetchedAt: 1 }) as T;
      case "runner.models.get": {
        if (String(params.id) === "broken") throw new ApiError("unknown_executor", "Unknown executor broken");
        return structuredClone(s.models[String(params.id)] ?? { runner: String(params.id), revision: s.revision, default: null, models: [] }) as T;
      }
      case "runner.models.set_many": {
        if (s.gate) await s.gate;
        if (s.fail) throw s.fail;
        if (params.expectedRevision !== s.revision) throw new ApiError("conflict", "Executor settings changed elsewhere.");
        bump(s);
        for (const runner of params.runners as { id: string; default: string; models: RunnerModels["models"] }[]) s.models[runner.id] = { runner: runner.id, revision: s.revision, default: runner.default, models: runner.models };
        return { revision: s.revision, runners: (params.runners as { id: string }[]).map(r => s.models[r.id]), warnings: s.warnings ?? [] } as T;
      }
      case "runner.settings.get": return structuredClone(s.settings) as T;
      case "runner.settings.save": {
        if (s.fail) throw s.fail;
        if (params.expectedRevision !== s.revision) throw new ApiError("conflict", "Executor settings changed elsewhere.");
        bump(s);
        s.settings = { revision: s.revision, order: params.order as string[], runners: params.runners as ExecutorSettings["runners"] };
        if (s.lose) { s.lose = false; throw new Error("socket closed"); }
        return { ...structuredClone(s.settings), warnings: s.warnings ?? [] } as T;
      }
      default: return {} as T;
    }
  },
});

/** Mount one hook in a throwaway component; `get()` returns its latest state. */
async function mount<T>(s: Server, hook: () => T): Promise<{ get: () => T; rerender: () => Promise<void>; unmount: () => Promise<void> }> {
  let latest: T;
  const container = fakeElement("div");
  const api = apiFor(s);
  let tick = 0;
  const Harness = () => { latest = hook(); return null; };
  const view = () => <TaskContext.Provider value={{ state: { ...initialState(), connected: true, invalidations: { runners: tick } }, api }}><Harness /></TaskContext.Provider>;
  await act(async () => { render(view(), container as never); });
  return {
    get: () => latest!,
    rerender: async () => { tick++; await act(async () => { render(view(), container as never); }); },
    unmount: async () => { await act(async () => { render(null, container as never); }); },
  };
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
const models = async (s: Server, runners = Object.keys(s.models)) => {
  const page = await mount<ModelDraftsState>(s, () => useModelDrafts(runners, targets));
  await until(() => page.get().loaded && page.get().drafts.length >= runners.filter(r => r !== "broken").length);
  await settle();
  return page;
};
const sets = (s: Server) => s.calls.filter(call => call.op === "runner.models.set_many");

test("the table lists declared models only; the listing describes them and feeds Add a model", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "unknown" }] } }, { go: { runner: "go", source: "opencode", fetchedAt: 1, models: [{ id: "glm", costOut: 2 }, { id: "other", costOut: 9 }] } });
  const page = await models(s);
  expect(page.get().draftOf("go")!.rows.map(row => row.id)).toEqual(["glm"]);
  expect(page.get().available.go!.models!.map(model => model.id)).toEqual(["glm", "other"]);
  expect(page.get().dirty).toBe(false);
  await page.unmount();
});

test("a size edit saves once through set_many with the load revision and only the changed runner", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "unknown" }] }, codex: { default: null, models: [] } });
  s.warnings = ['runners.go: model "glm" is unrated (tier unknown)', "runners.go: model glm could not be checked: offline"];
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  expect(page.get().dirty).toBe(true);
  let outcome: unknown;
  await act(async () => { outcome = await page.get().save(); });
  expect(outcome).toMatchObject({ ok: true, revision: "r2" });
  expect(sets(s)).toHaveLength(1);
  expect(sets(s)[0]!.params).toEqual({ expectedRevision: "r1", runners: [{ id: "go", default: "glm", models: [{ id: "glm", tier: "medium" }] }] });
  expect(page.get().dirty).toBe(false);
  // Routine warnings the table already shows stay hidden; others are stated in plain words.
  expect(page.get().notice).toBe("Saved. runners.go: model glm could not be checked: offline");
  await page.unmount();
});

test("save, edit, save again: the second set_many sends the revision the first save returned", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  await act(async () => { await page.get().save(); });
  await act(async () => page.get().edits.size("go", "glm", "frontier"));
  await act(async () => { await page.get().save(); });
  expect(sets(s).map(call => call.params.expectedRevision)).toEqual(["r1", "r2"]);
  await page.unmount();
});

test("a set_many conflict after a real change elsewhere keeps the draft and asks to Discard", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  bump(s); s.models.go!.models = [{ id: "glm", tier: "frontier" }];
  let outcome: unknown;
  await act(async () => { outcome = await page.get().save(); });
  expect(outcome).toEqual({ ok: false });
  expect(page.get().conflict).toBe(true);
  expect(page.get().notice).toBe("Model settings changed elsewhere. Discard to load them.");
  expect(page.get().draftOf("go")!.rows[0]!.tier).toBe("medium");
  await act(async () => { await page.get().discard(); });
  expect(page.get().conflict).toBe(false);
  expect(page.get().draftOf("go")!.rows[0]!.tier).toBe("frontier");
  await page.unmount();
});

test("a revision moved by another write on this page (Takes work) retries once when the models are unchanged", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  bump(s); // runner.settings.save moved the strategy revision without touching models
  let outcome: unknown;
  await act(async () => { outcome = await page.get().save(); });
  expect(outcome).toMatchObject({ ok: true });
  expect(sets(s).map(call => call.params.expectedRevision)).toEqual(["r1", "r2"]);
  expect(s.models.go!.models).toEqual([{ id: "glm", tier: "medium" }]);
  await page.unmount();
});

test("a refresh with identical models while dirty stays silent and adopts the newer revision", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  bump(s);
  await act(async () => page.get().reload());
  await settle();
  expect(page.get().conflict).toBe(false);
  expect(page.get().notice).toBe("");
  expect(page.get().draftOf("go")!.rows[0]!.tier).toBe("medium");
  await act(async () => { await page.get().save(); });
  expect(sets(s).map(call => call.params.expectedRevision)).toEqual(["r2"]);
  await page.unmount();
});

test("a genuine external model change while dirty keeps the draft and the old revision, so Save is a conflict", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "glm", "medium"));
  bump(s); s.models.go!.models = [{ id: "glm", tier: "small" }, { id: "new", tier: "frontier" }];
  await act(async () => page.get().reload());
  await settle();
  expect(page.get().conflict).toBe(true);
  expect(page.get().draftOf("go")!.rows.map(row => [row.id, row.tier])).toEqual([["glm", "medium"]]);
  await act(async () => { await page.get().save(); });
  expect(sets(s)).toHaveLength(1);
  expect(sets(s)[0]!.params.expectedRevision).toBe("r1");
  expect(s.models.go!.models).toHaveLength(2);
  await page.unmount();
});

test("an external change on a clean page reloads the models without a conflict", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s);
  bump(s); s.models.go!.models = [{ id: "glm", tier: "frontier" }];
  await act(async () => page.get().reload());
  await settle();
  expect(page.get().conflict).toBe(false);
  expect(page.get().draftOf("go")!.rows[0]!.tier).toBe("frontier");
  await page.unmount();
});

test("an edit made while a save is in flight survives it and stays dirty; editing is locked meanwhile", async () => {
  const s = server({ go: { default: "a", models: [{ id: "a", tier: "small" }, { id: "b", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("go", "a", "medium"));
  let release!: () => void;
  s.gate = new Promise(resolve => { release = resolve; });
  let saving!: Promise<unknown>;
  await act(async () => { saving = page.get().save(); });
  expect(page.get().busy).toBe(true);
  // While the save runs, edits are no-ops (every editing control is disabled too).
  await act(async () => page.get().edits.add("go", "c", "small"));
  expect(page.get().draftOf("go")!.rows.map(row => row.id)).toEqual(["a", "b"]);
  release(); s.gate = undefined;
  await act(async () => { await saving; });
  expect(page.get().dirty).toBe(false);
  await page.unmount();
});

test("turning a model off saves it as undeclared and a later identical refresh raises no notice", async () => {
  const s = server({ go: { default: "a", models: [{ id: "a", tier: "small" }, { id: "b", tier: "medium" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.toggle("go", "a", false));
  expect(page.get().draftOf("go")!.default).toBe("b");
  await act(async () => { await page.get().save(); });
  expect(sets(s)[0]!.params.runners).toEqual([{ id: "go", default: "b", models: [{ id: "b", tier: "medium" }] }]);
  await act(async () => page.get().reload());
  await settle();
  expect(page.get().notice).toBe("Saved.");
  expect(page.get().conflict).toBe(false);
  expect(page.get().draftOf("go")!.rows.map(row => row.id)).toEqual(["b"]);
  await page.unmount();
});

test("adding uses the suggested size, the first model becomes the default, duplicates and blanks are ignored", async () => {
  const s = server({ codex: { default: null, models: [] } });
  const page = await models(s);
  await act(async () => page.get().edits.add("codex", " gpt-5 ", "frontier"));
  await act(async () => page.get().edits.add("codex", "gpt-5", "small"));
  await act(async () => page.get().edits.add("codex", "   ", null));
  await act(async () => page.get().edits.add("codex", "gpt-5-mini", null));
  const draft = page.get().draftOf("codex")!;
  expect(draft.rows.map(row => [row.id, row.tier, row.on])).toEqual([["gpt-5", "frontier", true], ["gpt-5-mini", "unknown", true]]);
  expect(draft.default).toBe("gpt-5");
  await act(async () => page.get().edits.makeDefault("codex", "gpt-5-mini"));
  expect(page.get().draftOf("codex")!.default).toBe("gpt-5-mini");
  await act(async () => { await page.get().save(); });
  expect(sets(s)[0]!.params.runners).toEqual([{ id: "codex", default: "gpt-5-mini", models: [{ id: "gpt-5", tier: "frontier" }, { id: "gpt-5-mini", tier: "unknown" }] }]);
  await page.unmount();
});

test("an off model cannot become the default; removing the default moves it; all off with no default blocks Save", async () => {
  const s = server({ go: { default: "a", models: [{ id: "a", tier: "small" }, { id: "b", tier: "small" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.toggle("go", "b", false));
  await act(async () => page.get().edits.makeDefault("go", "b"));
  expect(page.get().draftOf("go")!.default).toBe("a");
  await act(async () => page.get().edits.remove("go", "a"));
  expect(page.get().draftOf("go")!.rows.map(row => row.id)).toEqual(["b"]);
  const blocked = { ...page.get() };
  expect(blocked.blocked).toEqual([]); // the removed default stays as the saved default
  const fresh = server({ go: { default: null, models: [{ id: "a", tier: "small" }] } });
  const other = await models(fresh);
  await act(async () => other.get().edits.toggle("go", "a", false));
  expect(other.get().blocked).toEqual(["go"]);
  await act(async () => { await other.get().save(); });
  expect(sets(fresh)).toHaveLength(0);
  await other.unmount(); await page.unmount();
});

test("an agent whose models failed to load is read-only and left out of saves", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } });
  const page = await models(s, ["go", "broken"]);
  expect(page.get().errors.broken).toBe("Unknown executor broken");
  await act(async () => page.get().edits.add("broken", "x", "small"));
  expect(page.get().draftOf("broken")).toBeUndefined();
  expect(page.get().dirty).toBe(false);
  await page.unmount();
});

test("Refresh bypasses the listing cache exactly once and keeps later reads cached", async () => {
  const s = server({ go: { default: "glm", models: [{ id: "glm", tier: "small" }] } }, { go: { runner: "go", source: "opencode", fetchedAt: 5, models: [{ id: "glm" }] } });
  const page = await models(s);
  s.available.go = { runner: "go", source: "opencode", fetchedAt: 9, models: [{ id: "glm" }, { id: "new" }] };
  await act(async () => { await page.get().refreshListing("go"); });
  expect(page.get().available.go!.models!.map(model => model.id)).toEqual(["glm", "new"]);
  await act(async () => page.get().reload());
  await settle();
  const listings = s.calls.filter(call => call.op === "executor.models.available");
  expect(listings.filter(call => call.params.refresh === true)).toHaveLength(1);
  expect(listings.length).toBeGreaterThanOrEqual(3);
  await page.unmount();
});

test("the planner's models are edited and saved like any agent's, with their size", async () => {
  const s = server({ "claude-code": { default: "opus", models: [{ id: "opus", tier: "medium" }] } });
  const page = await models(s);
  await act(async () => page.get().edits.size("claude-code", "opus", "frontier"));
  await act(async () => page.get().edits.add("claude-code", "haiku", "small"));
  await act(async () => { await page.get().save(); });
  expect(sets(s)[0]!.params.runners).toEqual([{ id: "claude-code", default: "opus", models: [{ id: "opus", tier: "frontier" }, { id: "haiku", tier: "small" }] }]);
  await page.unmount();
});

// Executor order and limits (the former Executors draft).
const limits = async (s: Server) => {
  const page = await mount<ExecutorSettingsState>(s, () => useExecutorSettings());
  await until(() => !!page.get().draft);
  return page;
};
const saves = (s: Server) => s.calls.filter(call => call.op === "runner.settings.save");

test("Tasks at once and priority edits stay in the draft, validate, and save once", async () => {
  const s = server({});
  const page = await limits(s);
  await act(async () => page.get().edit(draft => { draft.runners.codex!.maxTasks = "0"; }));
  expect(page.get().errors.codex).toBe("Enter a whole number from 1 to 16.");
  let saved: unknown;
  await act(async () => { saved = await page.get().save(); });
  expect(saved).toBe(false);
  await act(async () => page.get().edit(draft => { draft.runners.codex!.maxTasks = "3"; draft.order.reverse(); }));
  await act(async () => { saved = await page.get().save(); });
  expect(saved).toBe(true);
  expect(saves(s).map(call => call.params)).toEqual([{ expectedRevision: "r1", order: ["go", "codex"], runners: [{ id: "go", enabled: true, maxTasks: 2 }, { id: "codex", enabled: true, maxTasks: 3 }] }]);
  expect(page.get().dirty).toBe(false);
  await page.unmount();
});

test("a lost save response is confirmed against the saved values before it counts", async () => {
  const s = server({});
  const page = await limits(s);
  await act(async () => page.get().edit(draft => { draft.runners.go!.maxTasks = "4"; }));
  s.lose = true;
  let saved: unknown;
  await act(async () => { saved = await page.get().save(); });
  expect(saved).toBe(true);
  expect(saves(s)).toHaveLength(1);
  expect(page.get().dirty).toBe(false);
  expect(page.get().saved!.runners.find(runner => runner.id === "go")!.maxTasks).toBe(4);
  // A failure that did not commit keeps the draft and reports the error.
  await act(async () => page.get().edit(draft => { draft.runners.go!.maxTasks = "5"; }));
  s.fail = new ApiError("unavailable", "Service unavailable");
  await act(async () => { saved = await page.get().save(); });
  expect(saved).toBe(false);
  expect(String(page.get().error)).toContain("Service unavailable");
  expect(page.get().draft!.runners.go!.maxTasks).toBe("5");
  await page.unmount();
});

test("a draft against an older revision shows a conflict and Save waits for Reload", async () => {
  const s = server({});
  const page = await limits(s);
  await act(async () => page.get().edit(draft => { draft.runners.go!.maxTasks = "4"; }));
  bump(s);
  await page.rerender();
  await until(() => page.get().conflict);
  expect(page.get().conflict).toBe(true);
  let saved: unknown;
  await act(async () => { saved = await page.get().save(); });
  expect(saved).toBe(false);
  expect(saves(s)).toHaveLength(0);
  await act(async () => page.get().discard());
  await until(() => !page.get().dirty && !page.get().conflict);
  expect(page.get().draft!.runners.go!.maxTasks).toBe("2");
  await page.unmount();
});

test("Takes work saves immediately from the saved settings and keeps the page's other edits", async () => {
  const s = server({});
  const page = await limits(s);
  await act(async () => page.get().edit(draft => { draft.runners.go!.maxTasks = "5"; }));
  let revision: unknown;
  await act(async () => { revision = await page.get().saveEnabled("codex", false); });
  expect(revision).toBe("r2");
  expect(saves(s)[0]!.params).toEqual({ expectedRevision: "r1", order: ["codex", "go"], runners: [{ id: "codex", enabled: false, maxTasks: 1 }, { id: "go", enabled: true, maxTasks: 2 }] });
  expect(page.get().draft!.runners.go!.maxTasks).toBe("5");
  expect(page.get().draft!.runners.codex!.enabled).toBe(false);
  // A failed immediate write throws, so the switch reverts with its error.
  s.fail = new ApiError("unavailable", "Service unavailable");
  await expect(page.get().saveEnabled("codex", true)).rejects.toThrow("Service unavailable");
  await page.unmount();
});

test("after a models save on this page, the limits save uses the revision it returned", async () => {
  const s = server({});
  const page = await limits(s);
  await act(async () => page.get().edit(draft => { draft.runners.go!.maxTasks = "6"; }));
  bump(s); // runner.models.set_many committed first
  await act(async () => page.get().rebase(s.revision));
  let saved: unknown;
  await act(async () => { saved = await page.get().save(s.revision); });
  expect(saved).toBe(true);
  expect(saves(s)[0]!.params.expectedRevision).toBe("r2");
  await page.unmount();
});
