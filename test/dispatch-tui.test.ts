import {expect,test} from "bun:test";
import {workRows} from "../src/dashboard/screens/work";
import {reviewDetail,reviewItem} from "../src/dashboard/screens/review";
import type {AttentionItem} from "../src/attention/types";
import {PLAIN_THEME} from "../src/dashboard/theme";
import type {ScreenCtx,TaskDetail} from "../src/dashboard/screens/types";

test("TUI work explanation follows the selected candidate",()=>{
 const detail:TaskDetail={id:"root",state:"done",work:{rootId:"root",parentId:null,depth:0},workTree:{
  totals:{tasks:1,running:0,queued:0,executionSeconds:4,dependencyWaitSeconds:null,childWaitSeconds:null,capacityWaitSeconds:null,usagePools:[]},
  nodes:[{taskId:"root",depth:0,title:"Check work",state:"done",model:null,actualModel:null,dependencies:[],review:null,attempts:[{model:"model-a",actualModel:null},{model:"model-b",actualModel:"model-b"}],
   decisions:[{attempt:1,engine:{id:"ladder"},selectedCandidateId:"b",proposal:{state:"ranked",choices:[{id:"a",reason:"First option"},{id:"b",reason:"Selected second option"}]}},{attempt:2,engine:{id:"ladder"},selectedCandidateId:"c",proposal:{state:"ranked",choices:[{id:"c",reason:"Second attempt option"}]}}]}],
 }};
 const lines=workRows({theme:PLAIN_THEME} as ScreenCtx,detail,100).flatMap(row=>row.line.map(span=>span.text)).join(" ");
 expect(lines).toContain("Selected second option");
 expect(lines).toContain("Second attempt option");
 expect(lines).toContain("observed model-b");
 expect(lines).not.toContain("First option");
 expect(lines).toContain("Completed");
});
test("TUI work section says when the task can coordinate sub-agents",()=>{
 const detail={id:"root",state:"running",work:{rootId:"root",parentId:null,depth:0,allowDelegation:true}} as TaskDetail;
 const text=(d:TaskDetail)=>workRows({theme:PLAIN_THEME} as ScreenCtx,d,100).flatMap(row=>row.line.map(span=>span.text)).join(" ");
 expect(text(detail)).toContain("This task can coordinate sub-agents.");
 expect(text({...detail,work:{...detail.work!,allowDelegation:false}})).not.toContain("coordinate");
});
test("TUI hides managed retry when service says work cannot restart",()=>{
 const ctx={supports:()=>true} as unknown as ScreenCtx,a={taskId:"root",title:"Blocked work",kind:"review"} as AttentionItem;
 const detail={id:"root",state:"failed",rev:9,work:{rootId:"root",parentId:null,depth:0},workTree:{nodes:[{taskId:"root",retryEligibility:{allowed:false,reason:"Work deadline has expired"}}]}} as unknown as TaskDetail;
 expect(reviewItem(ctx,a,undefined,detail).keys.t).toBeUndefined();
 detail.workTree!.nodes[0]!.retryEligibility={allowed:true};
 expect(reviewItem(ctx,a,undefined,detail).keys.t).toBeDefined();
});
test("TUI verdict hints match actual managed work actions",()=>{
 const ctx={supports:()=>true,s:{tasks:[]},theme:PLAIN_THEME,now:100,width:100} as unknown as ScreenCtx;
 const a={taskId:"root",title:"Blocked work",kind:"review",repo:null} as AttentionItem;
 const detail={id:"root",state:"failed",rev:9,work:{rootId:"root",parentId:null,depth:0},files:[],workTree:{totals:{tasks:1,running:0,queued:0,executionSeconds:1,dependencyWaitSeconds:0,childWaitSeconds:0,capacityWaitSeconds:0,usagePools:[]},nodes:[{taskId:"root",depth:0,title:"Blocked work",state:"failed",model:null,actualModel:null,dependencies:[],review:null,attempts:[],decisions:[],retryEligibility:{allowed:false,reason:"Work deadline has expired"}}]}} as TaskDetail;
 const lines=()=>reviewDetail(ctx,a,{value:detail},100).flatMap(row=>row.line.map(span=>span.text)).join(" ");
 expect(lines()).not.toContain("Send back");expect(lines()).not.toContain("Retry on another executor");expect(lines()).not.toContain("Retry work");
 detail.workTree!.nodes[0]!.retryEligibility={allowed:true};
 expect(lines()).toContain("Retry work");
});
