import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { SortableList } from "../app/src/ds/SortableList";
import { SaveBar } from "../app/src/ds/SaveBar";
import { countSetupChanges, discardSetup, ladderChanges, moveKey, orderChanges, positionAnnouncement, ruleChanges } from "../app/src/model/dispatcher-setup";
import { SavedSetups, SetupEditor } from "../app/src/screens/settings/DispatcherSetup";
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
  expect(html).toContain('aria-label="Move Codex down"');
  expect(html).toContain('aria-label="Move OpenCode up"');
  expect(html).toContain('aria-label="Remove Claude Code"');
  // The first item cannot move up and the last cannot move down: those controls are left out (UI-13).
  expect(html).not.toContain('aria-label="Move Codex up"');
  expect(html).not.toContain('aria-label="Move OpenCode down"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("pc-sortable__handle");
  expect(html).not.toContain("<select");
});

test("sortable list without a remove handler offers no remove control", () => {
  const html = renderToString(<SortableList label="Ladder steps" items={items} onReorder={() => {}} />);
  expect(html).not.toContain("Remove Codex");
  expect(html).toContain("Move Codex down");
});

test("save_bar_counts_changes", () => {
  const saved = dispatchConfigSchema.parse({});
  const ladder = { ...saved, reservePct: saved.reservePct + 5, steps: [...saved.steps].reverse() };
  expect(ladderChanges(saved, saved)).toBe(0);
  expect(ladderChanges(saved, ladder)).toBe(3);
  const savedRules = [{ kinds: ["tests"], executors: ["codex"] }, { executors: ["claude-code", "codex"] }];
  expect(ruleChanges(savedRules, savedRules)).toBe(0);
  expect(ruleChanges(savedRules, [savedRules[0]!, { executors: ["codex", "claude-code"] }])).toBe(1);
  expect(ruleChanges(savedRules, [{ kinds: ["docs"], executors: ["codex"] }, ...savedRules])).toBe(3);
  expect(orderChanges(["a", "b"], ["b", "a"])).toBe(1);
  expect(orderChanges(["a"], ["a"])).toBe(0);
  expect(countSetupChanges({ eligibility: { kind: "global", saved: savedRules, draft: [savedRules[0]!, { executors: ["codex"] }] }, savedLadder: saved, ladder })).toBe(4);
  const one = renderToString(<SaveBar count={1} onSave={() => {}} onDiscard={() => {}} />);
  expect(one).toContain("1 unsaved change<");
  const many = renderToString(<SaveBar count={4} onSave={() => {}} onDiscard={() => {}} saveLabel="Save setup" />);
  expect(many).toContain("4 unsaved changes");
  expect(many.match(/pc-btn--primary/g)).toHaveLength(1);
  expect(many).toContain("Discard");
  expect(many).toContain("Save setup");
  expect(many).toContain('aria-live="polite"');
});

test("save bar stays quiet when clean and explains a blocked save", () => {
  const clean = renderToString(<SaveBar count={0} onSave={() => {}} onDiscard={() => {}} />);
  expect(clean).not.toContain("Discard");
  expect(clean).toContain('aria-live="polite"');
  const blocked = renderToString(<SaveBar count={2} onSave={() => {}} onDiscard={() => {}} blockedReason="Name the new profile first." />);
  expect(blocked).toContain("Name the new profile first.");
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
  for (const copy of ["Who may do the work", "Choice ladder", "Task kinds: tests", "Everything else", "Move Claude Code down", "Move Codex up", "Add OpenCode", "Capable model with spare capacity", "Move Capable model with spare capacity down"]) expect(html).toContain(copy);
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
