import { pendingClient } from "./pending";
/** No network or navigation: every host request uses the sandboxed panel bridge. */
export const client=`
const embedded=JSON.parse(document.getElementById("pacer-actions").textContent);
function unpack(value) {
 if(Array.isArray(value)) return value.map(unpack);
 if(value && typeof value==="object") return Object.hasOwn(value,"$runs") ? value.$runs.map(([c,n])=>c.repeat(n)).join("") : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unpack(v)]));
 return value;
}
const data=unpack(embedded.encoded ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(embedded.encoded), c=>c.charCodeAt(0)))) : embedded);
const providerNames={"claude-code":"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",byteplus:"BytePlus",local:"Local model",opencode:"OpenCode"};
for (const p of [...data.rows,...data.muted]) p.name=Object.hasOwn(providerNames,p.id) ? providerNames[p.id] : p.id;
data.executors=data.rows.map(p=>p.id);
const statusNode=document.getElementById("status");
const status={ get textContent() { return statusNode.textContent; }, set textContent(value) {
 statusNode.textContent=value;
 for (const el of document.querySelectorAll("[data-status]")) el.textContent=value;
} };
if(data.buildAlert) status.textContent=data.buildAlert.title+(data.buildAlert.body?": "+data.buildAlert.body:"");
const sentAt=[], pending=new Map();
let sequence=0, context=null, sending=false;
const submitButton=document.getElementById("delegate-send");
function finishSending() { sending=false; submitButton.disabled=false; }
function show(view) {
  if(view==="strategy" && savedStrategy) {try {sessionStorage.setItem("pacer-seen-strategies",JSON.stringify([...seenStrategies,savedStrategy.key+":"+savedStrategy.at].slice(-100)));}catch {}}
  for (const el of document.querySelectorAll("[data-page]")) el.hidden=el.dataset.page!==view;
  status.textContent="";
}
function live(workspace) {
  const available=data.consoles.filter(c=>c.handle && c.live);
  const selected=workspace===undefined ? available[0] : available.find(c=>Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>t.id===c.handle));
  if (selected) { if(workspace!==undefined) data.handle=selected.handle; document.getElementById("console-hint").hidden=true; return true; }
  status.textContent=workspace!==undefined && Array.isArray(workspace?.terminals) && workspace.terminals.some(t=>typeof t.title==="string" && /^pacer(?: console)?$/.test(t.title)) ? "Reopen the panel to connect to the new console." : data.autoConsole ? "The pacer console for this worktree is starting. Try again in a few seconds." : "Start the console first.";
  document.getElementById("console-hint").hidden=false;
  return false;
}
function updateFreshness() {
  for(const el of document.querySelectorAll("[data-age-at]"))el.textContent=Math.max(0,Math.floor(Date.now()/1000-Number(el.dataset.ageAt)))+"s ago";
  for(const el of document.querySelectorAll("[data-updated]")) el.textContent=data.updatedAt ? new Date(data.updatedAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}) : "—";
  const old=Date.now()/1000-data.snapshotAt>120;
  for(const el of document.querySelectorAll("[data-freshness]")) {
    // Unchanged data is not re-rendered (Orca reloads the panel on every write), so age alone is not a fault: show it neutrally.
    el.parentElement.className="name live " + (!data.reachable ? "bad" : old ? "muted" : "good");
    el.textContent=!data.reachable ? "Not connected" : (old ? "Updated " : "Live · ") + new Date(data.snapshotAt*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false});
  }
}
updateFreshness(); setInterval(()=>{updateFreshness();recoverActions();},30000);
function request(action, params, purpose, after, onFailure) {
  const now=Date.now();
  while (sentAt.length && now - sentAt[0] >= 10000) sentAt.shift();
  if (sentAt.length >= 30) { status.textContent="Please wait before sending another command."; return false; }
  const requestId="pacer-" + (++sequence), message={type:"orca-panel-action",requestId,action,params};
  if (new TextEncoder().encode(JSON.stringify(message)).length > 65536) { status.textContent="Panel message exceeds 64 KiB."; return false; }
  pending.set(requestId,{purpose,after,onFailure}); sentAt.push(now);
  window.parent.postMessage(message,"*"); return true;
}
function readContext(after, onFailure) { return request("workspace.readContext",{},"context",after,onFailure); }
function sendCommand(command, after, onFailure, workspace) {
  const fail=()=>{ if(onFailure) onFailure(); return false; };
  if (Object.values(command).some(value=>typeof value==="string" && /[\\x7f-\\x9f]/.test(value))) { status.textContent="Input contains unsupported control characters."; return fail(); }
  if (!live()) return fail();
  const send=value=>{
    updateContext(value);
    if (!live(value)) return fail();
    const text=": pacer '" + JSON.stringify({v:1,type:"cmd",data:command}).replace(/'/g,"\\\\u0027") + "'";
    if (text.length > 4096) { status.textContent="pacer command line exceeds 4096 characters. Shorten your brief and try again."; return fail(); }
    if (!request("terminal.sendText",{terminalId:data.handle,text,enter:true},"console",after,onFailure)) return fail();
    return true;
  };
  if (workspace!==undefined) return send(workspace);
  if (!readContext(send,onFailure)) return fail();
  return true;
}
${pendingClient}
function updateContext(value) {
  context=value && typeof value.branch==="string" && typeof value.displayName==="string" ? value : null;
  for (const el of document.querySelectorAll("[data-worktree]")) el.textContent=context ? context.displayName : "—";
  document.getElementById("worktree-branch").textContent=context ? context.branch : "—";
  const connected=context && data.consoles.some(c=>c.live && Array.isArray(context.terminals) && context.terminals.some(t=>t.id===c.handle));
  for (const el of document.querySelectorAll("[data-console-connection]")) el.textContent=context ? (connected ? "console connected in " : "console not connected in ") + context.displayName : "console not connected";
}
// Escape data before creating local provider rows; the same nodes populate the radio list.
function h(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
for (const el of document.querySelectorAll("[data-text]")) el.innerHTML=h(data.text[el.dataset.text]);
const strategyEntries=data.strategies.map(e=>typeof e==="string"?{name:e,summary:"",active:e===data.strategy}:e);
document.getElementById("strategy-list").innerHTML=strategyEntries.map((e,i)=>'<button type="button" class="row" data-strategy="'+i+'"'+(e.active?' disabled title="This strategy is already active."':'')+'><span>'+(e.active?'✓':'')+'</span><span class="stack grow"><strong>'+h(e.name)+'</strong><small>'+h(e.summary)+'</small></span>'+(e.active?'<span class="pill">Active</span>':'')+'</button>').join("");
document.getElementById("strategy-from").innerHTML=strategyEntries.map(e=>'<option value="'+h(e.name)+'"'+(e.active?' selected':'')+'>'+h(e.name)+'</option>').join("");
for(const b of document.querySelectorAll("[data-strategy]")) {const entry=strategyEntries[Number(b.dataset.strategy)];if(!entry)continue;const command={cmd:"use",strategy:entry.name};bindAction(b,command);b.addEventListener("click",()=>pendingSend(b,command));}
let seenStrategies=[];
try { seenStrategies=JSON.parse(sessionStorage.getItem("pacer-seen-strategies") || "[]"); if(!Array.isArray(seenStrategies))seenStrategies=[]; } catch {}
const savedStrategy=(data.savedAlerts || []).find(a=>!seenStrategies.includes(a.key+":"+a.at));
const afterSession=document.getElementById("strategy-after");
if(savedStrategy) {
 afterSession.hidden=false;
 afterSession.innerHTML='<h2>After the session</h2><div class="card row strategy-saved"><span class="good">✓</span><div class="stack grow"><strong>'+h(savedStrategy.title)+'</strong><small>'+h(savedStrategy.body)+'</small></div><button type="button" data-saved-switch>Switch</button></div>';
 document.querySelector("[data-saved-switch]")?.addEventListener("click",event=>pendingSend(event.currentTarget,{cmd:"use",strategy:savedStrategy.key.slice("strategySaved-".length)}));
}
document.getElementById("ranked-order").innerHTML=h(data.rows.map(p=>p.name).join(" → ") || "No executor available");
function icon(p,size) {
  return Object.hasOwn(data.paths,p.id) ? '<svg role="img" aria-label="'+h(p.name)+'" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="currentColor"><path d="'+data.paths[p.id]+'"></path></svg>' : '<span class="monogram" role="img" aria-label="'+h(p.name)+'" style="width:'+size+'px;height:'+size+'px">'+h(p.id==="codex" ? "Cx" : p.id.slice(0,2))+'</span>';
}
function meter(p) {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct===null?null:Math.max(0,Math.min(100,p.pacePct));
 return '<div class="meter slim '+p.tone+'" role="progressbar" aria-label="'+h(p.name)+' usage" aria-valuenow="'+used+'" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:'+used+'%"></div>'+(pace===null?'':'<div class="pace" style="left:'+pace+'%"></div>')+'</div>';
}
const rankedList=document.getElementById("ranked-list"), mutedList=document.getElementById("unavailable-list"), options=document.getElementById("executor-options");
rankedList.innerHTML=data.rows.map((p,i)=>'<div class="stack provider"><div class="row"><span class="rank">'+(i+1)+'</span><div class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></div><span class="pill '+p.tone+'">'+h(p.words)+'</span><button type="button" data-executor-action="'+i+'">Block</button></div>'+meter(p)+'</div>').join("") || '<div class="provider muted">No executor available yet.</div>';
mutedList.innerHTML=data.muted.map((p,i)=>'<div class="row"><span class="name">'+icon(p,13)+h(p.name)+'</span><span>'+h(p.detail)+'</span><button type="button" data-executor-action="'+(data.rows.length+i)+'">'+(p.blocked?'Unblock':'Block')+'</button></div>').join("");
options.innerHTML=data.rows.map((p,i)=>'<label class="radio"><input type="radio" name="executor" value="'+i+'"><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span><span class="pill '+p.tone+'">'+h(p.words)+'</span></label>').join("") + data.muted.filter(p=>p.verdict==="EXHAUSTED").map(p=>'<label class="radio"><input type="radio" name="executor" value="unavailable" disabled><span class="stack grow"><span class="name">'+icon(p,14)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span></label>').join("");
for(const b of document.querySelectorAll("[data-executor-action]")) {
 const provider=[...data.rows,...data.muted][Number(b.dataset.executorAction)];if(provider)bindAction(b,{cmd:provider.blocked?"unblock":"block",executor:provider.id});
 b.addEventListener("click",()=>{
 const p=[...data.rows,...data.muted][Number(b.dataset.executorAction)];
 if(p && /^[a-z0-9-]{1,64}$/.test(p.id))pendingSend(b,{cmd:p.blocked?"unblock":"block",executor:p.id});
});}
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", ()=>{
  if (["delegate","strategy"].includes(b.dataset.view)) {
    if (!live()) return;
    readContext(value=>{ updateContext(value); if(!live(value)) return; show(b.dataset.view); document.getElementById(b.dataset.view==="delegate" ? "goal" : "strategy-brief").focus(); });
  } else show(b.dataset.view);
});
for(const card of document.querySelectorAll("[data-focus]")) {
 const command=data.commands[card.dataset.focus];if(!command)continue;
 bindAction(card,command);
 card.addEventListener("click",event=>{if(event.target.closest("button,input,select,a"))return;pendingSend(card,command);});
 card.addEventListener("keydown",event=>{if(event.target!==card || !["Enter"," "].includes(event.key))return;event.preventDefault();pendingSend(card,command);});
}
for (const b of document.querySelectorAll("[data-command]")) {
 if(data.commands[b.dataset.command])bindAction(b,data.commands[b.dataset.command]);
 b.addEventListener("click", ()=>{
  const command=data.commands[b.dataset.command];
  if (command) pendingSend(b,command); else status.textContent="Reopen the panel to load this action.";
});
}
for (const b of document.querySelectorAll("[data-setup]")) {bindAction(b,{cmd:"type",text:b.dataset.setup});b.addEventListener("click", ()=>{
  const key=beginAction(b,{cmd:"type",text:b.dataset.setup});if(!key)return;
  readContext(value=>{
    updateContext(value);
    const terminal=context && Array.isArray(context.terminals) && context.terminals[0];
    if (!terminal || typeof terminal.id!=="string") { status.textContent="Open a terminal in this worktree first"; restoreAction(key);return; }
    request("terminal.sendText",{terminalId:terminal.id,text:b.dataset.setup,enter:false},"setup",()=>restoreAction(key),()=>restoreAction(key));
  },()=>restoreAction(key));
});}
for (const b of document.querySelectorAll("[data-connect-agents]")) b.addEventListener("click", ()=>{
 b.disabled=true;
 readContext(value=>{
  const terminal=value?.terminals?.find(t=>t.id===data.setupTerminal);
  if(!terminal){b.disabled=false;status.textContent="Opening a terminal… Reopen the panel shortly.";return;}
  request("terminal.sendText",{terminalId:terminal.id,text:data.setupCommand || "pacer setup --yes",enter:true},"connect",()=>{status.textContent="Connecting your agents…";},()=>{b.disabled=false;});
 },()=>{b.disabled=false;});
});
for (const b of document.querySelectorAll("[data-bootstrap-retry]")) b.addEventListener("click", ()=>{
 show("setup"); status.textContent="pacer will retry automatically. Reopen the panel shortly.";
});
for (const b of document.querySelectorAll("[data-check]")) b.addEventListener("click", ()=>{
  if (!data.reachable) {
    status.textContent="Waiting for pacer serve. Start it, then reopen this panel.";
    document.getElementById("console-hint").hidden=true;
    return;
  }
  pendingSend(b,{cmd:"refresh"});
});
document.getElementById("delegate-send").addEventListener("click", ()=>{
  if (sending) { status.textContent="A command is already being sent. Please wait."; return; }
  if (!live()) return;
  const goal=document.getElementById("goal").value, acceptance=document.getElementById("done").value;
  const selected=document.querySelector('input[name="executor"]:checked');
  if (!goal.trim()) { status.textContent="What should be done is required."; return; }
  if (goal.length > 2000 || acceptance.length > 500) { status.textContent="Goal must be at most 2000 characters; Done when at most 500."; return; }
  if (!selected || selected.disabled || selected.value && (!data.executors[Number(selected.value)] || !/^[a-z0-9-]{1,64}$/.test(data.executors[Number(selected.value)]))) { status.textContent="Choose an available executor."; return; }
  const command={cmd:"delegate",goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})};
  const action=beginAction(submitButton,command);if(!action)return;
  sending=true;
  const failDelegate=()=>{restoreAction(action);finishSending();};
  if (!readContext(value=>{
    updateContext(value);
    if (!context || !context.branch) { status.textContent="Focus a worktree first."; failDelegate(); return; }
    if (!sendCommand({cmd:"delegate",branch:context.branch,displayName:context.displayName,...(typeof context.worktreeId==="string" && context.worktreeId ? {worktreeId:context.worktreeId} : {}),goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})}, ()=>{
      document.getElementById("goal").value="";
      document.getElementById("done").value="";
      document.querySelector('input[name="executor"][value=""]').checked=true;
      sending=false; show("overview");
      status.textContent="Sent. The task id appears in the pacer console.";
    }, failDelegate, value)) failDelegate();
  }, failDelegate)) failDelegate();
});
document.getElementById("strategy-send").addEventListener("click", ()=>{ if(sending){status.textContent="A command is already being sent. Please wait.";return;} if(!live())return;
 const brief=document.getElementById("strategy-brief").value, from=document.getElementById("strategy-from").value, agent=document.getElementById("strategy-agent").value;
 if(!brief.trim() || brief.length>2000 || !["claude-code","codex"].includes(agent)) {status.textContent="Enter a brief of at most 2000 characters and choose a configured agent.";return;}
 const button=document.getElementById("strategy-send");const action=beginAction(button,{cmd:"strategy-build",agent,from,brief});if(!action)return;sending=true;
 const finish=()=>{sending=false;restoreAction(action);};
 if(!readContext(value=>{updateContext(value);if(!context || !context.branch){status.textContent="Focus a worktree first.";finish();return;}
 sendCommand({cmd:"strategy-build",agent,from,brief,branch:context.branch,...(context.worktreeId?{worktreeId:context.worktreeId}:{})},()=>{sending=false;status.textContent="Sent to the pacer console. Watch the new terminal.";},finish,value);
 },finish))finish();
});
document.getElementById("done").addEventListener("keydown", event=>{
 if(event.key==="Enter") {event.preventDefault();document.getElementById("delegate-send").click();}
});
window.addEventListener("message", event=>{
  const r=event.data;
  if (event.source!==window.parent || !r || r.type!=="orca-panel-action-result" || !pending.has(r.requestId)) return;
  const item=pending.get(r.requestId); pending.delete(r.requestId);
  if (!r.ok) { status.textContent=typeof r.error==="string" ? r.error : "Orca refused this request."; if (item.onFailure) item.onFailure(); return; }
  if (item.purpose==="context") { updateContext(r.value); if (item.after) item.after(r.value); return; }
  const accepted=r.value && r.value.accepted;
  status.textContent=accepted ? item.purpose==="setup" ? "Typed into your terminal. Press Enter to run it." : "Sent to pacer console" : "Orca refused to type into the terminal.";
  if (accepted && item.after) item.after(r.value);
  if (!accepted && item.onFailure) item.onFailure();
});
for(const a of Object.values(actionStates)) {
 if(a.action?.cmd==="delegate")bindAction(submitButton,a.action);
 if(a.action?.cmd==="strategy-build")bindAction(document.getElementById("strategy-send"),a.action);
}
const notificationControl=document.getElementById("notification-level");
if(notificationControl){
 for(const a of Object.values(actionStates))if(a.action?.cmd==="notify-level")bindAction(notificationControl,a.action);
 notificationControl.addEventListener("change",()=>{
  const level=notificationControl.value;if(!["off","important","all"].includes(level))return;
  pendingSend(notificationControl,{cmd:"notify-level",level},()=>{status.textContent="Sent to pacer console. Saving notification preference...";});
 });
}
recoverActions();
try {const saved=Number(sessionStorage.getItem("pacer-panel-scroll"));if(Number.isFinite(saved)&&saved>=0)window.scrollTo?.(0,saved);}catch{}
window.addEventListener("scroll",()=>{try{sessionStorage.setItem("pacer-panel-scroll",String(window.scrollY));}catch{}},{passive:true});
readContext(value=>{ live(value); });
`;
