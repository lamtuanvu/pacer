import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { DiagnosticResults, DiagnosticsSection, diagnosticReportText } from "../app/src/screens/settings/Diagnostics";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { callOp, opNames } from "../src/api/ops";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { fakeCtx } from "./helpers";

test("diagnostics starts idle and has an accessible service-backed run action", () => {
  const html = renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as any}}><DiagnosticsSection/></TaskContext.Provider>);
  expect(html).toContain("Run all checks");
  expect(html).toContain('role="status"');
  expect(html).toContain("No checks run yet");
  // The hook-invocation caveat belongs to a run result, not the idle page.
  expect(html).not.toContain("unverified until observed");
});
test("attention default does not mistake unverified checks for passed checks", () => {
  const report = {checkedAt:0, checks:[
    {name:"Claude hook configuration",level:"ok" as const,evidence:"configured" as const,detail:"SessionStart command present"},
    {name:"Claude handler probes",level:"ok" as const,evidence:"tested" as const,detail:"Isolated fixture"},
    {name:"Claude host invocation",level:"info" as const,evidence:"unverified" as const,detail:"No host evidence",fix:"Inspect /hooks"},
  ]};
  const html = renderToString(<DiagnosticResults report={report}/>);
  expect(html).toContain('Showing 0 of 3 checks needing attention.');
  expect(html).toContain('No checks need attention.');
  expect(html).toContain('data-count="2"');
  expect(html).toContain('data-count="1"');
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

test('results expose report-backed groups with individual collapsed rows', () => {
  const html = renderToString(<DiagnosticResults report={{checkedAt:0,checks:[
    {name:'Install codex',level:'warn',detail:'missing file',fix:'arbitrary command'},
    {name:'Skill codex',level:'warn',detail:'changed file'},
    {name:'Binary codex',level:'ok',detail:'installed'},
  ]}}/>);
  expect(html).toContain('Needs attention');
  expect(html).toContain('Executors');
  expect(html).toContain('Passed');
  expect(html.match(/<details/g)).toHaveLength(3);
  expect(html).not.toContain('Plugins');
});

test('repairs only target the selected planner integration, never suggested strings or another account', async () => {
  const { diagnosticRepair } = await import('../src/view-model/diagnostics');
  expect(diagnosticRepair({name:'Install codex#work',level:'warn',detail:''}, 'codex#work')).toEqual({agent:'codex'});
  expect(diagnosticRepair({name:'Install codex#other',level:'warn',detail:''}, 'codex#work')).toBeUndefined();
  expect(diagnosticRepair({name:'Service',level:'warn',detail:'',fix:'pacer install codex'}, 'codex')).toBeUndefined();
  expect(diagnosticRepair({name:'Claude hook configuration',level:'warn',detail:''}, 'claude-code')).toEqual({agent:'claude-code'});
  expect(diagnosticRepair({name:'Install codex',level:'ok',detail:''}, 'codex')).toBeUndefined();
});

test('unverified evidence remains visible on warnings without double counting', () => {
 const html=renderToString(<DiagnosticResults report={{checkedAt:0,checks:[{name:'Claude hook configuration',level:'warn',evidence:'unverified',detail:'missing settings'}]}}/>);
 expect(html).toContain('Not checked');
 expect(html).toContain('Unverified');
 // Unverified warnings remain warnings: summary buckets never count a row twice.
 expect(html).toContain('data-count="0"');
});

test('named install checks retain their account and unavailable account folders offer setup instead of repair', async () => {
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
 const html=renderToString(<DiagnosticResults report={unavailable} onRepair={()=>{}}/>);
 expect(html).not.toContain('>Repair<');
});

test('setup links lead to relevant flows and do not imply planner setup fixes host issues', async () => {
 const {diagnosticSetupLink}=await import('../src/view-model/diagnostics');
 expect(diagnosticSetupLink({name:'Usage codex#work',level:'warn',detail:''})?.href).toBe('#/settings/accounts');
 expect(diagnosticSetupLink({name:'Service',level:'warn',detail:''})?.href).toBe('#/setup');
 expect(diagnosticSetupLink({name:'macOS code signing',level:'warn',detail:''})).toBeUndefined();
 expect(diagnosticSetupLink({name:'Orca',level:'warn',detail:''})).toBeUndefined();
});

 test('failures start collapsed with plain details and totals count each check once', () => {
 const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:[
 {name:'Service',level:'fail',detail:'Connection refused',fix:'Start the service'},
 {name:'Binary codex',level:'ok',detail:'Installed'},
 {name:'Claude host invocation',level:'info',evidence:'unverified',detail:'No observation'},
 {name:'Activity',level:'info',detail:'Available'},
 ]}}/>);
 expect(html).not.toMatch(/<details[^>]*open[^>]*class="pc-disclosure pc-diagnostic-row__details/);
 expect(html).toContain('Connection refused');
 expect(html).toContain('Start the service');
 expect(html.match(/data-count="1"/g)).toHaveLength(3);
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

test('attention rows expose next steps without opening technical details and omit missing timing', () => {
 const html=renderToString(<DiagnosticResults report={{checkedAt:1,checks:[{name:'Service',level:'warn',detail:'installed: true; running: false; healthy: false; binary matches current: true',fix:'pacer service restart'}]}}/>);
 expect(html).toContain('not running');
 expect(html).toContain('Technical details');
 expect(html).not.toContain('Not recorded');
 expect(html).toContain('Search checks');
 expect(html).toContain('Filter checks');
});


test('diagnostic summaries distinguish service failures and retain measured latency', async () => {
 const {diagnosticSummary, diagnosticBucket} = await import('../src/view-model/diagnostics');
 const check=(name:string,detail:string)=>({name,detail,level:'warn' as const});
 expect(diagnosticSummary(check('Service','installed: false; running: false; healthy: false; binary matches current: false'))).toContain('not installed');
 expect(diagnosticSummary(check('Service','installed: true; running: true; healthy: true; binary matches current: false'))).toBe('The service uses a different installed version.');
 expect(diagnosticSummary(check('Link latency','/v2/snapshot max 120.5 ms across 3 requests (target < 50 ms)'))).toContain('120.5 ms');
 expect(diagnosticSummary(check('Removable volume access','$HOME/repo: access denied (Operation not permitted)'))).toContain('denied access');
 expect(diagnosticSummary(check('macOS code signing','code object is not signed at all'))).toContain('no code signature');
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
