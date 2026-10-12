/** No network or navigation: every host request uses the sandboxed panel bridge. */
export const client = `
const embedded = JSON.parse(document.getElementById("pacer-actions").textContent);
const data = embedded.encoded ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(embedded.encoded), c=>c.charCodeAt(0)))) : embedded;
const providerNames = {"claude-code":"Claude",codex:"Codex",cursor:"Cursor",agy:"Antigravity",byteplus:"BytePlus",local:"Local model"};
for (const p of [...data.rows,...data.muted]) p.name = Object.hasOwn(providerNames,p.id) ? providerNames[p.id] : p.id;
data.executors = data.rows.map(p=>p.id);
const status = document.getElementById("status");
const sentAt = [], pending = new Map();
let sequence = 0, context = null;
function show(view) {
  for (const el of document.querySelectorAll("[data-page]")) el.hidden = el.dataset.page !== view;
  status.textContent = "";
}
function live() {
  if (data.handle && Date.now() <= data.expires) return true;
  for (const b of document.querySelectorAll("[data-command],[data-live]")) b.disabled = true;
  status.textContent = "Console heartbeat expired. Reopen this panel to refresh.";
  return false;
}
function request(action, params, purpose, after) {
  const now = Date.now();
  while (sentAt.length && now - sentAt[0] >= 10000) sentAt.shift();
  if (sentAt.length >= 30) { status.textContent = "Please wait before sending another command."; return false; }
  const requestId = "pacer-" + (++sequence), message = {type:"orca-panel-action",requestId,action,params};
  if (new TextEncoder().encode(JSON.stringify(message)).length > 65536) { status.textContent = "Panel message exceeds 64 KiB."; return false; }
  pending.set(requestId,{purpose,after}); sentAt.push(now);
  window.parent.postMessage(message,"*"); return true;
}
function readContext(after) { return request("workspace.readContext",{},"context",after); }
function sendCommand(command, after) {
  if (!live()) return false;
  const text = ": pacer '" + JSON.stringify({v:1,type:"cmd",data:command}).replace(/'/g,"\\\\u0027") + "'";
  if (text.length > 4096) { status.textContent = "pacer command line exceeds 4096 characters. Shorten your brief and try again."; return false; }
  return request("terminal.sendText",{terminalId:data.handle,text,enter:true},"console",after);
}
function updateContext(value) {
  context = value && typeof value.branch === "string" && typeof value.displayName === "string" ? value : null;
  for (const el of document.querySelectorAll("[data-worktree]")) el.textContent = context ? context.displayName : "—";
  document.getElementById("worktree-branch").textContent = context ? context.branch : "—";
}
// Escape data before creating local provider rows; the same nodes populate the radio list.
function h(value) { return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
for (const el of document.querySelectorAll("[data-text]")) el.innerHTML = h(data.text[el.dataset.text]);
document.getElementById("ranked-order").innerHTML = h(data.rows.map(p=>p.name).join(" → ") || "No executor available");
function icon(p,size) {
  return Object.hasOwn(data.paths,p.id) ? '<svg role="img" aria-label="'+h(p.name)+'" width="'+size+'" height="'+size+'" viewBox="0 0 24 24" fill="currentColor"><path d="'+data.paths[p.id]+'"></path></svg>' : '<span class="monogram" role="img" aria-label="'+h(p.name)+'" style="width:'+size+'px;height:'+size+'px">'+h(p.id === "codex" ? "Cx" : p.id.slice(0,2))+'</span>';
}
function meter(p) {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct===null?null:Math.max(0,Math.min(100,p.pacePct));
 return '<div class="meter slim '+p.tone+'" role="progressbar" aria-label="'+h(p.name)+' usage" aria-valuenow="'+used+'" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:'+used+'%"></div>'+(pace===null?'':'<div class="pace" style="left:'+pace+'%"></div>')+'</div>';
}
const rankedList = document.getElementById("ranked-list"), mutedList = document.getElementById("unavailable-list"), options = document.getElementById("executor-options");
rankedList.innerHTML = data.rows.map((p,i) => '<div class="stack provider"><div class="row"><span class="rank">'+(i+1)+'</span><div class="stack grow"><span class="name">'+icon(p,16)+h(p.name)+'</span><small>'+h(p.detail)+'</small></div><span class="pill '+p.tone+'">'+h(p.words)+'</span></div>'+meter(p)+'</div>').join("") || '<div class="provider muted">No executor available yet.</div>';
mutedList.innerHTML = data.muted.map(p=>'<div class="row"><span class="name">'+icon(p,13)+h(p.name)+'</span><span>'+h(p.detail)+'</span></div>').join("");
options.innerHTML = data.rows.map((p,i)=>'<label class="radio"><input type="radio" name="executor" value="'+i+'"><span class="stack grow"><span class="name">'+icon(p,16)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span><span class="pill '+p.tone+'">'+h(p.words)+'</span></label>').join("") + data.muted.filter(p=>p.verdict === "EXHAUSTED").map(p=>'<label class="radio"><input type="radio" name="executor" value="unavailable" disabled><span class="stack grow"><span class="name">'+icon(p,16)+h(p.name)+'</span><small>'+h(p.detail)+'</small></span></label>').join("");
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => {
  if (b.dataset.view === "delegate") {
    if (!live()) return;
    readContext(value => { updateContext(value); show("delegate"); document.getElementById("goal").focus(); });
  } else show(b.dataset.view);
});
for (const b of document.querySelectorAll("[data-command]")) b.addEventListener("click", () => {
  const command = data.commands[b.dataset.command];
  if (command) sendCommand(command);
});
for (const b of document.querySelectorAll("[data-setup]")) b.addEventListener("click", () => {
  readContext(value => {
    updateContext(value);
    const terminal = context && Array.isArray(context.terminals) && context.terminals[0];
    if (!terminal || typeof terminal.id !== "string") { status.textContent = "Open a terminal in this worktree first"; return; }
    request("terminal.sendText",{terminalId:terminal.id,text:b.dataset.setup,enter:false},"setup");
  });
});
for (const b of document.querySelectorAll("[data-check]")) b.addEventListener("click", () => {
  if (data.handle && Date.now() <= data.expires) sendCommand({cmd:"refresh"});
  else status.textContent = "Reopen this panel to check the latest connection and budget.";
});
document.getElementById("delegate-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!live()) return;
  const goal = document.getElementById("goal").value, acceptance = document.getElementById("done").value;
  const selected = document.querySelector('input[name="executor"]:checked');
  if (!goal.trim()) { status.textContent = "What should be done is required."; return; }
  if (goal.length > 2000 || acceptance.length > 500) { status.textContent = "Goal must be at most 2000 characters; Done when at most 500."; return; }
  if (!selected || selected.disabled || selected.value && (!data.executors[Number(selected.value)] || !/^[a-z0-9-]{1,64}$/.test(data.executors[Number(selected.value)]))) { status.textContent = "Choose an available executor."; return; }
  readContext(value => {
    updateContext(value);
    if (!context || !context.branch) { status.textContent = "Focus a worktree first."; return; }
    sendCommand({cmd:"delegate",branch:context.branch,displayName:context.displayName,goal,acceptance,...(selected.value?{executor:data.executors[Number(selected.value)]}:{})});
  });
});
window.addEventListener("message", event => {
  const r = event.data;
  if (event.source !== window.parent || !r || r.type !== "orca-panel-action-result" || !pending.has(r.requestId)) return;
  const item = pending.get(r.requestId); pending.delete(r.requestId);
  if (!r.ok) { status.textContent = typeof r.error === "string" ? r.error : "Orca refused this request."; return; }
  if (item.purpose === "context") { updateContext(r.value); if (item.after) item.after(r.value); return; }
  const accepted = r.value && r.value.accepted;
  status.textContent = accepted ? item.purpose === "setup" ? "Typed into your terminal. Press Enter to run it." : "Sent to pacer console" : "Orca refused to type into the terminal.";
  if (accepted && item.after) item.after(r.value);
});
readContext();
`;
