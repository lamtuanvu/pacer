import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { slotBlock, slotLimit, slotUse } from "../src/engine/slots";
import type { TaskRecord } from "../src/tasks/types";
const strategy = (extra = {}) => validateStrategy({ accounts: { claude: {kind: "claude"}, codex: {kind: "codex"}, cursor: {kind: "cursor"} }, planner: "claude-code", hosts: {box: {ssh: "box", max_tasks: 2}}, routing: [{default: ["codex", "cursor", "codex@box"]}], ...extra }, "test");
const task = (executor: string, host?: string, state = "running") => ({state, executor, ...(host ? {run: {executor, host}} : {})}) as TaskRecord;
test("executor, host, then machine limits win", () => {
  const s = strategy();
  expect(slotBlock(s, "codex", slotUse([task("codex")]))).toBe("Codex busy (1/1)");
  expect(slotBlock(s, "claude-code", slotUse([task("codex"), task("cursor")]))).toBe("this machine busy (2/2)");
  const use = slotUse([task("codex@box", "box"), task("codex@box", "box"), task("codex", undefined, "done")]);
  expect(use.local).toBe(0);
  expect(use.byHost.box).toBe(2);
  expect(slotBlock(s, "codex@box", use)).toBe("Codex busy (2/2)");
  expect(slotLimit(s, "codex@box")).toEqual({executor: 2, host: 2, local: null});
});
test("configured limits are validated and applied", () => {
  const s = strategy({runners: {codex: {max_tasks: 3}}, execution: {local_max_tasks: 4}});
  expect(slotLimit(s, "codex")).toEqual({executor: 3, host: null, local: 4});
  for (const n of [0, 17, 1.5]) {
    expect(() => strategy({runners: {codex: {max_tasks: n}}})).toThrow("runners.codex.max_tasks must be 1..16");
    expect(() => strategy({execution: {local_max_tasks: n}})).toThrow("execution.local_max_tasks must be 1..16");
  }
});

test("remote tasks count against their host before a run reference exists", () => {
  expect(slotUse([task("codex@box")])).toEqual({byExecutor: {"codex@box": 1}, byHost: {box: 1}, local: 0});
  const s = strategy({runners: {"codex@box": {max_tasks: 3}}});
  expect(slotBlock(s, "codex@box", slotUse([task("codex@box"), task("codex@box")]))).toBe("box busy (2/2)");
});
