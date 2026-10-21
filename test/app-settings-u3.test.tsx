import { desktopStatus } from "./fixtures/desktop-update/status";
import { SettingsPanel } from '../app/src/shell/SettingsPanel';
import { expect, test } from 'bun:test';
import { clock } from "../src/view-model/format";
import { renderToString } from 'preact-render-to-string';
import { TaskContext } from '../app/src/screens/task-shared';
import { initialState } from '../app/src/data/store';
import { SettingsGeneral, AddExecutor, RemoteHosts, HostDetail, JobProgress, executorId, executorReady, performOperation } from '../app/src/screens/settings/index';
import { settings, host, executor, job } from './fixtures/ui/settings';
const state = {...initialState(),snapshot:{executors:[executor],accounts:[],hosts:[{...host,executors:[executor.id],repos:1}],planner:{agent:'codex',runner:'codex#team',advice:'Keep planning'},repos:[]} as any};
const api = {call:async()=>({}),hello:async()=>({}),snapshot:async()=>({})} as any;
const render = (child:any,s=state) => renderToString(<TaskContext.Provider value={{state:s,api}}>{child}</TaskContext.Provider>);
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
 expect(labels).toHaveLength(2);
 for (const [, body] of labels) { expect(body).toMatch(/class="[^"]*pc-checkbox__input[^"]*"/); expect(body).toContain('type="checkbox"'); }
 expect(labels[0]![1]).toContain('Enabled');
 expect(labels[1]![1]).toContain('Check for updates');
});
test('all General sections provide loading and empty states',()=>{
 expect(render(<SettingsGeneral section="planner"/>)).toContain('Loading');
 const empty={...state,snapshot:{...state.snapshot,executors:[],hosts:[]}};
 const html=["accounts","executors","routing","strategies"].map(section=>render(<SettingsGeneral section={section} initialData={{...settings,accounts:[],strategies:[],routing:{rules:[],available:[]}}}/>,empty)).join("")+render(<RemoteHosts/>,empty);
 for(const word of ['No accounts','No executors','No remote hosts','No routing rules','No strategies'])expect(html).toContain(word);
});
test('wizard has four board steps and never claims ready before a passed check',()=>{
 const html=render(<AddExecutor/>);for(const word of ['Agent','Account','Where','Model &amp; checks','Executor id'])expect(html).toContain(word);
 expect(html).not.toContain('is ready');
 expect(executorId({agent:'codex',account:'team',host:'devbox'})).toBe(executor.id);
 expect(executorReady(job)).toBe(false);expect(executorReady({...job,state:'passed'})).toBe(true);expect(executorReady({...job,state:'failed'})).toBe(false);
});
test('host board includes management sections, facts and service supplied branch fate',()=>{
 const html=render(<HostDetail alias="devbox" initialData={host}/>);
 expect(html).toContain('pc-page--standard');expect(html).toContain('aria-label="Breadcrumb"');
 for(const text of ['Run checks','Open SSH terminal','Pause new work','Max parallel tasks','Repositories','Map a repo','Account folders on host','Worktrees on host','kept','Remove host'])expect(html).toContain(text);
 expect(html).toContain('aria-label="Codex"');expect(html).toContain('disabled');expect(html).not.toContain('Full sessions');
});
test('host list and detail expose loading and empty states',()=>{
 expect(render(<RemoteHosts/>)).toContain('devbox');expect(render(<HostDetail alias="missing"/>)).toContain('Loading');
 expect(render(<RemoteHosts/>,{...state,snapshot:{...state.snapshot,hosts:[]}})).toContain('No remote hosts');
});
test('job progress uses service words and steps, including error hints',()=>{
 const html=renderToString(<JobProgress job={{...job,state:'failed',error:{code:'bad',message:'Check failed',hint:'Sign in on host'}}}/>);
 for(const text of ['CLI found','Test task','failed','Check failed','Sign in on host'])expect(html).toContain(text);
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
 const result=await Bun.build({entrypoints:['app/src/screens/settings/index.ts'],target:'browser',minify:true});
 expect(result.success).toBe(true);expect(result.outputs.length).toBe(1);
 const text=await result.outputs[0]!.text();expect(text).toContain('adoptedStyleSheets');expect(text).toContain('--surface-card');
 // Settings composes the shared eligibility vocabulary; use the governed UI-3 budget.
 expect(Bun.gzipSync(text).byteLength).toBeLessThan(APP_JS_BUDGET);
});
test('restored executor draft resumes checks and Ready follows a passed job only',()=>{
 const initialDraft={step:'4',agent:'codex',account:'team',host:'devbox',createdId:executor.id,jobId:job.id};
 const draw=(stateValue:'running'|'failed'|'passed')=>render(<AddExecutor initialDraft={initialDraft}/>,{...state,jobs:{[job.id]:{...job,state:stateValue}}});
 expect(draw('running')).toContain('Running checks');expect(draw('running')).not.toContain('is ready');
 expect(draw('failed')).toContain('Run checks again');expect(draw('failed')).not.toContain('is ready');
 expect(draw('passed')).toContain(`${executor.id} is ready`);expect(draw('passed')).toContain('Back to settings');
});
test('new endpoint form includes URL, key source and model limits',()=>{
 // The URL form sits behind the OpenCode provider picker's "Use a URL instead".
 const html=render(<AddExecutor initialDraft={{step:'2',agent:'opencode'}} initialUrlForm/>);
 for(const text of ['Base URL','API key environment variable','Context limit','Output limit','Quota — a plan with limits','Metered — pay per token','Unmetered — free or local'])expect(html).toContain(text);
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

test('multiple accounts always shows the threshold beside Spread and Fill, disabled only for Spread',()=>{
 for(const mode of ['spread','fill']) {
  const html=render(<SettingsGeneral section="planner" initialData={{...settings,config:{...settings.config,keys:{...settings.config.keys,'pacing.accounts':{value:mode}}}}}/>);
  expect(html).toContain('class="u3-accounts-mode"');
  expect(html).toContain('Move to the next account at');
  expect(html).toContain('% used');
  expect(html).toMatch(mode==='spread'?/max="100" disabled value="80"/:/max="100" value="80"/);
 }
});

test('settings navigation pluralises rule counts',()=>{
 for(const count of [1,3]) {
  const rules=Array.from({length:count},()=>settings.routing.rules[0]!);
  const html=renderToString(<SettingsPanel route={{name:"settings",section:"routing",query:{repo:null,scope:null}}} counts={null} badges={{routing:`${rules.length} ${rules.length===1?"rule":"rules"}`}}/>);
  expect(html).toContain(`>${count} ${count===1?'rule':'rules'}</span>`);
 }
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
test('settings pages leave their page title to the shell and inline links are underlined', () => {
 for (const child of [<SettingsGeneral initialData={settings}/>, <AddExecutor/>, <RemoteHosts/>, <HostDetail alias="devbox" initialData={host}/>]) {
  expect(render(child)).not.toContain('<h1');
 }
 const emptyState = {...state,snapshot:{...state.snapshot,hosts:[]}};
 expect(render(<RemoteHosts/>, emptyState)).not.toContain('>Remote hosts</h2>');
 expect(render(<SettingsGeneral initialData={settings}/>, emptyState)).toContain('href="#/settings/hosts"');
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

test('Executors copy matches routing: a failed check does not skip an executor',()=>{
 const html=render(<SettingsGeneral section="executors" initialData={settings}/>);
 expect(html).not.toContain('skipped until it passes again');
 expect(html).toContain('A failed check marks the executor Failing (Unavailable when it is signed out or not working) and raises attention. Recent task failures means two or more tasks failed in the past 24 hours; a passed check does not clear that history. Routing keeps using executors with either warning. Disable an executor to skip it.');
});

test('a not-tested endpoint executor reads Not tested, not Ready, in Executors',()=>{
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
 expect(html).toContain('Service 0.5.0 · Up to date');
 expect(html).not.toContain('Desktop app');
 const failed = render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.5.0',latest:'0.5.0',available:false,error:'offline'}}}/>);
 expect(failed).toContain('Update check failed');
 expect(failed).not.toContain('Up to date');
 const available = render(<SettingsGeneral section="updates" initialData={{updates:{current:'0.3.1',latest:'0.5.0',available:true}}}/>);
 expect(available).toContain('Update service and restart');

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
 expect(panel).toContain('aria-label="Update ready"');
 expect(panel).toContain('>↑</span>');
 expect(panel).toContain('pc-rail__badge--info');
 expect(panel).toContain('title="Update ready"');
 expect(panel.match(/aria-current="page"/g)).toHaveLength(1);
});

test('completed executor setup offers another account without leaving the wizard', () => {
 const initialDraft={step:'4',agent:'claude-code',account:'team',createdId:executor.id,jobId:job.id};
 const html=render(<AddExecutor initialDraft={initialDraft}/>,{...state,jobs:{[job.id]:{...job,state:'passed'}}});
 expect(html).toContain('Add another account');
 expect(html).toContain('Back to settings');
 expect((html.match(/pc-btn--primary/g)||[]).length).toBe(1);
});

test('adding another account replaces the completed draft with an unlocked account step', async () => {
 const {options}=await import('preact');
 const saved=new Map<string,string>();
 const key='pacer.settings.add-executor';
 saved.set(key,JSON.stringify({step:'4',agent:'claude-code',host:'devbox',account:'team',model:'old',rank:'1',createdId:executor.id,jobId:job.id}));
 const oldStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
 const oldVNode=options.vnode;
 let startAnother:(()=>void)|undefined;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
 options.vnode=node=>{oldVNode?.(node);if(node.type==='button'&&(node.props as any).children==='Add another account')startAnother=(node.props as any).onClick;};
 try {
  render(<AddExecutor/>,{...state,jobs:{[job.id]:{...job,state:'passed'}}});
  expect(startAnother).toBeDefined();
  startAnother!();
  const html=render(<AddExecutor/>);
  expect(html).toContain('Which account pays for it?');
  expect(html).toContain('New account');
  expect(html).not.toContain('is ready');
  expect(JSON.parse(saved.get(key)!)).toEqual({step:'2',agent:'claude-code',host:'devbox',account:'',model:'',rank:'',createdId:'',jobId:''});
 } finally {
  options.vnode=oldVNode;
  if(oldStorage)Object.defineProperty(globalThis,'sessionStorage',oldStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');
 }
});
