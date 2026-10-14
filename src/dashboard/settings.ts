import {readFileSync} from 'node:fs';
import {accountCmd,runnerCmd,type AccountDeps} from '../commands/accounts';
import {configCmd} from '../commands/config';
import {loadStrategy,strategyPath} from '../config/strategy';
import {StrategyDoc} from '../config/edit';
import {listStrategies} from '../link/strategies';
import type {Ctx} from '../types';
import type {CmdData,LinkSnapshot} from '../link/envelope';
import type {Result} from '../commands/types';
import {moveSelection} from './input';
export interface SettingsRow {id:string;section:string;text:string;reason?:string;run?:()=>Promise<unknown>}
export interface SettingsDeps {changed():void;report(text:string):void;command(data:CmdData):Promise<void>;login?:AccountDeps['login'];snapshot?:()=>LinkSnapshot}
/** Terminal settings calls the same validated writers as the CLI. */
export class DashboardSettings {
 open=false;selected=0;busy=false;pending:Promise<void>=Promise.resolve();
 prompt:null|{question:string;value:string;resolve(value:string):void;reject(error:Error):void}=null;
 constructor(private ctx:Ctx,private deps:SettingsDeps){}
 private ask=(question:string):Promise<string>=>new Promise((resolve,reject)=>{this.prompt={question,value:'',resolve,reject};this.deps.changed();});
 private async result(result:Promise<Result>){const r=await result;this.deps.report(r.err||r.out);}
 private set(key:string,value:string){return this.result(configCmd(['set',key,value],this.ctx));}
 private async remove(kind:'account'|'runner',name:string){if(!/^y(?:es)?$/i.test(await this.ask(`Remove ${name}? y/N`)))return;await this.result((kind==='account'?accountCmd:runnerCmd)(['rm',name],this.ctx));}
 rows():SettingsRow[]{
  const s=loadStrategy(this.ctx),runners=Object.values(s.runners),rows:SettingsRow[]=[];
  const add=(section:string,id:string,text:string,run?:SettingsRow['run'],reason?:string)=>rows.push({section,id,text,run,reason});
  const planner=runners.find(r=>r.agent===s.planner.agent&&r.account===s.planner.account)?.id??s.planner.agent;
  const choices=runners.filter(r=>['claude-code','codex','cursor','opencode'].includes(r.agent)&&!r.host).map(r=>r.id);
  add('Planner','planner',planner,()=>this.set('planner',choices[(choices.indexOf(planner)+1)%choices.length]??planner));
  for(const a of Object.values(s.accounts)){
   const users=runners.filter(r=>r.account===a.name),p=this.deps.snapshot?.().budget?.providers.find(p=>p.account===a.name||users.some(r=>r.id===p.id));
   const reason=s.planner.account===a.name?"Planner — can't remove":users.length?`In use by ${users.map(r=>r.id).join(', ')}`:undefined;
   add('Accounts',`account-${a.name}`,`${a.name} · ${a.kind} · ${a.source} · ${p?.usedPct==null?'Usage unknown':`${Math.round(p.usedPct)}% used`} · ${p?(p.unavailableReason||p.brokenReason?'Unavailable':'Available'):'Sign-in state unknown'} · Runners: ${users.map(r=>r.id).join(', ')||'None'}`,()=>this.remove('account',a.name),reason);
  }
  const account=(link=false)=>this.result(accountCmd(['add',...(link?['--orca']:[])],this.ctx,{prompt:this.ask,login:this.deps.login,print:this.deps.report}));
  add('Accounts','account-add','Add account',()=>account());add('Accounts','account-link','Link Orca account',()=>account(true));
  for(const r of runners)add('Runners',`runner-${r.id}`,`${r.id} · ${r.agent} · ${r.account} · ${r.model??'default model'}`,()=>this.remove('runner',r.id),r.id===planner?"Planner — can't remove":runners.length<=1?'Last runner':undefined);
  add('Runners','runner-add','Add runner',()=>this.result(runnerCmd(['add'],this.ctx,{prompt:this.ask})));
  for(const id of s.pacing.order){const blocked=!!this.deps.snapshot?.().budget?.providers.find(p=>p.id===id)?.blockedReason;add('Executors',`executor-${id}`,`${id} · ${blocked?'Disabled':'Enabled'} · [ / ] reorder`,()=>this.deps.command({cmd:blocked?'unblock':'block',executor:id}));}
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
  add('Plugin','update-check',`Update checks: ${check?'on':'off'}`,()=>this.set('update_check',String(!check)));
  add('Plugin','plugin-info','Notifications and automatic console: Orca plugin settings');
  return rows;
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
  if(key==='s'){this.start(async()=>{const name=await this.ask(`Strategy (${listStrategies(this.ctx).join(', ')})`);await this.deps.command({cmd:'use',strategy:name});});return;}
  if(['a','l'].includes(key)&&['Accounts','Runners'].includes(row?.section)){const id=key==='l'?'account-link':row.section==='Accounts'?'account-add':'runner-add';this.start(rows.find(r=>r.id===id)!.run!);return;}
  if(['[',']'].includes(key)&&row?.id.startsWith('executor-')){const s=loadStrategy(this.ctx),order=[...s.pacing.order],i=order.indexOf(row.id.slice(9)),j=i+(key==='['?-1:1);if(j>=0&&j<order.length){[order[i],order[j]]=[order[j],order[i]];this.start(()=>this.set('pacing.order',order.join(',')));}return;}
  if(key==='r'&&row?.section==='Executors'||key==='n'&&row?.section==='Strategies'){this.start(()=>this.builder());return;}
  if((key==='enter'||key==='x'&&['Accounts','Runners'].includes(row?.section)||key==='b'&&row?.section==='Executors')&&row?.run){if(row.reason)this.deps.report(row.reason);else this.start(row.run);}
  if(key==='c')this.start(()=>this.deps.command({cmd:'check-updates'}));if(key==='u')this.start(rows.find(r=>r.id==='update')!.run!);
 }
}

/** Release raw mode and the alternate screen for an interactive login, even on failure. */
export async function terminalLogin(argv:string[],env:Record<string,string|undefined>,terminal:{suspend():void;resume():void},spawn:(argv:string[],env:Record<string,string|undefined>)=>Promise<number>=(argv,env)=>Bun.spawn(argv,{env,stdin:'inherit',stdout:'inherit',stderr:'inherit'}).exited):Promise<number>{
 terminal.suspend();try{return await spawn(argv,env);}finally{terminal.resume();}
}
