import { expect, test } from "bun:test";
import { executorEnv } from "../src/exec/process";
import { TERMINAL_STATES } from "../src/tasks/types";
import { taskStatus } from "../app/src/model/tasks";
import { attentionGroups, attentionText } from "../src/view-model/panel";
import { cards } from "../src/dashboard/model";
import type { LinkSnapshot } from "../src/link/envelope";

test("executor env carries the current task identity", () => {
  expect(executorEnv({PACER_TASK_ID:"old"}, {}, "t-current").PACER_TASK_ID).toBe("t-current");
});
test("needs_input is terminal and labelled in app, panel and TUI", () => {
  expect(TERMINAL_STATES).toContain("needs_input");
  expect(taskStatus({state:"needs_input"}).label).toBe("Needs your answer");
  const s = {tasks:[{id:"t", state:"needs_input", goal:"g", updatedAt:100}], budget:null} as unknown as LinkSnapshot;
  const groups = attentionGroups(s, 100);
  expect(groups).toHaveLength(1);
  expect(attentionText(groups[0],100)).toBe("Needs your answer");
  expect(cards(s,100).find(g=>g.title==="Needs attention")?.cards[0].text).toContain("Needs your answer");
});
