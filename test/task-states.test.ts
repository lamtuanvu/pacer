import { expect, test } from "bun:test";
import { executorEnv } from "../src/exec/process";
import { TERMINAL_STATES } from "../src/tasks/types";
import { taskStatus } from "../src/view-model/words";
import { attentionGroups, attentionText } from "../src/view-model/panel";
import { deriveTaskItems } from "../src/core/task-attention";
import { apiTask } from "../src/api/read-model/tasks";
import { record } from "./read-model-helpers";
import { fakeCtx } from "./helpers";
import { renderDashboard } from "../src/dashboard/render";
import { emptySnapshot } from "../src/link/envelope";
import { screenItems } from "../src/dashboard/render";
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
  // The board uses service attention, including the question and its Answer action.
  const ctx=fakeCtx({now:100});
  const task=apiTask(ctx,record("needs_input",100,{question:{text:"Which database?",at:100}}));
  const attention=deriveTaskItems({now:100,tasks:[task],executors:[],accounts:[],planner:null,setup:{complete:true,open:0,items:[]},update:null,retryTarget:()=>null});
  const current={...emptySnapshot(),at:100,tasks:[task],attention};
  const item=screenItems(current,100).find(i=>i.id===`attention:${attention[0]!.id}`)!;
  expect(item.primary?.effect.type).toBe("prompt");
  if(item.primary?.effect.type === "prompt") expect(item.primary.effect.prompt.submit("SQLite")).toMatchObject({type:"action",action:{op:"task.answer",params:{id:task.id,text:"SQLite"}}});
  const tui=renderDashboard(current,150,24,100,{selected:0,noColor:true});
  expect(tui).toContain("! Needs your answer");
  expect(tui).toContain("Which database?");
  expect(tui).toContain(`⏎ ${item.primary!.label}`);
});
