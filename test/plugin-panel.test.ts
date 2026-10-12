import { test, expect } from "bun:test";
import { runInNewContext } from "node:vm";
import { renderPanel, jsonForScript, escapeHtml } from "../orca-plugin/src/panel";
import { emptySnapshot, decodeCmdLine, type LinkSnapshot, type ProviderLine } from "../src/link/envelope";
import { headline, answerDetail, initialView, rankedProviders, mutedProviders, attentionGroups, attentionText, verdictWords } from "../orca-plugin/src/panel/model";
import { icon, displayName } from "../orca-plugin/src/panel/icons";
import { delegateLine } from "../orca-plugin/src/panel/delegate";
import { duration } from "../orca-plugin/src/panel/shared";
const provider=(id:string, verdict="OK", values:Partial<ProviderLine>={}):ProviderLine=>({id,verdict,usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false,...values});
function snapshot():LinkSnapshot {
 return {...emptySnapshot(),at:100,budget:{generatedAt:100,strategy:"default",planner:"claude-code",mode:"normal",providers:[provider("claude-code","ON_PACE",{usedPct:30,pacePct:28,resetsAt:100+4*86400+20*3600}),provider("agy"),provider("local"),provider("codex","AHEAD",{usedPct:36,pacePct:24}),provider("cursor","EXHAUSTED",{resetsAt:100+5*3600+24*60})],ranked:[{id:"agy",verdict:"OK"},{id:"local",verdict:"OK"},{id:"codex",verdict:"AHEAD"}]},console:{handle:"term_console",paneKey:null,pid:1,startedAt:0,heartbeatAt:100}};
}
function panel(s=snapshot(),reachable=true,nowS=100) {return renderPanel(s,{nowS,reachable,transport:"bridge"});}
function payload(html:string) {const d=JSON.parse(html.match(/id="pacer-actions">(.*?)<\/script>/s)![1]);return d.encoded?JSON.parse(Buffer.from(d.encoded,"base64").toString("utf8")):d;}
class Node {
 dataset:Record<string,string>={}; disabled=false; hidden=false; textContent=""; innerHTML=""; value=""; focused=false; handlers:Record<string,Function>={};
 addEventListener(name:string,fn:Function){this.handlers[name]=fn;}
 click(){this.handlers.click?.();}
 focus(){this.focused=true;}
}
function browser(html=panel()) {
 const ids:Record<string,Node>=Object.fromEntries(["status","delegate-form","goal","done","worktree-branch","ranked-list","unavailable-list","executor-options","ranked-order"].map(id=>[id,new Node()]));
 const make=(dataset:Record<string,string>)=>Object.assign(new Node(),{dataset});
 const pages=[make({page:"overview"}),make({page:"setup"}),make({page:"delegate"})];
 const views=[make({view:"delegate"}),make({view:"overview"})], strategy=make({command:"strategy"}), setups=[make({setup:"pacer serve"}),make({setup:"pacer console --open"})],worktree=new Node(),selected=new Node();
 const sent:any[]=[];let now=100000,listener:Function=()=>{};
 const parent={postMessage:(m:any)=>sent.push(m)};
 runInNewContext(html.match(/<script>\n([\s\S]*?)<\/script>/)![1],{
  Date:{now:()=>now},TextEncoder,TextDecoder,Uint8Array,atob,
  document:{getElementById:(id:string)=>id==="pacer-actions"?{textContent:html.match(/id="pacer-actions">(.*?)<\/script>/s)![1]}:ids[id],
   querySelectorAll:(selector:string)=>selector==="[data-page]"?pages:selector==="[data-view]"?views:selector==="[data-command]"?[strategy]:selector==="[data-setup]"?setups:selector==="[data-worktree]"?[worktree]:selector==="[data-command],[data-live]"?[strategy,...views]:[],querySelector:()=>selected},
  window:{parent,addEventListener:(_n:string,h:Function)=>listener=h},
 });
 const reply=(m:any,value:any,ok=true,source=parent)=>listener({source,data:{type:"orca-panel-action-result",requestId:m.requestId,ok,value}});
 return {ids,pages,views,strategy,setups,selected,sent,reply,now:(v:number)=>now=v,submit:()=>ids["delegate-form"].handlers.submit({preventDefault(){}})};
}
for(const [verdict,expected] of [["ON_PACE","You're on pace for the week."],["OK","You're on pace for the week."],["AHEAD","Claude is ahead of pace. Slow down planning."],["NEAR_LIMIT","Claude is ahead of pace. Slow down planning."],["BEHIND","Claude is behind pace. Room for more planning."],["UNKNOWN","Budget unknown."]]) test(`headline ${verdict}`,()=>expect(headline(provider("claude-code",verdict))).toBe(expected));
test("exhausted and absent planner headlines and unknown detail",()=>{
 expect(headline(provider("claude-code","EXHAUSTED",{resetsAt:1000}))).toStartWith("Claude is out until ");expect(headline()).toBe("Budget unknown.");
 const s=snapshot();expect(answerDetail(s,100)).toBe("Claude has 70% left with 4 days 20 hours to go. New work goes to Antigravity.");
 s.budget!.providers[0].usedPct=null;s.budget!.providers[0].resetsAt=null;expect(answerDetail(s,100)).toBe("New work goes to Antigravity.");
 expect(duration(3600,true)).toBe("1 hour");expect(duration(86400+3600,true)).toBe("1 day 1 hour");expect(duration(5*3600+24*60)).toBe("5h 24m");
});
test("ranked rows, muted quota, icons and plain verdict words",()=>{
 const s=snapshot();const b=browser();expect(rankedProviders(s).map(p=>p.id)).toEqual(["agy","local","codex"]);expect(mutedProviders(s).map(p=>p.id)).toEqual(["cursor"]);
 const rows=b.ids["ranked-list"].innerHTML;expect(rows.indexOf("Antigravity")).toBeLessThan(rows.indexOf("Local model"));expect(rows.indexOf("Local model")).toBeLessThan(rows.indexOf("Codex"));expect(rows).toContain("Ahead of pace");expect(rows).toContain('left:24%');
 expect(b.ids["unavailable-list"].innerHTML).toContain("out of quota · back in 5h 24m");expect(b.ids["executor-options"].innerHTML).toContain('value="unavailable" disabled');
 for(const [id,name] of [["claude-code","Claude"],["cursor","Cursor"],["agy","Antigravity"],["byteplus","BytePlus"],["local","Local model"],["codex","Codex"],["test","test"]]) {expect(icon(id)).toContain(`aria-label="${name}"`);expect(displayName(id)).toBe(name);}
 expect(icon("codex")).toContain("Cx");expect(icon("test")).toContain(">te<");expect(icon("agy",13)).toContain('width="13"');
 for(const [v,word] of [["OK","Available"],["AHEAD","Ahead of pace"],["BEHIND","Behind pace"],["EXPIRING","Expiring soon"],["NEAR_LIMIT","Near limit"],["wat","Unknown"]]) expect(verdictWords(v)).toBe(word);
});
test("attention groups duplicate goals, excludes failed executor, detects stuck tasks after ten minutes",()=>{
 const s=snapshot();s.tasks=[{id:"a",state:"failed",goal:"same",executor:"agy",backend:null,worktree:null,updatedAt:90},{id:"b",state:"limit",goal:"same",executor:"agy",backend:null,worktree:null,updatedAt:80},{id:"c",state:"running",goal:"stuck",executor:null,backend:null,worktree:null,updatedAt:-501},{id:"d",state:"queued",goal:"just ten",executor:null,backend:null,worktree:null,updatedAt:-500}];
 const groups=attentionGroups(s,100);expect(groups).toHaveLength(2);expect(attentionText(groups[0],100)).toBe("Failed twice on Antigravity");expect(groups[0].retry?.id).toBe("local");expect(groups[1].stuck).toBe(true);
 const data=payload(panel(s));expect(data.commands["attention-0"]).toEqual({cmd:"retry",taskId:"a",executor:"local"});expect(data.commands["attention-1"]).toEqual({cmd:"stop",taskId:"c"});
 s.budget!.ranked=[{id:"cursor",verdict:"EXHAUSTED"},{id:"agy",verdict:"OK"}];expect(attentionGroups(s,100)[0].retry).toBeNull();
});
test("setup selection and checklist states",()=>{
 const s=snapshot();expect(initialView(s,true,100)).toBe("overview");expect(initialView(s,false,100)).toBe("setup");expect(initialView({...s,budget:null},true,100)).toBe("setup");expect(initialView(s,true,131)).toBe("setup");
 const html=panel(s,false);expect(html).toContain('data-page="setup">');expect(html).toContain("Last known budget");expect(html).toContain("not live");expect(html).toContain("pacer never changes Orca's settings");expect(html).toContain('step done');expect(html).toContain('data-setup="pacer serve"');
});
test("setup commands use focused first terminal and never enter; no-terminal result is useful",()=>{
 const b=browser(panel(emptySnapshot(),false));b.setups[0].click();const contextRequest=b.sent.at(-1);expect(contextRequest.action).toBe("workspace.readContext");b.reply(contextRequest,{branch:"x",displayName:"X",terminals:[{id:"first"},{id:"second"}]});
 const send=b.sent.at(-1);expect(send.params).toEqual({terminalId:"first",text:"pacer serve",enter:false});b.reply(send,{accepted:true});expect(b.ids.status.textContent).toBe("Typed into your terminal. Press Enter to run it.");
 b.setups[1].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[]});expect(b.ids.status.textContent).toBe("Open a terminal in this worktree first");
});
test("delegate form switches locally, reads focused context and encodes the full brief",()=>{
 const b=browser();b.views[0].click();b.reply(b.sent.at(-1),{branch:"feat",displayName:"Feature",terminals:[]});expect(b.pages[2].hidden).toBe(false);expect(b.ids.goal.focused).toBe(true);expect(b.ids["worktree-branch"].textContent).toBe("feat");
 b.ids.goal.value="fix 'quotes' <script>\u2028";b.ids.done.value="bun test";b.selected.value="2";b.submit();b.reply(b.sent.at(-1),{branch:"current",displayName:"Current",terminals:[]});const send=b.sent.at(-1);
 expect(send.params.enter).toBe(true);expect(send.params.terminalId).toBe("term_console");expect(decodeCmdLine(send.params.text).cmd?.data).toEqual({cmd:"delegate",branch:"current",displayName:"Current",goal:b.ids.goal.value,acceptance:"bun test",executor:"codex"});
 b.reply(send,{accepted:true});expect(b.ids.status.textContent).toBe("Sent to pacer console");b.views[1].click();expect(b.pages[0].hidden).toBe(false);
});
test("delegate payload validates exact limits and oversized encoded lines without truncation",()=>{
 const c={branch:"x",displayName:"X",terminals:[]};expect(decodeCmdLine(delegateLine(c,"g".repeat(2000),"a".repeat(500))).cmd?.data.goal).toHaveLength(2000);
 for(const [g,a] of [["",""],["g".repeat(2001),""],["g","a".repeat(501)]]) expect(()=>delegateLine(c,g,a)).toThrow();
 expect(()=>delegateLine(c,"'".repeat(2000),"")).toThrow("4096");expect(()=>delegateLine(null,"goal","")).toThrow();
 const b=browser();b.ids.goal.value="'".repeat(2000);b.submit();b.reply(b.sent.at(-1),c);expect(b.sent.at(-1).action).toBe("workspace.readContext");expect(b.ids.status.textContent).toContain("4096");
 b.ids.goal.value="g".repeat(2001);const count=b.sent.length;b.submit();expect(b.sent).toHaveLength(count);expect(b.ids.status.textContent).toContain("2000");
 b.ids.goal.value="goal";b.selected.disabled=true;b.submit();expect(b.sent).toHaveLength(count);
});
test("heartbeat gating and rate limit include context requests",()=>{
 const b=browser();b.now(130000);b.strategy.click();expect(b.sent).toHaveLength(2);b.now(130001);b.strategy.click();expect(b.sent).toHaveLength(2);expect(b.strategy.disabled).toBe(true);expect(b.ids.status.textContent).toContain("expired");
 const r=browser();for(let i=0;i<35;i++)r.strategy.click();expect(r.sent).toHaveLength(30);r.now(110000);r.strategy.click();expect(r.sent).toHaveLength(31);
 r.reply(r.sent.at(-1),{accepted:true},true,{} as any);expect(r.ids.status.textContent).not.toBe("Sent to pacer console");
});
test("all views escape hostile goals, titles, branches and provider identifiers",()=>{
 const attack="</script><script>\"'\u2028\u2029";const s=snapshot();s.budget!.mode=attack;s.budget!.providers.push(provider(attack));s.budget!.ranked.push({id:attack,verdict:"OK"});s.console!.handle=attack;s.tasks=[{id:"t",state:"failed",goal:attack,executor:attack,backend:null,worktree:null,updatedAt:1}];s.alerts=[{key:"a",level:"error",title:attack,body:attack,at:1}];
 const html=panel(s);expect(html).not.toContain("<script>\"");expect(jsonForScript(attack)).not.toMatch(/[<\u2028\u2029]/);expect(escapeHtml('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");
 const b=browser(html);expect(b.ids["ranked-list"].innerHTML).toContain("&lt;/script&gt;");b.reply(b.sent[0],{branch:attack,displayName:attack,terminals:[]});expect(b.ids["worktree-branch"].textContent).toBe(attack);expect(html).toContain("default-src 'none'");expect(html).not.toMatch(/https?:/);
});
test("maximum snapshots and hostile escaping stay under 64 KiB",()=>{
 for(const fill of ["x","\"","<","&","界","🧠"]) {
  const s=snapshot();s.budget!.planner=fill.repeat(64).slice(0,64);s.budget!.mode=fill.repeat(32).slice(0,32);s.console!.handle=fill.repeat(1024).slice(0,1024);s.budget!.providers=Array.from({length:32},(_,i)=>provider(String(i)+fill.repeat(62),"OK",{usedPct:50,pacePct:28,resetsAt:3700,window:fill.repeat(32).slice(0,32),stale:true}));s.budget!.ranked=s.budget!.providers.map(p=>({id:p.id,verdict:p.verdict}));
  s.tasks=Array.from({length:20},(_,i)=>({id:`t${i}`+"i".repeat(125),state:"failed",goal:String(i)+fill.repeat(198).slice(0,198),executor:fill.repeat(64).slice(0,64),backend:null,worktree:null,updatedAt:100}));s.alerts=Array.from({length:10},(_,i)=>({key:`a${i}`,level:"warn",title:fill.repeat(120),body:fill.repeat(1000),at:100}));
  expect(Buffer.byteLength(panel(s))).toBeLessThan(65536);expect(payload(panel(s)).rows).toHaveLength(32);
 }
});
test("stale budget is amber and unknown percentages use em dash",()=>{
 const s=snapshot();s.console!.heartbeatAt=250;const html=panel(s,true,250);expect(html).toContain('name live warn');s.budget!.providers[0].usedPct=null;s.budget!.providers[0].pacePct=null;expect(panel(s)).toContain("Pace marker —");
});
test("expired heartbeat is checked again after an asynchronous context reply",()=>{
 const b=browser();b.ids.goal.value="fix";b.submit();const before=b.sent.length;b.now(130001);b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[]});expect(b.sent).toHaveLength(before);expect(b.ids.status.textContent).toContain("expired");
});
test("rejected bridge send reports failure and duplicate responses cannot change status",()=>{
 const b=browser();b.strategy.click();const command=b.sent.at(-1);b.reply(command,{accepted:false});expect(b.ids.status.textContent).toContain("refused");b.reply(command,{accepted:true});expect(b.ids.status.textContent).toContain("refused");
});
test("prototype names are unknown providers with accessible monogram fallbacks",()=>{
 for(const id of ["__proto__","constructor","toString"]) {expect(displayName(id)).toBe(id);expect(icon(id)).toContain(`aria-label="${id}"`);expect(icon(id)).not.toContain("<path");expect(verdictWords(id)).toBe("Unknown");}
});
test("recently done shows the latest three tasks with executor and age",()=>{
 const s=snapshot();s.tasks=Array.from({length:4},(_,i)=>({id:`t${i}`,state:"done",goal:`completed goal ${i}`,executor:"codex",backend:null,worktree:null,updatedAt:i}));
 const html=panel(s);expect(html).not.toContain("completed goal 0");for(const i of [1,2,3])expect(html).toContain(`completed goal ${i}`);expect(html).toContain("Codex · 1m ago");expect(html.indexOf("completed goal 3")).toBeLessThan(html.indexOf("completed goal 2"));
});
