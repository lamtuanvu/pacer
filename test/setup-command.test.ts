import { withVersionFixtures } from "./planner-detect-fixtures";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupCmd, type SetupDeps } from "../src/commands/setup";
import { validateStrategy } from "../src/config/strategy";
import { readManifest } from "../src/install/manifest";
import { main } from "../src/cli";
import { fakeCtx } from "./install-plugin-fixtures";
function fixture(bins = ["claude", "codex", "cursor-agent", "opencode"]) {
 const ctx = withVersionFixtures(fakeCtx({ which: bin => bins.includes(bin) ? `/fixture/${bin}` : null, env: { PACER_BIN: "/fixture/pacer" } }));
 let installed = false, installs = 0, questions: string[] = [], previews: string[] = [];
 const deps: SetupDeps = { tty: false, stdoutTTY: false, print: () => {}, question: async q => { questions.push(q); return ""; }, confirm: async p => { previews.push(p); return false; },
  onboardingClient: async () => { throw new Error("No service in the setup unit fixture"); },
  service: () => ({ status: async () => ({ installed }) as any, install: async () => { installed = true; installs++; return []; } }) };
 return { ctx, deps, questions, previews, get installs() { return installs; } };
}
test("non TTY ensures strategy and skips service but never edits agent config without consent", async () => {
 const f = fixture(), r = await setupCmd(["--json"], f.ctx, f.deps);
 expect(r.code).toBe(0); expect(JSON.parse(r.out).agents.every((a:any) => !a.installed)).toBe(true);
 expect(f.installs).toBe(0); expect(existsSync(join(f.ctx.home, ".claude"))).toBe(false); expect(f.questions).toHaveLength(0);
});
test("planner numbered question uses choice, current default and --planner skips", async () => {
 const f = fixture();
 expect((await setupCmd([], f.ctx, { ...f.deps, tty: true, question: async q => { f.questions.push(q); return "2"; } })).code).toBe(0);
 const path = join(f.ctx.pacerHome, "strategy.yaml"); expect(validateStrategy(Bun.YAML.parse(readFileSync(path,"utf8")),path).planner.agent).toBe("codex");
 expect(f.questions[0]).toContain("1. claude-code\n2. codex");
 await setupCmd([], f.ctx, {...f.deps,tty:true}); expect(f.questions.some(q => q.includes("Planner [2]"))).toBe(true);
 f.questions.length=0; const before=readFileSync(path,"utf8");
 await setupCmd(["--planner","opencode","--service"],f.ctx,{...f.deps,tty:true});expect(f.questions).toHaveLength(0);
 const after=readFileSync(path,"utf8");
 expect(validateStrategy(Bun.YAML.parse(after),path).planner.agent).toBe("opencode");
 expect(after.slice(after.indexOf("\n"))).toBe(before.slice(before.indexOf("\n")));
});
test("no CLI still creates valid strategy, explicit missing planner is accepted", async () => {
 for (const args of [[], ["--planner", "cursor"]]) {
  const f=fixture([]),r=await setupCmd(args,f.ctx,f.deps);expect(r.code).toBe(0);expect(r.out).toContain("No agent CLI was found");
  expect(validateStrategy(Bun.YAML.parse(readFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"utf8")),"test").planner.agent).toBe(args.length?"cursor":"claude-code");
 }
});
test("TTY per-agent no leaves configs untouched; yes connects only consenting agents",async()=>{
 const f=fixture();await setupCmd([],f.ctx,{...f.deps,tty:true});expect(f.previews).toHaveLength(4);expect(readManifest(f.ctx).planners).toEqual({});
 const r=await setupCmd([],f.ctx,{...f.deps,tty:true,confirm:async p=>{expect(p).toContain("Undo: pacer uninstall");expect(p).toContain("No MCP");return p.startsWith("Codex:");}});
 expect(r.code).toBe(0);expect(Object.keys(readManifest(f.ctx).planners)).toEqual(["codex"]);expect(existsSync(join(f.ctx.home,".claude"))).toBe(false);
});
test("--yes connects without MCP; rerun is idempotent",async()=>{
 const f=fixture();const r=await setupCmd(["--yes","--json"],f.ctx,f.deps);expect(r.code).toBe(0);expect(Object.keys(readManifest(f.ctx).planners)).toHaveLength(4);
 const path=join(f.ctx.home,".claude/settings.json"),before=readFileSync(path,"utf8");
 const again=await setupCmd(["--yes"],f.ctx,f.deps);expect(again.code).toBe(0);expect(again.out).toContain("✓ Codex (already done)");expect(f.installs).toBe(1);expect(readFileSync(path,"utf8")).toBe(before);
 expect(existsSync(join(f.ctx.home,".codex/config.toml"))).toBe(false);
});
test("non-TTY --agents grants consent only to selection",async()=>{
 const f=fixture();expect((await setupCmd(["--agents","codex"],f.ctx,f.deps)).code).toBe(0);expect(Object.keys(readManifest(f.ctx).planners)).toEqual(["codex"]);
});
for(const args of [["--agents","wrong"],["--agents"],["--planner","wrong"],["--wat"]])test(`init rejects ${args.join(" ")}`,async()=>{
 const f=fixture();expect((await setupCmd(args,f.ctx,f.deps)).code).toBe(2);expect(f.installs).toBe(0);
});
test("init no longer offers an Orca panel when Orca is installed",async()=>{
 const f=fixture([]);f.ctx.env.ORCA_CLI_COMMAND="orca";const r=await setupCmd([],f.ctx,f.deps);expect(r.code).toBe(0);expect(r.out).not.toMatch(/Orca|live panel/i);
});
test("CLI help exposes init and setup alias",async()=>{const f=fixture();const help=(await main(["help"],f.ctx)).out;expect(help).toContain("init [--planner");expect(help).toContain("setup [--planner");});
test("non-TTY input never launches dashboard even if stdout is a TTY",async()=>{
 const f=fixture([]);let dashboards=0;const r=await setupCmd([],f.ctx,{...f.deps,stdoutTTY:true,dashboard:async()=>{dashboards++;return {code:0,out:"",err:""};}});expect(r.code).toBe(0);expect(dashboards).toBe(0);
});

test("login service requires consent in TTY and explicit opt-in without a TTY", async () => {
 for (const args of [[], ["--service"], ["--yes"]]) {
  const f = fixture(["claude"]);
  const r = await setupCmd([...args, "--json"], f.ctx, f.deps);
  expect(r.code).toBe(0);
  expect(f.installs).toBe(args.length ? 1 : 0);
  expect(JSON.parse(r.out).service).toBe(args.length > 0);
 }
 for (const answer of ["", "n"]) {
  const f = fixture(["claude"]);
  const r = await setupCmd(["--no-dashboard"], f.ctx, { ...f.deps, tty: true, question: async q => { f.questions.push(q); return answer; } });
  expect(r.code).toBe(0);
  expect(f.questions[0]).toBe("Run pacer in the background at login? It keeps budgets fresh and runs delegated tasks. [Y/n] ");
  expect(f.installs).toBe(answer === "" ? 1 : 0);
 }
});

test("init ends with useful next actions and an honest service summary", async () => {
 const f = fixture(["claude"]);
 const r = await setupCmd([], f.ctx, f.deps);
 expect(r.out).toContain("login service skipped");
 expect(r.out).toContain("Next:");
 expect(r.out).toContain("Ask your planner for some work and it will delegate");
 expect(r.out).toContain("pacer open");
 expect(r.out).toContain("pacer doctor");
 expect(r.out).not.toContain("pacer install");
});

for (const answer of ["", "yes", "n"]) test(`init offers first delegation with answer ${JSON.stringify(answer)} after summary and before dashboard`, async () => {
 const f=fixture(["claude"]),events:string[]=[];
 const r=await setupCmd(["--yes"],f.ctx,{...f.deps,tty:true,stdoutTTY:true,
  print:line=>events.push(line),question:async q=>{events.push(q);return answer;},
  onboardingClient:async()=>({close(){events.push("closed");},call:async<T>(op:string)=>{
   events.push(op);
   return (op==="setup.check"?{items:[{id:"executor",status:"done"},{id:"first",status:"pending"}]}:{task_id:"t-first",executor:"codex",repo:"/tmp/scratch"}) as T;
  }}),dashboard:async()=>{events.push("dashboard");return {code:0,out:"",err:""};}});
 expect(r.code).toBe(0);
 const offer="Try a first delegation now? It runs a tiny docs task in a scratch repo. [Y/n] ";
 expect(events).toContain(offer);
 expect(events.indexOf(offer)).toBeGreaterThan(events.findIndex(e=>e.startsWith("Setup:")));
 expect(events.indexOf(offer)).toBeLessThan(events.indexOf("dashboard"));
 expect(events).toContain(answer==="n"?"onboarding.skip":"onboarding.try");
 if(answer!=="n")expect(events).toContain("Started t-first on codex. Review it with: pacer review t-first (or in pacer open)");
 expect(events).toContain("closed");
});

for (const [tty,ranked,done] of [[false,true,false],[true,false,false],[true,true,true]]) test(`init skips first delegation offer tty=${tty} ranked=${ranked} reviewed=${done}`,async()=>{
 const f=fixture(["claude"]),calls:string[]=[];
 const r=await setupCmd(["--yes","--no-dashboard"],f.ctx,{...f.deps,tty,onboardingClient:async()=>({close(){},call:async<T>(op:string)=>{
  calls.push(op);return {items:[{id:"executor",status:ranked?"done":"pending"},{id:"first",status:done?"done":"pending"}]} as T;
 }})});
 expect(r.code).toBe(0);expect(f.questions).toEqual([]);expect(calls).toEqual(tty?["setup.check"]:[]);
});

test("init still succeeds when the first-delegation offer cannot reach the service", async () => {
 const f=fixture(["claude"]),lines:string[]=[];
 const r=await setupCmd(["--yes","--no-dashboard"],f.ctx,{...f.deps,tty:true,print:line=>lines.push(line),onboardingClient:async()=>{throw new Error("pacer isn't running");}});
 expect(r.code).toBe(0);
 expect(lines.join("\n")).toContain("Try a first delegation later");
});
test('init exposes actual policy mode in text and JSON even with no policy plugins',async()=>{
 const f=fixture([]);
 const first=await setupCmd(['--json'],f.ctx,f.deps);
 expect(JSON.parse(first.out).policy).toEqual({mode:'open',plugins:0});
 const path=join(f.ctx.pacerHome,'strategy.yaml');
 const {writeFileSync}=await import('node:fs');writeFileSync(path,readFileSync(path,'utf8')+'\nplugins:\n  policy:\n    mode: closed\n');
 const next=await setupCmd([],f.ctx,f.deps);
 expect(next.out).toContain('policy: closed (0 plugins)');
});
