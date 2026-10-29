import { desktopStatus } from "./fixtures/desktop-update/status";
import { SettingsPanel } from '../app/src/shell/SettingsPanel';
import { StrategyQuickAccessPopup } from '../app/src/shell/StrategyQuickAccess';
import { expect, test } from 'bun:test';
import { SetupEditor } from '../app/src/screens/settings/DispatcherSetup';
import { SavedSetups } from '../app/src/screens/settings/Dispatcher';
import { dispatchConfigSchema } from '../src/dispatch/types';
import { clock } from "../src/view-model/format";
import { renderToString } from 'preact-render-to-string';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { machineNow } from '../app/src/screens/settings/General';
import { SettingsGeneral, AddExecutor, RemoteHosts, HostDetail, JobProgress, executorId, executorReady, performOperation } from '../app/src/screens/settings/index';
import { settings, host, executor, job } from './fixtures/ui/settings';
const state = {...initialState(),snapshot:{executors:[executor],accounts:[],hosts:[{...host,executors:[executor.id],repos:1}],planner:{agent:'codex',runner:'codex#team',advice:'Keep planning'},repos:[]} as any};
const api = {call:async()=>({}),hello:async()=>({}),snapshot:async()=>({})} as any;
const render = (child:any,s=state) => renderToString(<TaskContext.Provider value={{state:s,api}}>{child}</TaskContext.Provider>);
test('the executor pool offers only executors that are not already in a rule', () => {
 const view={strategy:'default',planner:'codex',plannerAccount:'work',source:'built-in' as const,config:dispatchConfigSchema.parse({})};
 const html=render(<SetupEditor view={view} eligibility={{kind:'global',rules:[{kinds:['tests'],executors:['codex']},{executors:['codex']}],available:['codex','cursor']}} onSaved={()=>{}} onDirtyChange={()=>{}}/>);
 expect(html).toContain('Add Cursor');
 expect(html).not.toContain('Add Codex');
 expect(html).toContain('Rule 1 task kinds');
});
test('Dispatcher owns saved setups and executor eligibility', () => {
 expect(render(<SettingsGeneral section="dispatcher" initialData={settings}/>)).toContain('Loading dispatcher');
 const html=render(<SavedSetups initialData={settings.strategies}/>);
 expect(html).toContain('Saved setups');
 expect(html).toContain('id="saved-profiles"');
});
test('rail quick access has one Dispatcher settings link',()=>{
 const html=render(<StrategyQuickAccessPopup route={{name:"settings",section:"dispatcher",query:{repo:null,scope:null}}} close={()=>{}}/>);
 expect(html).toContain('Open Dispatcher settings');
 expect(html).not.toContain('Edit Routing Rules');
 expect(html).not.toContain('Manage Strategies');
});
test('Planner uses the actual planner agent without mounting other settings',()=>{
 const html=render(<SettingsGeneral section="planner" initialData={settings}/>);
 expect(html).toContain('aria-label="Codex"');
 expect(html).toContain('Review integration changes');
 expect(html).not.toContain('Link Orca account');
 expect((html.match(/pc-btn--primary/g)||[]).length).toBeLessThanOrEqual(1);
});
test('executor and update checkboxes keep their labels inline', () => {
 const html = render(<SettingsGeneral section="executors" initialData={settings}/>) + render(<SettingsGeneral section="updates" initialData={settings}/>);
 const labels = [...html.matchAll(/<label class="pc-checkbox">([\s\S]*?)<\/label>/g)];
 // The update row's checkbox sits in a bare hit-area label; SettingRow's own label names it.
 expect(labels).toHaveLength(1);
 for (const [, body] of labels) { expect(body).toMatch(/class="[^"]*pc-checkbox__input[^"]*"/); expect(body).toContain('type="checkbox"'); }
 expect(labels[0]![1]).toContain('Enabled');
 // The update preference is a SettingRow: its label names the checkbox.
 const id = /<label[^>]*for="([^"]+)"[^>]*>Check automatically<\/label>/.exec(html)?.[1];
 expect(html).toMatch(new RegExp(`<input(?=[^>]*type="checkbox")(?=[^>]*id="${id}")`));
});
test('all General sections provide loading and empty states',()=>{
 expect(render(<SettingsGeneral section="planner"/>)).toContain('Loading');
 const empty={...state,snapshot:{...state.snapshot,executors:[],hosts:[]}};
 const html=["accounts","executors","dispatcher"].map(section=>render(<SettingsGeneral section={section} initialData={{...settings,accounts:[],strategies:[],routing:{rules:[],available:[]}}}/>,empty)).join("")+render(<RemoteHosts/>,empty)+render(<SavedSetups initialData={[]}/>,empty);
 for(const word of ['No accounts','No executors','No remote hosts','Loading dispatcher','No saved setups'])expect(html).toContain(word);
});
test('wizard has four board steps and never claims ready before a passed check',()=>{
 const html=render(<AddExecutor/>);for(const word of ['Agent','Account','Where','Model &amp; checks','Executor id'])expect(html).toContain(word);
 expect(html).not.toContain('is ready');
 expect(executorId({agent:'codex',account:'team',host:'devbox'})).toBe(executor.id);
 expect(executorReady(job)).toBe(false);expect(executorReady({...job,state:'passed'})).toBe(true);expect(executorReady({...job,state:'failed'})).toBe(false);
});
test('host board includes management sections, facts and service supplied branch fate',()=>{
 const html=render(<HostDetail alias="devbox" initialData={host}/>);
 expect(html).toContain('pc-page--full');expect(html).toContain('aria-label="Breadcrumb"');
 for(const text of ['Run checks','Open SSH terminal','Pause new work','Max parallel tasks','Repositories','Map a repo','Account folders on host','Worktrees on host','kept','Remove host'])expect(html).toContain(text);
 expect(html).toContain('aria-label="Codex"');expect(html).toContain('disabled');expect(html).not.toContain('Full sessions');
});
test('host list and detail expose loading and empty states',()=>{
 expect(render(<RemoteHosts/>)).toContain('devbox');expect(render(<HostDetail alias="missing"/>)).toContain('Loading');
 expect(render(<RemoteHosts/>,{...state,snapshot:{...state.snapshot,hosts:[]}})).toContain('No remote hosts');
});
test('job progress uses service words and steps, including error hints',()=>{
 const html=renderToString(<JobProgress job={{...job,state:'failed',error:{code:'bad',message:'Check failed',hint:'Sign in on host'}}}/>);
 for(const text of ['CLI found','Test task','Failed','Check failed','Sign in on host'])expect(html).toContain(text);
});
test('operation helper preserves response and error details, and follows bare or wrapped jobs',async()=>{
 const calls:any[]=[];
 const result=await performOperation(async(op,p)=>{calls.push([op,p]);return {job,message:'Checking host',hint:'Keep SSH available'} as any;},'runner.check',{id:executor.id});
 expect(result.job).toEqual(job);expect(result.message).toBe('Checking host');expect(result.hint).toBe('Keep SSH available');expect(calls).toEqual([['runner.check',{id:executor.id}]]);
 const bare=await performOperation(async()=>job as any,'runner.check',{});expect(bare.job).toEqual(job);
 await expect(performOperation(async()=>{throw new Error('Service refused');},'host.remove',{})).rejects.toThrow('Service refused');
});
test('terminal job state wins over an older running event',async()=>{
 const {latestJob}=await import('../app/src/screens/settings/shared');
 expect(latestJob(job,{...job,state:'passed'})?.state).toBe('passed');
 expect(latestJob({...job,state:'failed'},job)?.state).toBe('failed');
});
test('section failures show the service hint and a retry action',async()=>{
 const {ResourceState}=await import('../app/src/screens/settings/shared');
 const {ApiError}=await import('../app/src/data/api');
 const html=renderToString(<ResourceState resource={{data:undefined,error:new ApiError('unavailable','Cannot read settings','Start pacer'),loading:false,reload:()=>{}}}><span/></ResourceState>);
 expect(html).toContain('Cannot read settings');expect(html).toContain('Start pacer');expect(html).toContain('Try again');
});
test('standalone screens bundle for the browser with their CSP compatible styles',async()=>{
 const {APP_JS_BUDGET}=await import('../app/build');
 // Split like the shipped app, so lazy screens leave the entry chunk the browser loads first.
 const result=await Bun.build({entrypoints:['app/src/screens/settings/index.ts'],target:'browser',minify:true,splitting:true});
 expect(result.success).toBe(true);
 const chunks=await Promise.all(result.outputs.filter(file=>file.path.endsWith('.js')).map(async file=>({path:file.path,kind:file.kind,text:await file.text()})));
 expect(chunks.filter(chunk=>chunk.kind==='entry-point')).toHaveLength(1);
 const all=chunks.map(chunk=>chunk.text).join('\n');expect(all).toContain('adoptedStyleSheets');expect(all).toContain('--surface-card');
 // Only the entry chunk counts against the UI-3 budget; lazily loaded chunks are fetched on demand (decisions.md, 2026-10-29).
 const entry=chunks.find(chunk=>chunk.kind==='entry-point')!;
 expect(Bun.gzipSync(entry.text).byteLength).toBeLessThan(APP_JS_BUDGET);
});
test('restored executor draft resumes checks and Ready follows a passed job only',()=>{
 const initialDraft={step:'4',agent:'codex',account:'team',host:'devbox',createdId:executor.id,jobId:job.id};
 const draw=(stateValue:'running'|'failed'|'passed')=>render(<AddExecutor initialDraft={initialDraft}/>,{...state,jobs:{[job.id]:{...job,state:stateValue}}});
 expect(draw('running')).toContain('Running checks');expect(draw('running')).not.toContain('is ready');
 expect(draw('failed')).toContain('Run checks again');expect(draw('failed')).not.toContain('is ready');
 expect(draw('passed')).toContain(`${executor.id} is ready`);expect(draw('passed')).toContain('>OK</a>');
});
test('new endpoint form includes URL, key source and model limits',()=>{
 // The URL form sits behind the OpenCode provider picker's "Use a URL instead".
 const html=render(<AddExecutor initialDraft={{step:'2',agent:'opencode'}} initialUrlForm/>);
 for(const text of ['Base URL','API key environment variable','Context limit','Output limit','Unmetered — free or local','aria-haspopup="listbox"'])expect(html).toContain(text);
});
test('the shipped app.js, which includes the Settings screens, stays within the 60 KB gzip budget (UI-3)',async()=>{
 const {APP_JS_BUDGET,buildApp}=await import('../app/build');
 const app=(await buildApp()).find(file=>file.path==='app.js')!;
 expect(app.text).toContain('Remote hosts');
 expect(Bun.gzipSync(app.text).byteLength).toBeLessThan(APP_JS_BUDGET);
});
test('a passed host connection check cannot make an executor Ready',()=>{
 expect(executorReady({...job,kind:'host.check',state:'passed'})).toBe(false);
});

test('Accounts show usage words, sign-in pills, used-by and sign-in commands only in a disclosure',()=>{
 const accounts=[{name:'team',kind:'codex',signedIn:true,runners:[executor.id]},{name:'empty',kind:'codex',signedIn:false,state:'no_subscription'},{name:'unknown',kind:'codex'},
  {name:'out',kind:'codex',signedIn:false,signin_command:'CODEX_HOME=$HOME/.codex-out codex login'},{name:'local',kind:'endpoint',signedIn:null,state:'ready'},{name:'nokey',kind:'endpoint',signedIn:null,state:'key_missing'}];
 const s={...state,snapshot:{...state.snapshot,accounts:[{name:'team',agent:'codex',usedPct:17,window:'week',resetsAt:Date.UTC(2026,9,19)/1000,verdict:'ON_PACE',signedIn:true,executors:[executor.id]}]}};
 const html=render(<SettingsGeneral section="accounts" initialData={{...settings,accounts}}/>,s);
 expect(html).toContain(`17% of week · resets ${clock(Date.UTC(2026,9,19)/1000,Date.now()/1000)}`);expect(html).not.toContain('ON_PACE');
 for(const label of ['Signed in','No subscription','Unknown','Signed out','Ready','Key missing'])expect(html).toMatch(new RegExp(`pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?${label}</span>`));
 expect(html).toContain('<th>Status</th>');expect(html).not.toContain('<th>Sign-in</th>');
 expect(html).toContain('<th>Used by</th>');expect(html).toContain(executor.id);
 // Sign-in help only for native accounts known to be signed out (here: empty and out), never for endpoints.
 expect(html.match(/<summary>Fix sign-in<span class="sr-only"> for [a-z]+<\/span><\/summary>/g)).toHaveLength(2);
 expect(html).toContain('<summary>Fix sign-in<span class="sr-only"> for empty</span></summary>');
 expect(html).toMatch(/<details class="pc-disclosure"><summary>Fix sign-in<span class="sr-only"> for out<\/span><\/summary><code>CODEX_HOME=/);expect(html).not.toContain('<details open');
});

test('Ark CLI quota authentication errors show recovery in the affected account',()=>{
 const accounts=[{name:'coding-plan',kind:'endpoint',quotaSource:'arkcli',state:'not_tested',usageReading:{windows:[],error:'Ark CLI sign-in required. Run arkcli auth login.',availability:{state:'unknown',reason:'authentication_failed'}}}];
 const html=render(<SettingsGeneral section="accounts" initialData={{...settings,accounts}}/>);
 expect(html).toContain('Fix Ark CLI sign-in');
 expect(html).toContain('arkcli auth login');
 expect(html).toContain('Refresh usage');
 expect(html).not.toContain('No subscription');
});

test('multiple accounts retains the threshold as a board row, disabled only for Spread',()=>{
 for(const mode of ['spread','fill']) {
  const html=render(<SettingsGeneral section="planner" initialData={{...settings,config:{...settings.config,keys:{...settings.config.keys,'pacing.accounts':{value:mode}}}}}/>);
  expect(html).toContain('class="pc-budget-threshold"');
  expect(html).toContain('Move to the next account at');
  expect(html).toContain('% used');
  expect(html).toMatch(mode==='spread'?/max="100" disabled value="80"/:/max="100" value="80"/);
 }
});

test('settings navigation gives assignment policy one destination',()=>{
 const html=renderToString(<SettingsPanel route={{name:"settings",section:"dispatcher",query:{repo:null,scope:null}}} counts={null}/>);
 expect(html).toContain('aria-current="page"');
 expect(html).toContain('Dispatcher');
 expect(html).not.toContain('>Routing<');
 expect(html).not.toContain('>Strategies<');
});

test('settings feedback explains automatic migration in plain language',async()=>{
 const result=await performOperation(async()=>({id:'codex',migrated:{backup:'strategy.yaml.pre-accounts.bak'}}) as any,'runner.set',{id:'codex',max_tasks:2});
 expect(result.message).toBe('Saved.');
 expect(result.hint).toBe('Updated your settings file to the current format. A backup was saved.');
});
test('General exposes named parallel tasks controls and shared capacity notes',()=>{
 const limited={...executor,rank:1,slots:{used:0,max:4},limitedBy:'machine'};
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine:{used:0,max:2},executors:[limited]}});
 expect(html).toContain('Parallel tasks for '+executor.id);
 expect(html).toContain('Limited to 2 by this machine');
 const machine=render(<SettingsGeneral section="machine" initialData={settings}/>);
 expect(machine).toContain('Parallel tasks on this machine');
 expect(machine).toContain('Shared by all executors that run on this machine.');
 expect(html).toContain('min="1" max="16" step="1"');
 expect(html).not.toContain('>Slots<');
 const planner=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,executors:[{...limited,rank:'planner'}]}});
 expect(planner).not.toContain('Parallel tasks for '+executor.id);
});
test('This machine shows the guard state now and no limit by default',()=>{
 const machine={used:3,max:Number.MAX_SAFE_INTEGER,hardCap:null,unlimited:true,memoryPressure:'critical' as const,memoryPressureLimit:'critical' as const,loadPerCore:4.92,loadLimit:null,open:false,reason:'machine_memory_pressure' as const,detail:'memory pressure critical'};
 const html=render(<SettingsGeneral section="machine" initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine}});
 expect(html).toContain('Now: memory pressure critical · load 4.9 per core · 3 running · new tasks wait: memory pressure critical');
 expect(html).toContain('No limit');
 expect(html).toContain('Hold new tasks at memory pressure');
 expect(html).toContain('Load limit per CPU core');
 const unavailable=render(<SettingsGeneral section="machine" initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine:{used:0,max:4,hardCap:4,unlimited:false,memoryPressure:null,loadPerCore:null,open:true,detail:'memory pressure signal unavailable'}}});
 expect(unavailable).toContain('Now: memory pressure unavailable · 0 running of 4');
 expect(machineNow(undefined)).toBeNull();
 const overview=render(<SettingsGeneral initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine}});
 expect(overview).toContain('No limit');
 // The legacy max stands in for "no cap" for 3.0 clients and is never shown.
 for(const page of [html,overview])expect(page).not.toContain(String(Number.MAX_SAFE_INTEGER));
 expect(render(<SettingsGeneral initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine:{used:0,max:3}}})).toContain('3 parallel');
});
test('board pages render their headline and other editors retain shell titles', () => {
 expect(render(<SettingsGeneral section="planner" initialData={settings}/>)).toContain('<h1>Budget &amp; pacing</h1>');
 for (const child of [<AddExecutor/>, <RemoteHosts/>, <HostDetail alias="devbox" initialData={host}/>]) {
  expect(render(child)).not.toContain('<h1');
 }
 const emptyState = {...state,snapshot:{...state.snapshot,hosts:[]}};
 expect(render(<RemoteHosts/>, emptyState)).not.toContain('>Remote hosts</h2>');
 expect(render(<SettingsGeneral section="machine" initialData={settings}/>, emptyState)).toContain('href="#/settings/hosts"');
});

test('Settings and host executors share uncertainty; retained account usage is historical',()=>{
 const decision={state:'uncertain',reasons:[{code:'budget_expired_or_unknown',evidenceIds:[]}],evaluatedAt:1000,validUntil:null,evidenceAgeS:null,availability:'unknown',budget:'unknown',spendingRisk:'unknown'} as const;
 const uncertain={...executor,eligibility:decision};
 const snapshot={...state.snapshot,at:1000,executors:[uncertain],accounts:[{name:settings.accounts![0]!.name,usedPct:61,window:'5h',stale:true,eligibility:decision}]};
 const general=render(<SettingsGeneral section="accounts" initialData={settings}/>,{...state,snapshot});
 const executors=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot});
 expect(executors).toContain('Uncertain fallback');expect(general).toContain('Historical usage');expect(general).toContain('Observation time unknown');
 const remote=render(<HostDetail alias="devbox" initialData={{...host,executors:[uncertain] as any}}/>);
 expect(remote).toContain('Uncertain fallback');
 const known={...uncertain,eligibility:{...decision,evaluatedAt:state.snapshot.at??Date.now()/1000,evidenceAgeS:10800}};
 expect(render(<HostDetail alias="devbox" initialData={{...host,executors:[known] as any}}/>)).toContain('observed 3h ago');
});

test('Agents copy matches routing: a failed check does not skip an executor',()=>{
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>);
 expect(html).not.toContain('skipped until it passes again');
 expect(html).toContain('Unavailable executors are skipped; warning states may still receive work.');
});

test('a not-tested endpoint executor reads Not tested, not Ready, in Agents',()=>{
 const row={...executor,id:'opencode#lab',agent:'opencode',account:'lab',host:null,state:'ready',untested:true,reason:'not tested — run a check',lastCheck:null} as any;
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,executors:[row]}});
 expect(html).toMatch(/pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Not tested<\/span>/);
 expect(html).not.toMatch(/pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Ready<\/span>/);
});
test('an untested endpoint keeps its eligibility decision and its unchecked status',()=>{
 const eligibility={state:'uncertain',reasons:[{code:'budget_missing',evidenceIds:[]}],evaluatedAt:1000,validUntil:null,evidenceAgeS:null,availability:'unknown',budget:'unknown',spendingRisk:'unknown'} as const;
 const row={...executor,id:'opencode#lab',agent:'opencode',account:'lab',host:null,state:'ready',untested:true,eligibility,lastCheck:null} as any;
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,at:1000,executors:[row]}});
 expect(html).toContain('Uncertain fallback');
 expect(html).toContain('No budget observation is available · Not tested');
 expect(html).not.toMatch(/pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*<\/span>)?Ready<\/span>/);
});
test('an executor row states its reason once, not again under Last check',()=>{
 const detail='Sign in to account cwork (signed out — run claude and log in)';
 const row={...executor,state:'down',reason:'signed out — run claude and log in',lastCheck:{at:100,passed:false,detail}} as any;
 const failing={...executor,id:'claude-code#main',state:'failing',reason:'test task failed: Not logged in',lastCheck:{at:100,passed:false,detail:'test task failed: Not logged in'}} as any;
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,executors:[row,failing]}});
 expect(html.split('signed out — run claude and log in').length-1).toBe(1);
 expect(html.split('test task failed: Not logged in').length-1).toBe(1);
});
test('Add executor offers sign-in only for a signed-out native account',()=>{
 const accounts=[{name:'work',kind:'endpoint',signedIn:null,state:'not_tested'},{name:'in',kind:'claude',signedIn:true},{name:'out',kind:'claude',signedIn:false}] as any;
 const html=(agent:string,account:string)=>render(<AddExecutor initialDraft={{step:'2',agent,account}} initialAccounts={accounts}/>);
 expect(html('opencode','work')).not.toContain('Sign in to work');
 expect(html('claude-code','in')).not.toContain('Sign in to in');
 expect(html('claude-code','out')).toContain('Sign in to out');
});
test('Accounts show an endpoint account\'s weekly dollar spend against its cap', () => {
 const name = settings.accounts[0]!.name;
 const html = render(<SettingsGeneral section="accounts" initialData={settings}/>, {...state, snapshot: {...state.snapshot, accounts: [{name, agent: 'opencode', usedPct: 64, spendUsdWeek: 3.2, capUsdWeek: 5, window: '7d $'}]}});
 expect(html).toContain('$3.20 of $5 this week');
});
test('historical endpoint usage keeps its weekly spend and cap', () => {
 const name = settings.accounts[0]!.name;
 const html = render(<SettingsGeneral section="accounts" initialData={settings}/>, {...state, snapshot: {...state.snapshot, accounts: [{name, agent: 'opencode', usedPct: 64, spendUsdWeek: 3.2, capUsdWeek: 5, window: '7d $', stale: true}]}});
 expect(html).toContain('$3.20 of $5 this week');
 expect(html).toContain('Historical usage · Observation time unknown');
});

test('Updates identifies the service and preserves failed-check status', () => {
 const html = render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.5.0',latest:'0.5.0',available:false}}}/>);
 expect(html).toContain('pacer 0.5.0');
 expect(html).toContain('Up to date');
 expect(html).not.toContain('Desktop app');
 const failed = render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.5.0',latest:'0.5.0',available:false,error:'offline'}}}/>);
 expect(failed).toContain('Update check failed');
 expect(failed).not.toContain('Up to date');
 const available = render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.3.1',latest:'0.5.0',available:true}}}/>);
 expect(available).toContain('Install 0.5.0');

});

test('eligible executors retain recent task failures separately from their passed check',()=>{
 const eligibility={state:'eligible',reasons:[],evaluatedAt:1000,validUntil:null,evidenceAgeS:0,availability:'available',budget:'available',spendingRisk:'none'} as const;
 const row={...executor,state:'failing',recentFailures:2,reason:'2 recent failures',eligibility,lastCheck:{at:1000,passed:true,detail:'Ready'}} as any;
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,at:1000,executors:[row]}}).split('<tbody>')[1]!.split('</tbody>')[0]!;
 expect(html).toContain('Eligible');
 expect(html).toContain('Recent task failures');
 expect(html).toContain('2 recent failures');
 expect(html).toContain('Passed');
 expect(html).not.toContain('Failing');
 const failedCheck=render(<SettingsGeneral section="executors" initialData={settings}/>,{...state,snapshot:{...state.snapshot,at:1000,executors:[{...row,lastCheck:{at:1000,passed:false,detail:'test task failed'}}]}}).split('<tbody>')[1]!.split('</tbody>')[0]!;
 expect(failedCheck).toContain('Failing');
 expect(failedCheck).toContain('Failed');
 expect(failedCheck).not.toContain('Recent task failures');
});

test('paged Updates keeps OTA controls, service identity and navigation status together', () => {
 const status = desktopStatus({current:'0.3.1',phase:'ready',target:'0.5.0',actions:['restart']});
 const updated = {...state,connected:true,version:'0.4.0',features:{readModel:true,ops:new Set(['desktop.update.restart'])},snapshot:{...state.snapshot,desktopUpdates:[status]}};
 const html=render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.4.0',latest:'0.5.0',available:true}}}/>,updated);
 expect(html).toContain('pacer desktop · 0.3.1');
 expect(html).toContain('Service 0.4.0');
 expect(html).toContain('Restart to update');
 expect(html).not.toContain('Update service and restart');
 expect(html).not.toContain('Pacing policy');
 const panel=renderToString(<SettingsPanel route={{name:'settings',section:'updates',query:{repo:null,scope:null}}} counts={null} snapshot={updated.snapshot}/>);
 expect(panel).not.toContain('pc-settings-nav__badge--info');
 expect(panel).not.toContain('title="Update ready"');
 expect(panel).toContain('>App preferences<');
 expect(panel.match(/aria-current="page"/g)).toHaveLength(1);
});

test('completed executor setup offers OK and another executor', () => {
 const initialDraft={step:'4',agent:'claude-code',account:'team',createdId:executor.id,jobId:job.id};
 const html=render(<AddExecutor initialDraft={initialDraft}/>,{...state,jobs:{[job.id]:{...job,state:'passed'}}});
 expect(html).toContain('Add another executor');
 expect(html).toContain('>OK</a>');
 expect(html).not.toContain('Cancel');
 expect(html).not.toContain('check before Ready');
 expect((html.match(/pc-btn--primary/g)||[]).length).toBe(1);
});

test('adding another executor clears all previous choices and returns to agent selection', async () => {
 const {options}=await import('preact');
 const saved=new Map<string,string>();
 const key='pacer.settings.add-executor';
 saved.set(key,JSON.stringify({step:'4',agent:'claude-code',host:'devbox',account:'team',model:'old',rank:'1',createdId:executor.id,jobId:job.id}));
 const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 const oldVNode=options.vnode;
 let startAnother:(()=>void)|undefined;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
 options.vnode=node=>{oldVNode?.(node);if(node.type==='button'&&(node.props as any).children==='Add another executor')startAnother=(node.props as any).onClick;};
 try {
  render(<AddExecutor/>,{...state,jobs:{[job.id]:{...job,state:'passed'}}});
  expect(startAnother).toBeDefined();
  startAnother!();
  const html=render(<AddExecutor/>);
  expect(html).toContain('Which agent?');
  expect(html).not.toContain('is ready');
  expect(JSON.parse(saved.get(key)!)).toEqual({step:'1',agent:'codex',host:'',account:'',model:'',rank:'',createdId:'',jobId:''});
 } finally {
  options.vnode=oldVNode;
  if(oldStorage)Object.defineProperty(globalThis,'sessionStorage',oldStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');
 }
});


test('OK clears completed executor state before returning to the executor list', async () => {
 const {options}=await import('preact');
 const key='pacer.settings.add-executor';
 const saved=new Map([[key,JSON.stringify({step:'4',agent:'claude-code',host:'devbox',account:'team',model:'old',rank:'1',createdId:executor.id,jobId:job.id})]]);
 const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 const oldVNode=options.vnode;
 let finish:(()=>void)|undefined;
 let href:string|undefined;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
 options.vnode=node=>{oldVNode?.(node);if(node.type==='a'&&(node.props as any).children==='OK'){finish=(node.props as any).onClick;href=(node.props as any).href;}};
 try {
  render(<AddExecutor/>,{...state,jobs:{[job.id]:{...job,state:'passed'}}});
  expect(finish).toBeDefined();
  expect(href).toBe('#/settings/executors');
  finish!();
  expect(saved.has(key)).toBe(false);
  const html=render(<AddExecutor/>);
  expect(html).toContain('Which agent?');
  expect(html).not.toContain('is ready');
 } finally {
  options.vnode=oldVNode;
  if(oldStorage)Object.defineProperty(globalThis,'sessionStorage',oldStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');
 }
});
