import { validateStrategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
import type { TaskRecord } from "../src/tasks/types";
export function capacityFixture(planner="claude-code") {
 const s=validateStrategy({planner,providers:{[planner]:{},codex:{},cursor:{},opencode:{via:"opencode",model:"test/model",usage:"unmetered"}}},"test");
 const local=s.runners.codex;
 s.runners["codex@devbox"]={...local,id:"codex@devbox",name:"codex@devbox",host:"devbox"};
 s.hosts.devbox={alias:"devbox",ssh:"devbox",maxTasks:3,repos:{},accounts:{}};
 const st:Status={generatedAt:100000,strategy:"test",planner,mode:"normal",disabled:false,calendarPace:false,providers:Object.values(s.runners).map(r=>({id:r.name,account:r.account,usage:"quota",installed:true,stale:false,verdict:"BEHIND",windows:[],binding:{name:"week",usedPct:63,pace:77,activeHoursLeft:24,resetsAt:200000,lengthS:604800,paced:true,verdict:"BEHIND"}})),executors:{ranked:[{id:"codex",score:1,verdict:"BEHIND",reason:""}],excluded:[]}};
 return {s,st};
}
export const record=(state:TaskRecord["state"], at:number, extra:Partial<TaskRecord>={}):TaskRecord=>({id:`t-${at}`,createdAt:at,state,brief:{repo:"/missing/api",goal:"test"},kind:null,requestedExecutor:null,timeoutS:60,attempts:[],...extra});
