import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { answerDetail, mutedProviders, plannerProvider, rankedProviders } from "../src/view-model/panel";
import { renderDashboard } from "../src/dashboard/render";

function current(): ClientSnapshot {
 const s=structuredClone(fixture) as unknown as ClientSnapshot;
 s.strategies=[{name:"current",active:true,summary:"",description:""}];
 for(const field of ["budget","alerts","console","consoles"])Object.defineProperty(s,field,{get(){throw new Error(`Legacy read: ${field}`);},configurable:true});
 return s;
}
test("current clients render without legacy snapshot fields",()=>{
 const s=current();
 expect(plannerProvider(s)?.usedPct).toBe(63);
 expect(rankedProviders(s)[0]?.id).toBe("codex#team@devbox");
 expect(mutedProviders(s).map(p=>p.id)).toContain("local");
 expect(answerDetail(s,s.at)).toContain("37% left");
 const tui=renderDashboard(s,120,24,s.at,{selected:0,noColor:true});
 expect(tui).toContain("[NORMAL]  strategy current");
 expect(tui).toContain("Claude Code planner  week");
 expect(tui).toContain("63% used · pace 77%");
});
test("a null planner still means a current service",()=>{
 const s=current();s.planner=null;s.executors=[];s.accounts=[];
 expect(plannerProvider(s)).toBeUndefined();
 expect(rankedProviders(s)).toEqual([]);
 expect(renderDashboard(s,100,20,s.at,{selected:0})).toContain("Planner · waiting for service data");
});
test("equivalent read-model and older service data: the TUI renders board fields",()=>{
 const s=current();s.tasks=[];s.attention=[];s.executors=s.executors!.slice(0,2);
 s.accounts=[{name:"claude-code",agent:"claude-code",source:"default",usedPct:63,pacePct:77,resetsAt:s.planner!.resetsAt,window:"weekly",verdict:"BEHIND",signedIn:true,executors:["claude-code"]},...s.accounts!];
 const legacy={...fixture,tasks:[],attention:[],strategies:s.strategies,mode:s.mode,
  budget:{generatedAt:s.at,strategy:"current",planner:"claude-code",mode:"normal",providers:[plannerProvider(s)!,rankedProviders(s)[0]!],ranked:[{id:"codex#team@devbox",verdict:"BEHIND"}]},
  console:{pid:1,startedAt:1,heartbeatAt:s.at,handle:null,paneKey:null,version:s.service!.version},alerts:[]};
 // This object represents an older service; the fixture also contains new fields.
 for(const key of ["planner","executors","accounts","service","setup"])delete (legacy as Record<string,unknown>)[key];
 const old=legacy as unknown as ClientSnapshot;
 // The board consumes service-derived fields; legacy budget content cannot change it.
 const board=renderDashboard(s,120,24,s.at,{selected:0,noColor:true});
 expect(board).toContain("Claude Code planner");
 expect(board).toMatch(/1\s+Codex\s+team\s+week/);
 Object.defineProperty(s,"budget",{value:legacy.budget,configurable:true});
 expect(renderDashboard(s,120,24,s.at,{selected:0,noColor:true})).toBe(board);
 expect(renderDashboard(old,120,24,s.at,{selected:0,noColor:true})).toContain("Planner · waiting for service data");
});

