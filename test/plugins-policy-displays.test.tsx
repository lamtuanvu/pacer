import uiSnapshot from './fixtures/ui/snapshot.json';
import type {ClientSnapshot} from '../src/view-model/snapshot';
import {expect,test,afterEach} from 'bun:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {renderToString} from 'preact-render-to-string';
import {fakeCtx} from './helpers';
import {capacityFixture} from './read-model-helpers';
import {buildReadModel} from '../src/api/read-model';
import {emptySnapshot} from '../src/link/envelope';
import {renderDashboard} from '../src/dashboard/render';
import {renderLine} from '../src/render/line';
import {renderText} from '../src/render/text';
import {setupText} from '../src/setup/checklist';
import {SetupView} from '../app/src/screens/setup/Setup';
import {SetupBanner} from '../app/src/screens/setup/SetupBanner';
import {SetupContext} from '../app/src/screens/setup/context';
import {TaskContext} from '../app/src/screens/task-shared';
import {initialState} from '../app/src/data/store';
import {DispatchView} from '../app/src/screens/dispatch/Dispatch';
import {Tray} from '../app/src/tray/Tray';
import {createApi} from '../app/src/data/api';
import {createTrayIpc} from '../app/src/tray/ipc';
import {pluginRegistry,shutdownPlugins} from '../src/plugins';
import {createActionRunner} from '../app/src/data/actions';
const runner=createActionRunner({call:async<T,>()=>({} as T),waitFor:async()=>true,refetch(){},navigate(){}});
const homes:ReturnType<typeof fakeCtx>[]=[];
afterEach(async()=>{for(const ctx of homes.splice(0))await shutdownPlugins(ctx);});
for(const mode of ['open','closed'] as const) test(`metadata snapshot and terminal/tray displays expose ${mode} with zero policy starts`,()=>{
 const ctx=fakeCtx();homes.push(ctx);let starts=0;
 pluginRegistry(ctx,{bundled:[],spawnBundled:()=>{starts++;throw Error('must not start');}});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:'claude-code',providers:{'claude-code':{}},plugins:{policy:{mode}}}));
 const {st,s}=capacityFixture(),setup={checkedAt:ctx.now,complete:true,ready:true,items:[]};
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks:[],hosts:[],setup});
 expect(model).toHaveProperty('policy',{mode,plugins:0});
 expect(model.setup.policy).toBe(model.policy);
 const words=mode==='open'?'policy: open':'policy: closed (0 plugins)';
 const snapshot={...emptySnapshot(),...model};
 expect(setupText({...setup,policy:model.policy})).toContain(words);
 expect(renderText(st,model.policy)).toContain(words);
 expect(renderLine(snapshot,{color:false,width:140})).toContain(words);
 expect(renderDashboard(snapshot,140,35,ctx.now,{noColor:true})).toContain(words);
 const html=renderToString(<Tray snapshot={snapshot} api={createApi()} ipc={createTrayIpc({location:{assign(){}}})}/>);
 expect(html).toContain(words);
 expect(starts).toBe(0);
});
test('old snapshots show unknown policy instead of implying a failure mode',()=>{
 const snapshot=emptySnapshot();
 expect(renderDashboard(snapshot,140,35,100,{noColor:true})).toContain('policy: unknown');
});

for(const mode of ['open','closed'] as const) test(`web setup, Dispatch home and banner expose ${mode} policy metadata with count available`,()=>{
 const policy={mode,plugins:2},words=mode==='open'?'policy: open':'policy: closed (2 plugins)';
 const caption=mode==='open'?'policy: open · 2 enabled plugins · a failing plugin is ignored':'policy: closed (2 plugins) · a failing plugin blocks the action';
 const checklist={checkedAt:1,complete:true,ready:false,policy,items:[{id:'first',title:'First delegation',status:'pending' as const,required:false}]};
 const api=createApi(),query={repo:null,scope:null};
 const setup=renderToString(<TaskContext.Provider value={{api,state:initialState()}}><SetupView checklist={checklist} query={query}/></TaskContext.Provider>);
 expect(setup).toContain(words);
 // The Dispatch page names the policy, so the banner above it does not repeat it (UI-15).
 const banner=renderToString(<SetupContext.Provider value={{checklist,refresh(){},setRunning(){}}}><SetupBanner/></SetupContext.Provider>);
 expect(banner).toContain('Finish setting up pacer');expect(banner).not.toContain('policy:');
 // The Dispatch home (#443) replaced Overview; its live line names the policy mode and what it does as visible text.
 const overview=renderToString(<SetupContext.Provider value={{checklist,refresh(){},setRunning(){}}}><DispatchView snapshot={{...emptySnapshot(),policy}} query={query} now={100} runner={{} as never}/></SetupContext.Provider>);
 expect(overview).toContain(caption);expect(overview.match(/policy:/g)).toHaveLength(1);
 for(const html of [setup,overview])expect(html).not.toMatch(/title="[^"]*policy/);
});
// PR #494 live run: narrow Dispatch showed no policy mode outside the one setup state that shows the banner.
const SETUP_STATES={ready:{complete:true,ready:true,items:[]},optional:{complete:true,ready:false,items:[{id:'first',title:'First delegation',status:'pending' as const,required:false}]},incomplete:{complete:false,ready:false,items:[{id:'service',title:'Service',status:'pending' as const,required:true}]}};
for(const [state,setup] of Object.entries(SETUP_STATES)) for(const mode of ['open','closed'] as const) test(`narrow Dispatch shows the ${mode} policy once with setup ${state}`,()=>{
 const policy={mode,plugins:2},checklist={checkedAt:1,policy,...setup};
 for(const [label,extra] of [['empty',{}],['first run',{firstRun:<p>Start here</p>}],['working',{}]] as const){
  const snapshot=label==='working'?{...structuredClone(uiSnapshot),policy} as ClientSnapshot:{...emptySnapshot(),policy};
  const html=renderToString(<SetupContext.Provider value={{checklist,refresh(){},setRunning(){}}}><DispatchView snapshot={snapshot} query={{repo:null,scope:'repo:github.com/acme/api'}} now={100} runner={runner} {...extra}/></SetupContext.Provider>);
  expect(html).not.toContain('<h1>');
  expect(html).toContain(`<span class="pc-dispatch__policy muted">${mode==='open'?'policy: open · 2 enabled plugins · a failing plugin is ignored':'policy: closed (2 plugins) · a failing plugin blocks the action'}</span>`);
  expect(html.match(/policy:/g)).toHaveLength(1);
 }
});
test('tray policy caption sits inside the padded planner section with visible detail',()=>{
 const snapshot={...structuredClone(uiSnapshot),policy:{mode:'closed' as const,plugins:2}} as ClientSnapshot;
 const html=renderToString(<Tray snapshot={snapshot} api={createApi()} ipc={createTrayIpc({location:{assign(){}}})}/>);
 const start=html.search(/<section[^>]*class="tray-planner"/),planner=html.slice(start,html.indexOf('</section>',start));
 expect(start).toBeGreaterThanOrEqual(0);
 expect(planner).toContain('<div class="tray-policy">policy: closed (2 plugins) · a failing plugin blocks the action</div>');
 expect(html.match(/policy:/g)).toHaveLength(1);expect(html).not.toMatch(/title="[^"]*policy/);
});
test('polled snapshot keeps enabled policy count current without starting the installed plugin',()=>{
 const ctx=fakeCtx();homes.push(ctx);let starts=0;
 pluginRegistry(ctx,{bundled:[],spawnBundled:()=>{starts++;throw Error('must not start');},spawn:(()=>{starts++;throw Error('must not start');}) as never});
 const dir=join(ctx.pacerHome,'plugins','fx-policy');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'pacer-plugin.json'),JSON.stringify({id:'fx-policy',version:'1.0.0',publisher:'test',host:'^1.5',entry:'main.ts',capabilities:[],contributes:{policy:{}}}));
 const config=(mode:string)=>writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:'claude-code',providers:{'claude-code':{}},plugins:{policy:{mode},installed:{'fx-policy':{version:'1.0.0',capabilities:[]}}}}));
 const {st,s}=capacityFixture(),setup={checkedAt:ctx.now,complete:true,ready:true,items:[],policy:{mode:'open' as const,plugins:0}};
 config('open');const first=buildReadModel(ctx,{status:st,strategy:s,tasks:[],hosts:[],setup});expect(first.policy).toEqual({mode:'open',plugins:1});
 config('closed');const next=buildReadModel(ctx,{status:st,strategy:s,tasks:[],hosts:[],setup});expect(next.policy).toEqual({mode:'closed',plugins:1});expect(next.setup.policy).toBe(next.policy);
 expect(starts).toBe(0);
});
test('backend status supplies policy metadata for classic status JSON and installed statusline',async()=>{
 const {computeStatus}=await import('../src/engine/status');
 const ctx=fakeCtx();homes.push(ctx);let starts=0;
 pluginRegistry(ctx,{bundled:[],spawnBundled:()=>{starts++;throw Error('must not start');}});
 mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:'claude-code',providers:{'claude-code':{}},plugins:{policy:{mode:'closed'}}}));
 const {s}=capacityFixture();const st=await computeStatus(ctx,s,{cacheOnly:true,profile:null});
 expect(JSON.parse(JSON.stringify(st)).policy).toEqual({mode:'closed',plugins:0});
 expect(renderText(st)).toContain('policy: closed (0 plugins)');
 expect(renderLine(st,{color:false,width:140})).toContain('policy: closed (0 plugins)');
 expect(starts).toBe(0);
});
for(const width of [20,40,60,80,120]) for(const policy of [{mode:'closed' as const,plugins:0},{mode:'closed' as const,plugins:123456},{mode:'open' as const,plugins:2},undefined]) test(`statusline retains policy metadata at ${width} columns for ${policy?.mode??'unknown'} ${policy?.plugins??''}`,()=>{
 const snapshot={...structuredClone(uiSnapshot),policy} as ClientSnapshot;
 const line=renderLine(snapshot,{color:false,width});
 expect(line.length).toBeLessThanOrEqual(width);
 expect(line).toMatch(/policy:\s?(closed|open|unknown)/);
 if(policy?.mode==='closed')expect(line).toMatch(new RegExp(`closed(?: \\(|/)${policy.plugins}(?: plugins\\))?`));
 if(width>=60)expect(line).toContain(policy?.mode==='closed'?`policy: closed (${policy.plugins} plugins)`:policy?.mode==='open'?'policy: open':'policy: unknown');
});
for(const width of [60,80,120]) for(const update of [undefined,'available','failed','current','disabled'] as const) test(`TUI closed0 preserves primary and help at ${width} columns with ${update??'no update'}`,()=>{
 const snapshot={...emptySnapshot(),policy:{mode:'closed' as const,plugins:0},attention:[{id:'problem',kind:'failed' as const,severity:'problem' as const,title:'Needs check',detail:'Check executor',raisedAt:1,since:1,notify:'all' as const,repo:null,actions:[{label:'Run checks',op:'runner.check',params:{id:'codex'}}]}]};
 const frame=renderDashboard(snapshot,width,30,100,{noColor:true,update,ops:['runner.check']});
 const footer=frame.split('\n').at(-1)!;
 expect(footer).toContain('Run checks');expect(footer).toContain('? help');
 expect(footer).toMatch(/policy:\s?closed(?: \(0 plugins\)|\/0)/);
 expect(footer).not.toContain('…');expect(footer.length).toBeLessThanOrEqual(width);
});

for(const unicode of [true,false]) test(`minimum TUI footer keeps closed0 and complete help with unicode=${unicode}`,()=>{
 const snapshot={...structuredClone(uiSnapshot),policy:{mode:'closed' as const,plugins:0}} as ClientSnapshot;
 const frame=renderDashboard(snapshot,60,30,100,{theme:{depth:'truecolor',appearance:'dark',unicode,motion:false,plain:false},update:'failed'});
 const footer=frame.split('\n').at(-1)!.replace(/\x1b\[[0-9;]*m/g,'');
 expect(footer).toContain('Run checks');expect(footer).toContain('x dismiss');expect(footer).toContain('? help');expect(footer).toContain('policy:closed/0');
 expect(footer).not.toContain('…');expect(footer.length).toBeLessThanOrEqual(60);
});
// PR #494 live run: the policy token displaced 'd delegate' at 120 and 'x dismiss' / '. actions' at 80.
const KEY_HINTS:Record<number,string[]>={120:['Run checks','x dismiss','. actions (3)','f repo scope','d delegate','? help'],80:['Run checks','x dismiss','. actions (3)','? help'],60:['Run checks','x dismiss','? help']};
for(const width of [120,80,60]) for(const update of [undefined,'available','disabled','current'] as const) for(const policy of [{mode:'open' as const,plugins:0},{mode:'closed' as const,plugins:2},{mode:'closed' as const,plugins:123456}]) test(`TUI footer keeps existing key hints ahead of ${policy.mode}/${policy.plugins} policy at ${width} columns with ${update??'no update'}`,()=>{
 const snapshot={...structuredClone(uiSnapshot),policy} as ClientSnapshot;
 const footer=renderDashboard(snapshot,width,30,100,{noColor:true,update,version:'0.12.0'}).split('\n').at(-1)!;
 for(const hint of KEY_HINTS[width]!)expect(footer).toContain(hint);
 expect(footer).not.toContain('…');expect(footer.length).toBeLessThanOrEqual(width);
 // The policy token shows whole or shortened, never cut.
 if(footer.includes('policy'))expect(footer).toMatch(/policy: (open|closed \(\d+ plugins\))|policy:(open|closed)\/\d+/);
});
test('TUI footer shows the policy token wherever it fits beside the key hints',()=>{
 const snapshot={...structuredClone(uiSnapshot),policy:{mode:'closed' as const,plugins:2}} as ClientSnapshot;
 const footer=(width:number,update?:'disabled')=>renderDashboard(snapshot,width,30,100,{noColor:true,update,version:'0.12.0'}).split('\n').at(-1)!;
 expect(footer(160,'disabled')).toContain('policy: closed (2 plugins) · pacer 0.12.0 · update checks off');
 expect(footer(120)).toContain('policy: closed (2 plugins) · pacer 0.12.0');
 expect(footer(120,'disabled')).toContain('policy:closed/2 · update checks off');
 expect(footer(80)).toContain('policy:closed/2');
});
