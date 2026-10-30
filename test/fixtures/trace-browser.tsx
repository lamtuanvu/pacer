import {render} from "preact";
import detail from "./ui/task-get.json";
import snapshot from "./ui/snapshot.json";
import {Trace} from "../../app/src/screens/trace/Trace";
import {Layout} from "../../app/src/shell/Layout";
import {TaskContext} from "../../app/src/screens/task-shared";
import {initialState} from "../../app/src/data/store";
import {NavigationProvider} from "../../app/src/navigation";
import {resolveRoute,type Route} from "../../app/src/router";
import type {BrowserApi} from "../../app/src/data/api";
import type {TaskDetail} from "../../src/core/task-detail";

const scenario=new URLSearchParams(location.search).get("scenario");
const now=Date.now()/1000;
const usage={total:1200,measuredAttempts:1,partialAttempts:0,unknownAttempts:0,lowerBound:false,byExecutor:[{agent:"codex",account:null,model:null,total:1200,measuredAttempts:1,partialAttempts:0,unknownAttempts:0,attempts:1}]};
const decision={attempt:1,selectedCandidateId:'["codex",{"kind":"default"}]',proposal:{state:"ranked",step:"capable-with-headroom",choices:[{id:'["codex",{"kind":"default"}]',reason:"available"},{id:'["agy",{"kind":"default"}]',reason:"busy"}]}};
const attempts=[{executor:"codex",startedAt:now-120,endedAt:now-60,tokens:{total:1200,coverage:"measured"}}];
const task={...detail,routing:(scenario==="routing-only"?{...detail.routing,chosen:"codex",why:"available",skipped:[{executor:"agy",reason:"busy"}]}:scenario==="no-candidates"?null:detail.routing) as TaskDetail["routing"],id:"trace-root",title:scenario==="long"?"A very long root task title with enough words to verify that the trace heading wraps naturally within the viewport without hiding the review actions or pushing content outside the application canvas":"Browser-validate the Client Node PWA drop",state:scenario==="running"?"running":"done",review:null,resolved:null,retriedBy:null,dismissed:false,work:{rootId:"trace-root",parentId:null,depth:0},startedAt:now-150,endedAt:now-30,updatedAt:now-30,attempts,tokens:usage,files:[{path:"result.ts",added:214,removed:37}],derived:{files:"ready"},timeline:[{at:now-150,text:"queued"},{at:now-60,text:"acceptance passed"},{at:now-30,text:"done"}],acceptance:{cmd:"bun run test:e2e --project=pwa && bun run lint",state:"passed",durationS:161,summary:"48 tests"}};
const node={waivedChildren:[],review:{accepted:true},taskId:"trace-root",parentId:null,title:task.title,state:task.state,executor:"codex",attempts,decisions:[scenario==="null-proposal"?{...decision,proposal:null}:decision]};
if(scenario==="routing-only" || scenario==="no-candidates") node.decisions=[];
const tree={nodes:[node,{...node,taskId:"trace-child",title:scenario==="long"?"A very long subtask title ".repeat(10):"Run demo-stages flow with WebGL enabled",parentId:"trace-root",state:"done",createdAt:now-130}],totals:{tokens:usage}};
if(scenario==="root-only") tree.nodes=[node];
const calls:string[]=[];(window as any).traceCalls=calls;
const api={async call(op:string){
 calls.push(op);
 if(op==="task.get") {if(scenario==="error")throw new Error("Task read failed");return task;}
 if(op==="dispatch.tree") {if(scenario==="tree-error")throw new Error("Trace read failed");return tree;}
 return {};
}} as BrowserApi;
const state={...initialState(),connected:true,snapshot:{...snapshot,planner:{...snapshot.planner,runner:"codex#team"}} as any,features:{readModel:true,ops:new Set(["dispatch.review"])}}, route=resolveRoute("#/tasks/trace-root") as Route;
render(<TaskContext.Provider value={{api,state}}><NavigationProvider route={route}><Layout route={route} state={state} title="Task"><Trace id="trace-root" query={route.query}/></Layout></NavigationProvider></TaskContext.Provider>,document.getElementById("app")!);
