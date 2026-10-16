import { expect, test } from "bun:test";
import { renderStatusPage as renderPanel } from "../orca-plugin/src/panel";
import { MANUAL_INSTALL } from "../orca-plugin/src/bootstrap";
import { emptySnapshot, type LinkSnapshot, type ProviderLine, type TaskData } from "../src/link/envelope";

const nowS = new Date("2026-10-15T12:00:00+07:00").getTime()/1000;
const provider = (id:string, account:string, usedPct:number):ProviderLine => ({id,account,agent:id.split("#")[0],usedPct,pacePct:40,resetsAt:nowS+86400,window:"weekly",verdict:"ON_PACE",stale:account==="team"});
const task = (id:string,state:string,updatedAt=nowS):TaskData => ({id,state,updatedAt,goal:`${id} goal`,executor:"codex#team",backend:"native",worktree:"feature-branch"});
function snapshot():LinkSnapshot {
 return {...emptySnapshot(),at:nowS,budget:{generatedAt:nowS,strategy:"default",planner:"claude-code#personal",mode:"normal",ranked:[],providers:[provider("claude-code#personal","personal",30),provider("codex#team","team",60),provider("opencode#team","team",60),provider("opencode#local","local",0)]},tasks:[{...task("running","running"),attemptStartedAt:nowS-60,progress:{phase:"testing",files:1,commits:0,logBytes:10,lastOutputAt:nowS}},task("queued","queued"),task("partial","partial",nowS-120),task("done","done",nowS-60),{...task("reviewed","done"),review:{accepted:true,kind:null,note:null,at:nowS}},{...task("dismissed","done"),dismissed:true}],alerts:[{key:"warning",level:"warn",title:"Quota warning",body:"Check team usage",at:nowS-30},{key:"error",level:"error",title:"Task failed",body:"Executor stopped",at:nowS-60},{key:"info",level:"info",title:"Hidden info",body:"Routine",at:nowS}]};
}
const view={nowS,reachable:true,transport:"http" as const,updates:{cli:"1.0.0",plugin:"1.0.1",latest:"1.1.0",available:true},setup:{checkedAt:nowS,complete:false,items:[{id:"service",title:"Login service",required:true,status:"pending" as const,command:"pacer init"}]}};
function readOnly(html:string) {
 for(const token of ['<button','<input','<select','<textarea','<form','role="button"','data-command','data-view','data-setup','data-focus']) expect(html).not.toContain(token);
 expect(html).not.toMatch(/<script\b(?![^>]*type="application\/json")/i);
 expect(html).toContain("script-src 'none'");
 expect(html).toMatch(/user-select:\s*text/);
}
test("panel is read-only",()=>readOnly(renderPanel(snapshot(),view)));
test("status page shows every section",()=>{
 const html=renderPanel(snapshot(),view);
 for(const text of ["Normal","Live · updated 12:00","Planner","Claude Code (personal)","30%","Resets Fri 12:00","You&#39;re on pace for the week.","Accounts","personal","team","local","Available","60%","weekly","stale","Runners:","Codex (team)","Running","running goal","queued goal","started 11:59","testing","Waiting for review","partial goal","done goal","finished 11:59","feature-branch","pacer review &lt;id&gt;","Alerts","Quota warning","Executor stopped","Versions","pacer 1.0.0","plugin 1.0.1","Update available: 1.1.0","pacer update","Setup","Login service","pacer init","pacer open","open the pacer app"]) expect(html).toContain(text);
 expect(html).not.toContain("reviewed goal");expect(html).not.toContain("dismissed goal");expect(html).not.toContain("Hidden info");
 expect(html.indexOf("done goal")).toBeLessThan(html.indexOf("partial goal"));
 const sections=[...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(m=>m[1]);
 expect(sections).toEqual(["Planner","Accounts","Running","Waiting for review","Alerts","Versions","Setup"]);
 expect(html.match(/class="account card stack"/g)).toHaveLength(3);
});
test("times are absolute",()=>{
 const html=renderPanel(snapshot(),{...view,reachable:false});
 expect(html).toContain("Not connected · last data 12:00");expect(html).not.toContain("ago");expect(html).not.toContain("data-age-at");
 expect(renderPanel(snapshot(),{...view,nowS:nowS+60})).toBe(renderPanel(snapshot(),view));
});
test("bootstrap mode shows install steps",()=>{
 const html=renderPanel(emptySnapshot(),{...view,bootstrap:{install:{status:"done",detail:"Installed"},start:{status:"failed",detail:"Service unavailable"},agents:[]}});
 readOnly(html);
 for(const text of [MANUAL_INSTALL,"pacer init","install: done","Installed","start: failed","Service unavailable","automatically","plugin restarts","pacer open"]) expect(html).toContain(text);
 expect(html).not.toContain("<h2>Planner</h2>");expect(html).not.toContain("<h2>Versions</h2>");
 expect(renderPanel(emptySnapshot(),{...view,bootstrap:{install:{status:"pending"},start:{status:"pending"},agents:[]}})).toContain("install: pending");
});
test("review and alert lists are bounded and newest first",()=>{
 const s=snapshot();s.tasks=Array.from({length:12},(_,i)=>task(`review${i}`,"done",nowS-i));
 s.alerts=Array.from({length:7},(_,i)=>({key:`alert${i}`,level:"warn",title:`Alert ${i}`,body:"x".repeat(201),at:nowS-i}));
 const html=renderPanel(s,view);expect(html).toContain("review9 goal");expect(html).not.toContain("review10 goal");expect(html).toContain("Alert 4");expect(html).not.toContain("Alert 5");expect(html).not.toContain("x".repeat(201));
});
test("status text is escaped and running goals are truncated",()=>{
 const s=snapshot();s.tasks=[{...task("escape","running"),goal:'<img src=x onerror="bad">'+'x'.repeat(110)}];
 const html=renderPanel(s,view);readOnly(html);expect(html).toContain('&lt;img src=x onerror=&quot;bad&quot;&gt;');expect(html).not.toContain('<img');expect(html).not.toContain('x'.repeat(100));
});

test("installed live snapshots show status even when the worker supplies bootstrap state",()=>{
 const html=renderPanel(snapshot(),{...view,bootstrap:{install:{status:"done"},start:{status:"done"},agents:[]}});
 expect(html).toContain("<h2>Planner</h2>");expect(html).not.toContain("<h2>Install</h2>");
});

test("incomplete setup distinguishes optional checks without controls or relative times",()=>{
 const html=renderPanel(snapshot(),{...view,setup:{...view.setup,items:[...view.setup.items,{id:"agent:codex",title:"Codex login",required:false,status:"pending"}]}});
 expect(html).toContain("Optional");expect(html).toContain("Codex login");readOnly(html);expect(html).not.toContain("ago");
});
