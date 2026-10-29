import {render} from "preact";
import {ActionContext} from "../../../app/src/data/action-context";
import {initialState} from "../../../app/src/data/store";
import {TaskContext} from "../../../app/src/screens/task-shared";
import {WorkView} from "../../../app/src/screens/work/WorkView";

let reviewed=false;
const node=()=>({taskId:"t-focus",parentId:null,rootId:"t-focus",depth:0,title:"Focus task",state:"done",rev:reviewed?2:1,executor:"codex",model:null,actualModel:null,review:reviewed?{accepted:true}:null,question:null,retryEligibility:{allowed:false},options:{maxAttempts:1},dependencies:[],waivedChildren:[],attempts:[],decisions:[]});
const api={call:async(op:string)=>op==="dispatch.tree"?{rootId:"t-focus",nodes:[node()],totals:{tasks:1,running:0,queued:0,executionSeconds:0,queueWaitSeconds:0,dependencyWaitSeconds:0,childWaitSeconds:0,capacityWaitSeconds:null,provisionalWaits:0,usagePools:[{account:"codex",poolId:null,observedDeltaPct:17.456,unknownAttempts:0}]}}:op==="dispatch.events"?{events:[],next:0,hasMore:false}:{groups:[{kind:"fix",difficulty:"small",runner:"codex",model:null,settings:"default",sampleCount:20,successRate:0.85,confidenceLower:0.65,confidenceUpper:0.95,averageDurationS:10,averageUsagePct:3.456}],totalReviews:20,minimumSamples:20}} as never;
const actions={run:async()=>{reviewed=true;return {status:"done"}},result:()=>null} as never;
render(<ActionContext.Provider value={actions}><TaskContext.Provider value={{state:{...initialState(),connected:true},api}}><WorkView id="t-focus"/></TaskContext.Provider></ActionContext.Provider>,document.getElementById("root")!);
