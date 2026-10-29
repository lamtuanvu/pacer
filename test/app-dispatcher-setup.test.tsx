import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { SortableList } from "../app/src/ds/SortableList";
import { SaveBar } from "../app/src/ds/SaveBar";
import { countSetupChanges, discardSetup, ladderChanges, moveKey, orderChanges, PartialSaveError, positionAnnouncement, reconcileSetup, ruleChanges, saveSetup, type SetupDraft } from "../app/src/model/dispatcher-setup";
import { DispatcherGuidedSetup, SetupEditor } from "../app/src/screens/settings/DispatcherSetup";
import { SavedSetups } from "../app/src/screens/settings/Dispatcher";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

const items = [{ key: "codex", label: "Codex" }, { key: "claude-code", label: "Claude Code" }, { key: "opencode", label: "OpenCode" }];

test("sortable_keyboard_reorder", () => {
  expect(moveKey(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  expect(moveKey(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  expect(moveKey(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  expect(moveKey(["a", "b", "c"], 2, 3)).toEqual(["a", "b", "c"]);
  expect(positionAnnouncement("Codex", 1, 3)).toBe("Codex moved to position 2 of 3.");
  const html = renderToString(<SortableList label="Allowed executors" items={items} onReorder={() => {}} onRemove={() => {}} />);
  expect(html).toContain('aria-label="Allowed executors"');
  expect(html).toContain('aria-label="Move down: Codex"');
  expect(html).toContain('aria-label="Move up: OpenCode"');
  expect(html).toContain('aria-label="Remove: Claude Code"');
  // The first item cannot move up and the last cannot move down: those controls are left out (UI-13).
  expect(html).not.toContain('aria-label="Move up: Codex"');
  expect(html).not.toContain('aria-label="Move down: OpenCode"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("pc-sortable__handle");
  expect(html).not.toContain("<select");
});

test("sortable list without a remove handler offers no remove control", () => {
  const html = renderToString(<SortableList label="Ladder steps" items={items} onReorder={() => {}} />);
  expect(html).not.toContain("Remove: Codex");
  expect(html).toContain("Move down: Codex");
});

test("save_bar_counts_changes", () => {
  const saved = dispatchConfigSchema.parse({});
  const ladder = { ...saved, reservePct: saved.reservePct + 5, steps: [...saved.steps].reverse() };
  expect(ladderChanges(saved, saved)).toBe(0);
  expect(ladderChanges(saved, ladder)).toBe(2);
  const savedRules = [{ kinds: ["tests"], executors: ["codex"] }, { executors: ["claude-code", "codex"] }];
  expect(ruleChanges(savedRules, savedRules)).toBe(0);
  expect(ruleChanges(savedRules, [savedRules[0]!, { executors: ["codex", "claude-code"] }])).toBe(1);
  expect(ruleChanges(savedRules, [{ kinds: ["docs"], executors: ["codex"] }, ...savedRules])).toBe(1);
  expect(orderChanges(["a", "b"], ["b", "a"])).toBe(1);
  expect(orderChanges(["a"], ["a"])).toBe(0);
  expect(countSetupChanges({ eligibility: { kind: "global", saved: savedRules, draft: [savedRules[0]!, { executors: ["codex"] }] }, savedLadder: saved, ladder })).toBe(3);
  const one = renderToString(<SaveBar count={1} onSave={() => {}} onDiscard={() => {}} />);
  expect(one).toContain("1 unsaved change<");
  const many = renderToString(<SaveBar count={4} onSave={() => {}} onDiscard={() => {}} saveLabel="Save choices" statusDot size="sm" scope="Global list for tests tasks" />);
  expect(many).toContain("4 unsaved changes");
  expect(many.match(/pc-btn--primary/g)).toHaveLength(1);
  expect(many).toContain("Discard");
  expect(many).toContain("Save choices");
  expect(many).toContain("Global list for tests tasks");
  expect(many).toContain("pc-save-bar__dot--dirty");
  expect(many).toContain("pc-btn--sm");
  expect(many).toContain('aria-live="polite"');
});

test("save bar stays quiet when clean and explains a blocked save", () => {
  const clean = renderToString(<SaveBar count={0} onSave={() => {}} onDiscard={() => {}} />);
  expect(clean).not.toContain("Discard");
  expect(clean).toContain('aria-live="polite"');
  const blocked = renderToString(<SaveBar count={2} onSave={() => {}} onDiscard={() => {}} blockedReason="Name the new saved setup first." />);
  expect(blocked).toContain("Name the new saved setup first.");
  expect(blocked).toContain("disabled");
});

test("discard_restores", () => {
  const saved = dispatchConfigSchema.parse({});
  const savedRules = [{ kinds: ["tests"], executors: ["codex"] }, { executors: ["claude-code"] }];
  const restored = discardSetup({ eligibility: { kind: "global", saved: savedRules, draft: [{ executors: ["codex"] }] }, savedLadder: saved, ladder: { ...saved, steps: [] } });
  expect(restored.eligibility.draft).toEqual(savedRules);
  expect(restored.eligibility.draft).not.toBe(savedRules);
  expect(restored.ladder).toEqual(saved);
  expect(restored.ladder).not.toBe(saved);
  expect(countSetupChanges(restored)).toBe(0);
  const project = discardSetup({ eligibility: { kind: "project", saved: ["codex"], draft: [] }, savedLadder: saved, ladder: saved });
  expect(project.eligibility.draft).toEqual(["codex"]);
});

const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["routing.get", "routing.set", "strategy.list", "strategy.use", "strategy.save", "strategy.preview", "dispatch.config.get"]) } };
const view = { strategy: "default", planner: "claude-code", plannerAccount: "claude1", source: "built-in" as const, config: dispatchConfigSchema.parse({}) };
const routing = { rules: [{ kinds: ["tests"], executors: ["codex"] }, { executors: ["claude-code", "codex"] }], available: ["claude-code", "codex", "opencode"] };
const wrap = (node: preact.ComponentChildren) => renderToString(<TaskContext.Provider value={{ state, api: { call: async () => ({}) } } as any}>{node}</TaskContext.Provider>);

test("guided setup shows who may work as sortable lists beside the executor pool", () => {
  const html = wrap(<SetupEditor view={view} eligibility={{ kind: "global", rules: routing.rules, available: routing.available }} onSaved={() => {}} onDirtyChange={() => {}} />);
  for (const copy of ["Who may do the work", "How should Pacer choose?", "Task kinds: tests", "Everything else", "Only one executor: if Codex cannot take work", "There is no fallback.", "From saved setup default.", "Add OpenCode", "Capable model with spare capacity", "Move down: Capable model with spare capacity"]) expect(html).toContain(copy);
  expect(html).toContain('role="tablist"');
  expect(html).toContain('role="tabpanel"');
  expect(html).toContain('aria-selected="true"');
  expect(html).toContain('<h3 class="pc-section-heading">Available executors');
  expect(html).toContain("pc-executor-rank");
  expect(html).not.toContain("pc-executor-id"); // Plain agent names need no repeated id.
  expect(html).toContain("pc-sortable--icons");
  expect(html).toContain("+ Set up a new executor");
  expect(html).not.toContain("unsaved change");
  expect(html.match(/pc-btn--primary/g) ?? []).toHaveLength(0);
});

test("saved setups are marked with an identicon and switch only through an explicit button", () => {
  const html = wrap(<SavedSetups initialData={[{ name: "default", active: true, summary: "Built in" }, { name: "night", active: false, summary: "Cheap runs" }]} />);
  expect(html.match(/pc-identicon /g)).toHaveLength(2);
  expect(html).toContain("night");
  expect(html).toContain("Use night");
  expect(html).not.toContain("Use default");
  expect(html).toContain("Active");
});

const base = dispatchConfigSchema.parse({});
const reordered = { ...base, steps: [...base.steps].reverse() };
const globalSetup = (saved: any[], draft: any[], ladder = base, savedLadder = base): SetupDraft => ({ eligibility: { kind: "global", saved, draft }, savedLadder, ladder, strategy: "default" });

test("reconcile adopts our own save and clean parts, and keeps a conflicting draft", () => {
  const saved = [{ executors: ["codex"] }], draft = [{ executors: ["codex", "cursor"] }];
  // Our own routing save: the new saved rules equal the draft; the unsaved ladder draft survives.
  const own = reconcileSetup(globalSetup(saved, draft, reordered), globalSetup(draft, draft));
  expect(own.conflict).toBe(false);
  expect(own.setup.eligibility.saved).toEqual(draft);
  expect(ladderChanges(own.setup.savedLadder, own.setup.ladder)).toBe(1);
  // A clean part follows the new saved value.
  const clean = reconcileSetup(globalSetup(saved, saved), globalSetup([{ executors: ["cursor"] }], [{ executors: ["cursor"] }]));
  expect(clean.setup.eligibility.draft).toEqual([{ executors: ["cursor"] }]);
  expect(clean.conflict).toBe(false);
  // Another client changed rules we are editing: keep the draft and its base, report a conflict.
  const other = reconcileSetup(globalSetup(saved, draft), globalSetup([{ executors: ["claude-code"] }], [{ executors: ["claude-code"] }]));
  expect(other.conflict).toBe(true);
  expect(other.setup.eligibility.draft).toEqual(draft);
  expect(other.setup.eligibility.saved).toEqual(saved);
  // The ladder changed elsewhere while we edit it.
  const ladder = reconcileSetup(globalSetup(saved, saved, reordered), { ...globalSetup(saved, saved), savedLadder: { ...base, reservePct: 9 }, ladder: { ...base, reservePct: 9 }, strategy: "night" });
  expect(ladder.conflict).toBe(true);
  expect(ladder.setup.ladder).toEqual(reordered);
  expect(ladder.setup.strategy).toBe("default");
});

test("reconcile keeps a project draft when only the revision moved", () => {
  const current: SetupDraft = { eligibility: { kind: "project", saved: ["codex"], draft: ["cursor"], rev: 2 }, savedLadder: base, ladder: base, strategy: "default" };
  const merged = reconcileSetup(current, { ...current, eligibility: { kind: "project", saved: ["codex"], draft: ["codex"], rev: 3 } });
  expect(merged.conflict).toBe(false);
  expect(merged.setup.eligibility).toEqual({ kind: "project", saved: ["codex"], draft: ["cursor"], rev: 3 });
});

function recorder(fail?: (op: string) => unknown) {
  const calls: [string, any][] = [];
  const call = async <T,>(op: string, params: unknown): Promise<T> => {
    calls.push([op, params]);
    const failure = fail?.(op); if (failure) throw failure;
    if (op === "dispatch.config.get") return { strategy: "default", config: base } as T;
    if (op === "strategy.preview") return { ok: true, errors: [] } as T;
    return {} as T;
  };
  return { calls, call };
}
const profile = { name: "night", reason: " cheaper " };

test("save sequence writes eligibility first, then validates, saves and activates the ladder", async () => {
  const { calls, call } = recorder();
  const done = await saveSetup({ call, setup: globalSetup([{ executors: ["codex"] }], [{ executors: ["cursor"] }], reordered), profile });
  expect(calls.map(([op]) => op)).toEqual(["dispatch.config.get", "routing.set", "strategy.preview", "strategy.save", "strategy.use"]);
  expect(calls[1]![1]).toEqual({ rules: [{ executors: ["cursor"] }] });
  expect(calls[3]![1]).toEqual({ name: "night", draft: { from: "default", set: { dispatch: reordered } }, reason: "cheaper" });
  expect(done).toEqual(["executor rules", "setup night, now active"]);
  const unchanged = recorder();
  expect(await saveSetup({ call: unchanged.call, setup: globalSetup([], []), profile })).toEqual([]);
  expect(unchanged.calls).toEqual([]);
});

test("project orders save with their revision and an empty order removes the override", async () => {
  const project = (draft: string[]): SetupDraft => ({ eligibility: { kind: "project", saved: ["codex"], draft, rev: 4 }, savedLadder: base, ladder: base, strategy: "default" });
  const set = recorder();
  await saveSetup({ call: set.call, setup: project(["cursor", "codex"]), repo: { key: "local:a", label: "acme" }, profile });
  expect(set.calls).toEqual([["project.strategy.set", { repo: "local:a", executors: ["cursor", "codex"], expect_rev: 4 }]]);
  const remove = recorder();
  expect(await saveSetup({ call: remove.call, setup: project([]), repo: { key: "local:a", label: "acme" }, profile })).toEqual(["removal of the project order; acme now uses the global rules"]);
  expect(remove.calls).toEqual([["project.strategy.remove", { repo: "local:a", expect_rev: 4 }]]);
  const conflict = recorder(op => op === "project.strategy.set" && new Error("Project strategy changed"));
  await expect(saveSetup({ call: conflict.call, setup: project(["cursor"]), repo: { key: "local:a", label: "acme" }, profile })).rejects.toThrow("Project strategy changed");
});

test("a ladder failure after saved rules reports what saved; stale profiles and invalid ladders stop before saving", async () => {
  const partial = recorder(op => op === "strategy.save" && new Error("name taken"));
  const failure = await saveSetup({ call: partial.call, setup: globalSetup([{ executors: ["codex"] }], [{ executors: ["cursor"] }], reordered), profile }).catch(error => error);
  expect(failure).toBeInstanceOf(PartialSaveError);
  expect(failure.message).toBe("Saved executor rules. name taken");
  expect(failure.done).toEqual(["executor rules"]);
  const activation = recorder(op => op === "strategy.use" && new Error("busy"));
  await expect(saveSetup({ call: activation.call, setup: globalSetup([], [], reordered), profile })).rejects.toThrow("Saved night, but it could not be activated: busy");
  // A stale profile stops the save before the rules are written, so nothing saves part-way.
  const stale = recorder();
  await expect(saveSetup({ call: stale.call, setup: { ...globalSetup([{ executors: ["codex"] }], [{ executors: ["cursor"] }], reordered), strategy: "night" }, profile })).rejects.toThrow("changed in another client");
  expect(stale.calls.map(([op]) => op)).toEqual(["dispatch.config.get"]);
  const invalid: typeof stale = { calls: [], call: async <T,>(op: string): Promise<T> => { invalid.calls.push([op, {}]); return (op === "dispatch.config.get" ? { strategy: "default", config: base } : { ok: false, errors: ["Step ids must be unique."] }) as T; } };
  await expect(saveSetup({ call: invalid.call, setup: globalSetup([], [], reordered), profile })).rejects.toThrow("Step ids must be unique.");
  expect(invalid.calls.map(([op]) => op)).not.toContain("strategy.save");
});


test("one move counts once for executor orders, task rules and ladder steps", () => {
  const order = ["a", "b", "c", "d"];
  expect(orderChanges(order, moveKey(order, 0, 3))).toBe(1);
  expect(orderChanges(order, ["d", "c", "b", "a"])).toBe(3);
  expect(orderChanges(order, ["a", "c", "e"])).toBe(3);
  const rules = [{ executors: order }];
  expect(ruleChanges(rules, [{ executors: moveKey(order, 0, 3) }])).toBe(1);
  expect(ruleChanges(rules, [{ executors: ["a", "b", "c", "d", "e", "f"] }])).toBe(2);
  const config = dispatchConfigSchema.parse({});
  expect(ladderChanges(config, { ...config, steps: moveKey(config.steps, 0, 1) })).toBe(1);
  expect(ladderChanges(config, { ...config, steps: [{ ...config.steps[0]!, match: { kind: "tests" } }, ...config.steps.slice(1)] })).toBe(1);
  expect(ladderChanges(config, { ...config, steps: [{ ...config.steps[0]!, id: "renamed" }, ...config.steps.slice(1)] })).toBe(1);
});

test("saved SaveBar shows a good status dot and keeps its scope", () => {
  const html = renderToString(<SaveBar count={0} notice="Changes saved" scope="acme/repo list" statusDot size="sm" onSave={() => {}} onDiscard={() => {}} />);
  expect(html).toContain("Changes saved");
  expect(html).toContain("acme/repo list");
  expect(html).toContain("pc-save-bar__dot");
  expect(html).not.toContain("pc-save-bar__dot--dirty");
  expect(html).not.toContain("Discard");
});


test("executor snapshot supplies account status and unavailable pool recovery", () => {
  const snapshot = { tasks: [], executors: [
    { id: "codex", agent: "codex", account: "work", enabled: true, state: "blocked", reason: "Maintenance" },
    { id: "opencode", agent: "opencode", account: "local", enabled: true, state: "down", reason: "host_offline" },
  ], accounts: [] };
  const html = renderToString(<TaskContext.Provider value={{ state: { ...state, snapshot }, api: { call: async () => ({}) } } as any}>
    <SetupEditor view={view} eligibility={{ kind: "global", rules: [{ executors: ["codex"] }], available: ["codex", "opencode"] }} onSaved={() => {}} onDirtyChange={() => {}} />
  </TaskContext.Provider>);
  expect(html).toContain("Blocked by you");
  expect(html).toContain("work");
  expect(html).toContain("Agent needs attention");
  expect(html.replace(/<span role="tooltip"[^>]*>[\s\S]*?<\/span>/g, "")).not.toContain("host_offline");
  expect(html).toContain(">Fix</a>");
  expect(html).not.toContain('aria-label="Add OpenCode"');
});

test("a full executor pool uses the board empty copy", () => {
  const html = wrap(<SetupEditor view={view} eligibility={{ kind: "global", rules: [{ executors: ["codex"] }], available: ["codex"] }} onSaved={() => {}} onDirtyChange={() => {}} />);
  expect(html).toContain("Every executor is in the list.");
});

test("pool reasons use eligibility copy for known and unknown codes", () => {
  for (const [code, copy] of [["authentication_failed", "Sign-in is required"], ["new_internal_code", "Agent needs attention"]]) {
    const snapshot = { tasks: [], executors: [{ id: "opencode", agent: "opencode", account: "local", enabled: true, state: "down", reason: code,
      eligibility: { state: "ineligible", reasons: [{ code, evidenceIds: [] }], evaluatedAt: 0, validUntil: null, evidenceAgeS: null, availability: "unavailable", budget: "unknown", spendingRisk: "unknown" } }], accounts: [] };
    const html = renderToString(<TaskContext.Provider value={{ state: { ...state, snapshot }, api: { call: async () => ({}) } } as any}>
      <SetupEditor view={view} eligibility={{ kind: "global", rules: [{ executors: ["codex"] }], available: ["codex", "opencode"] }} onSaved={() => {}} onDirtyChange={() => {}} />
    </TaskContext.Provider>);
    expect(html).toContain(copy!);
    expect(html).not.toContain(code!);
    expect(html).toContain(">Fix</a>");
  }
});


test("scope uses board pressed buttons and explains why repository scope is disabled", () => {
  const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["routing.get", "routing.set"]) } };
  const html = renderToString(<TaskContext.Provider value={{state,api:{call:async()=>({})}} as any}>
    <DispatcherGuidedSetup view={{strategy:"default",planner:"codex",plannerAccount:"work",source:"built-in",config:dispatchConfigSchema.parse({})}} onSaved={()=>{}} />
  </TaskContext.Provider>);
  expect(html).toContain('role="group" aria-label="Scope"');
  expect(html).toContain('pc-segmented--board');
  expect(html).toMatch(/aria-pressed="true"[^>]*>All repositories<\/button>/);
  expect(html).toMatch(/aria-pressed="false"[^>]*disabled[^>]*>One repository<\/button>/);
  expect(html).toContain("Add a repository to edit its own executor list.");
  expect(html).not.toContain('role="radiogroup"');
});
