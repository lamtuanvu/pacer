import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { SetupEditor } from "../app/src/screens/settings/DispatcherSetup";
import { dispatchConfigSchema } from "../src/dispatch/types";
import { moveExecutor, reconcileExecutor, projectDraft } from "../app/src/model/project-strategies";
import { TaskContext, queryRevision } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";

const view = { repo: {key:"github.com/acme/repo",label:"acme/repo",path:"/repo"},rev:2,executors:["cursor#team@local","codex#personal@local"],available:[{id:"cursor#team",reference:"cursor#team@local",label:"Cursor · team · local"},{id:"codex#personal",reference:"codex#personal@local",label:"Codex · personal · local"}] };
const state = {...initialState(),connected:true,features:{readModel:true,ops:new Set(["project.strategy.get","project.strategy.set","project.strategy.list","project.strategy.remove"])},snapshot:{repos:[view.repo],tasks:[]} as any};
const api = {call:async()=>view} as any;
const config = {strategy:"default",planner:"codex",plannerAccount:"work",source:"built-in" as const,config:dispatchConfigSchema.parse({})};
const render = (s=state,initial=view) => renderToString(<TaskContext.Provider value={{state:s,api}}><SetupEditor view={config} eligibility={{kind:"project",repo:initial.repo.key,repoLabel:initial.repo.label,view:initial}} onSaved={()=>{}} onDirtyChange={()=>{}}/></TaskContext.Provider>);
test("editor names keyboard reorder controls and distinguishes saved project order", () => {
  const html=render();
  for(const copy of ["Executor order for acme/repo","Move down: Cursor · team · local","Move up: Codex · personal · local","Use global rules","Allowed executors for acme/repo, in priority order"]) expect(html).toContain(copy);
  expect(html).not.toContain("unsaved change");
  const inherited=render(state,{...view,rev:0,executors:null as any});
  expect(inherited).toContain("Add executors to give this repository its own order");
  expect(inherited).toContain("Add Cursor · team · local");
  expect(inherited).not.toContain(">Use global rules<");
});
test("disconnected editors explain why saving is unavailable", () => {
  const html=render({...state,connected:false});
  expect(html).toContain("Reconnect to save");
  expect(html).toContain("disabled");
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

test("project preview names the repository without exposing its storage key", async () => {
  const {DelegateRoutingPreview}=await import("../app/src/screens/Delegate");
  const routing={ranked:[],excluded:[],policy:{source:"project" as const,repoKey:"local:deadbeef",rev:1,executors:[]}};
  const html=renderToString(<DelegateRoutingPreview routing={routing} executor="" repoLabel="My project"/>);
  expect(html).toContain("Project order for My project");
  expect(html).not.toContain("deadbeef");
});

test("keyboard submission waits for the current repository routing check",async()=>{
  const {handleDelegateKey}=await import("../app/src/screens/Delegate");
  let submitted=0;
  handleDelegateKey({key:"Enter",ctrlKey:true,metaKey:false,isComposing:false,repeat:false,preventDefault(){},stopPropagation(){}},()=>{submitted++;},true);
  expect(submitted).toBe(0);
});

test("an unavailable project preview explains each excluded executor", async()=>{
  const {DelegateRoutingPreview}=await import("../app/src/screens/Delegate");
  const routing={ranked:[],excluded:[{id:"codex",reason:"signed out — run codex login"},{id:"cursor",reason:"at capacity"}],policy:{source:"project" as const,repoKey:"local:project",rev:1,executors:[]}};
  const html=renderToString(<DelegateRoutingPreview routing={routing} executor="" repoLabel="Project"/>);
  expect(html).toContain("Codex: signed out");expect(html).toContain("Cursor: at capacity");
});


test("project rows resolve snapshot status by executor ID and preserve unavailable references", () => {
  const snapshot = { repos: [view.repo], tasks: [], accounts: [], executors: [
    { id: "cursor#team", agent: "cursor", account: "team", enabled: true, state: "blocked", reason: "Maintenance" },
  ] };
  const html = render({ ...state, snapshot }, { ...view, executors: [...view.executors, "removed#old@local"] });
  expect(html).toContain("Blocked by you");
  expect(html).toContain('class="pc-executor-id">cursor#team');
  expect(html).toContain("Unavailable in the active setup");
  expect(html).toContain("pc-sortable--icons");
  expect(html).toContain('<h3 class="pc-section-heading">Available executors');
});
