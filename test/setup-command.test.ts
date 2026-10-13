import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupCmd, type SetupDeps } from "../src/commands/setup";
import { agentPlans } from "../src/install/detection";
import { readManifest } from "../src/install/manifest";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";
function fixture(bins=["claude","codex","cursor","opencode"]) {
 const ctx=fakeCtx({which:bin=>bins.includes(bin)?`/fixture/${bin}`:null,env:{PACER_BIN:"/fixture/pacer"}});
 let installed=false, installs=0,statuses=0;
 const deps:SetupDeps={tty:false,service:()=>({status:async()=>{statuses++;return {installed} as any;},install:async()=>{installs++;installed=true;return [];}})};
 return {ctx,deps,get installs(){return installs;},get statuses(){return statuses;}};
}
test("non TTY preview exits 2 without any strategy, service or integration writes",async()=>{
 const {ctx,deps}=fixture();const result=await setupCmd([],ctx,deps);expect(result.code).toBe(2);
 expect(result.out).toContain("Claude Code:");expect(result.out).toContain("settings.json");expect(result.out).toContain("Undo: pacer uninstall codex");
 expect(existsSync(ctx.pacerHome)).toBe(false);expect(existsSync(join(ctx.home,".claude"))).toBe(false);
 const json=await setupCmd(["--json"],ctx,deps);expect(JSON.parse(json.out).applied).toBe(false);
});
test("TTY confirmation default no is mutation-free; yes applies exact selection",async()=>{
 const f=fixture();const no=await setupCmd([],f.ctx,{...f.deps,tty:true,confirm:async plan=>{expect(plan).toContain("No MCP");return false;}});
 expect(no.code).toBe(2);expect(existsSync(f.ctx.pacerHome)).toBe(false);
 const yes=await setupCmd(["--agents","codex"],f.ctx,{...f.deps,tty:true,confirm:async()=>true});expect(yes.code).toBe(0);expect(Object.keys(readManifest(f.ctx).planners)).toEqual(["codex"]);expect(f.installs).toBe(1);
});
test("setup ensures own components and installs detected agents once without adding MCP",async()=>{
 const f=fixture();const r=await setupCmd(["--yes","--json"],f.ctx,f.deps);expect(r.code).toBe(0);
 expect(JSON.parse(r.out).agents.map((a:any)=>a.id)).toEqual(["claude-code","codex","cursor","opencode"]);expect(existsSync(join(f.ctx.pacerHome,"strategy.yaml"))).toBe(true);expect(f.installs).toBe(1);
 const before=readFileSync(join(f.ctx.home,".claude/settings.json"),"utf8");const manifest=readManifest(f.ctx);
 expect(Object.keys(manifest.planners)).toHaveLength(4);
 expect(existsSync(join(f.ctx.home,".codex/config.toml"))).toBe(false);expect(existsSync(join(f.ctx.home,".cursor/mcp.json"))).toBe(false);expect(existsSync(join(f.ctx.home,".config/opencode/opencode.json"))).toBe(false);
 const again=await setupCmd(["--yes"],f.ctx,f.deps);expect(again.code).toBe(0);expect(again.out).toContain("Codex: already connected");expect(f.installs).toBe(1);expect(readFileSync(join(f.ctx.home,".claude/settings.json"),"utf8")).toBe(before);
});
for(const args of [["--agents","wrong"],["--agents"],["--wat"],["--agents","codex,"]])test(`setup rejects arguments ${args.join(" ")}`,async()=>{
 const f=fixture();expect((await setupCmd(args,f.ctx,f.deps)).code).toBe(2);expect(f.statuses).toBe(0);
});
test("missing selected CLI errors before own setup; init and service failures do not install agents",async()=>{
 const f=fixture(["claude"]);expect((await setupCmd(["--yes","--agents","codex"],f.ctx,f.deps)).code).toBe(2);
 expect((await setupCmd(["--yes"],f.ctx,f.deps)).code).toBe(1);expect(existsSync(join(f.ctx.home,".claude"))).toBe(false);
 const g=fixture();mkdirSync(g.ctx.pacerHome,{recursive:true});writeFileSync(join(g.ctx.pacerHome,"strategy.yaml"),"already exists");
 const r=await setupCmd(["--yes"],g.ctx,{...g.deps,service:()=>({status:async()=>{throw new Error("service unavailable");},install:async()=>[]})});expect(r.code).toBe(1);expect(r.err).toContain("service unavailable");expect(existsSync(join(g.ctx.home,".codex"))).toBe(false);
});
test("setup with no agents is harmless when strategy exists; preview honors custom paths",async()=>{
 const f=fixture([]);mkdirSync(f.ctx.pacerHome,{recursive:true});writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"exists");expect((await setupCmd(["--yes"],f.ctx,f.deps)).out).toBe("No agent CLIs detected.");
 const g=fixture();g.ctx.env.CODEX_HOME=join(g.ctx.home,"custom-codex");g.ctx.env.XDG_CONFIG_HOME=join(g.ctx.home,"custom-config");
 const agents=agentPlans(g.ctx.home,g.ctx.pacerHome,g.ctx.which,g.ctx.env);expect(agents.find(a=>a.id==="codex")?.files[0]).toBe(join(g.ctx.home,"custom-codex/skills/pacer/SKILL.md"));expect(agents.find(a=>a.id==="opencode")?.files[0]).toBe(join(g.ctx.home,"custom-config/opencode/skills/pacer/SKILL.md"));
});
test("CLI exposes setup in help and routes non TTY previews",async()=>{
 const f=fixture();expect((await main(["help"],f.ctx)).out).toContain("setup [--yes]");const r=await main(["setup"],f.ctx);expect(r.code).toBe(2);expect(r.out).toContain("Codex");
});
