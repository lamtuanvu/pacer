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
 return {...emptySnapshot(),at:100,strategies:["default","custom"],budget:{generatedAt:100,strategy:"default",planner:"claude-code",mode:"normal",providers:[provider("claude-code","ON_PACE",{usedPct:30,pacePct:28,resetsAt:100+4*86400+20*3600}),provider("agy"),provider("local"),provider("codex","AHEAD",{usedPct:36,pacePct:24}),provider("cursor","EXHAUSTED",{resetsAt:100+5*3600+24*60})],ranked:[{id:"agy",verdict:"OK"},{id:"local",verdict:"OK"},{id:"codex",verdict:"AHEAD"}]},console:{handle:"term_console",paneKey:null,pid:1,startedAt:0,heartbeatAt:100}};
}
function panel(s=snapshot(),reachable=true,nowS=100) {return renderPanel(s,{nowS,reachable,transport:"bridge"});}
function payload(html:string) {const d=JSON.parse(html.match(/id="pacer-actions">(.*?)<\/script>/s)![1]);const raw=d.encoded?JSON.parse(Buffer.from(d.encoded,"base64").toString("utf8")):d;
 const unpack=(v:any):any=>Array.isArray(v)?v.map(unpack):v&&typeof v==="object"?Object.hasOwn(v,"$runs")?v.$runs.map(([c,n]:[string,number])=>c.repeat(n)).join(""):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,unpack(x)])):v;return unpack(raw);}
class Node {
 parentElement:any={className:""}; className=""; dataset:Record<string,string>={}; disabled=false; hidden=false; textContent=""; innerHTML=""; value=""; focused=false; handlers:Record<string,Function>={};
 addEventListener(name:string,fn:Function){this.handlers[name]=fn;}
 click(){this.handlers.click?.();}
 focus(){this.focused=true;}
}
function browser(html=panel(),seen:string[]=[]) {
 const ids:Record<string,Node>=Object.fromEntries(["notification-level","delegate-send","strategy-send","strategy-after","strategy-form","strategy-list","strategy-from","strategy-agent","strategy-brief","status","delegate-form","goal","done","worktree-branch","ranked-list","unavailable-list","executor-options","ranked-order","strategy-picker","console-hint"].map(id=>[id,new Node()]));
 ids["strategy-after"].hidden=true;ids["strategy-picker"].hidden=true;ids["console-hint"].hidden=true;
 const make=(dataset:Record<string,string>)=>Object.assign(new Node(),{dataset});
 const pages=[make({page:"overview"}),make({page:"setup"}),make({page:"delegate"})];
 const submitButton=ids["delegate-send"], best=new Node();best.value="";
 const views=[make({view:"delegate"}),make({view:"overview"})], strategy=make({strategyToggle:""}), setups=[make({setup:"pacer service install"}),make({setup:"pacer console --open"}),make({setup:"pacer console"})],worktree=new Node(),selected=new Node();
 const connects=[...html.matchAll(/data-connect-agents/g)].map(()=>make({connectAgents:""})), retries=[...html.matchAll(/data-bootstrap-retry/g)].map(()=>make({bootstrapRetry:""}));
 const check=new Node(), updated=new Node(), connection=new Node(), feedback=Array.from({length:4},()=>new Node());
 const commandButtons=[...html.matchAll(/data-command="([^"]+)"/g)].map(m=>make({command:m[1]}));
 const setupAges=[...html.matchAll(/data-setup-checked="([^"]+)"/g)].map(m=>make({setupChecked:m[1]}));
 const focusCards=[...html.matchAll(/data-focus="([^"]+)"/g)].map(m=>make({focus:m[1]}));
 const strategies=[make({strategy:"0"}),make({strategy:"1"})], freshness=[new Node(),new Node()], intervals:Function[]=[];
 const sent:any[]=[];let now=100000,listener:Function=()=>{};
 const parent={postMessage:(m:any)=>sent.push(m)};
 runInNewContext(html.match(/<script>\n([\s\S]*?)<\/script>/)![1],{
  sessionStorage:{getItem:()=>JSON.stringify(seen),setItem:(_key:string,value:string)=>{seen=JSON.parse(value);}},
  Date:class extends Date {static now(){return now;}},setInterval:(fn:Function,ms:number)=>{expect([1000,30000]).toContain(ms);intervals.push(fn);},TextEncoder,TextDecoder,Uint8Array,atob,
  document:{getElementById:(id:string)=>id==="pacer-actions"?{textContent:html.match(/id="pacer-actions">(.*?)<\/script>/s)![1]}:ids[id],
   querySelectorAll:(selector:string)=>selector==="[data-connect-agents]"?connects:selector==="[data-bootstrap-retry]"?retries:selector==="[data-focus]"?focusCards:selector==="[data-status]"?feedback:selector==="[data-console-connection]"?[connection]:selector==="[data-check]"?[check]:selector==="[data-updated]"?[updated]:selector==="[data-page]"?pages:selector==="[data-view]"?views:selector==="[data-command]"?commandButtons:selector==="[data-setup-checked]"?setupAges:selector==="[data-setup-check]"?commandButtons.filter(b=>b.dataset.command==="checkSetup"):selector==="[data-strategy-toggle]"?[strategy]:selector==="[data-strategy]"?strategies:selector==="[data-freshness]"?freshness:selector==="[data-setup]"?setups:selector==="[data-worktree]"?[worktree]:selector==="[data-command],[data-live]"?[strategy,...views]:[],querySelector:(selector:string)=>selector.includes("submit")?submitButton:selector.includes('value=""')?best:selected},
  window:{parent,addEventListener:(n:string,h:Function)=>{if(n==="message")listener=h;}},
 });
 const reply=(m:any,value:any,ok=true,source=parent)=>listener({source,data:{type:"orca-panel-action-result",requestId:m.requestId,ok,value}});
 return {commandButtons,setupAges,connects,retries,focusCards,ids,pages,feedback,connection,views,strategy,strategies,freshness,check,updated,tick:()=>intervals.forEach(fn=>fn()),setups,selected,best,submitButton,sent,reply,now:(v:number)=>now=v,submit:()=>ids["delegate-send"].click()};
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
 const s=snapshot();expect(initialView(s,true,100)).toBe("overview");expect(initialView(s,false,100)).toBe("setup");expect(initialView({...s,budget:null},true,100)).toBe("setup");expect(initialView(s,true,130)).toBe("overview");expect(initialView(s,true,131)).toBe("setup");
 const html=panel(s,false);expect(html).toContain('data-page="setup">');expect(html).toContain("Login service");expect(html).toContain("pacer init");expect(html).toContain("Checked 0 s ago");
});
test("setup commands use focused first terminal and never enter; no-terminal result is useful",()=>{
 const b=browser(panel(emptySnapshot(),false));b.setups[0].click();const contextRequest=b.sent.at(-1);expect(contextRequest.action).toBe("workspace.readContext");b.reply(contextRequest,{branch:"x",displayName:"X",terminals:[{id:"first"},{id:"second"}]});
 const send=b.sent.at(-1);expect(send.params).toEqual({terminalId:"first",text:"pacer service install",enter:false});b.reply(send,{accepted:true});expect(b.ids.status.textContent).toBe("Typed into your terminal. Press Enter to run it.");
 b.setups[1].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[]});expect(b.ids.status.textContent).toBe("Open a terminal in this worktree first");
});
test("delegate form switches locally, reads focused context and encodes the full brief",()=>{
 const b=browser();b.views[0].click();b.reply(b.sent.at(-1),{branch:"feat",displayName:"Feature",terminals:[{id:"term_console"}]});expect(b.pages[2].hidden).toBe(false);expect(b.ids.goal.focused).toBe(true);expect(b.ids["worktree-branch"].textContent).toBe("feat");
 b.ids.goal.value="fix 'quotes' <script>\u2028";b.ids.done.value="bun test";b.selected.value="2";b.submit();b.reply(b.sent.at(-1),{branch:"current",displayName:"Current",terminals:[{id:"term_console"}]});const send=b.sent.at(-1);
 expect(send.params.enter).toBe(true);expect(send.params.terminalId).toBe("term_console");expect(decodeCmdLine(send.params.text).cmd?.data).toEqual({cmd:"delegate",branch:"current",displayName:"Current",goal:b.ids.goal.value,acceptance:"bun test",executor:"codex"});
 b.reply(send,{accepted:true});expect(b.ids.status.textContent).toBe("Sent. The task id appears in the pacer console.");expect(b.pages[0].hidden).toBe(false);expect(b.ids.goal.value).toBe("");expect(b.ids.done.value).toBe("");expect((b.best as any).checked).toBe(true);expect(b.submitButton.disabled).toBe(true);
});
test("delegate payload validates exact limits and oversized encoded lines without truncation",()=>{
 const c={branch:"x",displayName:"X",terminals:[{id:"term_console"}]};expect(decodeCmdLine(delegateLine(c,"g".repeat(2000),"a".repeat(500))).cmd?.data.goal).toHaveLength(2000);
 for(const [g,a] of [["",""],["g".repeat(2001),""],["g","a".repeat(501)]]) expect(()=>delegateLine(c,g,a)).toThrow();
 expect(()=>delegateLine(c,"'".repeat(2000),"")).toThrow("4096");expect(()=>delegateLine(null,"goal","")).toThrow();
 const b=browser();b.ids.goal.value="'".repeat(2000);b.submit();b.reply(b.sent.at(-1),c);expect(b.sent.at(-1).action).toBe("workspace.readContext");expect(b.ids.status.textContent).toContain("4096");
 b.ids.goal.value="g".repeat(2001);const count=b.sent.length;b.submit();expect(b.sent).toHaveLength(count);expect(b.ids.status.textContent).toContain("2000");
 b.ids.goal.value="goal";b.selected.disabled=true;b.submit();expect(b.sent).toHaveLength(count);
});
test("client requires a console live at render and current workspace membership",()=>{
 const b=browser();b.now(700000);b.strategies[1].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});expect(b.sent.at(-1).action).toBe("terminal.sendText");
 const expired=browser(panel(snapshot(),true,131));expired.now(131000);expired.strategies[1].click();expect(expired.sent.some(m=>m.action==="terminal.sendText")).toBe(false);expect(expired.ids.status.textContent).toContain("console");
 const absent=browser();absent.strategies[1].click();absent.reply(absent.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"other"}]});expect(absent.sent.some(m=>m.action==="terminal.sendText")).toBe(false);expect(absent.ids.status.textContent).toBe("The pacer console for this worktree is starting. Try again in a few seconds.");expect(absent.ids["console-hint"].hidden).toBe(false);
});
test("pending action suppresses duplicate clicks until outcome or timeout",()=>{
 const r=browser();for(let i=0;i<35;i++)r.strategies[1].click();expect(r.sent).toHaveLength(2);r.now(161000);r.tick();r.strategies[1].click();expect(r.sent).toHaveLength(3);
});
test("all views escape hostile goals, titles, branches and provider identifiers",()=>{
 const attack="</script><script>\"'\u2028\u2029";const s=snapshot();s.budget!.mode=attack;s.budget!.providers.push(provider(attack));s.budget!.ranked.push({id:attack,verdict:"OK"});s.console!.handle=attack;s.tasks=[{id:"t",state:"failed",goal:attack,executor:attack,backend:null,worktree:null,updatedAt:1}];s.alerts=[{key:"a",level:"error",title:attack,body:attack,at:1}];
 const html=panel(s);expect(html).not.toContain("<script>\"");expect(jsonForScript(attack)).not.toMatch(/[<\u2028\u2029]/);expect(escapeHtml('&<>"\'')).toBe("&amp;&lt;&gt;&quot;&#39;");
 const b=browser(html);expect(b.ids["ranked-list"].innerHTML).toContain("&lt;/script&gt;");b.reply(b.sent[0],{branch:attack,displayName:attack,terminals:[{id:"term_console"}]});expect(b.ids["worktree-branch"].textContent).toBe(attack);expect(html).toContain("default-src 'none'");expect(html).not.toMatch(/https?:/);
});
test("maximum snapshots and hostile escaping stay under 64 KiB",()=>{
 for(const fill of ["x","\"","<","&","界","🧠"]) {
  const s=snapshot();s.budget!.planner=fill.repeat(64).slice(0,64);s.budget!.mode=fill.repeat(32).slice(0,32);s.console!.handle=fill.repeat(1024).slice(0,1024);s.budget!.providers=Array.from({length:32},(_,i)=>provider(String(i)+fill.repeat(62),"OK",{usedPct:50,pacePct:28,resetsAt:3700,window:fill.repeat(32).slice(0,32),stale:true}));s.budget!.ranked=s.budget!.providers.map(p=>({id:p.id,verdict:p.verdict}));
  s.consoles=Array.from({length:32},(_,i)=>({handle:`term_${String(i).padStart(36,"0")}`,paneKey:null,pid:i+1,startedAt:0,heartbeatAt:100}));s.strategies=Array.from({length:32},(_,i)=>String(i)+fill.repeat(126).slice(0,126));
  s.tasks=Array.from({length:20},(_,i)=>({id:`t${i}`+"i".repeat(125),state:"failed",goal:String(i)+fill.repeat(198).slice(0,198),executor:fill.repeat(64).slice(0,64),backend:null,worktree:null,updatedAt:100}));s.alerts=Array.from({length:10},(_,i)=>({key:`a${i}`,level:"warn",title:fill.repeat(120),body:fill.repeat(1000),at:100}));
  expect(Buffer.byteLength(panel(s))).toBeLessThan(65536);expect(payload(panel(s)).rows).toHaveLength(32);
  expect(Buffer.byteLength(renderPanel(s,{nowS:100,transport:"http",reachable:true,updates:{cli:"0.1.20",plugin:"0.1.20",latest:"0.1.21",available:true}}))).toBeLessThan(65536);
  const rendered=browser(panel(s));expect(rendered.ids["ranked-list"].innerHTML.match(/class="stack provider"/g)).toHaveLength(32);expect(rendered.ids["strategy-list"].innerHTML.match(/data-strategy=/g)).toHaveLength(32);
 }
});
test("stale budget is amber and unknown percentages use em dash",()=>{
 const s=snapshot();s.console!.heartbeatAt=250;const html=panel(s,true,250);expect(html).toContain('name live warn');s.budget!.providers[0].usedPct=null;s.budget!.providers[0].pacePct=null;expect(panel(s)).toContain("Pace marker —");
});
test("rendered live flag survives heartbeat age while current context still gates the send",()=>{
 const b=browser();b.ids.goal.value="fix";b.submit();b.now(900000);
 b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 expect(b.sent.at(-1).action).toBe("terminal.sendText");
});
test("rejected bridge send reports failure and duplicate responses cannot change status",()=>{
 const b=browser();b.strategies[1].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});const command=b.sent.at(-1);b.reply(command,{accepted:false});expect(b.ids.status.textContent).toContain("refused");b.reply(command,{accepted:true});expect(b.ids.status.textContent).toContain("refused");
});
test("prototype names are unknown providers with accessible monogram fallbacks",()=>{
 for(const id of ["__proto__","constructor","toString"]) {expect(displayName(id)).toBe(id);expect(icon(id)).toContain(`aria-label="${id}"`);expect(icon(id)).not.toContain("<path");expect(verdictWords(id)).toBe("Unknown");}
});
test("recently done shows the latest three tasks with executor and age",()=>{
 const s=snapshot();s.tasks=Array.from({length:4},(_,i)=>({id:`t${i}`,state:"done",goal:`completed goal ${i}`,executor:"codex",backend:null,worktree:null,updatedAt:i}));
 const html=panel(s).split('<script type="application/json"')[0];expect(html).not.toContain("completed goal 0");for(const i of [1,2,3])expect(html).toContain(`completed goal ${i}`);expect(html).toContain("Codex · 1m ago");expect(html.indexOf("completed goal 3")).toBeLessThan(html.indexOf("completed goal 2"));
});

test("retry excludes all failed executors in a goal group and hides action when none remain",()=>{
 const s=snapshot();s.tasks=[{id:"a",state:"failed",goal:"same",executor:"agy",backend:null,worktree:null,updatedAt:90},{id:"b",state:"limit",goal:"same",executor:"local",backend:null,worktree:null,updatedAt:80}];
 expect(attentionGroups(s,100)[0].retry?.id).toBe("codex");
 s.budget!.providers.find(p=>p.id==="codex")!.verdict="EXHAUSTED";
 expect(attentionGroups(s,100)[0].retry).toBeNull();
 expect(payload(panel(s)).commands).not.toHaveProperty("attention-0");expect(panel(s)).not.toContain("Retry on");
});
test("unranked available and unknown providers show no quota reset claim",()=>{
 const s=snapshot();s.budget!.providers.push(provider("byteplus","OK",{resetsAt:3700}),provider("unknown","UNKNOWN"));
 const html=browser(panel(s)).ids["unavailable-list"].innerHTML;
 expect(html).toContain("not in the queue");expect(html).not.toContain("back in 1h");expect(html).not.toContain("reset unknown");expect(html).not.toContain("not ranked");
});
for (const [reachable,now,tone,label] of [[true,100,"good","Live ·"],[true,250,"warn","Live ·"],[false,100,"bad","Not connected"]] as const) test(`delegate header shares overview connection indicator ${tone}`,()=>{
 const html=panel(snapshot(),reachable,now);
 const delegate=html.match(/data-page="delegate" hidden>(.*?)<\/main>/s)![1];
 expect(delegate).toContain(`name live ${tone}`);expect(delegate).toContain(label);
 if(reachable)expect(delegate).toMatch(/Live · \d{2}:\d{2}/);
});

test("delegate blocks duplicate submits during context and terminal requests",()=>{
 const b=browser();b.ids.goal.value="fix";b.submit();const count=b.sent.length;
 expect(b.submitButton.disabled).toBe(true);b.submit();expect(b.sent).toHaveLength(count);
 b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});const send=b.sent.at(-1);
 b.submit();expect(b.sent).toHaveLength(count+1);
 b.reply(send,{accepted:false});expect(b.submitButton.disabled).toBe(false);expect(b.ids.goal.value).toBe("fix");b.submit();expect(b.sent).toHaveLength(count+2);
});
for(const phase of ["context","terminal"]) test(`delegate releases pending state on bridge ${phase} failure`,()=>{
 const b=browser();b.ids.goal.value="fix";b.submit();expect(b.submitButton.disabled).toBe(true);
 if(phase==="terminal")b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 b.reply(b.sent.at(-1),null,false);expect(b.submitButton.disabled).toBe(false);expect(b.ids.goal.value).toBe("fix");expect(b.ids.status.textContent).toContain("refused");
 const count=b.sent.length;b.submit();expect(b.sent).toHaveLength(count+1);
});
test("delegate payload includes worktree id when workspace context supplies it",()=>{
 const c={worktreeId:"wt-1",branch:"shared",displayName:"X",terminals:[{id:"term_console"}]};
 expect(decodeCmdLine(delegateLine(c,"fix","")).cmd?.data.worktreeId).toBe("wt-1");
 const b=browser();b.ids.goal.value="fix";b.submit();b.reply(b.sent.at(-1),c);
 expect(decodeCmdLine(b.sent.at(-1).params.text).cmd?.data.worktreeId).toBe("wt-1");
});
for(const field of ["goal","done"]) for(const code of [0x7f,0x80,0x9f]) test(`delegate rejects control ${code} in ${field} visibly`,()=>{
 const b=browser();b.ids.goal.value="fix";b.ids[field].value="bad"+String.fromCharCode(code)+"input";b.submit();
 const last=b.sent.at(-1);if(last.action==="workspace.readContext")b.reply(last,{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 expect(b.sent.some(m=>m.action==="terminal.sendText")).toBe(false);expect(b.ids.status.textContent).toContain("control");expect(b.submitButton.disabled).toBe(false);
});

test("panel picks the worktree console from multiple registrations",()=>{
 const s=snapshot();s.consoles=[s.console!,{...s.console!,handle:"focused"}];const b=browser(panel(s));b.ids.goal.value="fix";b.submit();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"focused"}]});expect(b.sent.at(-1).params.terminalId).toBe("focused");
});
test("strategy view lists summaries and sends a selected name",()=>{
 const b=browser();b.strategies[1].click();b.reply(b.sent.at(-1),{branch:"main",displayName:"Main",terminals:[{id:"term_console"}]});
 expect(decodeCmdLine(b.sent.at(-1).params.text).cmd?.data).toEqual({cmd:"use",strategy:"custom"});expect(b.ids["strategy-list"].innerHTML).toContain("Active");
 const s=snapshot();s.strategies=["default"];expect(panel(s)).toContain('data-view="strategy" data-live');expect(panel(s)).toContain("Build a new strategy with an agent");
});
test("freshness indicator turns stale in place on its thirty-second timer",()=>{
 const b=browser();expect(b.freshness[0].parentElement.className).toContain("good");b.now(221000);b.tick();expect(b.freshness[0].parentElement.className).toContain("muted");expect(b.freshness[0].textContent).toContain("Updated ");
});
test("rendered desktop panel uses Orca's compact typography and control dimensions",()=>{
 const css=panel().match(/<style>(.*?)<\/style>/s)![1];
 const declarations=(selector:string)=>{
  const block=[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(m=>m[1].split(",").includes(selector)).map(m=>m[2]).join(";");
  return Object.fromEntries(block.split(";").map(d=>{const i=d.indexOf(":");return [d.slice(0,i),d.slice(i+1)];}));
 };
 expect(declarations("body")["font-size"]).toBe("12px");expect(declarations("body")["font-family"]).toContain("var(--app-font-family");
 expect(declarations("small")["font-size"]).toBe("11px");expect(declarations(".headline")["font-size"]).toBe("13px");expect(declarations(".percent")["font-size"]).toBe("18px");
 expect(declarations("button")["min-height"]).toBe("28px");expect(declarations("button.primary")["min-height"]).toBe("32px");expect(declarations(".content")["padding"]).toBe("12px");expect(declarations(".meter")["height"]).toBe("6px");expect(declarations(".meter.slim")["height"]).toBe("3px");
});

test("missing-console recovery only types pacer console into the focused first terminal",()=>{
 const b=browser(panel(emptySnapshot()));b.setups[2].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"first"}]});
 expect(b.sent.at(-1).params).toEqual({terminalId:"first",text:"pacer console",enter:false});b.reply(b.sent.at(-1),{accepted:true});expect(b.ids.status.textContent).toContain("Press Enter");
});

test("rendered console liveness includes thirty seconds and excludes thirty-one",()=>{
 expect(payload(panel(snapshot(),true,130)).consoles).toHaveLength(1);
 expect(payload(panel(snapshot(),true,131)).consoles).toHaveLength(0);
});

test("Check again explains an unreachable link without mentioning the console or sending",()=>{
 const b=browser(panel(snapshot(),false));const before=b.sent.length;b.check.click();
 expect(b.ids.status.textContent).toBe("Waiting for pacer serve. Start it, then reopen this panel.");
 expect(b.sent).toHaveLength(before);expect(b.ids["console-hint"].hidden).toBe(true);
});
test("Check again explains a reachable link with no console in the active worktree",()=>{
 const b=browser();b.check.click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"other"}]});
 expect(b.ids.status.textContent).toBe("The pacer console for this worktree is starting. Try again in a few seconds.");expect(b.ids["console-hint"].hidden).toBe(false);
 expect(b.sent.some(m=>m.action==="terminal.sendText")).toBe(false);
});
test("Check again refreshes a reachable console in the active worktree",()=>{
 const b=browser();b.check.click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 expect(decodeCmdLine(b.sent.at(-1).params.text).cmd?.data).toEqual({cmd:"refresh"});
});
test("client renders the snapshot update time and ages freshness without a reload",()=>{
 const s=snapshot();const at=Date.UTC(2026,9,12,10)/1000;s.at=at;s.budget!.generatedAt=at;
 const b=browser(panel(s,true,at));b.now(at*1000);b.tick();
 expect(b.updated.textContent).toBe(new Date(at*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}));expect(b.freshness[0].parentElement.className).toContain("good");
 b.now((at+121)*1000);b.tick();expect(b.updated.textContent).toBe(new Date(at*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}));expect(b.freshness[0].textContent).toContain("Updated ");
});

test("a fresh registration remains usable when a stale duplicate precedes it",()=>{
 const s=snapshot();s.consoles=[{...s.console!,heartbeatAt:69}];
 const b=browser(panel(s));b.strategies[1].click();
 b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 expect(b.sent.at(-1).action).toBe("terminal.sendText");
});

test("strategy builder sends safe brief payload into current worktree and limits input",()=>{
 const b=browser();b.ids["strategy-brief"].value="Protect Claude";b.ids["strategy-from"].value="default";b.ids["strategy-agent"].value="codex";
 b.ids["strategy-send"].click();const context=b.sent.at(-1);b.reply(context,{branch:"main",displayName:"Main",worktreeId:"wt",terminals:[{id:"term_console"}]});
 expect(decodeCmdLine(b.sent.at(-1).params.text).cmd?.data).toEqual({cmd:"strategy-build",agent:"codex",from:"default",brief:"Protect Claude",branch:"main",worktreeId:"wt"});
 b.reply(b.sent.at(-1),{accepted:true});expect(b.ids.status.textContent).toBe("Sent to the pacer console. Watch the new terminal.");
 b.ids["strategy-brief"].value="x".repeat(2001);const count=b.sent.length;b.ids["strategy-send"].click();expect(b.sent).toHaveLength(count);
});
test("strategy summaries escape and every button has nowrap and shrink protection",()=>{
 const s=snapshot();s.strategies=[{name:"default",active:true,summary:'<script>alert("x")</script>',description:""}];
 const html=panel(s), b=browser(html);expect(b.ids["strategy-list"].innerHTML).toContain("&lt;script&gt;");expect(html).toContain("button{white-space:nowrap;flex-shrink:0;");expect(html).toContain('maxlength="2000"');expect(html).not.toContain('<option value="agy"');
});
test("after-session card uses newest unseen saved alert and escapes its text",()=>{
 const s=snapshot();s.alerts=[{key:"strategySaved-new",level:"info",title:'New strategy "new" saved',body:"Codex first",at:100},{key:"strategySaved-older",level:"info",title:'<img onerror="bad">',body:"<script>bad</script>",at:90}];
 const b=browser(panel(s),["strategySaved-new:100"]);expect(b.ids["strategy-after"].hidden).toBe(false);expect(b.ids["strategy-after"].innerHTML).toContain("&lt;img");expect(b.ids["strategy-after"].innerHTML).not.toContain('<script>');
 expect(browser(panel(s),["strategySaved-new:100","strategySaved-older:90"]).ids["strategy-after"].hidden).toBe(true);
});

test("console build alerts show the actual session outcome in the panel",()=>{
 for(const [level,title,body] of [["info","Strategy session opened in a new terminal",""],["error","Strategy session failed","Terminal creation refused <script>"]]){
  const s=snapshot();s.alerts=[{key:"strategy-build",level:level as "info"|"error",title,body,at:100}];
  expect(browser(panel(s)).ids.status.textContent).toBe(title+(body?": "+body:""));
 }
});
test("strategy note includes the information icon and OpenCode has a readable label",()=>{
 const s=snapshot();s.budget!.providers.push({id:"opencode",verdict:"OK",usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false});s.budget!.ranked.push({id:"opencode",verdict:"OK"});
 const b=browser(panel(s));expect(b.ids["ranked-list"].innerHTML).toContain("OpenCode");expect(panel(s)).toContain('aria-label="Information"');
});

test("autoConsole panel starting state and manual fallback",()=>{
 for(const [autoConsole,reachable,starting] of [[true,true,true],[false,true,false],[true,false,false]] as const){
  const html=renderPanel(emptySnapshot(),{nowS:100,transport:"http",reachable,autoConsole});
  expect(html.includes("Starting pacer console in this worktree...")).toBe(starting);
  expect(html.includes('>Start console</button>')).toBe(!starting);
  if(starting){expect(html).toContain("◐");expect(html).toContain("prefers-reduced-motion");}
 }
});

for(const transport of ["bridge","channel"] as const)test(`manual console fallback on ${transport}`,()=>{
 const html=renderPanel(emptySnapshot(),{nowS:100,transport,reachable:true,autoConsole:true});
 expect(html).toContain('>Start console</button>');expect(html).not.toContain("Starting pacer console");
});

for(const [outcome,now] of [[{status:"starting",at:100},114],[{status:"starting",at:100},115],[{status:"gave-up",at:100},101],[{status:"<script>bad</script>",at:100},101]] as const)test(`bounded starting hint ${outcome.status} at ${now}`,()=>{
 const html=renderPanel(emptySnapshot(),{nowS:now,transport:"http",reachable:true,autoConsole:true,autoConsoleOutcome:outcome} as any);
 expect(html.includes('>Start console</button>')).toBe(now!==114);expect(html).not.toContain('<script>bad</script>');
});

test("setup uses live automatic checklist without service typing commands", () => {
 for (const installed of [false,true]) {
  const html=panel({...snapshot(),serviceInstalled:installed},false);
  expect(html).toContain("Setup"); expect(html).toContain("Binary");
  expect(html).toContain("Login service");expect(html).toContain("pacer init");
  expect(html).not.toContain('data-setup="pacer service');
 }
});
test("brief link outages keep a disabled grey overview for 20 seconds before setup", () => {
 const s=snapshot();
 const render=(nowS:number,lastSeenAt?:number)=>renderPanel(s,{nowS,transport:"http",reachable:false,lastSeenAt});
 for(const now of [100,119]) { const html=render(now,100); expect(html).toContain('data-page="overview">');expect(html).toContain("Reconnecting...");expect(html).toContain('pointer-events:none" inert'); }
 expect(render(120,100)).toContain('data-page="setup">'); expect(render(100)).toContain('data-page="setup">');
 expect(renderPanel(s,{nowS:110,transport:"http",reachable:true,lastSeenAt:100})).not.toContain("Reconnecting...");
});

test("all primary views expose polite feedback and forms rely on visible JavaScript validation",()=>{
 const html=panel(); expect(html).not.toMatch(/\srequired(?:\s|>)/);expect(html.match(/data-status role="status" aria-live="polite"/g)).toHaveLength(4);
 const b=browser();b.ids["strategy-brief"].value="";b.ids["strategy-send"].click();expect(b.ids.status.textContent).toContain("Enter a brief");
});
test("all console actions show startup feedback when console is missing, including strategy-build submit",()=>{
 for(const autoConsole of [true,false]) {
  const html=renderPanel(emptySnapshot(),{nowS:100,reachable:true,transport:"http",autoConsole});const b=browser(html);
  const expected=autoConsole?"The pacer console for this worktree is starting. Try again in a few seconds.":"Start the console first.";
  b.submit();expect(b.ids.status.textContent).toBe(expected);
  b.ids["strategy-send"].click();expect(b.ids.status.textContent).toBe(expected);
  b.strategies[0].click();expect(b.ids.status.textContent).toBe(expected);b.views[0].click();expect(b.ids.status.textContent).toBe(expected);
 }
 const b=browser();b.strategies[1].click();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_new",title:"pacer"}]});expect(b.ids.status.textContent).toBe("Reopen the panel to connect to the new console.");
});

test("sandboxed panel action buttons use click handlers and never depend on form submit",()=>{
 const html=panel();expect(html).not.toContain('type="submit"');expect(html).not.toContain('<form');const b=browser(html);
 expect(b.ids["delegate-form"].handlers.submit).toBeUndefined();expect(b.ids["strategy-form"].handlers.submit).toBeUndefined();
 expect(b.ids["delegate-send"].handlers.click).toBeDefined();expect(b.ids["strategy-send"].handlers.click).toBeDefined();
 b.ids.goal.value="fix";b.ids.done.handlers.keydown({key:"Enter",preventDefault(){}});b.reply(b.sent.at(-1),{branch:"main",displayName:"Main",terminals:[{id:"term_console"}]});expect(b.sent.at(-1).action).toBe("terminal.sendText");
});
test("feedback appears below each primary action and console footnote follows focused workspace membership",()=>{
 const s=snapshot();s.consoles=[{...s.console!,handle:"other"},s.console!];const b=browser(panel(s));
 b.reply(b.sent.at(-1),{branch:"focus",displayName:"Focused",terminals:[{id:"term_console"}]});expect(b.connection.textContent).toBe("console connected in Focused");
 b.check.click();b.reply(b.sent.at(-1),{branch:"empty",displayName:"Empty",terminals:[{id:"neither"}]});expect(b.connection.textContent).toBe("console not connected in Empty");
 expect(b.feedback.every(n=>n.textContent==="The pacer console for this worktree is starting. Try again in a few seconds.")).toBe(true);
});

test("overview feedback stays in the main action bar when a retry button is present",()=>{
 const s=snapshot();s.tasks=[{id:"failed",state:"failed",goal:"fix",executor:"claude-code",backend:null,worktree:null,updatedAt:100}];
 const html=panel(s);const overview=html.match(/<main[^>]*data-page="overview"[^>]*>([\s\S]*?)<\/main>/)![1];
 expect(overview).toContain('data-command="attention-0"');
 expect(overview.indexOf('data-status')).toBeGreaterThan(overview.indexOf('class="actionbar"'));
 for(const view of ["setup","delegate","strategy"]){const body=html.match(new RegExp(`<main[^>]*data-page="${view}"[^>]*>([\\s\\S]*?)<\\/main>`))![1];expect(body.indexOf('data-status')).toBeGreaterThan(body.indexOf('class="actionbar"'));}
});

test("panel action is immediately pending and restores on refused send",()=>{
 const b=browser();b.ids.goal.value="fix";b.submit();
 expect(b.submitButton.disabled).toBe(true);expect(b.submitButton.innerHTML).toContain("Delegating");
 b.reply(b.sent.at(-1),null,false);expect(b.submitButton.disabled).toBe(false);
 expect(b.submitButton.innerHTML).not.toContain("Delegating");
});

for (const level of ["off", "important", "all"] as const) test(`notification preference ${level} renders from worker data`, () => {
 const html=renderPanel(snapshot(),{nowS:100,reachable:true,transport:"bridge",notifications:level});
 expect(html).toContain(`value="${level}" selected`);
 expect(payload(html).notifications).toBe(level);
});
test("generated panel script uses only panel-callable host actions",()=>{
 const script=panel().match(/<script>\n([\s\S]*?)<\/script>/)![1];
 const actions=[...script.matchAll(/(?:request|call)\("([a-z]+\.[A-Za-z]+)"/g)].map(m=>m[1]);
 expect(actions.length).toBeGreaterThan(0);
 expect(actions.every(a=>["workspace.readContext","terminal.sendText","notifications.show"].includes(a!))).toBe(true);
 expect(script).not.toMatch(/(?:settings|storage)\./);
});
test("notification change sends console command and stays pending until worker confirms",()=>{
 const b=browser(), control=b.ids["notification-level"];
 control.innerHTML='<option value="important">Important</option>';control.value="off";
 b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 control.handlers.change!();expect(control.disabled).toBe(true);expect(control.innerHTML).toContain("Important");
 b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 const send=b.sent.at(-1);expect(send.action).toBe("terminal.sendText");
 expect(decodeCmdLine(send.params.text).cmd?.data).toEqual({cmd:"notify-level",level:"off"});
 b.reply(send,{accepted:true});expect(control.disabled).toBe(true);expect(b.ids.status.textContent).toContain("console");
});
test("notification send refusal restores select and reports failure",()=>{
 const b=browser(), control=b.ids["notification-level"];control.value="all";
 control.handlers.change!();b.reply(b.sent.at(-1),{branch:"x",displayName:"X",terminals:[{id:"term_console"}]});
 b.reply(b.sent.at(-1),{accepted:false});expect(control.disabled).toBe(false);expect(b.ids.status.textContent).toContain("refused");
});

test("running and needs-attention cards show muted escaped placement",()=>{
 const s=snapshot();s.tasks=[{id:"run",state:"running",goal:"running",executor:"codex",backend:"orca",worktree:"/new/path",updatedAt:100,runnerAlive:true,placement:{mode:"new",why:"agent: <risky>"}},{id:"fail",state:"failed",goal:"failed",executor:"codex",backend:"orca",worktree:"/repo",updatedAt:100,placement:{mode:"current",why:"read-only kind"}}];
 const html=panel(s);expect(html).toContain('<small class="muted">new worktree /new/path (agent: &lt;risky&gt;)</small>');expect(html).toContain('<small class="muted">current worktree (read-only kind)</small>');
});

test("focus command validation and cards require a live terminal",()=>{
 const {parseCmd}=require("../src/link/envelope");
 expect(parseCmd({v:1,type:"cmd",data:{cmd:"focus",taskId:"t_123"}})?.data).toEqual({cmd:"focus",taskId:"t_123"});
 for(const taskId of [undefined,"", "../bad",123])expect(parseCmd({v:1,type:"cmd",data:{cmd:"focus",taskId}})).toBeNull();
 const s=snapshot();s.tasks=[{id:"running_1",state:"running",goal:"run",executor:"codex",backend:"orca",worktree:null,updatedAt:100,terminalPresent:true},{id:"failed_1",state:"failed",goal:"fail",executor:"codex",backend:"orca",worktree:null,updatedAt:99,terminalPresent:true},{id:"direct_1",state:"running",goal:"direct",executor:"codex",backend:"direct",worktree:null,updatedAt:98}];
 const html=panel(s),data=payload(html);expect(html).toContain('role="button" tabindex="0" data-focus="focus-running_1"');expect(html).toContain('data-focus="focus-failed_1"');expect(html).not.toContain('data-focus="focus-direct_1"');
 expect(data.commands['focus-running_1']).toEqual({cmd:"focus",taskId:"running_1"});expect(html).toContain('["Enter"," "].includes(event.key)');expect(html).toContain('event.target.closest("button,input,select,a")');expect(html).not.toContain('<form');
 s.tasks[1].resolved="reviewed";expect(attentionGroups(s,100)).toEqual([]);
});
test("focus card mouse and keyboard actions keep child controls and send focus commands",()=>{
 const s=snapshot();s.tasks=[{id:"run_1",state:"running",goal:"run",executor:"codex",backend:"orca",worktree:null,updatedAt:100,terminalPresent:true}];
 for(const key of [null,"Enter"," "]){const b=browser(panel(s)),card=b.focusCards[0];card.innerHTML='<button>Retry</button>';
  const count=b.sent.length;card.handlers.click({target:{closest:()=>({})}});expect(b.sent.length).toBe(count);
  let prevented=false;if(key)card.handlers.keydown({target:card,key,preventDefault:()=>{prevented=true;}});else card.handlers.click({target:{closest:()=>null}});
  if(key)expect(prevented).toBe(true);expect(card.innerHTML).toBe('<button>Retry</button>');
  const context=b.sent.at(-1);b.reply(context,{branch:"main",displayName:"Main",terminals:[{id:"term_console"}]});
  const command=b.sent.at(-1);expect(command.action).toBe("terminal.sendText");expect(command.params.text).toContain('"cmd":"focus","taskId":"run_1"');
 }
});

test("Check now sends check-setup through the focused console",()=>{
 const setup={checkedAt:100,complete:false,items:[{id:"link",title:"Link",required:true,status:"pending" as const,command:"pacer init"}]};
 const html=renderPanel(snapshot(),{nowS:100,transport:"http",reachable:true,setup});
 expect(html).toContain('data-command="checkSetup"');expect(payload(html).commands.checkSetup).toEqual({cmd:"check-setup"});
 expect(html).not.toContain("data-connect-agents");
 const b=browser(html),button=b.commandButtons.find(n=>n.dataset.command==="checkSetup")!;
 b.reply(b.sent.at(-1),{branch:"main",displayName:"Main",terminals:[{id:"term_console"}]});
 button.click();b.reply(b.sent.at(-1),{branch:"main",displayName:"Main",terminals:[{id:"term_console"}]});
 expect(decodeCmdLine(b.sent.at(-1).params.text).cmd?.data).toEqual({cmd:"check-setup"});
 b.reply(b.sent.at(-1),{accepted:true});expect(button.disabled).toBe(false);
 button.click();b.reply(b.sent.at(-1),{branch:"other",displayName:"Other",terminals:[{id:"elsewhere"}]});expect(button.hidden).toBe(true);
 expect(b.setupAges[0].textContent).toBe("Checked 0 s ago");b.now(108000);b.tick();expect(b.setupAges[0].textContent).toBe("Checked 8 s ago");
});

test("operations keeps setup and updates inside content below its header",()=>{
 const html=renderPanel(snapshot(),{nowS:100,reachable:true,transport:"http",setup:{checkedAt:100,complete:true,items:[]},updates:{plugin:"0.1.22",cli:"0.1.22",latest:"0.1.22",available:false}});
 const body=html.match(/data-page="overview"[^>]*>([\s\S]*?)<\/main>/)![1];
 expect(body.indexOf('<header>')).toBeLessThan(body.indexOf('Setup ✓'));
 expect(body.indexOf('<header>')).toBeLessThan(body.indexOf('data-updates'));
 expect(body).toContain('pacer 0.1.22 · up to date');
 expect(panel()).not.toContain('data-updates');
});
test("missing console has one reason and a compact disabled action row",()=>{
 const s=snapshot();s.console=null;
 const html=renderPanel(s,{nowS:100,reachable:true,transport:"http",setup:{checkedAt:100,complete:true,items:[]}});
 const body=html.match(/data-page="overview"[^>]*>([\s\S]*?)<\/main>/)![1];
 expect(body.match(/The pacer console for this worktree is starting\. Try again in a few seconds\./g)).toHaveLength(1);
 expect(body).not.toContain('Starting pacer console in this worktree...');
 expect(body).toMatch(/data-live disabled>Delegate a task<\/button><button/);
 expect(body).not.toMatch(/<\/button><small/);
});
test("setup shows one primary init block and required rows before optional rows",()=>{
 const setup={checkedAt:100,complete:false,items:[
  {id:"live",title:"Live plugin",required:false,status:"pending" as const,command:"pacer init"},
  {id:"service",title:"Login service",required:true,status:"pending" as const,command:"pacer init"},
  {id:"agent:codex",title:"Codex",required:false,status:"pending" as const,detail:"Optional · not connected",command:"pacer init"},
 ]};
 const html=renderPanel(emptySnapshot(),{nowS:100,reachable:false,transport:"http",setup});
 const body=html.match(/data-page="setup"[^>]*>([\s\S]*?)<\/main>/)![1];
 expect(body.match(/<code[^>]*>pacer init<\/code>/g)).toHaveLength(1);
 expect(body).toContain('Finish setup in a terminal:');
 expect(body.indexOf('Login service')).toBeLessThan(body.indexOf('Optional</h2>'));
 expect(body.indexOf('Optional</h2>')).toBeLessThan(body.indexOf('Live plugin'));
 expect(body).toContain('Not running yet');expect(body).toContain('Not connected');
 expect(body).not.toContain('>pending');expect(body).not.toContain('Optional · not connected');
});
