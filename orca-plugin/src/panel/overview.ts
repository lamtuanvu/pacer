import type { CmdData, LinkSnapshot, ProviderLine } from "../../../src/link/envelope";
import { displayName, icon, mark } from "./icons";
import { h, time, age } from "./shared";
import { answerDetail, attentionGroups, attentionText, headline, tone } from "./model";
export function meter(p:ProviderLine, slim=false): string {
 if(p.usedPct===null) return "";
 const used=Math.max(0,Math.min(100,p.usedPct)), pace=p.pacePct==null?null:Math.max(0,Math.min(100,p.pacePct));
 return `<div class="meter ${slim?"slim":""} ${tone(p.verdict)}" role="progressbar" aria-label="${h(displayName(p.id))} usage${pace===null?"":`, pace ${pace}%`}" aria-valuenow="${used}" aria-valuemin="0" aria-valuemax="100"><div class="fill" style="width:${used}%"></div>${pace===null?"":`<div class="pace" style="left:${pace}%"></div>`}</div>`;
}
export function connectionIndicator(s:LinkSnapshot, now:number, reachable:boolean):string {
 const old=now-(s.budget?.generatedAt??s.at)>120;
 return `<span class="name live ${reachable?old?"warn":"good":"bad"}"><span class="dot"></span><span data-freshness>${reachable?`Live · ${h(time(s.budget?.generatedAt??s.at))}`:"Not connected"}</span></span>`;
}
export function header(s:LinkSnapshot, now:number, reachable:boolean):string {
 return `<header><span class="brand name">${mark}pacer</span>${s.budget?`<span class="pill">${h((s.mode?.mode??s.budget.mode).replace(/^./,c=>c.toUpperCase()))} mode</span>`:""}<span class="grow"></span>${connectionIndicator(s,now,reachable)}</header>`;
}
function strategyPicker(s:LinkSnapshot):string {
 const names=s.strategies?.length?s.strategies:[s.budget?.strategy ?? "default"];
 return `<section id="strategy-picker" class="card stack" hidden></section>${names.length===1?`<small>Only one strategy (${h(names[0])}). Add files under ~/.pacer/strategies to switch.</small>`:""}`;
}
export function overview(s:LinkSnapshot, now:number, reachable:boolean, commands:Record<string,CmdData>, text:Record<string,string>):string {
 const p=s.budget?.providers.find(p=>p.id===s.budget?.planner), attention=attentionGroups(s,now);
 return `<div class="content">${header(s,now,reachable)}
 <div class="card stack answer"><div class="stack"><div class="headline">${h(headline(p,now))}</div><div class="muted">${h(answerDetail(s,now))}</div></div>${p?`<div class="stack"><div class="row"><span class="name">${icon(p.id,14)}${h(displayName(p.id))}</span><small>planner</small><span class="grow"></span><span class="percent">${p.usedPct===null?"—":`${Math.round(p.usedPct)}%`}</span><small>used</small></div>${meter(p)}<div class="row"><small>Pace marker ${p.pacePct==null?"—":`${p.pacePct}%`}</small><span class="grow"></span><small>${p.resetsAt===null?"Reset unknown":`Resets ${h(new Date(p.resetsAt*1000).toLocaleString([], {weekday:"short",hour:"2-digit",minute:"2-digit"}))}`}</small></div></div>`:""}</div>
 <section class="stack section"><div class="row"><h2>Who runs next</h2><span class="grow"></span><small>in this order</small></div><div class="list" id="ranked-list"></div><div class="stack unavailable" id="unavailable-list"></div></section>
 <section class="stack section"><div class="row"><h2>Needs attention</h2>${attention.length?`<span class="pill bad">${attention.length}</span>`:""}</div>${attention.map((g,i)=>{
 const key=`attention-${i}`;
 text[key+"-goal"]=g.goal.length>96?g.goal.slice(0,93)+"…":g.goal; text[key+"-detail"]=attentionText(g,now)+(g.stuck?"":` · ${age(g.latest.updatedAt,now)}`);
 if(g.retry) text[key+"-executor"]=displayName(g.retry.id);
 if(g.stuck && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id)) commands[key]={cmd:"stop",taskId:g.latest.id};
 else if(g.retry && /^[A-Za-z0-9_-]{1,128}$/.test(g.latest.id) && /^[a-z0-9-]{1,64}$/.test(g.retry.id)) commands[key]={cmd:"retry",taskId:g.latest.id,executor:g.retry.id};
 return `<div class="card stack attention ${g.stuck?"stuck":""}"><div class="row"><span class="${g.stuck?"warn":"bad"}" aria-hidden="true">${g.stuck?"◐":"✕"}</span><div class="stack grow"><span class="task-goal"><span data-text="${key}-goal"></span></span><small><span data-text="${key}-detail"></span></small></div></div><div class="actions">${commands[key]?`<button type="button" class="${g.stuck?"":"primary"}" data-command="${key}">${g.stuck?"Stop it":`Retry on <span data-text="${key}-executor"></span>`}</button>`:"<small>No other executor available.</small>"}</div></div>`;
 }).join("")}${attention.length?"":"<small>Nothing needs attention.</small>"}</section>
 <section class="stack section"><h2>Recently done</h2><div class="stack recent">${[...s.tasks].filter(t=>t.state==="done").sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,3).map(t=>`<div class="row"><span class="good" aria-hidden="true">✓</span><div class="stack grow"><span class="ellipsis" title="${h(t.goal.slice(0,100))}">${h(t.goal.slice(0,100))}</span><small>${h(t.executor?displayName(t.executor):"—")} · ${h(age(t.updatedAt,now))}</small></div></div>`).join("")}${s.tasks.some(t=>t.state==="done")?"":"<small>No completed tasks yet.</small>"}</div></section>
 ${strategyPicker(s)}</div><div class="actionbar"><div class="actions"><button type="button" class="primary grow" data-view="delegate" data-live>Delegate a task</button><button type="button" data-strategy-toggle${(s.strategies?.length ?? 1)<=1?" disabled":""} aria-expanded="false">Strategy</button><button type="button" class="refresh" data-command="refresh" aria-label="Refresh">↻</button></div><div class="footnote">Updated <span data-updated>—</span> · console connected in <span data-worktree>—</span></div></div>`;
}
