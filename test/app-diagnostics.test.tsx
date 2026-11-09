import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { DiagnosticResults, DiagnosticsSection, diagnosticReportText } from "../app/src/screens/settings/Diagnostics";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { callOp, opNames } from "../src/api/ops";
import { writeUndoSnapshot } from "../src/install/undo-store";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { fakeCtx, localTs, tmpDir } from "./helpers";
import type { Remedy } from "../src/install/doctor";

const review: Remedy = {kind:'review',label:'Review and fix',op:'agent.preview',params:{agent:'claude-code'}};
const updateFiles: Remedy = {kind:'auto',label:'Update files',op:'agent.connect',params:{agent:'cursor'},consent:true};
const refresh: Remedy = {kind:'auto',label:'Refresh usage',op:'limits.refresh',params:{account:'codex#tse'}};
const service: Remedy = {kind:'auto',label:'Install pacer service',op:'service.install',consent:true};
const signIn: Remedy = {kind:'user',label:'Sign in to Codex',op:'account.signin',params:{name:'codex'}};
const billing: Remedy = {kind:'user',label:'Open Claude billing',url:'https://claude.ai/settings/billing',secondary:{label:'Turn off Claude',op:'runner.block',params:{id:'claude-code',reason:'No active subscription'}}};
const internal: Remedy = {kind:'internal',label:'Restart pacer service',op:'service.install',consent:true};
const agentTask = (check: string): Remedy => ({kind:'agent',label:'Fix with agent',op:'doctor.fix.delegate',params:{check,scope:'fix'}});

test("diagnostics starts idle and has an accessible service-backed run action", () => {
  const html = renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as any}}><DiagnosticsSection/></TaskContext.Provider>);
  expect(html).toContain("Run all checks");
  expect(html).toContain('role="status"');
  expect(html).toContain("No checks run yet");
  // The hook-invocation caveat belongs to a run result, not the idle page.
  expect(html).not.toContain("unverified until observed");
});
test("unverified and informational checks stay out of Needs a fix and passed counts", () => {
  const report = {checkedAt:0, checks:[
    {name:"Claude hook configuration",level:"ok" as const,evidence:"configured" as const,detail:"SessionStart command present"},
    {name:"Claude handler probes",level:"ok" as const,evidence:"tested" as const,detail:"Isolated fixture"},
    {name:"Claude host invocation",level:"info" as const,evidence:"unverified" as const,detail:"No host evidence",fix:"Inspect /hooks"},
  ]};
  const html = renderToString(<DiagnosticResults report={report}/>);
  expect(html).toContain('No problems found.');
  expect(html).not.toContain('Needs a fix');
  expect(html).toContain('Passed · 2');
  expect(html).toContain('Information and not checked · 1');
  for (const word of ['Configured', 'Tested working', 'Unverified']) expect(diagnosticReportText(report)).toContain(word);
});
test("doctor operation is additive and v3-only, with structured results and honest host evidence", async () => {
  expect(opNames()).toContain("doctor.run");
  expect(V3_ONLY_OPS.has("doctor.run")).toBe(true);
  const ctx=fakeCtx({which:()=>null});
  const {mkdirSync,writeFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  mkdirSync(ctx.pacerHome,{recursive:true});
  writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n');
  const result=await callOp(ctx,"doctor.run",{}) as {checkedAt:number;checks:any[];planner?:string};
  expect(result.checkedAt).toBe(ctx.now);
  expect(result.planner).toBe("claude-code");
  expect(result.checks.find(c=>c.name==="Claude host invocation").evidence).toBe("unverified");
  expect(result.checks.find(c=>c.name==="Claude handler probes").evidence).toBe("tested");
});

test("Diagnostics is a recognized Settings deep link", async () => {
  const { resolveRoute, settingsPath } = await import("../app/src/router");
  expect(settingsPath("diagnostics")).toBe("/settings/diagnostics");
  expect(resolveRoute("#/settings/diagnostics")).toMatchObject({name:"settings",section:"diagnostics"});
});

test('diagnostic titles retain readable agent and account identities', async () => {
  const {diagnosticTitle} = await import('../src/view-model/diagnostics');
  expect(diagnosticTitle('Binary codex#work')).toBe('Agent command · Codex (work)');
  expect(diagnosticTitle('CLI cursor')).toBe('Compatibility · Cursor');
  expect(diagnosticTitle('Login claude-code#work')).toBe('Sign-in indicator · Claude Code (work)');
  expect(diagnosticTitle('Usage codex')).toBe('Budget · Codex');
  expect(diagnosticTitle('Install claude-code')).toBe('Integration · Claude');
  expect(diagnosticTitle('Skill codex')).toBe('Planner skill · Codex');
  expect(diagnosticTitle('Unknown codex')).toBe('Unknown codex');
  expect(diagnosticTitle('toString codex')).toBe('toString codex');
});

test('persistent Settings navigation marks Diagnostics current without a second local menu', async () => {
  const {SettingsPanel} = await import('../app/src/shell/SettingsPanel');
  const {SettingsGeneral} = await import('../app/src/screens/settings/General');
  const panel = renderToString(<SettingsPanel route={{name:'settings',section:'diagnostics',query:{repo:null,scope:null}} as any} counts={null}/>);
  const local = renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as any}}><SettingsGeneral section="diagnostics"/></TaskContext.Provider>);
  expect(panel).toMatch(/<a(?=[^>]*href="[^"]*settings\/diagnostics")(?=[^>]*aria-current="page")[^>]*>[\s\S]*?Diagnostics<\/span>[\s\S]*?<\/a>/);
  expect(local).not.toContain('aria-label="Settings sections"');
  expect(local).toContain('id="diagnostics"');
});

test('diagnostic groups separate issues, passed and unverified without counting a check twice', async () => {
  const { diagnosticGroups } = await import('../src/view-model/diagnostics');
  const result = diagnosticGroups([
    {name:'Install codex#work',level:'warn',detail:'changed',evidence:'unverified'},
    {name:'Binary codex',level:'ok',detail:'installed'},
    {name:'Claude host invocation',level:'info',evidence:'unverified',detail:'unknown'},
    {name:'Activity',level:'info',detail:'calendar'},
  ]);
  expect(result.issues.map(g=>g.title)).toEqual(['Codex (work)']);
  expect(result.passed).toHaveLength(1);
  expect(result.unverified).toHaveLength(1);
  expect(result.information).toHaveLength(1);
  expect(result.issueCount).toBe(1);
});

test('results group problems into one card and collapse passed checks', () => {
  const html = renderToString(<DiagnosticResults report={{checkedAt:0,checks:[
    {name:'Install codex',level:'warn',detail:'missing file',fix:'arbitrary command',remedy:review},
    {name:'Skill codex',level:'warn',detail:'changed file',remedy:updateFiles},
    {name:'Binary codex',level:'ok',detail:'installed'},
  ]}}/>);
  expect(html).toContain('Needs a fix · 2');
  expect(html).toContain('pc-diagnostic-list--card');
  expect(html).toContain('Passed · 1');
  // Two rows' technical details, the collapsed Passed panel and its row; nothing starts open.
  expect(html.match(/<details/g)).toHaveLength(4);
  expect(html).not.toMatch(/<details[^>]*\sopen/);
  expect(html).not.toContain('arbitrary command<');
});

test('unverified warnings remain fixable problems without double counting', () => {
 const html=renderToString(<DiagnosticResults report={{checkedAt:0,checks:[{name:'Claude hook configuration',level:'warn',evidence:'unverified',detail:'missing settings',remedy:agentTask('Claude hook configuration')}]}}/>);
 expect(html).toContain('Needs a fix · 1');
 expect(html).not.toContain('Passed');
 expect(html).not.toContain('Information and not checked');
});

test('named install checks retain their account and unavailable account folders get no reconnect', async () => {
 const {runDoctor}=await import('../src/install/doctor');
 const {mkdirSync,writeFileSync}=await import('node:fs');
 const {join}=await import('node:path');
 const ctx=fakeCtx({which:()=>null});
 mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:'codex#work',accounts:{work:{kind:'codex',home:join(ctx.home,'work')}},runners:{'codex#work':{}}}));
 writeFileSync(join(ctx.pacerHome,'install-manifest.json'),JSON.stringify({version:1,planners:{'codex#work':{planner:'codex',account:'work',files:[{path:join(ctx.home,'work/AGENTS.md'),action:'created',undo:[]}],pacerArgv:[],commands:[],notes:[]}}}));
 const checks=await runDoctor(ctx);
 expect(checks.find(c=>c.name==='Install codex#work')?.level).toBe('warn');
 expect(checks.find(c=>c.name==='Install codex#work')?.fix).toBe('pacer install codex#work');
 const available=await callOp(ctx,'doctor.run',{}) as any;
 expect(available.repairAvailable).toBe(true);
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify({planner:'claude-code#missing',accounts:{missing:{kind:'claude',orca_account:'not-present'}},runners:{'claude-code#missing':{}}}));
 const unavailable=await callOp(ctx,'doctor.run',{}) as any;
 expect(unavailable.repairAvailable).toBe(false);
 const html=renderToString(<DiagnosticResults report={unavailable} onRemedy={()=>{}}/>);
 expect(html).not.toContain('Review and fix');
 expect(html).not.toContain('Update files');
});

test('rows start collapsed with plain details and omit missing timing', () => {
 const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:[
 {name:'Service',level:'fail',detail:'Connection refused',fix:'Start the service',remedy:service},
 {name:'Binary codex',level:'ok',detail:'Installed'},
 {name:'Claude host invocation',level:'info',evidence:'unverified',detail:'No observation'},
 {name:'Activity',level:'info',detail:'Available'},
 ]}}/>);
 expect(html).not.toMatch(/<details[^>]*\sopen/);
 expect(html).toContain('Connection refused');
 expect(html).toContain('Reported hint: Start the service');
 expect(html).toContain('fix runs: service.install (asks you first)');
 expect(html).toContain('Needs a fix · 1');
 expect(html).toContain('Passed · 1');
 expect(html).toContain('Information and not checked · 2');
 expect(html).not.toContain('took');
 expect(html).not.toContain('0.0s');
});

test('copy summary contains only existing report data', () => {
 const text = diagnosticReportText({checkedAt:1,checks:[{name:'Service',level:'fail',detail:'Unavailable',fix:'Check service'}]});
 expect(text).toContain('Last run');
 expect(text).toContain('Failed: Service\nUnavailable\nSuggested next step: Check service');
 expect(text).not.toContain('took');
});

test('diagnostic causes and remediation survive technical service and CLI evidence', async () => {
 const {diagnosticDetail, diagnosticNextStep} = await import('../app/src/screens/settings/presentation');
 expect(diagnosticDetail({name:'Service',level:'warn',detail:'installed: true; running: false; healthy: false; binary matches current: true'})).toContain('not running');
 expect(diagnosticDetail({name:'CLI codex',level:'fail',detail:'codex help is missing launch flags: --json'})).toContain('required launch options');
 expect(diagnosticNextStep('pacer service restart')).toContain('Restart');
 expect(diagnosticNextStep('pacer install codex#work')).toContain('Reconnect');
});

test('rows explain the problem in plain words and keep the raw output in Technical details', () => {
 const html=renderToString(<DiagnosticResults report={{checkedAt:1,checks:[{name:'Service',level:'warn',detail:'installed: true; running: false; healthy: false; binary matches current: true',fix:'pacer service restart',remedy:service}]}}/>);
 expect(html).toContain('not running');
 expect(html).toContain('Technical details');
 expect(html).toContain('installed: true; running: false');
 expect(html).not.toContain('Not recorded');
 // The search and filter controls are gone: the page shows only what needs a fix.
 expect(html).not.toContain('Search checks');
});


test('diagnostic summaries distinguish service failures and retain measured latency', async () => {
 const {diagnosticSummary, diagnosticBucket} = await import('../src/view-model/diagnostics');
 const check=(name:string,detail:string)=>({name,detail,level:'warn' as const});
 expect(diagnosticSummary(check('Service','installed: false; running: false; healthy: false; binary matches current: false'))).toContain('not installed');
 expect(diagnosticSummary(check('Service','installed: true; running: true; healthy: true; binary matches current: false'))).toBe('The service uses a different installed version.');
 expect(diagnosticSummary(check('Link latency','/v2/snapshot max 120.5 ms across 3 requests (target < 50 ms)'))).toContain('120.5 ms');
 expect(diagnosticSummary(check('Removable volume access','$HOME/repo: access denied (Operation not permitted)'))).toContain('denied access');
 expect(diagnosticSummary(check('macOS code signing','code object is not signed at all'))).toContain('no code signature');
 expect(diagnosticSummary(check('Usage codex','CoreError: native process owner supervises plugin children'))).toBe('The check returned technical output. Open Technical details for the reported result.');
 expect(diagnosticSummary(check('Usage codex','Error reading usage file'))).toBe('Error reading usage file');
 expect(diagnosticBucket({...check('Service','unavailable'),evidence:'unverified'})).toBe('attention');
 expect(diagnosticBucket({name:'Account',detail:'not inspected',level:'info',evidence:'unverified'})).toBe('unchecked');
 const report=diagnosticReportText({checkedAt:1,checks:[{...check('CLI example','example help is missing launch flags: --json'),fix:'Use example --help'}]});
 expect(report).toContain('example help is missing launch flags: --json');
 expect(report).toContain('Use example --help');
});

test('configured Claude hooks explain account-folder mismatch without claiming missing hooks', async () => {
 const {claudeHookChecks} = await import('../src/install/doctor-hooks');
 const {editClaudeSettings} = await import('../plugins/pacer-planners/claude');
 const {diagnosticSummary, diagnosticGuidance} = await import('../src/view-model/diagnostics');
 const {mkdirSync, writeFileSync} = await import('node:fs');
 const {join} = await import('node:path');
 const ctx=fakeCtx(), folder=join(ctx.home,'.claude');
 mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'settings.json'),editClaudeSettings(null,{
  session:'pacer msg hook session --planner claude-code',guard:'pacer guard --planner claude-code',statusline:'pacer statusline',
  stop:'pacer msg hook stop --planner claude-code',prompt:'pacer msg hook prompt --planner claude-code',
 },ctx.home).text);
 ctx.env.CLAUDE_CONFIG_DIR=join(ctx.home,'other-account');
 const checks=claudeHookChecks(ctx);
 for(const name of ['Claude hook configuration','Claude message hooks']) {
  const check=checks.find(c=>c.name===name)!;
  expect(check).toMatchObject({level:'warn',evidence:'configured'});
  expect(diagnosticSummary(check)).toContain('configured');
  expect(diagnosticSummary(check)).toContain('account folder');
  expect(diagnosticSummary(check)).not.toContain('missing');
  expect(diagnosticGuidance(check)).toContain('matching planner account');
 }
});

test('each remedy kind maps to one plan, and consent is never taken from the server params', async () => {
  const { remedyPlan, secondaryPlan } = await import('../src/view-model/diagnostics');
  expect(remedyPlan(refresh)).toEqual({kind:'run',op:'limits.refresh',params:{account:'codex#tse'}});
  expect(remedyPlan({...updateFiles,params:{agent:'cursor',consent:true}})).toMatchObject({kind:'run',op:'agent.connect',params:{agent:'cursor'},consent:{confirmLabel:'Update files'}});
  expect(remedyPlan(service)).toMatchObject({kind:'run',op:'service.install',params:{},consent:{title:'Install pacer service'}});
  expect(remedyPlan(review)).toEqual({kind:'review',agent:'claude-code'});
  expect(remedyPlan({...review,params:{agent:'not-an-agent'}})).toBeUndefined();
  expect(remedyPlan(signIn)).toEqual({kind:'signin',op:'account.signin',params:{name:'codex'}});
  expect(remedyPlan(billing)).toEqual({kind:'open',url:'https://claude.ai/settings/billing'});
  expect(secondaryPlan(billing)).toEqual({kind:'run',op:'runner.block',params:{id:'claude-code',reason:'No active subscription'}});
  expect(remedyPlan({kind:'user',label:'Privacy',url:'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'})).toMatchObject({kind:'open'});
  expect(remedyPlan(agentTask('Binary codex'))).toEqual({kind:'delegate',check:'Binary codex'});
  expect(remedyPlan(internal)).toMatchObject({kind:'run',op:'service.install',consent:{title:'Restart the pacer service',confirmLabel:'Restart'}});
});

test('remedy links open only https pages and System Settings panes', async () => {
  const { remedyPlan, remedyUrl } = await import('../src/view-model/diagnostics');
  for (const url of ['http://example.com','file:///etc/passwd','javascript:alert(1)','x-apple.systempreferencesX:','  https://example.com']) {
    expect(remedyUrl(url)).toBeUndefined();
    expect(remedyPlan({kind:'user',label:'Open',url})).toBeUndefined();
  }
  expect(remedyUrl('https://example.com/billing')).toBe('https://example.com/billing');
});

test('file-update consent names the files and service consent names the restart', async () => {
  const { remedyConsent } = await import('../src/view-model/diagnostics');
  expect(remedyConsent(updateFiles, ['a','b'])).toEqual({title:'Update pacer’s files for Cursor',message:'Pacer updates only its own files and keeps your edits. These 2 files change:',confirmLabel:'Update files'});
  expect(remedyConsent(service).message).toContain('restarts its background service');
  expect(remedyConsent(internal).confirmLabel).toBe('Restart');
});

test('fix tasks drive the row state from task reads, and only a passed recheck counts as fixed', async () => {
  const { diagnosticTaskStatus } = await import('../src/view-model/diagnostics');
  const base = {id:'t1',diagnosticCheck:'Binary codex',updatedAt:1};
  expect(diagnosticTaskStatus([{...base,state:'running'}],'Binary codex')).toMatchObject({label:'Fix task running',open:true,taskId:'t1'});
  expect(diagnosticTaskStatus([{...base,state:'done'}],'Binary codex')).toMatchObject({label:'Waiting for your review',open:true});
  expect(diagnosticTaskStatus([{...base,state:'needs_input'}],'Binary codex')).toMatchObject({label:'Needs your answer',open:true});
  expect(diagnosticTaskStatus([{...base,state:'failed'}],'Binary codex')).toBeUndefined();
  expect(diagnosticTaskStatus([{...base,state:'done',review:{accepted:true}}],'Binary codex')).toMatchObject({label:'Rechecking'});
  expect(diagnosticTaskStatus([{...base,state:'done',review:{accepted:true},diagnosticRecheck:{at:2,passed:true,level:'ok',detail:'found'}}],'Binary codex')).toMatchObject({label:'Fixed and rechecked',tone:'good',open:false});
  expect(diagnosticTaskStatus([{...base,state:'done',review:{accepted:true},diagnosticRecheck:{at:2,passed:false,level:'fail',detail:'still missing'}}],'Binary codex')).toMatchObject({label:'Still failing',detail:'still missing'});
  expect(diagnosticTaskStatus([{...base,state:'done',review:{accepted:false}}],'Binary codex')).toBeUndefined();
  expect(diagnosticTaskStatus([{...base,state:'running',dismissed:true}],'Binary codex')).toBeUndefined();
  expect(diagnosticTaskStatus([{...base,state:'running'},{...base,id:'t2',state:'done',updatedAt:5}],'Binary codex')?.taskId).toBe('t2');
  expect(diagnosticTaskStatus([{...base,state:'running'}],'Binary cursor')).toBeUndefined();
});

const mixedChecks = () => [
  {name:'Usage codex#tse',level:'warn' as const,detail:'stale',remedy:refresh},
  {name:'Install cursor',level:'warn' as const,detail:'changed',remedy:updateFiles},
  {name:'Skill claude-code',level:'warn' as const,detail:'missing',remedy:review},
  {name:'Login codex',level:'warn' as const,detail:'no login indicator',remedy:signIn},
  {name:'Usage claude-code',level:'warn' as const,detail:'no active subscription',remedy:billing},
  {name:'CLI opencode',level:'fail' as const,detail:'help failed',remedy:agentTask('CLI opencode')},
  {name:'Install claude-code',level:'warn' as const,detail:'CoreError: boom',remedy:internal},
  {name:'Skill codex',level:'warn' as const,detail:'CoreError: boom',remedy:internal},
  {name:'Service',level:'ok' as const,detail:'healthy'},
];

test('the page counts what pacer can fix by itself and offers one fix-all for automatic remedies only', async () => {
  const { diagnosticsPage } = await import('../src/view-model/diagnostics');
  const page = diagnosticsPage({checks: mixedChecks()});
  expect(page.openCount).toBe(6);
  expect(page.rows.map(row => row.kind)).toEqual(['Automatic','Automatic','Review changes','Needs you','Needs you','Agent']);
  expect(page.autoLeft.map(row => row.check.name)).toEqual(['Usage codex#tse','Install cursor']);
  expect(page.fixAllLabel).toBe('Fix 2 issues automatically');
  expect(page.headline).toBe('6 problems. Pacer can fix 2 by itself; the rest take one click each.');
  expect(page.rows[3]!.detail).toBe('No login indicator. Only you can do this. Pacer rechecks when you come back.');
  // A running remedy or an open fix task leaves the fix-all set.
  const running = diagnosticsPage({checks: mixedChecks(), outcomes:{'Usage codex#tse':{phase:'running',text:'Refreshing usage…'}}});
  expect(running.autoLeft.map(row => row.check.name)).toEqual(['Install cursor']);
  expect(running.fixAllLabel).toBe('Fix 1 issue automatically');
  expect(running.rows[0]!.progress).toBe('Refreshing usage…');
});

test('a fixed row stays in place as fixed after the recheck, and a failed fix shows the new error', async () => {
  const { diagnosticsPage } = await import('../src/view-model/diagnostics');
  const baseline = ['Usage codex#tse','Install cursor'];
  const checks = [{name:'Usage codex#tse',level:'ok' as const,detail:'fresh'},{name:'Install cursor',level:'warn' as const,detail:'changed',remedy:updateFiles}];
  const page = diagnosticsPage({checks, baseline, outcomes:{'Install cursor':{phase:'error',message:'Permission denied'}}});
  expect(page.rows.map(row => [row.check.name,row.fixed,row.kind])).toEqual([['Usage codex#tse',true,'Fixed'],['Install cursor',false,'Automatic']]);
  expect(page.rows[0]!.detail).toBe('Fixed and rechecked just now.');
  expect(page.rows[1]!.problem).toBe('Permission denied');
  expect(page.openCount).toBe(1);
  expect(diagnosticsPage({checks:[{name:'Usage codex#tse',level:'ok',detail:'fresh'}], baseline}).headline).toBe('Everything that can be fixed is fixed.');
});

test('checks pacer could not run form one group with one cause and one restart', async () => {
  const { diagnosticsPage } = await import('../src/view-model/diagnostics');
  const page = diagnosticsPage({checks: mixedChecks()});
  expect(page.rows.some(row => row.remedy?.kind === 'internal')).toBe(false);
  expect(page.internal?.titles).toEqual(['Integration · Claude','Planner skill · Codex']);
  expect(page.internal?.title).toBe('A pacer problem stopped 2 checks. Your setup wasn’t tested.');
  expect(page.internal?.remedy.label).toBe('Restart pacer service');
  expect(page.internal?.technical).toContain('Same cause for all 2 checks.');
  const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:mixedChecks()}} onRestart={()=>{}} onCopyReport={()=>{}}/>);
  expect(html).toContain('Couldn’t check · 2');
  expect(html.match(/A pacer problem stopped/g)).toHaveLength(1);
  expect(html).toContain('>Restart pacer service<');
  expect(html).toMatch(/Copy report<span class="sr-only"> to send to pacer/);
  const only = diagnosticsPage({checks: mixedChecks().filter(check => check.remedy === internal)});
  expect(only.headline).toBe('Pacer couldn’t run 2 checks. Nothing else needs a fix.');
});

test('each row shows its remedy kind, one action and an inline consent before consent-gated changes', () => {
  const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:mixedChecks()}} onRemedy={()=>{}}/>);
  for (const pill of ['Automatic','Review changes','Needs you','Agent']) expect(html).toContain(`>${pill}</span>`);
  for (const label of ['Refresh usage','Update files','Review and fix','Sign in to Codex','Open Claude billing','Turn off Claude','Fix with agent'])
    expect(html).toContain(`>${label}<span class="sr-only"> for `);
  const consent = {key:'Install cursor',requests:[{title:'Update pacer’s files for Cursor',message:'These 2 files change:',confirmLabel:'Update files',files:['$HOME/.cursor/rules/pacer.mdc','$HOME/.cursor/hooks.json']}],resolve:()=>{}};
  const confirming = renderToString(<DiagnosticResults report={{checkedAt:1,checks:mixedChecks()}} consent={consent} onRemedy={()=>{}}/>);
  expect(confirming).toContain('role="group" aria-label="Update pacer’s files for Cursor"');
  expect(confirming).toContain('hooks.json<wbr/>');
  expect(confirming).toContain('pacer.mdc<wbr/>');
  // While confirming, the row's own button stays mounted (so focus can return to it) but does nothing.
  expect(confirming).toMatch(/aria-disabled="true"[^>]*>Update files<span class="sr-only"> for Integration · Cursor/);
  expect(confirming).toContain('>Cancel<');
});

test('rows with an open fix task link to the task and hide the remedy button', () => {
  const tasks = [{id:'task 1',state:'running',diagnosticCheck:'CLI opencode',updatedAt:1}];
  const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:mixedChecks()}} tasks={tasks} onRemedy={()=>{}}/>);
  expect(html).toContain('Fix task running');
  expect(html).toContain('href="#/tasks/task%201"');
  expect(html).not.toContain('>Fix with agent<');
  const failed = renderToString(<DiagnosticResults report={{checkedAt:1,checks:mixedChecks()}} tasks={[{...tasks[0]!,state:'done',review:{accepted:true},diagnosticRecheck:{at:2,passed:false,level:'fail',detail:'help still fails'}}]} onRemedy={()=>{}}/>);
  expect(failed).toContain('Still failing after the fix task: help still fails');
  expect(failed).toContain('>Fix with agent<');
});

test('the review sheet lists every file and applies only from its primary button', async () => {
  const { ReviewSheet } = await import('../app/src/screens/settings/Diagnostics');
  const check = {name:'Skill claude-code',level:'warn' as const,detail:'missing',remedy:review};
  const preview = {revision:'r1',agent:'claude-code',files:['$HOME/.claude/skills/pacer/SKILL.md','$HOME/.claude/settings.json']};
  const html = renderToString(<ReviewSheet review={{check,preview,phase:'review'}} onApply={()=>{}} onClose={()=>{}}/>);
  expect(html).toContain('aria-label="Reconnect Claude"');
  expect(html).toContain('2 files change');
  expect(html).toContain('SKILL.md');
  expect(html).toContain('settings.json');
  expect(html).toContain('Apply and recheck');
  expect(html.match(/pc-btn--primary/g)).toHaveLength(1);
  const done = renderToString(<ReviewSheet review={{check,preview,phase:'done'}} report={{checkedAt:1,checks:[{...check,level:'ok'}]}} onApply={()=>{}} onClose={()=>{}}/>);
  expect(done).toContain('Updated 2 files and rechecked: Planner skill · Claude passes.');
});

test('the agent sheet shows the brief and scope, and links to the started task', async () => {
  const { AgentSheet } = await import('../app/src/screens/settings/Diagnostics');
  const check = {name:'CLI opencode',level:'fail' as const,detail:'opencode --help failed',remedy:agentTask('CLI opencode')};
  const html = renderToString(<AgentSheet agent={{check,scope:'fix',phase:'compose'}} onScope={()=>{}} onStart={()=>{}} onClose={()=>{}}/>);
  expect(html).toContain('aria-label="Fix with agent"');
  expect(html).toContain('Goal: Make the check “Compatibility · OpenCode” pass.');
  expect(html).toContain('opencode --help failed');
  expect(html).toContain('Fix it, ask before changing anything else');
  expect(html).toContain('Investigate only');
  expect(html).toContain('Start fix task');
  const started = renderToString(<AgentSheet agent={{check,scope:'investigate',phase:'started',taskId:'t-9'}} onScope={()=>{}} onStart={()=>{}} onClose={()=>{}}/>);
  expect(started).toContain('Fix task started');
  expect(started).toContain('Investigate: Compatibility · OpenCode');
  expect(started).toContain('href="#/tasks/t-9"');
});

test('the review sheet shows per-file change pills, notes and the 7-day undo note (board 17b)', async () => {
  const { ReviewSheet } = await import('../app/src/screens/settings/Diagnostics');
  const check = {name:'Skill claude-code',level:'warn' as const,detail:'missing',remedy:review};
  const preview = {revision:'r1',agent:'claude-code',files:['$HOME/.claude/skills/pacer/SKILL.md','$HOME/.claude/commands/pacer.md'],
    changes:[
      {path:'$HOME/.claude/skills/pacer/SKILL.md',change:'restore' as const,note:'Changed outside pacer; restored to the installed version'},
      {path:'$HOME/.claude/commands/pacer.md',change:'unchanged' as const,note:'Matches the installed version'},
      {path:'$HOME/.claude/CLAUDE.md',change:'kept' as const,note:'Yours. Pacer never edits it'},
    ]};
  const html = renderToString(<ReviewSheet review={{check,preview,phase:'review'}} onApply={()=>{}} onClose={()=>{}}/>);
  for (const pill of ['Restore','No change','Not touched']) expect(html).toContain(`>${pill}</span>`);
  expect(html).toContain('Changed outside pacer; restored to the installed version');
  expect(html).toContain('Yours. Pacer never edits it');
  expect(html).toContain('You can undo this from Diagnostics for 7 days');
  expect(html).toContain('2 files change');
  expect(html).not.toContain('pc-diagnostic-files');
  const done = renderToString(<ReviewSheet review={{check,preview,phase:'done',undo:{available:true,revision:'r1'}}} report={{checkedAt:1,checks:[{...check,level:'ok'}]}} onApply={()=>{}} onUndo={()=>{}} onClose={()=>{}}/>);
  expect(done).toContain('>Undo</');
  expect(done).toContain('Back to Diagnostics');
  expect(done).toContain('7 days');
});

test('the review sheet shows Undo only when the connect left something undoable, else a short reason (UI-13)', async () => {
  const { ReviewSheet } = await import('../app/src/screens/settings/Diagnostics');
  const check = {name:'Skill claude-code',level:'warn' as const,detail:'missing',remedy:review};
  const preview = {revision:'r1',agent:'claude-code',files:['$HOME/.claude/skills/pacer/SKILL.md']};
  // Available: the sheet offers Undo and keeps the 7-day note.
  const available = renderToString(<ReviewSheet review={{check,preview,phase:'done',undo:{available:true,revision:'r1'}}} onApply={()=>{}} onUndo={()=>{}} onClose={()=>{}}/>);
  expect(available).toContain('>Undo</');
  expect(available).toContain('for 7 days');
  // Unavailable: no Undo button, a plain-language reason instead.
  const unavailable = renderToString(<ReviewSheet review={{check,preview,phase:'done',undo:{available:false,reason:'too large to keep a copy'}}} onApply={()=>{}} onUndo={()=>{}} onClose={()=>{}}/>);
  expect(unavailable).toMatch(/Undo isn't available for this fix: too large to keep a copy/);
  expect(unavailable).not.toContain('>Undo</');
  // Unknown availability (older behaviour) falls back to the generic reason.
  const unknown = renderToString(<ReviewSheet review={{check,preview,phase:'done'}} onApply={()=>{}} onUndo={()=>{}} onClose={()=>{}}/>);
  expect(unknown).toMatch(/Undo isn't available for this fix: no pacer file changes to undo/);
});

test('the agent sheet names the executor pacer would route to, with no Change control (board 17c)', async () => {
  const { AgentSheet } = await import('../app/src/screens/settings/Diagnostics');
  const check = {name:'CLI opencode',level:'fail' as const,detail:'--help failed',remedy:agentTask('CLI opencode')};
  const html = renderToString(<AgentSheet agent={{check,scope:'fix',phase:'compose'}} routed={{id:'codex#team',reason:'22% of its budget used'}} onScope={()=>{}} onStart={()=>{}} onClose={()=>{}}/>);
  expect(html).toContain('Runs on');
  expect(html).toContain('Chosen by pacer: 22% of its budget used');
  expect(html).toContain('Codex');
  // doctor.fix.delegate has no executor override, so no Change control appears.
  expect(html).not.toMatch(/>Change</);
  // Without a routed executor the sheet keeps its generic line.
  const plain = renderToString(<AgentSheet agent={{check,scope:'fix',phase:'compose'}} onScope={()=>{}} onStart={()=>{}} onClose={()=>{}}/>);
  expect(plain).toContain('Pacer routes it to an executor by budget and pace');
});

test('agent.undo requires consent and restores the snapshot within 7 days, refusing when expired', async () => {
  const { callOp } = await import('../src/api/ops');
  const { restorePlannerInstall } = await import('../src/plugins/planner-install');
  const { sha256 } = await import('../src/install/fsx');
  const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ctx = fakeCtx();
  const folder = join(ctx.home, '.claude');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'settings.json'), installed = '{"hooks":{}}\n', before = '{"hooks":{}}\n';
  writeFileSync(path, installed);
  mkdirSync(ctx.pacerHome, { recursive: true });
  const key = 'claude-code';
  const snap = writeUndoSnapshot(ctx, key, [{ path, before, mode: 0o600, after: installed }], 'rev-1', ctx.now)!;
  writeFileSync(join(ctx.pacerHome, 'install-manifest.json'), JSON.stringify({ version: 1, planners: { [key]: {
    planner: 'claude-code', installedAt: ctx.now, pacerArgv: [], commands: [], notes: [],
    files: [{ path, action: 'edited', exact: true, undo: [] }],
    undoConnect: snap } } }));
  await expect(callOp(ctx, 'agent.undo', { agent: 'claude-code' })).rejects.toMatchObject({ code: 'not_allowed' });
  const r = await restorePlannerInstall(ctx, 'claude-code', key, 'rev-1');
  expect(r.restored).toEqual([path]);
  expect(readFileSync(path, 'utf8')).toBe(before);
  const { readManifest } = await import('../src/install/manifest');
  expect(readManifest(ctx).planners[key].undoneAt).toBeDefined();
  // Expired beyond the 7-day window is refused.
  const later = localTs(2026, 10, 28, 12, 0);
  const expiredCtx = fakeCtx({ now: later, pacerHome: tmpDir(), home: tmpDir() });
  const expiredFolder = join(expiredCtx.home, '.claude');
  mkdirSync(expiredFolder, { recursive: true });
  const expiredPath = join(expiredFolder, 'settings.json');
  writeFileSync(expiredPath, installed);
  mkdirSync(expiredCtx.pacerHome, { recursive: true });
  const expiredSnap = writeUndoSnapshot(expiredCtx, key, [{ path: expiredPath, before: installed, after: installed }], 'rev-1', localTs(2026, 10, 10, 12, 0))!;
  writeFileSync(join(expiredCtx.pacerHome, 'install-manifest.json'), JSON.stringify({ version: 1, planners: { [key]: {
    planner: 'claude-code', installedAt: localTs(2026, 10, 10, 12, 0), pacerArgv: [], commands: [], notes: [],
    files: [],
    undoConnect: expiredSnap } } }));
  await expect(restorePlannerInstall(expiredCtx, 'claude-code', key, 'rev-1')).rejects.toMatchObject({ code: 'not_found' });
  expect(existsSync(expiredPath)).toBe(true);
});

function fakeHost(answers: {confirm?: boolean; review?: boolean; delegate?: boolean} = {}) {
  const calls: [string, unknown][] = [], asked: unknown[] = [], opened: string[] = [], delegated: string[] = [], undos: {available:boolean;revision?:string;reason?:string}[] = [];
  const host = {
    call: async <T,>(op: string, params: unknown) => { calls.push([op, params]); return (op === 'agent.preview' ? {revision:'rev-7',agent:(params as {agent:string}).agent,files:['$HOME/a','$HOME/b']} : {}) as T; },
    confirm: async (request: unknown) => { asked.push(request); return answers.confirm ?? true; },
    review: async (preview: unknown) => { asked.push(preview); return answers.review ?? true; },
    delegate: async (check: string) => { delegated.push(check); return answers.delegate ?? true; },
    open: (url: string) => { opened.push(url); },
    reportUndo: (undo: {available:boolean;revision?:string;reason?:string}) => { undos.push(undo); },
  };
  return { host, calls, asked, opened, delegated, undos };
}

test('dispatch: automatic remedies run and recheck; consent is sent only after confirm', async () => {
  const { dispatchRemedy } = await import('../app/src/data/remedies');
  const { remedyPlan } = await import('../src/view-model/diagnostics');
  const plain = fakeHost();
  expect(await dispatchRemedy(remedyPlan(refresh)!, plain.host)).toBe('recheck');
  expect(plain.calls).toEqual([['limits.refresh',{account:'codex#tse'}]]);
  expect(plain.asked).toEqual([]);
  const files = fakeHost();
  expect(await dispatchRemedy(remedyPlan(updateFiles)!, files.host)).toBe('recheck');
  expect(files.asked).toEqual([expect.objectContaining({files:['$HOME/a','$HOME/b'],confirmLabel:'Update files'})]);
  expect(files.calls).toEqual([['agent.preview',{agent:'cursor'}],['agent.connect',{agent:'cursor',preview_revision:'rev-7',consent:true}]]);
  const declined = fakeHost({confirm:false});
  expect(await dispatchRemedy(remedyPlan(service)!, declined.host)).toBe('cancelled');
  expect(declined.calls).toEqual([]);
});

test('dispatch: review previews, waits for the sheet, then applies that revision with consent', async () => {
  const { dispatchRemedy } = await import('../app/src/data/remedies');
  const { remedyPlan } = await import('../src/view-model/diagnostics');
  const applied = fakeHost();
  expect(await dispatchRemedy(remedyPlan(review)!, applied.host)).toBe('recheck');
  expect(applied.calls).toEqual([['agent.preview',{agent:'claude-code'}],['agent.connect',{agent:'claude-code',consent:true,preview_revision:'rev-7'}]]);
  const closed = fakeHost({review:false});
  expect(await dispatchRemedy(remedyPlan(review)!, closed.host)).toBe('cancelled');
  expect(closed.calls).toEqual([['agent.preview',{agent:'claude-code'}]]);
});

test('dispatch: a reviewed connect reports its undo availability for the done sheet', async () => {
  const { dispatchRemedy } = await import('../app/src/data/remedies');
  const { remedyPlan } = await import('../src/view-model/diagnostics');
  const calls: [string, unknown][] = [], undos: {available:boolean;revision?:string;reason?:string}[] = [];
  // Cast the dispatch host (generic) through unknown; the responses are typed by shape only.
  const host = {
    call: async (op: string, params: unknown) => { calls.push([op, params]);
      if (op === 'agent.connect') return { installed: [], undo: { available: true, revision: 'rev-7' } };
      return { revision:'rev-7', agent:(params as {agent:string}).agent, files: [] }; },
    confirm: async () => true,
    review: async () => true,
    delegate: async () => true,
    open: () => {},
    reportUndo: (undo: {available:boolean;revision?:string;reason?:string}) => { undos.push(undo); },
  } as unknown as Parameters<typeof dispatchRemedy>[1];
  expect(await dispatchRemedy(remedyPlan(review)!, host)).toBe('recheck');
  expect(undos).toEqual([{ available: true, revision: 'rev-7' }]);
  // A connect that leaves nothing undoable reports the fallback reason.
  const none = {...host, call: async (op:string, p:unknown) => op === 'agent.connect' ? { installed: [], undo: { available:false, reason:'no pacer file changes to undo' } } : { revision:'r', agent:(p as {agent:string}).agent, files: [] }} as unknown as typeof host;
  const noneUndos: {available:boolean;revision?:string;reason?:string}[] = [];
  await dispatchRemedy(remedyPlan(review)!, {...none, reportUndo:(u:{available:boolean;revision?:string;reason?:string})=>noneUndos.push(u)});
  expect(noneUndos).toEqual([{ available:false, reason:'no pacer file changes to undo' }]);
});

test('dispatch: a consent-gated sign-in asks first; desktop refuses links it cannot open instead of claiming it opened them', async () => {
  const { dispatchRemedy, openRemedyUrl } = await import('../app/src/data/remedies');
  const { remedyPlan } = await import('../src/view-model/diagnostics');
  const gated = {...signIn, consent: true as const};
  const declined = fakeHost({confirm:false});
  expect(await dispatchRemedy(remedyPlan(gated)!, declined.host)).toBe('cancelled');
  expect(declined.calls).toEqual([]);
  const accepted = fakeHost();
  expect(await dispatchRemedy(remedyPlan(gated)!, accepted.host)).toBe('await-return');
  expect(accepted.calls).toEqual([['account.signin',{name:'codex',consent:true}]]);
  const opened: string[] = [];
  const desktop = {desktop:true, openExternal:(url: string) => { opened.push(url); }};
  expect(() => openRemedyUrl('x-apple.systempreferences:com.apple.preference.security', desktop)).toThrow('Open System Settings');
  openRemedyUrl('https://claude.ai/settings/billing', desktop);
  openRemedyUrl('x-apple.systempreferences:com.apple.preference.security', {...desktop, desktop:false});
  expect(opened).toEqual(['https://claude.ai/settings/billing','x-apple.systempreferences:com.apple.preference.security']);
});

test('dispatch: user remedies sign in or open the link and recheck on return; agent remedies delegate', async () => {
  const { dispatchRemedy, recheckOnReturn } = await import('../app/src/data/remedies');
  const { remedyPlan, secondaryPlan } = await import('../src/view-model/diagnostics');
  const user = fakeHost();
  expect(await dispatchRemedy(remedyPlan(signIn)!, user.host)).toBe('await-return');
  expect(await dispatchRemedy(remedyPlan(billing)!, user.host)).toBe('await-return');
  expect(await dispatchRemedy(secondaryPlan(billing)!, user.host)).toBe('recheck');
  expect(user.calls).toEqual([['account.signin',{name:'codex'}],['runner.block',{id:'claude-code',reason:'No active subscription'}]]);
  expect(user.opened).toEqual(['https://claude.ai/settings/billing']);
  const agent = fakeHost();
  expect(await dispatchRemedy(remedyPlan(agentTask('CLI opencode'))!, agent.host)).toBe('delegated');
  expect(agent.delegated).toEqual(['CLI opencode']);
  expect(await dispatchRemedy(remedyPlan(agentTask('CLI opencode'))!, fakeHost({delegate:false}).host)).toBe('cancelled');
  const target = new EventTarget(); let rechecks = 0;
  recheckOnReturn(() => rechecks++, target as never);
  target.dispatchEvent(new Event('focus')); target.dispatchEvent(new Event('focus'));
  expect(rechecks).toBe(1);
  const cancel = recheckOnReturn(() => rechecks++, target as never);
  cancel(); target.dispatchEvent(new Event('focus'));
  expect(rechecks).toBe(1);
});

test('dispatch: a service install that restarts pacer passes the old pid to the wait before the recheck', async () => {
  const { dispatchRemedy } = await import('../app/src/data/remedies');
  const { remedyPlan } = await import('../src/view-model/diagnostics');
  const order: unknown[] = [];
  const reply = (restarting: boolean) => async <T,>(op: string) => {
    order.push(op);
    return (op === 'snapshot.get' ? {snapshot:{service:{pid:10}}} : {installed:true,running:true,...(restarting ? {restarting:true} : {})}) as T;
  };
  const host = { ...fakeHost().host, call: reply(true), awaitRestart: async (before: number | undefined) => { order.push(['await-restart', before]); } };
  expect(await dispatchRemedy(remedyPlan(service)!, host)).toBe('recheck');
  expect(order).toEqual(['snapshot.get','service.install',['await-restart',10]]);
  // A reply without `restarting` (another client installed the job) rechecks at once.
  order.length = 0;
  expect(await dispatchRemedy(remedyPlan(service)!, { ...host, call: reply(false) })).toBe('recheck');
  expect(order).toEqual(['snapshot.get','service.install']);
  // A host that cannot wait skips the pid read.
  order.length = 0;
  expect(await dispatchRemedy(remedyPlan(service)!, { ...fakeHost().host, call: reply(true) })).toBe('recheck');
  expect(order).toEqual(['service.install']);
});

test('servicePid reads the answering service and gives up on a call that never settles', async () => {
  const { servicePid, restartsService } = await import('../app/src/data/remedies');
  expect(restartsService({restarting:true})).toBe(true);
  expect(restartsService({installed:true})).toBe(false);
  expect(restartsService(null)).toBe(false);
  expect(await servicePid(async <T,>(op: string) => (op === 'snapshot.get' ? {snapshot:{service:{pid:42}}} : {}) as T)).toBe(42);
  await expect(servicePid(() => new Promise(() => {}), 10)).rejects.toThrow('did not answer');
});

test('awaitServiceRestart polls the service itself until a new process answers, or gives up at the deadline', async () => {
  const { awaitServiceRestart } = await import('../app/src/data/remedies');
  let clock = 0;
  const opts = { intervalMs: 500, now: () => clock, sleep: async (ms: number) => { clock += ms; } };
  const sequence = (answers: (number | 'down' | undefined)[]) => {
    let seen = 0;
    return { read: async () => { const a = answers[Math.min(seen++, answers.length - 1)]; if (a === 'down') throw new Error('unreachable'); return a; }, seen: () => seen };
  };
  // The old process can still answer at first; only the new pid ends the wait.
  const known = sequence([10, 'down', 'down', 10, 11]);
  expect(await awaitServiceRestart(10, known.read, opts)).toBe(true);
  expect(known.seen()).toBe(5);
  // Without a known pid, the service must stop answering first.
  const unknown = sequence([10, 'down', 12]);
  expect(await awaitServiceRestart(undefined, unknown.read, opts)).toBe(true);
  expect(unknown.seen()).toBe(3);
  clock = 0;
  expect(await awaitServiceRestart(10, async () => 10, { ...opts, timeoutMs: 2000 })).toBe(false);
  expect(clock).toBe(2000);
  clock = 0;
  expect(await awaitServiceRestart(undefined, async () => 10, { ...opts, timeoutMs: 1000 })).toBe(false);
});

test('a restart wait keeps one snapshot.get in flight while a read never settles', async () => {
  const { awaitServiceRestart, servicePid } = await import('../app/src/data/remedies');
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  let calls = 0;
  const stuckCall = async <T,>(op: string) => (op === 'snapshot.get' ? (calls++, new Promise<never>(() => {})) : {} as T);
  expect(await awaitServiceRestart(10, () => servicePid(stuckCall, 20),
    { timeoutMs: 120, intervalMs: 30, sleep })).toBe(false);
  expect(calls).toBe(1);
});

test('a restart wait reuses a restarted service read that answers after several polls', async () => {
  const { awaitServiceRestart, servicePid } = await import('../app/src/data/remedies');
  let calls = 0, releaseRead: (value: unknown) => void;
  const slowCall = async <T,>(op: string) => {
    if (op !== 'snapshot.get') return {} as T;
    calls++;
    // The first read holds until the wait's first sleep releases it; later polls start their own.
    return new Promise<T>(resolve => { if (calls === 1) releaseRead = value => resolve(value as T);
      else resolve({ snapshot: { service: { pid: 11 } } } as T); });
  };
  const sleep = async () => { releaseRead({ snapshot: { service: { pid: 11 } } }); };
  expect(await awaitServiceRestart(10, () => servicePid(slowCall, 20), { timeoutMs: 3000, intervalMs: 20, sleep })).toBe(true);
  expect(calls).toBe(1);
});

test('fix-all runs the service install last so its restart cannot cut off the other fixes', async () => {
  const { serviceInstallLast } = await import('../app/src/data/remedies');
  const items = [{run:{op:'service.install',params:{}}},{run:{op:'limits.refresh',params:{}}},{run:{op:'agent.connect',params:{}}}];
  expect(serviceInstallLast(items).map(item => item.run.op)).toEqual(['limits.refresh','agent.connect','service.install']);
  expect(items[0].run.op).toBe('service.install');
});
