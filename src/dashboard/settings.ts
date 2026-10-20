import {readFileSync} from 'node:fs';
import {accountCmd,runnerCmd,type AccountDeps} from '../commands/accounts';
import {configCmd} from '../commands/config';
import {loadStrategy,strategyPath} from '../config/strategy';
import {StrategyDoc} from '../config/edit';
import {listStrategies} from '../link/strategies';
import type {Ctx} from '../types';
import type {DashboardAction} from './model';
import type {ClientSnapshot} from '../view-model/snapshot';
import {providers} from '../view-model/panel';
import {capacity, plannerMeter} from '../view-model/selectors';
import {clock, meterText} from '../view-model/format';
import type {Result} from '../commands/types';
import {moveSelection} from './input';
export interface SettingsRow {id:string;section:string;text:string;reason?:string;run?:()=>Promise<unknown>}
export interface SettingsDeps {ops?:()=>readonly string[];changed():void;report(text:string):void;command(data:DashboardAction):Promise<void>;login?:AccountDeps['login'];snapshot?:()=>ClientSnapshot}
/** Terminal settings calls the same validated writers as the CLI. */
export class DashboardSettings {
 open=false;selected=0;busy=false;pending:Promise<void>=Promise.resolve();
 prompt:null|{question:string;value:string;resolve(value:string):void;reject(error:Error):void}=null;
 constructor(private ctx:Ctx,private deps:SettingsDeps){}
 private ask=(question:string):Promise<string>=>new Promise((resolve,reject)=>{this.prompt={question,value:'',resolve,reject};this.deps.changed();});
 private async result(result:Promise<Result>){const r=await result;this.deps.report(r.err||r.out);}
 private set(key:string,value:string){return this.result(configCmd(['set',key,value],this.ctx));}
 private async remove(kind:'account'|'runner',name:string){if(!/^y(?:es)?$/i.test(await this.ask(`Remove ${name}? y/N`)))return;await this.result((kind==='account'?accountCmd:runnerCmd)(['rm',name],this.ctx));}
 strategyName():string{return loadStrategy(this.ctx).name;}
 rows():SettingsRow[]{
  const s=loadStrategy(this.ctx),runners=Object.values(s.runners),rows:SettingsRow[]=[];
  const snapshot=this.deps.snapshot?.(),ps=snapshot?providers(snapshot):[];
  const blocked=(id:string)=>snapshot?.planner===undefined?!!ps.find(p=>p.id===id)?.blockedReason:snapshot.executors?.find(e=>e.id===id)?.state==='blocked';
  const add=(section:string,id:string,text:string,run?:SettingsRow['run'],reason?:string)=>rows.push({section,id,text,run,reason});
  const planner=runners.find(r=>r.agent===s.planner.agent&&r.account===s.planner.account)?.id??s.planner.agent;
  const choices=runners.filter(r=>['claude-code','codex','cursor','opencode'].includes(r.agent)&&!r.host).map(r=>r.id);
  add('Planner','planner',`Planner: ${planner}${snapshot&&plannerMeter(snapshot)?` · ${meterText(plannerMeter(snapshot)!.usedPct,plannerMeter(snapshot)!.pacePct,'full')}`:''} · Enter cycle`,()=>this.set('planner',choices[(choices.indexOf(planner)+1)%choices.length]??planner));
  for(const a of Object.values(s.accounts)){
   const users=runners.filter(r=>r.account===a.name),p=ps.find(p=>p.account===a.name||users.some(r=>r.id===p.id)),usage=snapshot?.planner===undefined?p:snapshot.accounts?.find(row=>row.name===a.name);
   const available=snapshot?.planner!==undefined&&usage&&'signedIn' in usage&&usage.signedIn===false?'Unavailable':p?(p.unavailableReason||p.brokenReason?'Unavailable':'Available'):'Sign-in state unknown';
   const reason=s.planner.account===a.name?"Planner — can't remove":users.length?`In use by ${users.map(r=>r.id).join(', ')}`:undefined;
   add('Accounts',`account-${a.name}`,`${a.name} · ${a.kind} · ${a.source} · ${usage?.usedPct==null?'Usage unknown':`${Math.round(usage.usedPct)}% used`} · ${available} · Runners: ${users.map(r=>r.id).join(', ')||'None'}`,()=>this.remove('account',a.name),reason);
  }
  const account=(link=false)=>this.result(accountCmd(['add',...(link?['--orca']:[])],this.ctx,{prompt:this.ask,login:this.deps.login,print:this.deps.report}));
  add('Accounts','account-add','Add account',()=>account());add('Accounts','account-link','Link Orca account',()=>account(true));
  for(const r of runners)add('Runners',`runner-${r.id}`,`${r.id} · ${r.agent} · ${r.account} · ${r.model??'default model'}`,()=>this.remove('runner',r.id),r.id===planner?"Planner — can't remove":runners.length<=1?'Last runner':undefined);
  add('Runners','runner-add','+ Add executor',()=>this.result(runnerCmd(['add'],this.ctx,{prompt:this.ask})));
  for(const id of s.pacing.order){
   const disabled=blocked(id), row=snapshot?capacity(snapshot).find(e=>e.id===id):undefined, runner=s.runners[id];
   add('Executors',`executor-${id}`,`${row?.rank??s.pacing.order.indexOf(id)+1} ${id} · ${row?.model??runner?.model??'default model'} · ${row?.host??runner?.host??'this machine'} · ${disabled?'Disabled':'Enabled'}`,
    ()=>this.deps.command({cmd:disabled?'unblock':'block',executor:id}),undefined);
   if(row)rows[rows.length-1].text+=` · ${row.sub}${row.lastCheck?` · check ${clock(row.lastCheck.at,this.ctx.now,'UTC')}`:''}`;
  }
  add('Executors','routing',`Routing: ${s.routing.map(r=>`${r.kinds?.join(', ')??'default'} → ${r.executors.join(', ')}`).join('; ')} · Edit routing`,()=>this.builder());
  const policies=['priority','even','burn-before-reset','cheapest-first'];
  add('Pacing','policy',`Policy: ${s.pacing.policy}`,()=>this.set('pacing.policy',policies[(policies.indexOf(s.pacing.policy)+1)%policies.length]));
  add('Pacing','reserve',`Planner reserve: ${s.pacing.plannerReserve}%`,()=>this.set('pacing.planner_reserve',String(Math.min(50,s.pacing.plannerReserve+5))));
  add('Pacing','accounts-mode',`Accounts: ${s.pacing.accounts}`,()=>this.set('pacing.accounts',s.pacing.accounts==='spread'?'fill':'spread'));
  if(s.pacing.accounts==='fill')add('Pacing','threshold',`Fill threshold: ${s.pacing.fillThreshold}%`,()=>this.set('pacing.fill_threshold',String(Math.min(100,s.pacing.fillThreshold+5))));
  for(const name of listStrategies(this.ctx))add('Strategies',`strategy-${name}`,`${name}${name===s.name?' · Active':''}`,()=>this.deps.command({cmd:'use',strategy:name}));
  add('Strategies','strategy-new','New strategy',()=>this.builder());
  add('Updates','check-updates','Check for updates',()=>this.deps.command({cmd:'check-updates'}));
  add('Updates','update','Update',async()=>{if(/^y(?:es)?$/i.test(await this.ask('Run pacer update? y/N')))await this.deps.command({cmd:'update'});});
  const check=new StrategyDoc(readFileSync(strategyPath(this.ctx),'utf8')).getIn(['update_check'])!==false;
  add('Updates','update-check',`Update checks: ${check?'on':'off'}`,()=>this.set('update_check',String(!check)));
  for(const host of snapshot?.hosts??[])add('Hosts',`host-${host.alias}`,`${host.alias} · ${host.running}/${host.maxTasks} tasks · ${host.executors.join(', ')||'No executors'} · Enter check`,()=>this.deps.command({label:'Run host checks',op:'host.check',params:{alias:host.alias}}));
  const sectionOrder=['Planner & pacing','Executors','Accounts','Runners','Routing','Hosts','Strategies','Updates'];
  for(const row of rows){if(['Planner','Pacing'].includes(row.section))row.section='Planner & pacing';if(row.id==='routing')row.section='Routing';}
  rows.sort((a,b)=>sectionOrder.indexOf(a.section)-sectionOrder.indexOf(b.section));
  const supports=(op:string)=>!this.deps.ops||this.deps.ops().includes(op);
  return rows.flatMap(row=>{
   if(!row.run)return [row];
   const id=row.id;
   const op=id.startsWith('host-')?'host.check':id==='account-add'||id==='account-link'?'account.signin':id==='runner-add'?'runner.add':id.startsWith('account-')?'account.remove':id.startsWith('runner-')?'runner.remove':id.startsWith('executor-')?(blocked(id.slice(9))?'runner.unblock':'runner.block'):id==='routing'||id==='strategy-new'?'strategy.build':id.startsWith('strategy-')?'strategy.use':id==='check-updates'?'update.check':id==='update'?'update.apply':'config.set';
   return supports(op)?[row]:row.id.startsWith('executor-')||row.id.startsWith('host-')?[{...row,run:undefined}]:[];
  });
 }
 private async builder(){const agent=await this.ask('Planner agent (claude-code, codex)'),brief=await this.ask('Strategy brief');await this.deps.command({cmd:'strategy-build',agent,brief,from:loadStrategy(this.ctx).name});}
 private start(run:()=>Promise<unknown>){if(this.busy)return;this.busy=true;this.pending=Promise.resolve().then(run).then(()=>{}).catch(e=>this.deps.report(e instanceof Error?e.message:String(e))).finally(()=>{this.busy=false;this.prompt=null;this.deps.changed();});}
 async handle(key:string):Promise<void>{
  if(!this.open){if(key===','){this.open=true;this.selected=0;}return;}
  if(this.prompt){const p=this.prompt;if(key==='escape'){this.prompt=null;p.reject(Error('Settings change cancelled'));}else if(key==='enter'){this.prompt=null;p.resolve(p.value.trim());}else if(key==='backspace')p.value=Array.from(p.value).slice(0,-1).join('');else if(!['up','down','left','right'].includes(key)&&!/[\x00-\x1f\x7f]/.test(key))p.value+=key;return;}
  if(this.busy)return;
  if(key==='escape'){this.open=false;return;}
  const rows=this.rows();this.selected=moveSelection(key,this.selected,rows.length);const row=rows[this.selected];
  if(['left','right'].includes(key)&&['reserve','threshold'].includes(row?.id)){const s=loadStrategy(this.ctx),reserve=row.id==='reserve',value=reserve?s.pacing.plannerReserve:s.pacing.fillThreshold;this.start(()=>this.set(reserve?'pacing.planner_reserve':'pacing.fill_threshold',String(Math.max(reserve?0:50,Math.min(reserve?50:100,value+(key==='left'?-5:5))))));return;}
  if(key==='t'&&row?.id.startsWith('executor-')&&(!this.deps.ops||this.deps.ops().includes('runner.check'))){this.start(()=>this.deps.command({label:'Run executor check',op:'runner.check',params:{id:row.id.slice(9)}}));return;}
  if(key==='c'&&row?.id.startsWith('host-')){if(row.run)this.start(row.run);return;}
  if(key==='s'&&(!this.deps.ops||this.deps.ops().includes('strategy.use'))){this.start(async()=>{const name=await this.ask(`Strategy (${listStrategies(this.ctx).join(', ')})`);await this.deps.command({cmd:'use',strategy:name});});return;}
  if(['a','l'].includes(key)&&['Accounts','Runners'].includes(row?.section)){const id=key==='l'?'account-link':row.section==='Accounts'?'account-add':'runner-add';const run=rows.find(r=>r.id===id)?.run;if(run)this.start(run);return;}
  if(['[',']'].includes(key)&&row?.id.startsWith('executor-')&&(!this.deps.ops||this.deps.ops().includes('config.set'))){const s=loadStrategy(this.ctx),order=[...s.pacing.order],i=order.indexOf(row.id.slice(9)),j=i+(key==='['?-1:1);if(j>=0&&j<order.length){[order[i],order[j]]=[order[j],order[i]];this.start(()=>this.set('pacing.order',order.join(',')));}return;}
  if((key==='r'&&['Executors','Routing'].includes(row?.section??'')||key==='n'&&row?.section==='Strategies')&&(!this.deps.ops||this.deps.ops().includes('strategy.build'))){this.start(()=>this.builder());return;}
  if((key==='enter'||key==='x'&&['Accounts','Runners'].includes(row?.section)||key==='b'&&row?.section==='Executors')&&row?.run){if(row.reason)this.deps.report(row.reason);else this.start(row.run);}
  if(key==='c'&&rows.some(r=>r.id==='check-updates'))this.start(()=>this.deps.command({cmd:'check-updates'}));if(key==='u'){const run=rows.find(r=>r.id==='update')?.run;if(run)this.start(run);}
 }
}

/** Release raw mode and the alternate screen for an interactive login, even on failure. */
export async function terminalLogin(argv:string[],env:Record<string,string|undefined>,terminal:{suspend():void;resume():void},spawn:(argv:string[],env:Record<string,string|undefined>)=>Promise<number>=(argv,env)=>Bun.spawn(argv,{env,stdin:'inherit',stdout:'inherit',stderr:'inherit'}).exited):Promise<number>{
 terminal.suspend();try{return await spawn(argv,env);}finally{terminal.resume();}
}
