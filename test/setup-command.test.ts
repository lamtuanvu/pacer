import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupCmd, waitForLive, type SetupDeps } from "../src/commands/setup";
import { validateStrategy } from "../src/config/strategy";
import { readManifest } from "../src/install/manifest";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
function fixture(bins = ["claude", "codex", "cursor-agent", "opencode"]) {
 const ctx = fakeCtx({ which: bin => bins.includes(bin) ? `/fixture/${bin}` : null, env: { PACER_BIN: "/fixture/pacer" } });
 let installed = false, installs = 0, questions: string[] = [], previews: string[] = [];
 const deps: SetupDeps = { tty: false, stdoutTTY: false, orcaInstalled: false, print: () => {}, question: async q => { questions.push(q); return ""; }, confirm: async p => { previews.push(p); return false; }, service: () => ({ status: async () => ({ installed }) as any, install: async () => { installed = true; installs++; return []; } }) };
 return { ctx, deps, questions, previews, get installs() { return installs; } };
}
test("non TTY ensures strategy/service but never edits agent config without consent", async () => {
 const f = fixture(), r = await setupCmd(["--json"], f.ctx, f.deps);
 expect(r.code).toBe(0); expect(JSON.parse(r.out).agents.every((a:any) => !a.installed)).toBe(true);
 expect(f.installs).toBe(1); expect(existsSync(join(f.ctx.home, ".claude"))).toBe(false); expect(f.questions).toHaveLength(0);
});
test("planner numbered question uses choice, current default and --planner skips", async () => {
 const f = fixture();
 expect((await setupCmd([], f.ctx, { ...f.deps, tty: true, question: async q => { f.questions.push(q); return "2"; } })).code).toBe(0);
 const path = join(f.ctx.pacerHome, "strategy.yaml"); expect(validateStrategy(Bun.YAML.parse(readFileSync(path,"utf8")),path).planner).toBe("codex");
 expect(f.questions[0]).toContain("1. claude-code\n2. codex");
 await setupCmd([], f.ctx, {...f.deps,tty:true}); expect(f.questions.at(-1)).toContain("Planner [2]");
 f.questions.length=0; const before=readFileSync(path,"utf8");
 await setupCmd(["--planner","opencode"],f.ctx,{...f.deps,tty:true});expect(f.questions).toHaveLength(0);
 expect(readFileSync(path,"utf8")).toBe(before.replace("planner: codex","planner: opencode"));
});
test("no CLI still creates valid strategy, explicit missing planner is accepted", async () => {
 for (const args of [[], ["--planner", "cursor"]]) {
  const f=fixture([]),r=await setupCmd(args,f.ctx,f.deps);expect(r.code).toBe(0);expect(r.out).toContain("No agent CLI was found");
  expect(validateStrategy(Bun.YAML.parse(readFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"utf8")),"test").planner).toBe(args.length?"cursor":"claude-code");
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
test("live wait succeeds, Enter skips, timeout uses fake clock",async()=>{
 let at=0;
 expect(await waitForLive("unused",()=>{},{now:()=>at,live:()=>at>=2,sleep:async()=>{at++;},skip:new Promise(()=>{})})).toBe(true);
 expect(await waitForLive("unused",()=>{},{live:()=>false,skip:Promise.resolve()})).toBe(false);
 at=0;expect(await waitForLive("unused",()=>{},{now:()=>at,live:()=>false,sleep:async()=>{at+=60;},skip:new Promise(()=>{})})).toBe(false);
});
test("Orca init installs panel; TTY waits; non-TTY never waits/dashboard",async()=>{
 for(const tty of [false,true]){
  const f=fixture([]);let waits=0,dashboards=0,installs=0;const lines:string[]=[];
  const r=await setupCmd([],f.ctx,{...f.deps,tty,stdoutTTY:tty,orcaInstalled:true,print:l=>lines.push(l),plugin:async()=>{installs++;return {text:"done"};},waitLive:async()=>{waits++;return true;},dashboard:async()=>{dashboards++;return {code:0,out:"dashboard",err:""};}});
  expect(r.code).toBe(0);expect(installs).toBe(1);expect(waits).toBe(tty?1:0);expect(dashboards).toBe(tty?1:0);if(tty)expect(lines).toContain("✓ Live panel connected");else expect(r.out).toContain("Finish later with: pacer init");
 }
 const f=fixture([]);const lines:string[]=[];await setupCmd(["--no-dashboard"],f.ctx,{...f.deps,tty:true,orcaInstalled:true,print:l=>lines.push(l),plugin:async()=>({text:""}),waitLive:async()=>false});expect(lines).toContain("Finish later with: pacer init");
});
test("CLI help exposes init and setup alias",async()=>{const f=fixture();const help=(await main(["help"],f.ctx)).out;expect(help).toContain("init [--planner");expect(help).toContain("setup [--planner");});
test("non-TTY input never launches dashboard even if stdout is a TTY",async()=>{
 const f=fixture([]);let dashboards=0;const r=await setupCmd([],f.ctx,{...f.deps,stdoutTTY:true,dashboard:async()=>{dashboards++;return {code:0,out:"",err:""};}});expect(r.code).toBe(0);expect(dashboards).toBe(0);
});
