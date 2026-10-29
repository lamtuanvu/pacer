import { render } from "preact";
import detail from "./ui/task-get.json";
import snapshot from "./ui/snapshot.json";
import { ResultPage } from "../../app/src/screens/review/ResultPage";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";
import { initialState } from "../../app/src/data/store";
const settings = (window as any).SETTINGS;
const calls: {op:string;params:unknown}[] = (window as any).CALLS = [];
const task = {...detail, state:"failed", review:null, resolved:"worktree removed", backend:"direct", machine:null,
  attempts:[{executor:detail.executor,startedAt:detail.startedAt,endedAt:detail.endedAt,exitCode:1,log:""}], files:[{path:"a.ts",status:"modified",added:1,removed:1},{path:"b.ts",status:"modified",added:1,removed:0}], ...settings.task};
const api = {async call(op:string, params:unknown) {
  calls.push({op,params});
  if (op === "task.get") return task;
  if (op === "task.session") return {host:"builtin",machine:null,attempt:1,...settings.session};
  if (op === "dispatch.tree") return {nodes:[]};
  if (op === "task.diff") return {patch:"@@ -1 +1 @@\n-old\n+new"};
  if (op === "task.retry_options") return [{id:"antigravity",state:"ready",reason:"available"}];
  if (op === "session.file.read") throw new Error("File no longer exists");
  if (op === "task.review") return {retry:{id:"retried"}};
  return {};
}};
const store = {...initialState(), connected:true, snapshot:{...snapshot,attention:settings.attention ?? [],executors:[{id:task.executor,state:"ready"}]}, features:{readModel:true,ops:new Set(["task.review","task.session","session.file.read"])} };
const runner = createActionRunner({call:api.call as any, waitFor:async()=>true, refetch:()=>{},navigate:()=>{}});
render(<TaskContext.Provider value={{api:api as any,state:store as any}}><ActionContext.Provider value={runner}><ResultPage id={task.id} query={{repo:null,scope:null}} failure={settings.failure}/></ActionContext.Provider></TaskContext.Provider>,document.getElementById("app")!);
