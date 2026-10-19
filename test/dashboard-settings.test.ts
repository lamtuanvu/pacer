import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fakeCtx} from './helpers';
import {DashboardSettings} from '../src/dashboard/settings';
import {loadStrategy} from '../src/config/strategy';
import {emptySnapshot} from '../src/link/envelope';
import {renderDashboard} from '../src/dashboard/render';
function fixture(){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'# preserved\naccounts:\n  personal: {kind: claude}\n  spare: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex#spare]\n');return ctx;}
const tick=()=>new Promise(r=>setTimeout(r,0));
async function select(s:DashboardSettings,id:string){s.selected=s.rows().findIndex(r=>r.id===id);expect(s.selected).toBeGreaterThanOrEqual(0);await s.handle('enter');await tick();}
async function answer(s:DashboardSettings,value:string){for(const c of value)await s.handle(c);await s.handle('enter');await tick();}
test('settings opens with comma, navigates and escapes; renderer keeps sections and prompt bounded',async()=>{const s=new DashboardSettings(fixture(),{changed(){},report(){},command:async()=>{}});await s.handle(',');expect(s.open).toBe(true);await s.handle('down');expect(s.selected).toBe(1);await s.handle('up');expect(s.selected).toBe(0);const text=renderDashboard(emptySnapshot(),100,40,0,{selected:0,noColor:true,settings:s});for(const name of ['PLANNER & PACING','ACCOUNTS','RUNNERS','EXECUTORS','ROUTING','STRATEGIES','UPDATES','PLUGIN'])expect(text).toContain(name);expect(text.split('\n')).toHaveLength(40);await s.handle('escape');expect(s.open).toBe(false);});
test('pacing and update settings use validated CLI writers and preserve comments',async()=>{const ctx=fixture(),s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{}});await s.handle(',');for(const [id,key,value] of [['policy','policy','even'],['reserve','plannerReserve',20],['accounts-mode','accounts','fill'],['threshold','fillThreshold',95]] as const){await select(s,id);await s.pending;expect((loadStrategy(ctx).pacing as any)[key]).toBe(value);}await select(s,'update-check');await s.pending;expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('update_check: false');expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toContain('# preserved');});
test('account prompts accept names, suspend for fake login and return after exit',async()=>{const ctx=fixture();let exit!:(code:number)=>void;let login=false;const s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{},login:async(argv,env)=>{expect(argv).toEqual(['codex','login']);expect(env.CODEX_HOME).toBe(join(ctx.home,'.codex-work'));login=true;return new Promise(r=>exit=r);}});await s.handle(',');await select(s,'account-add');expect(s.prompt?.question).toBe('What do you want to add? 1. Claude Code account  2. Codex account  3. Model endpoint (OpenCode)');await answer(s,'codex');await answer(s,'work');expect(login).toBe(true);expect(s.busy).toBe(true);exit(0);await s.pending;expect(s.open).toBe(true);expect(s.busy).toBe(false);expect(loadStrategy(ctx).accounts.work.kind).toBe('codex');});
test('runner add and confirmed remove call shared validation; in-use accounts cannot be removed',async()=>{const ctx=fixture(),s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{}});await s.handle(',');await select(s,'runner-add');await answer(s,'codex#personal');await s.pending;expect(loadStrategy(ctx).runners['codex#personal']).toBeUndefined();await select(s,'runner-add');await answer(s,'codex#spare');await s.pending;await select(s,'runner-codex');expect(s.prompt?.question).toContain('y/N');await answer(s,'n');await s.pending;expect(loadStrategy(ctx).runners.codex).toBeDefined();await select(s,'runner-codex');await answer(s,'y');await s.pending;expect(loadStrategy(ctx).runners.codex).toBeUndefined();expect(s.rows().find(r=>r.id==='account-personal')?.reason).toContain('Planner');});
test('left and right adjust bounded percentages without wrapping at their limits',async()=>{const ctx=fixture(),s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{}});await s.handle(',');s.selected=s.rows().findIndex(r=>r.id==='reserve');await s.handle('left');await s.pending;expect(loadStrategy(ctx).pacing.plannerReserve).toBe(10);for(let i=0;i<20;i++){await s.handle('right');await s.pending;}expect(loadStrategy(ctx).pacing.plannerReserve).toBe(50);await s.handle('enter');await s.pending;expect(loadStrategy(ctx).pacing.plannerReserve).toBe(50);});
test('executor reordering writes CLI order while toggles, strategies and updates use existing commands',async()=>{const ctx=fixture();writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'accounts:\n  personal: {kind: claude}\n  spare: {kind: codex}\n  api: {kind: endpoint, usage: unmetered, model: local/test}\nplanner: claude-code\npacing: {order: [codex, opencode#api]}\nrouting:\n  - default: [codex, opencode#api]\n');const calls:any[]=[],s=new DashboardSettings(ctx,{changed(){},report(){},command:async c=>{calls.push(c);}});await s.handle(',');s.selected=s.rows().findIndex(r=>r.id==='executor-codex');await s.handle(']');await s.pending;expect(loadStrategy(ctx).pacing.order).toEqual(['opencode#api','codex']);s.selected=s.rows().findIndex(r=>r.id==='executor-codex');await s.handle('b');await s.pending;expect(calls.at(-1)).toEqual({cmd:'block',executor:'codex'});await select(s,'strategy-default');await s.pending;expect(calls.at(-1)).toEqual({cmd:'use',strategy:'default'});await s.handle('u');await tick();await answer(s,'n');await s.pending;expect(calls.some(c=>c.cmd==='update')).toBe(false);await s.handle('u');await tick();await answer(s,'y');await s.pending;expect(calls.at(-1)).toEqual({cmd:'update'});});
test('escape cancels a pending account prompt without writing',async()=>{const ctx=fixture(),before=readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8'),s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{}});await s.handle(',');await select(s,'account-add');await s.handle('escape');await s.pending;expect(s.prompt).toBeNull();expect(s.busy).toBe(false);expect(readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8')).toBe(before);});
test('terminal handoff restores dashboard after child exit and launch failure',async()=>{const {terminalLogin}=await import('../src/dashboard/settings');const events:string[]=[],terminal={suspend:()=>events.push('leave'),resume:()=>events.push('return')};let exit!:(code:number)=>void;const pending=terminalLogin(['codex','login'],{},terminal,async()=>{events.push('login');return new Promise(r=>exit=r);});expect(events).toEqual(['leave','login']);exit(7);expect(await pending).toBe(7);expect(events).toEqual(['leave','login','return']);await expect(terminalLogin(['claude'],{},terminal,async()=>{throw Error('missing agent');})).rejects.toThrow('missing agent');expect(events.at(-1)).toBe('return');});
test('planner choice moves the integration using the shared config writer',async()=>{const {existsSync}=await import('node:fs');const ctx=fixture(),messages:string[]=[],s=new DashboardSettings(ctx,{changed(){},report:m=>messages.push(m),command:async()=>{}});await s.handle(',');await select(s,'planner');await s.pending;expect(loadStrategy(ctx).planner).toEqual({agent:'codex',account:'spare'});expect(existsSync(join(ctx.home,'.codex/skills/pacer/SKILL.md'))).toBe(true);expect(messages.join('\n')).toContain('Undo: pacer config set planner claude-code');});
test('confirmed unused account removal keeps its folder and cancels on default answer',async()=>{const ctx=fixture();writeFileSync(join(ctx.pacerHome,'strategy.yaml'),readFileSync(join(ctx.pacerHome,'strategy.yaml'),'utf8').replace('planner:','  unused: {kind: endpoint, usage: unmetered}\nplanner:'));const s=new DashboardSettings(ctx,{changed(){},report(){},command:async()=>{}});await s.handle(',');await select(s,'account-unused');await answer(s,'');await s.pending;expect(loadStrategy(ctx).accounts.unused).toBeDefined();await select(s,'account-unused');await answer(s,'y');await s.pending;expect(loadStrategy(ctx).accounts.unused).toBeUndefined();});
test('link prompts use sanitized Orca account ids without a login',async()=>{const ctx=fixture();ctx.run=async()=>({code:0,stderr:'',stdout:JSON.stringify({ok:true,result:{claude:{accounts:[]},codex:{accounts:[{id:'team-id',label:'Team',email:'private@example.invalid'}]},rateLimits:{}}})});let logins=0;const messages:string[]=[],s=new DashboardSettings(ctx,{changed(){},report:m=>messages.push(m),command:async()=>{},login:async()=>{logins++;return 0;}});await s.handle(',');await select(s,'account-link');await answer(s,'codex');await answer(s,'team');await answer(s,'team-id');await s.pending;expect(loadStrategy(ctx).accounts.team.orcaAccount).toBe('team-id');expect(logins).toBe(0);expect(messages.join('\n')).not.toContain('private@example.invalid');});
test('split horizontal arrows reach percentage controls as keys',async()=>{const {Keys}=await import('../src/dashboard/input');const keys=new Keys();expect(keys.feed('\x1b[')).toEqual([]);expect(keys.feed('D\x1b[C')).toEqual(['left','right']);});
test('failed login reports its exit status while retaining the configured account',async()=>{const ctx=fixture(),messages:string[]=[],s=new DashboardSettings(ctx,{changed(){},report:m=>messages.push(m),command:async()=>{},login:async()=>7});await s.handle(',');await select(s,'account-add');await answer(s,'codex');await answer(s,'work');await s.pending;expect(messages.join('\n')).toContain('Login exited 7');expect(loadStrategy(ctx).accounts.work).toBeDefined();});
test('settings hides mutations absent from hello.ops and ignores their shortcuts',async()=>{
 const calls:any[]=[],s=new DashboardSettings(fixture(),{changed(){},report(){},command:async c=>{calls.push(c);},ops:()=>[]});
 await s.handle(',');expect(s.rows().filter(r=>r.run)).toEqual([]);
 for(const key of ['a','l','r','n','u','c','s'])await s.handle(key);
 expect(s.prompt).toBeNull();expect(calls).toEqual([]);
});

import migrationFixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot } from "../src/view-model/snapshot";
test("settings reads account usage and executor blocks from the current read model",async()=>{
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"accounts:\n  personal: {kind: claude}\n  team: {kind: codex}\nplanner: claude-code\npacing: {order: [codex]}\nrouting:\n  - default: [codex]\n");
 const s=structuredClone(migrationFixture) as unknown as ClientSnapshot;
 Object.defineProperty(s,"budget",{get(){throw new Error("Legacy budget read");}});s.accounts![0]!.usedPct=42;s.executors![1]={...s.executors![1]!,id:"codex",state:"blocked",reason:"user"};
 const calls:unknown[]=[];
 const settings=new DashboardSettings(ctx,{snapshot:()=>s,changed(){},report(){},command:async c=>{calls.push(c);},ops:()=>["runner.unblock","account.remove"]});
 expect(settings.rows().find(r=>r.id==="account-team")?.text).toContain("42% used");
 expect(settings.rows().find(r=>r.id==="executor-codex")?.text).toContain("Disabled");
 await settings.handle(",");settings.selected=settings.rows().findIndex(r=>r.id==="executor-codex");await settings.handle("enter");await settings.pending;
 expect(calls).toEqual([{cmd:"unblock",executor:"codex"}]);
});

test("settings board renders fixture meters, executors and hosts at 80 and 120 columns",async()=>{
 const ctx=fixture();ctx.now=migrationFixture.at;
 const snapshot=structuredClone(migrationFixture) as unknown as ClientSnapshot;
 const settings=new DashboardSettings(ctx,{snapshot:()=>snapshot,changed(){},report(){},command:async()=>{}});
 await settings.handle(",");
 for(const width of [80,120]){
  const text=renderDashboard(snapshot,width,45,snapshot.at,{selected:0,noColor:true,settings});
  expect(text).toContain("PLANNER & PACING");expect(text).toContain("HOSTS");
  expect(text.split("\n").every(line=>line.length<=width)).toBe(true);
  expect(text).toMatchSnapshot();
 }
});

test("settings executor and host checks dispatch advertised ops",async()=>{
 const ctx=fixture(),calls:unknown[]=[];
 const snapshot=structuredClone(migrationFixture) as unknown as ClientSnapshot;
 const settings=new DashboardSettings(ctx,{snapshot:()=>snapshot,ops:()=>["runner.check","host.check"],changed(){},report(){},command:async action=>{calls.push(action);}});
 await settings.handle(",");
 settings.selected=settings.rows().findIndex(r=>r.id==="executor-codex");
 await settings.handle("t");await settings.pending;
 settings.selected=settings.rows().findIndex(r=>r.id==="host-devbox");
 await settings.handle("c");await settings.pending;
 expect(calls).toEqual([
  {label:"Run executor check",op:"runner.check",params:{id:"codex"}},
  {label:"Run host checks",op:"host.check",params:{alias:"devbox"}},
 ]);
});

import { desktopStatus } from './fixtures/desktop-update/status';
test('desktop TUI actions use displayed revision/version and require restart confirmation',async()=>{
 const calls:any[]=[],status=desktopStatus({phase:'ready',target:'0.2.4',revision:8,actions:['restart','check','configure']});
 const s=new DashboardSettings(fixture(),{snapshot:()=>({...emptySnapshot(),desktopUpdates:[status]}),ops:()=>['desktop.update.restart','desktop.update.check','desktop.update.configure'],changed(){},report(){},command:async c=>{calls.push(c);}});
 await s.handle(',');expect(s.rows().some(r=>r.id==='update')).toBe(false);expect(s.rows().some(r=>r.text.includes('Restart to update'))).toBe(true);
 await s.handle('u');await tick();expect(s.prompt?.question).toContain('0.2.4');await answer(s,'n');await s.pending;expect(calls).toEqual([]);
 await s.handle('u');await tick();await answer(s,'y');await s.pending;expect(calls[0]).toMatchObject({op:'desktop.update.restart',params:{installationId:status.installationId,expectRevision:8,version:'0.2.4'}});
 await s.handle('c');await s.pending;expect(calls.at(-1).op).toBe('desktop.update.check');
});
test('desktop TUI configuration and cancellation require advertised actions; multiple installations require selection',async()=>{
 const calls:any[]=[],a=desktopStatus({phase:'waiting',actions:['cancel','configure']}),b=desktopStatus({installationId:'second',phase:'ready',target:'0.2.4',actions:['restart']});
 const s=new DashboardSettings(fixture(),{snapshot:()=>({...emptySnapshot(),desktopUpdates:[a,b]}),ops:()=>['desktop.update.cancel','desktop.update.configure','desktop.update.restart'],changed(){},report(){},command:async c=>{calls.push(c);}});
 await s.handle(',');await s.handle('u');await s.pending;expect(calls).toEqual([]);expect(s.prompt).toBeNull();
 const cancel=s.rows().find(r=>r.text==='Cancel update')!;expect(cancel).toBeDefined();await cancel.run!();expect(calls.at(-1).op).toBe('desktop.update.cancel');
 const configure=s.rows().find(r=>r.text==='Download updates automatically: on')!;await configure.run!();expect(calls.at(-1)).toMatchObject({op:'desktop.update.configure',params:{autoDownload:false}});
 a.actions=[];expect(s.rows().some(r=>r.text==='Cancel update')).toBe(false);
});
test('desktop TUI confirms inspected service paths and cancels the adoption revision',async()=>{
 const {adoptionStatus}=await import('./fixtures/desktop-update/status');
 const calls:any[]=[],status=desktopStatus({revision:9,adoption:adoptionStatus(),actions:['adopt']});
 const s=new DashboardSettings(fixture(),{snapshot:()=>({...emptySnapshot(),desktopUpdates:[status]}),ops:()=>['desktop.update.adopt','desktop.update.adoptCancel'],changed(){},report(){},command:async c=>{calls.push(c);}});
 await s.handle(',');await s.handle('u');await tick();
 expect(s.prompt?.question).toContain(status.adoption!.currentServiceExecutable);expect(s.prompt?.question).toContain(status.adoption!.replacementServiceExecutable);
 await answer(s,'n');await s.pending;expect(calls).toEqual([]);
 await s.handle('u');await tick();await answer(s,'y');await s.pending;
 expect(calls.at(-1)).toMatchObject({op:'desktop.update.adopt',params:{expectRevision:9}});
 status.adoption=adoptionStatus({phase:'waiting',revision:2});status.actions=['adoptCancel'];
 await s.rows().find(r=>r.text==='Cancel service change')!.run!();
 expect(calls.at(-1)).toMatchObject({op:'desktop.update.adoptCancel',params:{expectRevision:2}});
});
