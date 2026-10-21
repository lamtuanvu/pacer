import { expect, test } from "bun:test";
import { renderToString } from "preact-render-to-string";
import { DiagnosticResults, DiagnosticsSection } from "../app/src/screens/settings/Diagnostics";
import { TaskContext } from "../app/src/screens/task-shared";
import { initialState } from "../app/src/data/store";
import { callOp, opNames } from "../src/api/ops";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { fakeCtx } from "./helpers";

test("diagnostics starts idle and has an accessible service-backed run action", () => {
  const html = renderToString(<TaskContext.Provider value={{state:initialState(),api:{} as any}}><DiagnosticsSection/></TaskContext.Provider>);
  expect(html).toContain("Run checks");
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
  for (const word of ["Configured","Tested working","Unverified","Suggested next step","Inspect /hooks"]) expect(html).toContain(word);
  expect(html).toContain('<details');
  expect(html).not.toContain('<details open');
  expect(html).toContain('<pre>Claude hook configuration\nSessionStart command present</pre>');
});
test("doctor operation is additive and v3-only, with structured results and honest host evidence", async () => {
  expect(opNames()).toContain("doctor.run");
  expect(V3_ONLY_OPS.has("doctor.run")).toBe(true);
  const ctx=fakeCtx({which:()=>null});
  const {mkdirSync,writeFileSync} = await import('node:fs');
  const {join} = await import('node:path');
  mkdirSync(ctx.pacerHome,{recursive:true});
  writeFileSync(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n');
  const result=await callOp(ctx,"doctor.run",{}) as {checkedAt:number;checks:any[]};
  expect(result.checkedAt).toBe(ctx.now);
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
  expect(panel).toMatch(/<a(?=[^>]*href="[^"]*settings\/diagnostics")(?=[^>]*aria-current="page")[^>]*>[\s\S]*?Diagnostics<\/a>/);
  expect(local).not.toContain('aria-label="Settings sections"');
  expect(local).toContain('id="diagnostics"');
});
