import { expect, test } from "bun:test";
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { answerDetail, mutedProviders, plannerProvider, rankedProviders } from "../src/view-model/panel";
import { renderDashboard } from "../src/dashboard/render";
import { renderStatusPage } from "../orca-plugin/src/panel";
import { legacyChecklist } from "../orca-plugin/src/panel/setup";
import { LinkStore } from "../orca-plugin/src/store";

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
 expect(tui).toContain("normal · current");
 expect(tui).toContain("Planner Claude: 63%");
 const html=renderStatusPage(s,{nowS:s.at,reachable:true,transport:"api"});
 expect(html).toContain("Needs you");
 expect(html).toContain("63% · pace 77 · resets Mon</span>");
 expect(html).toContain('aria-label="Claude usage, pace 77%" aria-valuenow="63"');
 expect(html).toContain(s.planner!.advice);
 expect(legacyChecklist(s,s.at,true).complete).toBe(true);
});
test("a null planner still means a current service",()=>{
 const s=current();s.planner=null;s.executors=[];s.accounts=[];
 expect(plannerProvider(s)).toBeUndefined();
 expect(rankedProviders(s)).toEqual([]);
 expect(renderStatusPage(s,{nowS:s.at,reachable:true,transport:"api"})).toContain("Planner unknown");
 expect(renderDashboard(s,100,20,s.at,{selected:0})).toContain("Planner ?: ?");
});
test("plugin store observes read-model changes without legacy content keys",()=>{
 const store=new LinkStore(()=>0);let changes=0;store.onChange(()=>changes++);
 const s=current();store.replace(s);
 const heartbeat=current();heartbeat.at++;store.replace(heartbeat);
 expect(changes).toBe(1);
 const next=current();next.planner={...next.planner!,usedPct:64};store.replace(next);
 expect(changes).toBe(2);
 store.replace(next);expect(changes).toBe(2);
});

test("equivalent service data keep TUI output and panel budget while the current panel uses the board",()=>{
 const s=current();s.tasks=[];s.attention=[];s.executors=s.executors!.slice(0,2);
 s.accounts=[{name:"claude-code",agent:"claude-code",source:"default",usedPct:63,pacePct:77,resetsAt:s.planner!.resetsAt,window:"weekly",verdict:"BEHIND",signedIn:true,executors:["claude-code"]},...s.accounts!];
 const legacy={...fixture,tasks:[],attention:[],strategies:s.strategies,mode:s.mode,
  budget:{generatedAt:s.at,strategy:"current",planner:"claude-code",mode:"normal",providers:[plannerProvider(s)!,rankedProviders(s)[0]!],ranked:[{id:"codex#team@devbox",verdict:"BEHIND"}]},
  console:{pid:1,startedAt:1,heartbeatAt:s.at,handle:null,paneKey:null,version:s.service!.version},alerts:[]};
 // This object represents an older service; the fixture also contains new fields.
 for(const key of ["planner","executors","accounts","service","setup"])delete (legacy as Record<string,unknown>)[key];
 const old=legacy as unknown as ClientSnapshot;
 expect(renderDashboard(s,120,24,s.at,{selected:0})).toBe(renderDashboard(old,120,24,s.at,{selected:0}));
 const view={nowS:s.at,reachable:true,transport:"api" as const};
 const currentPanel=renderStatusPage(s,view), oldPanel=renderStatusPage(old,view);
 expect(currentPanel).toContain("63% · pace 77 · resets Mon</span>");
 expect(oldPanel).toContain("63% used");
 for(const html of [currentPanel,oldPanel])expect(html).toContain('aria-label="Claude usage, pace 77%" aria-valuenow="63"');
 expect(currentPanel).toContain("<h2>Needs you</h2>");
 expect(oldPanel).toContain("<h2>Accounts</h2>");
});

