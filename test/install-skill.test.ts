import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installPlanner } from "../src/install";
import { uninstallPlanner } from "../src/install/uninstall";
import { runDoctor } from "../src/install/doctor";
import { PACER_SKILL } from "../src/install/skill";
import { readManifest } from "../src/install/manifest";
import { fakeCtx } from "./install-plugin-fixtures";
import { PACER, snapshot } from "./install-helpers";
import { main } from "../src/cli";

const planners=[['claude-code','.claude'],['codex','.codex'],['cursor','.cursor'],['opencode','.config/opencode']] as const;
for(const [planner,dir] of planners){
 test(`${planner} default installs tracked skill without MCP and uninstalls byte-exactly`,async()=>{
  const calls:string[][]=[],ctx=fakeCtx({run:async a=>{calls.push(a);return {code:0,stdout:"",stderr:""};}}),before=snapshot(ctx.home);
  const r=await installPlanner({ctx,pacerArgv:PACER},planner),path=join(ctx.home,dir,"skills/pacer/SKILL.md");
  expect(readFileSync(path,"utf8")).toBe(PACER_SKILL);expect(r.record.files.some(f=>f.path===path)).toBe(true);
  expect(calls).toEqual([]);
  expect(existsSync(join(ctx.home,dir,planner==="codex"?"config.toml":planner==="opencode"?"opencode.json":"mcp.json"))).toBe(false);
  expect((await installPlanner({ctx,pacerArgv:PACER},planner)).touched).toEqual([]);
  expect((await runDoctor(ctx)).find(c=>c.name===`Skill ${planner}`)?.level).toBe("ok");
  await uninstallPlanner(ctx,planner);expect(snapshot(ctx.home)).toEqual(before);
 });
 test(`${planner} backs up a pre-existing skill and preserves later user changes`,async()=>{
  const ctx=fakeCtx(),path=join(ctx.home,dir,"skills/pacer/SKILL.md");mkdirSync(dirname(path),{recursive:true});writeFileSync(path,"user skill\n");
  await installPlanner({ctx,pacerArgv:PACER},planner);await uninstallPlanner(ctx,planner);expect(readFileSync(path,"utf8")).toBe("user skill\n");
  await installPlanner({ctx,pacerArgv:PACER},planner);writeFileSync(path,"user edits after install\n");await uninstallPlanner(ctx,planner);expect(readFileSync(path,"utf8")).toBe("user edits after install\n");
 });
}
for(const [planner,relative,content,marker] of [
 ['codex','.codex/config.toml','model="keep"\n[mcp_servers.pacer]\ncommand="old"\n','[mcp_servers.pacer]'],
 ['cursor','.cursor/mcp.json','{"mcpServers":{"pacer":{"command":"old"},"other":{"command":"keep"}}}','"pacer"'],
 ['opencode','.config/opencode/opencode.json','{"mcp":{"pacer":{"type":"local","command":["old"]},"other":{"type":"local","command":["keep"]}}}','"pacer"'],
] as const){
 test(`${planner} preserves existing MCP by default, removes explicitly and restores backup`,async()=>{
  const ctx=fakeCtx(),path=join(ctx.home,relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);
  await installPlanner({ctx,pacerArgv:PACER},planner);expect(readFileSync(path,"utf8")).toBe(content);
  await installPlanner({ctx,pacerArgv:PACER,mcp:false},planner);expect(readFileSync(path,"utf8")).not.toContain(marker);expect(readFileSync(path,"utf8")).toContain("keep");
  await uninstallPlanner(ctx,planner);expect(readFileSync(path,"utf8")).toBe(content);
 });
}
test("claude-code --no-mcp removes MCP through the claude CLI and never edits ~/.claude.json",async()=>{
 const calls:string[][]=[],ctx=fakeCtx({which:()=>"/usr/bin/claude",run:async(argv:string[])=>{calls.push(argv);return {code:0,stdout:"",stderr:""};}}),path=join(ctx.home,".claude.json"),content='{"mcpServers":{"pacer":{"command":"old"}}}';
 const binary=join(ctx.pacerHome,"fixture-claude"),log=join(ctx.pacerHome,"fixture-calls.jsonl");mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(binary,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(binary)},...process.argv.slice(2)])+'\\n');`,{mode:0o700});ctx.which=name=>name==="claude"?binary:null;
 writeFileSync(path,content);await installPlanner({ctx,pacerArgv:PACER,mcp:false},"claude-code");
 calls.push(...readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line)));
 expect(calls).toContainEqual([binary,"mcp","remove","-s","user","pacer"]);expect(calls.some(a=>a.includes("add"))).toBe(false);expect(readFileSync(path,"utf8")).toBe(content);
});
test("skill is short, describes CLI fields and executor/worktree rules",()=>{
 expect(PACER_SKILL.split("\n").length).toBeLessThan(80);expect(PACER_SKILL).toStartWith("---\nname: pacer\ndescription:");
  for(const s of ['budget','pace','worktree_reason','timeout_min','brief-file -','pacer wait','pacer review','pacer stop','report-limit','PACER_WORK_GRANT','pacer dispatch child','uncommitted','parallel','a grant cannot retry or answer its own task','## Other product actions','pacer api describe runner.settings.save','expect_rev','Never replay an uncertain mutation blindly','pacer session io','pacer attachment','pending is not success','Do not read private task files, credentials or logs.'])expect(PACER_SKILL).toContain(s);
});
test("install CLI accepts MCP options, defaults to skill, and rejects conflicting flags",async()=>{
 const ctx=fakeCtx({env:{PACER_BIN:PACER[0]}});
 expect((await main(["install","codex"],ctx)).code).toBe(0);expect(existsSync(join(ctx.home,".codex/config.toml"))).toBe(false);
 expect((await main(["install","codex","--mcp"],ctx)).code).toBe(0);expect(readFileSync(join(ctx.home,".codex/config.toml"),"utf8")).toContain("[mcp_servers.pacer]");
 expect((await main(["install","codex","--no-mcp"],ctx)).code).toBe(0);expect(readFileSync(join(ctx.home,".codex/config.toml"),"utf8")).not.toContain("[mcp_servers.pacer]");
 expect((await main(["install","codex","--mcp","--no-mcp"],ctx)).code).toBe(2);
});
test("Codex respects its custom skills directory and rolls back skills when later hooks fail",async()=>{
 const ctx=fakeCtx();ctx.env.CODEX_HOME=join(ctx.home,"custom-codex");const skill=join(ctx.env.CODEX_HOME,"skills/pacer/SKILL.md");
 await installPlanner({ctx,pacerArgv:PACER},"codex");expect(existsSync(skill)).toBe(true);await uninstallPlanner(ctx,"codex");expect(existsSync(skill)).toBe(false);
 const hooks=join(ctx.home,".codex/hooks.json");writeFileSync(hooks,"broken");await expect(installPlanner({ctx,pacerArgv:PACER},"codex")).rejects.toThrow();expect(existsSync(skill)).toBe(false);
});

test('skill teaches filtered operation discovery instead of embedding the full catalog', () => {
  for (const text of ['pacer api list', '--prefix', 'pacer api describe', 'pacer api call', '--params-file -', 'session io', 'attachment', 'client.control', 'expect_rev', 'consent', 'strategy.preview']) expect(PACER_SKILL).toContain(text);
  expect(PACER_SKILL).not.toContain('account.adopt');
});

test('skill teaches the messaging loop', () => {
  for (const text of ['pacer msg inbox --wait', 'pacer msg send <task> "<text>" --wait', '--answer <message-id>', '--send-back --note', '--retry-on <executor>', 'pacer msg log <task>', 'pacer msg close <task>', 'pacer msg read <message-id>', 'Stop and UserPromptSubmit hooks', 'pacer msg policy --project <repo-path>', 'pacer delegate --no-grant', 'use `pacer session io` only for a live interactive terminal']) expect(PACER_SKILL).toContain(text);
});
