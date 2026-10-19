import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { ProjectStrategies } from "../app/src/screens/settings/ProjectStrategies";
import { moveExecutor, reconcileExecutor, projectDraft } from "../app/src/model/project-strategies";
import { TaskContext, queryRevision } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

const view = { repo: {key:"github.com/acme/repo",label:"acme/repo",path:"/repo"},rev:2,executors:["cursor#team@local","codex#personal@local"],available:[{id:"cursor#team",reference:"cursor#team@local",label:"Cursor · team · local"},{id:"codex#personal",reference:"codex#personal@local",label:"Codex · personal · local"}] };
const state = {...initialState(),connected:true,features:{readModel:true,ops:new Set(["project.strategy.get","project.strategy.set","project.strategy.list","project.strategy.remove"])},snapshot:{repos:[view.repo],tasks:[]} as any};
const api = {call:async()=>view} as any;
const render = (s=state,initial=view) => renderToString(<TaskContext.Provider value={{state:s,api}}><ProjectStrategies initialData={initial}/></TaskContext.Provider>);
test("editor names keyboard reorder controls and distinguishes saved project order", () => {
  const html=render();
  for(const copy of ["Project strategies","Project order","Move Cursor · team · local down","Move Codex · personal · local up","Save project strategy","Use global strategy"]) expect(html).toContain(copy);
  expect(html).toContain("pc-select"); expect(html).toContain("pc-btn");
});
test("older services hide project settings and disconnected editors explain disabled saving", () => {
  expect(render({...state,features:{readModel:true,ops:new Set()}})).toBe("");
  expect(render({...state,connected:false})).toContain("Reconnect to save");
});
test("draft order is immutable and forbidden repository selections are cleared", () => {
  const draft=projectDraft(view); expect(moveExecutor(draft.executors,1,-1)).toEqual([...view.executors].reverse()); expect(draft.executors).toEqual(view.executors);
  const routing={ranked:[{id:"cursor",verdict:"ON_PACE",reason:"ready"}],excluded:[],policy:{source:"project" as const,repoKey:view.repo.key,rev:2,executors:["cursor#team@local"]}};
  expect(reconcileExecutor("codex",routing)).toBe(""); expect(reconcileExecutor("cursor",routing)).toBe("cursor");
});
test("policy edits invalidate task detail even when its stored revision is unchanged", () => {
  const before=queryRevision(state,"task.get",{id:"task"});
  expect(queryRevision({...state,invalidations:{"project-strategies":1}},"task.get",{id:"task"})).not.toBe(before);
});

test("settings update checks do not refresh themselves on their own config event", async () => {
  const { resourceRevision } = await import("../app/src/screens/settings/shared");
  expect(resourceRevision("update.check", {update:1})).toBe(resourceRevision("update.check", {update:2}));
  expect(resourceRevision("project.strategy.get", {"project-strategies":1})).not.toBe(resourceRevision("project.strategy.get", {"project-strategies":2}));
});

test("project edit conflicts preserve the service error and reload guidance", async () => {
  const { createActionRunner } = await import("../app/src/data/actions");
  const { ApiError } = await import("../app/src/data/api");
  const runner=createActionRunner({call:async()=>{throw new ApiError("conflict","Project strategy changed","Reload and review your draft");},waitFor:async()=>false,refetch:()=>{},navigate:()=>{}});
  expect(await runner.run("project",{label:"Save",op:"project.strategy.set",params:{}})).toEqual({status:"error",message:"Project strategy changed",hint:"Reload and review your draft"});
});
