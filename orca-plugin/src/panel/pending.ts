/** Browser-only action state: persisted across Orca's panel hot reloads. */
export const pendingClient = `
const actionStorage="pacer-pending-actions";
let actionStates={};
try {const saved=JSON.parse(sessionStorage.getItem(actionStorage)||"{}");if(saved && !Array.isArray(saved))actionStates=saved;}catch{}
const actionButtons=new Map();
function saveActions(){try{sessionStorage.setItem(actionStorage,JSON.stringify(actionStates));}catch{}}
function actionKey(c){return c.cmd+":"+(c.key?c.key+":"+c.value:c.name||c.command||c.taskId||c.taskIds?.join(",")||c.executor||c.strategy||c.level||c.goal||c.from||c.text||"");}
function actionLabel(c){const name=data.rows.find(p=>p.id===c.executor)?.name||c.executor||"executor";return ({focus:"Opening session...",retry:"Retrying on "+name+"...","retry-all":"Retrying all on "+name+"...",stop:"Stopping...",dismiss:"Dismissing...",delegate:"Delegating...","strategy-build":"Starting session...",use:"Switching...",block:"Blocking...",unblock:"Unblocking...",refresh:"Refreshing...","notify-level":"Saving preference...",type:"Typing command..."})[c.cmd]||"Working...";}
function outcome(a){
 const c=a.action,t=data.tasks||[],ids=c.taskIds||[c.taskId],p=[...data.rows,...data.muted].find(p=>p.id===c.executor);
 if(c.cmd==="retry"||c.cmd==="retry-all")return ids.every(id=>t.some(x=>x.retryOf===id)||t.find(x=>x.id===id)?.retriedBy);
 if(c.cmd==="focus")return (data.focusAlerts||[]).some(e=>e.key==="focus-"+c.taskId && e.level==="info" && e.at>=a.startedAt);
 if(c.cmd==="stop")return ids.every(id=>t.some(x=>x.id===id&&!["queued","running"].includes(x.state)));
 if(c.cmd==="dismiss")return ids.every(id=>!t.some(x=>x.id===id)||t.find(x=>x.id===id)?.dismissed);
 if(c.cmd==="delegate")return t.some(x=>!a.known.includes(x.id)&&(x.goal===c.goal||x.goal===c.goal.slice(0,197)+"..."));
 if(c.cmd==="block"||c.cmd==="unblock")return p && !!p.blocked===(c.cmd==="block");
 if(c.cmd==="use")return data.strategy===c.strategy;
 if(c.cmd==="strategy-build")return data.buildAlert && data.buildAlert.at>=a.startedAt;
 if(c.cmd==="refresh")return data.sequence>a.sequence;
 if(c.cmd==="notify-level")return data.notifications===c.level;
 if(c.cmd==="config-set")return data.prefs?.values[c.key]===c.value;
 if(c.cmd==="account-remove")return data.prefs && !data.prefs.accounts.includes(c.name);
 if(c.cmd==="runner-remove")return data.prefs && !data.prefs.runners.includes(c.name);
 if(c.cmd==="type"||c.cmd==="open-terminal")return a.accepted;
 return false;
}
function restoreAction(key){const entry=actionButtons.get(key);if(entry){entry.button.disabled=entry.disabled;if(actionStates[key]?.action.cmd!=="focus")entry.button.innerHTML=entry.html;entry.card?.removeAttribute?.("aria-busy");}actionButtons.delete(key);delete actionStates[key];saveActions();}
function paintAction(key,button){
 const a=actionStates[key];if(!a)return;
 if(!actionButtons.has(key))actionButtons.set(key,{button,disabled:button.disabled,html:button.innerHTML,card:button.closest?.(".card,.row,.actionbar")});
 button.disabled=true;if(a.action.cmd!=="notify-level"&&a.action.cmd!=="focus")button.innerHTML='<span class="action-spinner" aria-hidden="true">◐</span> '+h(actionLabel(a.action));
 actionButtons.get(key).card?.setAttribute?.("aria-busy","true");
}
function beginAction(button,action){
 const key=actionKey(action);if(actionStates[key]||button.disabled)return null;
 actionStates[key]={action,target:action.taskId||action.executor||action.strategy||"",startedAt:Date.now()/1000,known:(data.tasks||[]).map(t=>t.id),sequence:data.sequence};
 paintAction(key,button);saveActions();if(typeof setTimeout==="function")setTimeout(()=>recoverActions(),60000);return key;
}
function pendingSend(button,command,after,workspace){
 const key=beginAction(button,command);if(!key)return false;
 return sendCommand(command,value=>{if(actionStates[key]){actionStates[key].accepted=true;saveActions();}if(after)after(value);},()=>{restoreAction(key);if(!status.textContent)status.textContent="The console could not accept this action. Try again.";const card=button.closest?.(".card,.row,.actionbar");if(card?.insertAdjacentHTML)card.insertAdjacentHTML("beforeend",'<p role="alert" class="action-error">The console could not accept this action. Try again.</p>');},workspace);
}
function recoverActions(){
 for(const [key,a] of Object.entries(actionStates)){
  if(!a||typeof a.startedAt!=="number"||!a.action){delete actionStates[key];continue;}
  const rejection=(data.actionErrors||[]).find(e=>e.key===(a.action.cmd==="focus"?"focus-":"retry-")+a.action.taskId&&e.at>=a.startedAt);
  if(rejection){restoreAction(key);status.textContent=rejection.body;continue;}
  if(outcome(a)){restoreAction(key);if(a.action.cmd==="notify-level")status.textContent="Notification preference saved.";continue;}
  const button=actionButtons.get(key)?.button;
  if(Date.now()/1000-a.startedAt>=60){
   if(button){button.disabled=false;if(a.action.cmd!=="focus")button.innerHTML=actionButtons.get(key).html;}
   restoreAction(key);
   status.textContent="Still waiting for the pacer console. Check the pacer tab in this worktree.";
  }else if(button)paintAction(key,button);
 }
 saveActions();
}
function bindAction(button,action){const key=actionKey(action);if(actionStates[key]){if(outcome(actionStates[key])){restoreAction(key);if(action.cmd==="notify-level")status.textContent="Notification preference saved.";}else paintAction(key,button);}}
`;
