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
test('General follows board order and uses the actual planner agent',()=>{
 const html=render(<SettingsGeneral initialData={settings}/>);
 const labels=['Planner &amp; pacing','Accounts','Executors','Remote hosts','Routing','Strategies','Updates','Notifications','Appearance'];
 let at=html.indexOf('<h1');
 for(const label of labels){const next=html.indexOf(`>${label}</h2>`,at);expect(next).toBeGreaterThan(at);at=next;}
 expect(html).toContain('aria-label="Codex"');expect(html).toContain('codex#team');expect(html).toContain('Scratch task passed');
 expect(html).toContain('Link Orca account');expect(html).toContain('New from a brief');
 expect((html.match(/pc-btn--primary/g)||[]).length).toBeLessThanOrEqual(1);
});
test('executor and update checkboxes keep their labels inline', () => {
 const html = render(<SettingsGeneral initialData={settings}/>);
 const labels = [...html.matchAll(/<label class="pc-checkbox">([\s\S]*?)<\/label>/g)];
 expect(labels).toHaveLength(2);
 for (const [, body] of labels) { expect(body).toMatch(/class="[^"]*pc-checkbox__input[^"]*"/); expect(body).toContain('type="checkbox"'); }
 expect(labels[0]![1]).toContain('Enabled');
 expect(labels[1]![1]).toContain('Check for updates');
});
test('all General sections provide loading and empty states',()=>{
 expect(render(<SettingsGeneral/>)).toContain('Loading');
 const html=render(<SettingsGeneral initialData={{...settings,accounts:[],strategies:[],routing:{rules:[],available:[]}}}/>,{...state,snapshot:{...state.snapshot,executors:[],hosts:[]}});
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
 const result=await Bun.build({entrypoints:['app/src/screens/settings/index.ts'],target:'browser',minify:true});
 expect(result.success).toBe(true);expect(result.outputs.length).toBe(1);
 const text=await result.outputs[0]!.text();expect(text).toContain('adoptedStyleSheets');expect(text).toContain('--surface-card');
 // The aggregate settings entry includes the project-policy editor; the shipped app retains its separate 60 KB cap.
 expect(Bun.gzipSync(text).byteLength).toBeLessThan(32*1024);
});
test('restored executor draft resumes checks and Ready follows a passed job only',()=>{
 const initialDraft={step:'4',agent:'codex',account:'team',host:'devbox',createdId:executor.id,jobId:job.id};
 const draw=(stateValue:'running'|'failed'|'passed')=>render(<AddExecutor initialDraft={initialDraft}/>,{...state,jobs:{[job.id]:{...job,state:stateValue}}});
 expect(draw('running')).toContain('Running checks');expect(draw('running')).not.toContain('is ready');
 expect(draw('failed')).toContain('Run checks again');expect(draw('failed')).not.toContain('is ready');
 expect(draw('passed')).toContain(`${executor.id} is ready`);expect(draw('passed')).toContain('Back to settings');
});
test('new endpoint form includes URL, key source and model limits',()=>{
 const html=render(<AddExecutor initialDraft={{step:'2',agent:'opencode'}}/>);
 for(const text of ['Base URL','API key environment variable','Context limit','Output limit','Quota','Metered','Unmetered'])expect(html).toContain(text);
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
 const html=render(<SettingsGeneral initialData={{...settings,accounts}}/>,s);
 expect(html).toContain(`17% of week · resets ${clock(Date.UTC(2026,9,19)/1000,Date.now()/1000)}`);expect(html).not.toContain('ON_PACE');
 for(const label of ['Signed in','No subscription','Unknown','Signed out','Ready','Key missing'])expect(html).toMatch(new RegExp(`pc-pill[^"]*"[^>]*>(?:<span[^>]*>[^<]*</span>)?${label}</span>`));
 expect(html).toContain('<th>Status</th>');expect(html).not.toContain('<th>Sign-in</th>');
 expect(html).toContain('<th>Used by</th>');expect(html).toContain(executor.id);
 // Sign-in help only for native accounts known to be signed out (here: empty and out), never for endpoints.
 expect(html.match(/<summary>Fix sign-in<\/summary>/g)).toHaveLength(2);
 expect(html).toMatch(/<details class="pc-disclosure"><summary>Fix sign-in<\/summary><code>CODEX_HOME=/);expect(html).not.toContain('<details open');
});

test('multiple accounts always shows the threshold beside Spread and Fill, disabled only for Spread',()=>{
 for(const mode of ['spread','fill']) {
  const html=render(<SettingsGeneral initialData={{...settings,config:{...settings.config,keys:{...settings.config.keys,'pacing.accounts':{value:mode}}}}}/>);
  expect(html).toContain('class="u3-accounts-mode"');
  expect(html).toContain('Move to the next account at');
  expect(html).toContain('% used');
  expect(html).toMatch(mode==='spread'?/max="100" disabled value="80"/:/max="100" value="80"/);
 }
});

test('settings navigation pluralises rule counts',()=>{
 for(const count of [1,3]) {
  const rules=Array.from({length:count},()=>settings.routing.rules[0]!);
  const html=render(<SettingsGeneral initialData={{...settings,routing:{...settings.routing,rules}}}/>);
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
 const html=render(<SettingsGeneral initialData={settings}/>,{...state,snapshot:{...state.snapshot,machine:{used:0,max:2},executors:[limited]}});
 expect(html).toContain('Parallel tasks for '+executor.id);
 expect(html).toContain('Limited to 2 by this machine');
 expect(html).toContain('Parallel tasks on this machine');
 expect(html).toContain('Shared by all executors that run on this machine.');
 expect(html).toContain('min="1" max="16" step="1"');
 expect(html).not.toContain('>Slots<');
 const planner=render(<SettingsGeneral initialData={settings}/>,{...state,snapshot:{...state.snapshot,executors:[{...limited,rank:'planner'}]}});
 expect(planner).not.toContain('Parallel tasks for '+executor.id);
});
test('settings pages leave their page title to the shell and inline links are underlined', () => {
 for (const child of [<SettingsGeneral initialData={settings}/>, <AddExecutor/>, <RemoteHosts/>, <HostDetail alias="devbox" initialData={host}/>]) {
  expect(render(child)).not.toContain('<h1');
 }
 const emptyState = {...state,snapshot:{...state.snapshot,hosts:[]}};
 expect(render(<RemoteHosts/>, emptyState)).not.toContain('>Remote hosts</h2>');
 expect(render(<SettingsGeneral initialData={settings}/>, emptyState)).toMatch(/<a(?=[^>]*class="pc-inline-link")(?=[^>]*href="#\/settings\/hosts")[^>]*>Add a host\.<\/a>/);
});
