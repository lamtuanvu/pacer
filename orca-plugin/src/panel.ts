import type { SetupChecklist } from "../../src/setup/checklist";
import type { PluginUpdates } from "./updates";
import { MANUAL_INSTALL, type BootstrapState } from "./bootstrap";
import type { LinkSnapshot, ProviderLine } from "../../src/link/envelope";
import type { TransportId } from "./transports/choose";
import { accountGroups } from "../../src/render/accounts";
import { h } from "./panel/shared";
import { providerLabel, headline, verdictWords } from "./panel/model";
import { meter, placementLine } from "./panel/overview";
import { displayName, mark } from "./panel/icons";
import { style } from "./panel/style";
export { escapeHtml, jsonForScript } from "./panel/shared";

export interface StatusView {
 nowS:number; reachable:boolean; transport:TransportId|null;
 updates?:PluginUpdates; setup?:SetupChecklist; bootstrap?:BootstrapState;
}
// Compatibility with the worker until its console controls are retired.
export interface AutoConsoleOutcome { status:string; at:number }
export function renderPanel(s:LinkSnapshot, view:StatusView & {autoConsole?:boolean;notifications?:"off"|"important"|"all";lastSeenAt?:number;autoConsoleOutcome?:AutoConsoleOutcome}):string {
 return renderStatusPage(s,view);
}
function absolute(at:number, now:number, weekday=false):string {
 const date=new Date(at*1000), today=new Date(now*1000);
 const clock=date.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",hour12:false});
 return weekday || date.toDateString()!==today.toDateString() ? `${date.toLocaleDateString("en-GB",{weekday:"short"})} ${clock}` : clock;
}
const percent=(p:ProviderLine)=>p.usedPct===null?"Usage unknown":`${Math.round(p.usedPct)}% used`;
const section=(title:string,body:string)=>`<section class="stack section"><h2>${title}</h2>${body}</section>`;
function checklist(setup:SetupChecklist):string {
 const rows=(required:boolean)=>setup.items.filter(i=>i.required===required).map(i=>`<div class="step ${h(i.status)}"><span aria-hidden="true">${i.status==="done"?"✓":i.status==="failed"?"!":"·"}</span><div class="stack"><strong>${h(i.title)}</strong><small>${h(i.status)}${i.detail?` · ${h(i.detail)}`:""}</small></div></div>`).join("");
 const optional=rows(false);
 return `${rows(true)}${optional?`<div class="stack"><strong>Optional</strong>${optional}</div>`:""}`;
}
export function renderStatusPage(s:LinkSnapshot, view:StatusView):string {
 const {nowS}=view, providers=s.budget?.providers??[], planner=providers.find(p=>p.id===s.budget?.planner);
 const reset=(p:ProviderLine,weekday=false)=>p.resetsAt===null?"Reset unknown":`Resets ${absolute(p.resetsAt,nowS,weekday)}`;
 const mode=s.mode?.mode??s.budget?.mode??"unknown";
 const header=`<header><span class="brand name">${mark}pacer</span><span class="pill">${h(mode.replace(/^./,c=>c.toUpperCase()))}</span><span class="grow"></span><span class="live">${view.reachable?"Live · updated":"Not connected · last data"} ${h(absolute(s.at,nowS))}</span></header>`;
 let content:string;
 if(view.bootstrap && !s.budget && !view.setup?.complete) {
  const steps=(["install","start"] as const).map(name=>{const step=view.bootstrap![name];return `<p><strong>${name}: ${h(step.status)}</strong>${step.detail?` · ${h(step.detail)}`:""}</p>`;}).join("");
  content=section("Welcome to pacer","<p>pacer tracks your AI account budgets and task status. It helps you pace planning and delegate work to available executors.</p>")+section("Install",`<pre><code>${h(MANUAL_INSTALL)}</code></pre><pre><code>pacer init</code></pre>${steps}`)+section("Live panel","<p>The live panel opens automatically once pacer is installed and the plugin restarts.</p>")+section("Act in pacer","<p>Run <code>pacer open</code> in a terminal to open the pacer app, where you delegate, review and change settings.</p>");
 } else {
  const accounts=accountGroups(providers).flatMap(group=>{
   // Legacy providers have no account identity and must retain separate budgets.
   const rows=group.account?[group.rows]:group.rows.map(p=>[p]);
   return rows.map(runners=>{const p=runners[0];return `<div class="account card stack"><strong>${h(group.account??providerLabel(p))}</strong><span>${h(verdictWords(p.verdict))} · ${h(percent(p))}${p.stale?' · <span class="pill">stale</span>':""}</span>${meter(p,true)}<small>${h(p.window??"Window unknown")} · ${h(reset(p))}</small><small>Runners: ${h(runners.map(providerLabel).join(", "))}</small></div>`;});
  }).join("");
  const running=s.tasks.filter(t=>t.state==="running"||t.state==="queued").map(t=>`<div class="card stack"><strong>${h(t.goal.slice(0,100))}</strong><small>${h(t.executor?displayName(t.executor):"Executor pending")} · ${h(t.state)} · started ${h(absolute(t.attemptStartedAt??t.updatedAt,nowS))}${t.progress?` · ${h(t.progress.phase)}`:""}</small>${placementLine(t)}</div>`).join("");
  const waiting=s.tasks.filter(t=>!t.review&&!t.dismissed&&(t.state==="partial"||t.state==="done"||t.state==="needs_input")).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,10).map(t=>`<div class="card stack"><strong>${h(t.goal)}</strong><small>${h(t.executor?displayName(t.executor):"Executor unknown")} · ${t.state==="needs_input"?"Needs your answer":"finished"} ${h(absolute(t.updatedAt,nowS))}</small><small>${h(t.worktree??"Worktree unknown")}</small></div>`).join("");
  const alerts=s.alerts.filter(a=>a.level==="warn"||a.level==="error").sort((a,b)=>b.at-a.at).slice(0,5).map(a=>`<div class="card stack"><strong>${h(a.title)}</strong><p>${h(a.body.slice(0,200))}</p><small>${h(absolute(a.at,nowS))}</small></div>`).join("");
  const versions=`<p>pacer ${h(view.updates?.cli??s.console?.version??"unknown")} · plugin ${h(view.updates?.plugin??"unknown")}</p>${view.updates?.available?`<p>Update available: ${h(view.updates.latest??"unknown")} · <code>pacer update</code></p>`:""}`;
  content=section("Planner",`<div class="card stack">${planner?`<div class="row"><strong class="grow">${h(providerLabel(planner))}</strong><span>${h(percent(planner))}</span></div>${meter(planner)}<small>${h(reset(planner,true))}</small>`:"<small>Planner unknown · Reset unknown</small>"}<p class="headline">${h(headline(planner))}</p></div>`)+section("Accounts",accounts||"<small>No accounts reported.</small>")+section("Running",running||"<small>No tasks running.</small>")+section("Waiting for review",`${waiting||"<small>No tasks waiting for review.</small>"}<p>Review with <code>pacer review &lt;id&gt;</code> or in the pacer app.</p>`)+section("Alerts",alerts||"<small>No alerts.</small>")+section("Versions",versions);
 }
 if(view.setup&&!view.setup.complete)content+=section("Setup",`${checklist(view.setup)}<pre><code>pacer init</code></pre>`);
 const footer='<footer>pacer shows information here. To delegate, review, block executors or change settings, run <code>pacer open</code> in a terminal to open the pacer app.</footer>';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><title>pacer</title><style>${style}</style></head><body><main class="content">${header}${content}${footer}</main></body></html>`;
}
