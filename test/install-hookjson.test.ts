import { expect, test } from "bun:test";
import {
  addHooks, editHooksFile, isPacerHook, removeHooks, restoreHooks,
  type HookSpec,
} from "../src/install/hookjson";

const SETTINGS = {
  env: { OTHER_TOOL: "enabled" },
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "ato session" }] },
      { hooks: [{ type: "command", command: "$HOME/.claude/scripts/budget/budget-status --hook", timeout: 15, statusMessage: "Checking subscription budgets" }] },
    ],
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "orca pre-tool" }] },
      { matcher: "Agent|Task", hooks: [{ type: "command", command: "$HOME/.claude/scripts/budget/subagent_guard.py", timeout: 15 }] },
    ],
    PreCompact: [{ hooks: [{ type: "command", command: "orca compact" }] }],
  },
};
const SPECS: HookSpec[] = [
  { event: "SessionStart", command: "/new/pacer status --hook claude-code", timeout: 15, statusMessage: "Checking budgets" },
  { event: "PreToolUse", matcher: "Agent|Task", command: "/new/pacer guard --planner claude-code", timeout: 15 },
];

test("addHooks appends groups, is idempotent, and does not mutate settings", () => {
  const original = structuredClone(SETTINGS);
  const added = addHooks(SETTINGS, "claude", SPECS);
  expect(added).toEqual({
    ...SETTINGS,
    hooks: {
      ...SETTINGS.hooks,
      SessionStart: [...SETTINGS.hooks.SessionStart, { hooks: [{ type: "command", command: "/new/pacer status --hook claude-code", timeout: 15, statusMessage: "Checking budgets" }] }],
      PreToolUse: [...SETTINGS.hooks.PreToolUse, { matcher: "Agent|Task", hooks: [{ type: "command", command: "/new/pacer guard --planner claude-code", timeout: 15 }] }],
    },
  });
  expect(addHooks(added, "claude", SPECS)).toEqual(added);
  expect(SETTINGS).toEqual(original);
  expect(added).not.toBe(SETTINGS);
  expect(added.hooks.PreCompact).not.toBe(SETTINGS.hooks.PreCompact);
});

test("addHooks skips a command anywhere in an event and still adds it to other events", () => {
  const doc = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }, { type: "command", command: "pacer" }] }] } };
  expect(addHooks(doc, "claude", [
    { event: "PreToolUse", matcher: "Agent", command: "pacer" },
    { event: "SessionStart", command: "pacer" },
    { event: "SessionStart", command: "pacer" },
  ])).toEqual({ hooks: {
    PreToolUse: doc.hooks.PreToolUse,
    SessionStart: [{ hooks: [{ type: "command", command: "pacer" }] }],
  } });
});

test("removing legacy budget hooks and restoring them gives the original settings", () => {
  const original = structuredClone(SETTINGS);
  const result = removeHooks(SETTINGS, "claude", (command) => command.includes("/scripts/budget/"));
  expect(result.doc).toEqual({ ...SETTINGS, hooks: {
    SessionStart: [SETTINGS.hooks.SessionStart[0]],
    PreToolUse: [SETTINGS.hooks.PreToolUse[0]],
    PreCompact: SETTINGS.hooks.PreCompact,
  } });
  expect(result.removed).toEqual([
    { event: "SessionStart", hook: SETTINGS.hooks.SessionStart[1]!.hooks[0] },
    { event: "PreToolUse", matcher: "Agent|Task", hook: SETTINGS.hooks.PreToolUse[1]!.hooks[0] },
  ]);
  expect(restoreHooks(result.doc, "claude", result.removed)).toEqual(SETTINGS);
  expect(SETTINGS).toEqual(original);
  expect(result.doc.hooks.SessionStart).toHaveLength(1);
});

test("removeHooks preserves surviving hooks and empty events, but drops emptied groups and populated events", () => {
  const doc = { hooks: {
    Mixed: [{ matcher: "Agent", extra: true, hooks: [{ type: "command", command: "keep" }, { type: "command", command: "remove" }] }],
    Gone: [{ hooks: [{ type: "command", command: "remove" }] }],
    Empty: [],
    EmptyGroup: [{ hooks: [] }],
  } };
  expect(removeHooks(doc, "claude", (command) => command === "remove")).toEqual({
    doc: { hooks: { Mixed: [{ matcher: "Agent", extra: true, hooks: [{ type: "command", command: "keep" }] }], Empty: [] } },
    removed: [
      { event: "Mixed", matcher: "Agent", hook: { type: "command", command: "remove" } },
      { event: "Gone", hook: { type: "command", command: "remove" } },
    ],
  });
  expect(doc.hooks.Gone).toHaveLength(1);
});

test("restoreHooks appends separate groups and clones restored hooks", () => {
  const doc = { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "keep" }] }] } };
  const removed = [{ event: "PreToolUse", matcher: "Agent", hook: { type: "command", command: "old", timeout: 15 } }];
  const restored = restoreHooks(doc, "claude", removed);
  expect(restored.hooks.PreToolUse).toEqual([
    ...doc.hooks.PreToolUse,
    { matcher: "Agent", hooks: [{ type: "command", command: "old", timeout: 15 }] },
  ]);
  expect(doc.hooks.PreToolUse).toHaveLength(1);
  restored.hooks.PreToolUse[1].hooks[0].command = "changed";
  expect(removed[0]!.hook.command).toBe("old");
});

test("Cursor hooks are flat, appended, idempotent, removable, and restorable", () => {
  const doc = { other: true, hooks: { sessionStart: [{ command: "other", type: "command" }], empty: [] } };
  const specs: HookSpec[] = [{ event: "sessionStart", command: "/pacer session-start --planner cursor", timeout: 15, matcher: "ignored", statusMessage: "ignored" }];
  const added = addHooks(doc, "cursor", specs);
  expect(added).toEqual({ other: true, version: 1, hooks: {
    sessionStart: [{ command: "other", type: "command" }, { command: "/pacer session-start --planner cursor", timeout: 15 }], empty: [],
  } });
  expect(addHooks(added, "cursor", specs)).toEqual(added);
  const removed = removeHooks(added, "cursor", (command) => isPacerHook(command, "cursor"));
  expect(removed.doc).toEqual({ ...doc, version: 1 });
  expect(removed.removed).toEqual([{ event: "sessionStart", hook: { command: "/pacer session-start --planner cursor", timeout: 15 } }]);
  expect(restoreHooks(removed.doc, "cursor", removed.removed)).toEqual(added);
  expect(doc).not.toHaveProperty("version");
});

test("Cursor removes fully emptied events and preserves an existing version", () => {
  const doc = { version: 2, hooks: { sessionStart: [{ command: "remove" }], empty: [] } };
  expect(addHooks(doc, "cursor", [])).toEqual(doc);
  expect(removeHooks(doc, "cursor", () => true)).toEqual({
    doc: { version: 2, hooks: { empty: [] } },
    removed: [{ event: "sessionStart", hook: { command: "remove" } }],
  });
});

test("isPacerHook recognizes only pacer hook commands for the requested planner", () => {
  for (const command of [
    "/old/pacer guard --planner claude-code",
    "bun /repo/src/cli.ts status --hook claude-code",
    "node /repo/cli.js session-start --planner claude-code",
  ]) expect(isPacerHook(command, "claude-code")).toBe(true);
  for (const command of [
    "/old/pacer guard --planner codex",
    "/other guard --planner claude-code",
    "/old/pacer guard --planner claude-code --extra",
    "/old/pacer status --line",
    "/old/pacer status --hook claude-code-extra",
    "guard --planner claude-code",
    "$HOME/.claude/scripts/budget/budget-status --hook",
  ]) expect(isPacerHook(command, "claude-code")).toBe(false);
  expect(isPacerHook("/pacer guard --planner codex", "codex")).toBe(true);
  expect(isPacerHook("/pacer session-start --planner cursor", "cursor")).toBe(true);
});

test("editHooksFile parses JSONC and replaces old pacer hooks while keeping other planners", () => {
  const old = `{
    // Keep other tools and planners
    "env": {"OTHER_TOOL": "enabled"},
    "hooks": {"SessionStart": [
      {"hooks": [{"type": "command", "command": "other"}]},
      {"hooks": [{"type": "command", "command": "/old/pacer status --hook claude-code"}]},
      {"hooks": [{"type": "command", "command": "/old/pacer status --hook codex"}]},
    ]},
  }`;
  const edited = editHooksFile(old, "claude", [SPECS[0]!], "claude-code");
  expect(JSON.parse(edited)).toEqual({ env: { OTHER_TOOL: "enabled" }, hooks: { SessionStart: [
    { hooks: [{ type: "command", command: "other" }] },
    { hooks: [{ type: "command", command: "/old/pacer status --hook codex" }] },
    { hooks: [{ type: "command", command: "/new/pacer status --hook claude-code", timeout: 15, statusMessage: "Checking budgets" }] },
  ] } });
  expect(edited.endsWith("\n")).toBe(true);
  expect(editHooksFile(edited, "claude", [SPECS[0]!], "claude-code")).toBe(edited);
});

test("editHooksFile replaces old Cursor hooks", () => {
  const old = '{"version":1,"hooks":{"sessionStart":[{"command":"other"},{"command":"/old/pacer session-start --planner cursor"}]}}';
  expect(JSON.parse(editHooksFile(old, "cursor", [{ event: "sessionStart", command: "/new/pacer session-start --planner cursor" }], "cursor"))).toEqual({
    version: 1, hooks: { sessionStart: [{ command: "other" }, { command: "/new/pacer session-start --planner cursor" }] },
  });
});

test("editHooksFile creates a pretty-printed empty Cursor configuration with a newline", () => {
  expect(editHooksFile(null, "cursor", [], "cursor")).toBe('{\n  "version": 1,\n  "hooks": {}\n}\n');
});
