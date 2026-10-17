import { expect, test } from "bun:test";
import { buildExecutors, buildPlanner, buildAccounts } from "../src/api/read-model/capacity";
import type { ApiTask } from "../src/api/read-model/types";
import { capacityFixture } from "./read-model-helpers";

test("planner first, remote slots, shared places and exactly one next",()=>{
 const {s,st}=capacityFixture(), rows=buildExecutors(st,s,[],100000);
 expect(rows[0]!.rank).toBe("planner");
 expect(rows.find(r=>r.id==="codex@devbox")).toMatchObject({host:"devbox",slots:{used:0,max:3}});
 for(const r of rows.filter(r=>r.agent==="codex"))expect(r.sub.endsWith("this Mac + devbox")).toBe(true);
 expect(rows.filter(r=>r.next).map(r=>r.id)).toEqual(["codex"]);
 expect(buildAccounts(st,s).some(a=>a.executors.includes("codex@devbox"))).toBe(true);
});
test("blocked and broken take precedence over failures and capacity",()=>{
 const {s,st}=capacityFixture();st.providers.find(p=>p.id==="codex")!.brokenReason="broken";
 st.providers.find(p=>p.id==="cursor")!.blockedReason="blocked";
 const tasks=[1,2].map(i=>({id:String(i),executor:Object.values(s.runners).find(r=>r.agent==="opencode")!.id,state:"failed",updatedAt:99999}) as ApiTask);
 const rows=buildExecutors(st,s,tasks,100000);
 expect(rows.find(r=>r.id==="codex")).toMatchObject({state:"down",tone:"bad"});
 expect(rows.find(r=>r.id==="cursor")!.state).toBe("blocked");
 expect(rows.find(r=>r.agent==="opencode")!.state).toBe("failing");
});
for(const planner of ["claude-code","codex","cursor","opencode"])test(`planner meter is agnostic: ${planner}`,()=>{
 const {st}=capacityFixture(planner);
 expect(buildPlanner(st)).toMatchObject({verdict:"behind",deltaPts:-14,advice:"14 pts under pace — spend it."});
 st.providers.find(p=>p.id===planner)!.binding=null;
 expect(buildPlanner(st)).toMatchObject({verdict:"unknown",usedPct:null,pacePct:null,deltaPts:null,advice:"No usage reading for the planner yet."});
});

test("UNKNOWN planner with a binding hides all usage numbers",()=>{
 const {st}=capacityFixture();st.providers.find(p=>p.id===st.planner)!.verdict="UNKNOWN";
 expect(buildPlanner(st)).toMatchObject({verdict:"unknown",usedPct:null,pacePct:null,deltaPts:null,activeHoursLeft:null,resetsAt:null,window:null,advice:"No usage reading for the planner yet."});
});

test("capacity reasons redact credential-shaped diagnostics and email addresses",()=>{
 const {s,st}=capacityFixture();
 st.providers.find(p=>p.id==="codex")!.brokenReason="sign in person@example.test with sk-private-test-token";
 const row=buildExecutors(st,s,[],st.generatedAt).find(r=>r.id==="codex")!;
 expect(row.state).toBe("down");
 for(const secret of ["person@example.test","sk-private-test-token"])expect(JSON.stringify(row)).not.toContain(secret);
});

test("configured executor slots and shared machine and host limits",()=>{
 const {s,st}=capacityFixture();s.runners.codex!.maxTasks=3;s.execution={...s.execution,local_max_tasks:4};
 const tasks=[1,2].map(i=>({id:String(i),executor:"codex",state:"running",host:null}) as ApiTask);
 expect(buildExecutors(st,s,tasks,st.generatedAt).find(e=>e.id==="codex")).toMatchObject({state:"busy",slots:{used:2,max:3}});
 s.execution.local_max_tasks=2;
 expect(buildExecutors(st,s,tasks,st.generatedAt).find(e=>e.id==="codex")).toMatchObject({state:"full",reason:"this machine busy (2/2)"});
 s.runners["codex@devbox"]!.maxTasks=4;
 const remote=[1,2,3].map(i=>({id:String(i),executor:"codex@devbox",state:"running",host:"devbox"}) as ApiTask);
 expect(buildExecutors(st,s,remote,st.generatedAt).find(e=>e.host==="devbox")).toMatchObject({state:"full",reason:"devbox busy (3/3)",slots:{used:3,max:4}});
});
