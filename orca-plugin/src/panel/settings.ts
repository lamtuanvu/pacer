import { parse } from 'yaml';
import { validateStrategy, type Strategy } from '../../../src/config/strategy';
import type { CmdData, LinkSnapshot } from '../../../src/link/envelope';
import type { PluginUpdates } from '../updates';
import { h, actionStatus } from './shared';

/** Read strategy configuration only; account homes and credentials are never read. */
export function readPanelSettings(readText:(path:string)=>string|null, home:string, name='default'):{strategyConfig?:Strategy;updateCheck:boolean;error?:string} {
 try {
  const text=readText(name==='default'?`${home}/strategy.yaml`:`${home}/strategies/${name}.yaml`);
  if(!text)return {updateCheck:true};
  const raw=parse(text);
  return {strategyConfig:validateStrategy(raw,'active strategy',name),updateCheck:raw.update_check!==false};
 } catch {return {updateCheck:true,error:'Settings unavailable: fix the active strategy in a pacer terminal.'};}
}
export interface SettingsView {strategyConfig?:Strategy;updateCheck?:boolean;settingsError?:string;notifications?:'off'|'important'|'all';autoConsole?:boolean;updates?:PluginUpdates}
export function settingsView(s:LinkSnapshot, view:SettingsView, live:boolean, commands:Record<string,CmdData>):string {
 const cfg=view.strategyConfig, runners=Object.values(cfg?.runners??{}), planner=cfg?runners.find(r=>r.agent===cfg.planner.agent&&r.account===cfg.planner.account)?.id??cfg.planner.agent:s.budget?.planner && /^[a-z0-9][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?$/.test(s.budget.planner)?s.budget.planner:'Not configured';
 const disabled=live?'':' disabled';
 function button(id:string,label:string,cmd:CmdData,reason='',remove=false,active?:boolean) {
  commands[`s-${id}`]=cmd;
  const control=`<button data-command="s-${h(id)}"${remove?' data-remove="true"':''}${active===undefined?'':` aria-pressed="${active}"`}${!live?disabled:reason?` disabled title="${h(reason)}"`:''}>${h(label)}</button>`;
  return live&&reason?`<span class="disabled-action">${control}<small class="muted">${h(reason)}</small></span>`:control;
 }
 const set=(id:string,label:string,key:string,value:string,reason='',active?:boolean)=>button(id,label,{cmd:'config-set',key,value},reason,false,active);
 const section=(name:string,body:string)=>`<section class="stack section"><h2>${name}</h2><div class="card provider stack">${body}</div></section>`;
 const terminal=(id:string,label:string,command:CmdData['command'])=>button(id,label,{cmd:'open-terminal',command});
 if(!cfg) {
  const rows=[['Planner',planner],['Accounts','Unavailable'],['Runners','Unavailable'],['Executors','Unavailable'],['Pacing','Unavailable'],['Strategies',s.budget?.strategy??'default'],['Updates',view.updates?.cli??view.updates?.plugin??'Unknown'],['Plugin',`Notifications: ${view.notifications??'important'} · Automatic console: ${view.autoConsole===false?'off':'on'}`]];
  return `<div class="content"><header><strong class="grow">Settings</strong><button data-view="overview">Back</button></header><small>${h(view.settingsError??'Active strategy settings unavailable.')}</small>${!live?'<div class="note">Open a pacer console to change settings<button data-setup="pacer console">Open console</button></div>':''}<div class="card stack provider">${rows.map(([label,value])=>`<h2>${label}</h2><small>${h(value)}</small>`).join('')}</div><div class="actions">${terminal('init','Configure pacer','init')}</div>${actionStatus}</div>`;
 }
 const accounts=Object.values(cfg.accounts).map(a=>{
  const users=runners.filter(r=>r.account===a.name), readings=s.budget?.providers.filter(p=>p.account===a.name||(!p.account&&users.some(r=>r.id===p.id)))??[], usage=readings.find(p=>p.usedPct!==null)?.usedPct;
  const state=readings.length?readings.some(p=>p.unavailableReason||p.brokenReason)?'Unavailable':'Available':'Sign-in state unknown';
  return `<div class="stack"><div class="row"><strong class="grow">${h(a.name)}</strong><span class="pill">${h(a.source)}</span>${button(`account-${a.name}`,'Remove',{cmd:'account-remove',name:a.name},cfg.planner.account===a.name?"Planner — can't remove":users.length?`In use by ${users.map(r=>r.id).join(', ')}`:'',true)}</div><small>${h(a.kind)} · ${usage==null?'Usage unknown':`${Math.round(usage)}% used`} · ${state}</small><small>Runners: ${h(users.map(r=>r.id).join(', ')||'None')}</small></div>`;
 }).join('');
 const order=cfg?.pacing.order??[];
 const executors=order.map((id,i)=>{
  const blocked=!!s.budget?.providers.find(p=>p.id===id)?.blockedReason;
  const moved=(j:number)=>{const next=[...order];[next[i],next[j]]=[next[j]!,next[i]!];return next.join(',');};
  return `<div class="stack"><strong>${h(id)}</strong><div class="actions">${button(`toggle-${id}`,blocked?'Enable':'Disable',{cmd:blocked?'unblock':'block',executor:id})}${set(`up-${id}`,'↑','pacing.order',i>0?moved(i-1):order.join(','),i===0?'First executor':'')}${set(`down-${id}`,'↓','pacing.order',i<order.length-1?moved(i+1):order.join(','),i===order.length-1?'Last executor':'')}</div></div>`;
 }).join('');
 const policy=cfg?.pacing.policy??'priority', reserve=cfg?.pacing.plannerReserve??20, mode=cfg?.pacing.accounts??'spread', threshold=cfg?.pacing.fillThreshold??90;
 const policyDescriptions={priority:'Use executors in your order; move ahead-of-pace ones later and expiring quota first.',even:'Spread work toward executors with the most pace headroom.','burn-before-reset':'Use quota that would reset unused first.','cheapest-first':'Prefer unmetered, then quota, then metered.'};
 const choices=(key:string,values:string[],current:string)=>`<div class="actions segmented" role="group" aria-label="${h(key)}">${values.map(v=>set(`${key}-${v}`,v,key,v,'',v===current)).join('')}</div>`;
 const steps=(key:string,label:string,value:number,min:number,max:number)=>`<div class="row"><span class="grow">${label}: <strong>${value}%</strong></span>${set(`${key}-minus`,'−',key,String(Math.max(min,value-5)),value<=min?`Minimum ${min}%`:'')}${set(`${key}-plus`,'+',key,String(Math.min(max,value+5)),value>=max?`Maximum ${max}%`:'')}</div>`;
 const strategies=(s.strategies?.length?s.strategies:['default']).filter(e=>/^[a-z0-9][a-z0-9-]{0,39}$/.test(typeof e==='string'?e:e.name)).map(e=>typeof e==='string'?{name:e,active:e===(cfg?.name??s.budget?.strategy??'default')}:e);
 return `<div class="content"><header><strong class="grow">Settings</strong><button data-view="overview">Back</button></header>${!live?'<div class="note stack">Open a pacer console to change settings<button data-setup="pacer console">Open console</button></div>':''}${view.settingsError?`<p class="note">${h(view.settingsError)}</p>`:''}
 ${section('Planner',choices('planner',runners.filter(r=>['claude-code','codex','cursor','opencode'].includes(r.agent)&&!r.host).map(r=>r.id),planner))}
 ${section('Accounts',`${accounts||'<small>No accounts.</small>'}<div class="actions">${terminal('account-add','Add account','account-add')}${terminal('account-link','Link Orca account','account-add-orca')}</div>`)}
 ${section('Runners',`${runners.map(r=>`<div class="stack"><strong>${h(r.id)}</strong><small>${h(r.agent)} · ${h(r.account)}${r.model?` · ${h(r.model)}`:''}</small><div class="actions">${button(`runner-${r.id}`,'Remove',{cmd:'runner-remove',name:r.id},r.id===planner?"Planner — can't remove":runners.length<=1?'Last runner':'',true)}</div></div>`).join('')||'<small>No runners.</small>'}<div class="actions">${terminal('runner-add','Add runner','runner-add')}</div>`)}
 ${section('Executors',`${executors||'<small>No executors.</small>'}<small>${h(cfg?.routing.map(r=>`${r.kinds?.join(', ')??'default'} → ${r.executors.join(', ')}`).join('; ')??'')}</small><div class="actions"><button data-view="strategy"${disabled}>Edit routing</button></div>`)}
 ${section('Pacing',cfg?`<small>Policy: ${policy}</small>${choices('pacing.policy',['priority','even','burn-before-reset','cheapest-first'],policy)}<small>${policyDescriptions[policy]}</small>${steps('pacing.planner_reserve','Planner reserve',reserve,0,50)}<small>Accounts: ${mode}</small>${choices('pacing.accounts',['spread','fill'],mode)}<small>${mode==='spread'?'Spread across accounts by headroom.':'Fill one account until it leaves the pace band or reaches the threshold.'}</small>${mode==='fill'?steps('pacing.fill_threshold','Fill threshold',threshold,50,100):''}`:'<small>Settings unavailable.</small>')}
 ${section('Strategies',`${strategies.map(e=>`<div class="row"><strong class="grow">${h(e.name)}</strong>${button(`strategy-${e.name}`,e.active?'Active':'Use',{cmd:'use',strategy:e.name},e.active?'Current strategy':'')}</div>`).join('')}<div class="actions">${cfg?`<button data-view="strategy"${disabled}>New strategy</button>`:""}${terminal('init','Configure pacer','init')}</div>`)}
 ${section('Updates',`<small>${h(view.updates?.available?`Update available: ${view.updates.latest}`:`pacer ${view.updates?.cli??view.updates?.plugin??s.console?.version??'version unknown'}`)}</small><div class="actions">${button('check-updates','Check for updates',{cmd:'check-updates'})}${button('update','Update',{cmd:'update'})}</div>`)}
 ${section('Plugin',`<small>Notifications: ${h(view.notifications??'important')}</small><div class="actions segmented" role="group" aria-label="Notifications">${(['off','important','all'] as const).map(level=>button(`notify-${level}`,level,{cmd:'notify-level',level},'',false,level===(view.notifications??'important'))).join('')}</div><div class="row"><span class="grow">Update checks: ${cfg?view.updateCheck===false?'off':'on':'unknown'}</span>${cfg?set('update-check',view.updateCheck===false?'Enable':'Disable','update_check',String(view.updateCheck===false)):''}</div><small>Automatic console: ${view.autoConsole===false?'off':'on'} · Orca settings</small>`)}
 ${actionStatus}</div>`.replace(/<div class="actions"><\/div>/g,"");
}
