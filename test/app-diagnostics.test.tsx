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
  expect(html).toContain("unverified until observed");
});
test("results separate configuration, handler tests and unverified invocation with collapsed technical guidance", () => {
  const html = renderToString(<DiagnosticResults report={{checkedAt:0,checks:[
    {name:"Claude hook configuration",level:"ok",evidence:"configured",detail:"SessionStart command present"},
    {name:"Claude handler probes",level:"ok",evidence:"tested",detail:"Isolated fixture"},
    {name:"Claude host invocation",level:"info",evidence:"unverified",detail:"No host evidence",fix:"Inspect /hooks"},
  ]}}/>);
  for (const word of ["Configured","Tested working","Unverified","Suggested next step","Inspect /hooks", "Passed", "Not checked", "Planner"]) expect(html).toContain(word);
  expect(html).toContain('<details');
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html).toContain('Claude hook configuration\nSessionStart command present');
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
  expect(panel).toMatch(/<a(?=[^>]*href="[^"]*settings\/diagnostics")(?=[^>]*aria-current="page")[^>]*>[\s\S]*?Diagnostics<\/span><\/a>/);
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
  expect(html).toContain('Need a look');
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

 test('failures open with report details and totals count each check once', () => {
 const html = renderToString(<DiagnosticResults report={{checkedAt:1,checks:[
 {name:'Service',level:'fail',detail:'Connection refused',fix:'Start the service'},
 {name:'Binary codex',level:'ok',detail:'Installed'},
 {name:'Claude host invocation',level:'info',evidence:'unverified',detail:'No observation'},
 {name:'Activity',level:'info',detail:'Available'},
 ]}}/>);
 expect(html).toMatch(/<details[^>]*open/);
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
