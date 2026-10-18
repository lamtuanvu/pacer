import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as s from "../src/strategy/service";
import { build } from "../src/strategy/launcher";
import { parseStrategyArgs } from "../src/commands/plan7";
import { main } from "../src/cli";
import { parseSnapshot, emptySnapshot } from "../src/link/envelope";
import { pumpOnce } from "../src/link/pump";
import { loadStrategy, validateStrategy } from "../src/config/strategy";
const yaml=`planner: claude-code
providers:
  claude-code: {usage: reactive}
  codex: {usage: reactive}
  agy: {usage: reactive}
pacing:
  order: [codex, agy]
  planner_reserve: 15
routing:
  - default: [codex, agy]
`;
async function setup(){const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});await Bun.write(join(ctx.pacerHome,"strategy.yaml"),yaml);return ctx;}
test("draft replaces arrays and objects wholesale, unsets nested keys and guards prototype paths",()=>{
 expect(s.applyDraft({pacing:{order:["a"],policy:"even"},routing:[1]}, {from:"default",set:{"pacing.order":["b","c"],routing:[{default:["b"]}]},unset:["pacing.policy"]})).toEqual({pacing:{order:["b","c"]},routing:[{default:["b"]}]});
 expect(()=>s.applyDraft({}, {from:"default",set:{"__proto__.polluted":true}})).toThrow("invalid dotted path");
 expect(()=>s.applyDraft({routing:[]},{from:"default",set:{"routing.0":1}})).toThrow("replace wholesale");
});
test("save header, summary, overwrite, active/default protection and complete lifecycle",async()=>{
 const ctx=await setup();const draft={from:"default",description:"Protect Claude",set:{"pacing.planner_reserve":25}};
 for(const name of ["default","../escape","Upper","a".repeat(41),"-bad"])expect(()=>s.save(ctx,name,draft,"approved")).toThrow();
 const saved=s.save(ctx,"protect",draft,"User approved",{who:"Codex"});expect(saved.active).toBe(false);
 expect(s.show(ctx,"protect").yaml).toStartWith("# Protect Claude\n# created by Codex on ");expect(s.show(ctx,"protect").yaml).toContain(": User approved\n");
 expect(s.show(ctx,"protect").summary).toBe("Codex first, Claude keeps 25%");expect(loadStrategy(ctx).name).toBe("default");
 expect(()=>s.save(ctx,"protect",draft,"approved")).toThrow("already exists");
 s.save(ctx,"protect",draft,"replace approved",{overwrite:true});expect(s.list(ctx).find(x=>x.name==="protect")?.description).toBe("Protect Claude");
 await s.use({...ctx,which:()=>null},"protect");expect(loadStrategy(ctx).name).toBe("protect");expect(()=>s.remove(ctx,"protect")).toThrow("active");
 await s.use({...ctx,which:()=>null},"default");expect(s.remove(ctx,"protect").deleted).toBe(true);expect(()=>s.remove(ctx,"default")).toThrow("protected");
 expect(readFileSync(join(ctx.pacerHome,"link","latest.json"),"utf8")).toContain("Switched to strategy default");
});
test("preview validates with no writes and computes ranking changes and policy wording",async()=>{
 const ctx=await setup();const before=readdirSync(ctx.pacerHome);
 const result=await s.preview(ctx,{from:"default",set:{"pacing.order":["agy","codex"]}});
 expect(result.ok).toBe(true);expect(result.ranking).toEqual({current:["codex","agy"],draft:["agy","codex"]});expect(result.routing.current).toEqual(result.routing.draft);expect(readdirSync(ctx.pacerHome)).toEqual(before);
 const bad=await s.preview(ctx,{from:"default",set:{"pacing.planner_reserve":100}});expect(bad.ok).toBe(false);expect(bad.errors.join()).toContain("between 0 and 99");
 const even=await s.preview(ctx,{from:"default",set:{"pacing.policy":"even"}});expect(even.summary).toContain("even policy");
});
test("CLI repeated --set parses YAML flow values and --unset",async()=>{
 expect(parseStrategyArgs(["preview","--set","pacing.order=[codex, agy]","--set","pacing.planner_reserve=30","--unset","execution"]).set).toEqual({"pacing.order":["codex","agy"],"pacing.planner_reserve":30});
 const ctx=await setup();expect((await main(["strategy","preview","--from","default","--set","pacing.order=[agy, codex]"],ctx)).code).toBe(0);
 expect((await main(["strategy","save","cli","--reason","approved"],ctx)).code).toBe(0);expect((await main(["strategy","rm","cli"],ctx)).code).toBe(0);
 expect(()=>parseStrategyArgs(["--set","missing"])).toThrow("k=v");
});
test("launcher writes the complete brief and uses the terminal opener",async()=>{
 const ctx=await setup();let argv:string[]=[];
 const result=await build(ctx,{agent:"codex",from:"default",brief:'Protect Claude; $(touch /tmp/nope)',worktree:"id:wt"},{open:async(_c,o)=>{argv=o.argv;expect(o.worktree).toBe('id:wt');return {opened:true,target:'terminal',command:'codex prompt'};}});
 expect(argv[0]).toBe('codex');expect(argv[1]).toBe(readFileSync(result.path,'utf8'));
 const text=readFileSync(result.path,"utf8");expect(text).toContain(yaml);expect(text).toContain("Protect Claude; $(touch /tmp/nope)");expect(text).toContain("Codex first, Claude keeps 15%");expect(text).toContain("Current status:");expect(text).toContain("Save only after explicit approval");expect(text).toContain("Never switch");
 const fallback=await build({...ctx,which:()=>null});expect(fallback.opened).toBe(false);expect(fallback.message).toContain(fallback.command);
 for(const agent of ["agy","evil"])await expect(build(ctx,{agent})).rejects.toThrow("configured planner");
});
test("strategy build commands reject malformed input and snapshots accept both shapes",()=>{
 const data={cmd:"strategy-build" as const,agent:"codex",from:"default",brief:"Protect Claude",worktreeId:"wt",branch:"main"};const wrap=(data:unknown)=>({type:"cmd",data});

});
test("pump alerts once when a new strategy appears and includes header author",async()=>{
 const ctx=await setup();const deps={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}} as const),tasks:()=>[],publish:async()=>({seq:1,transports:["outbox"],errors:[]})};
 await pumpOnce(ctx,deps as any);s.save(ctx,"new-one",{from:"default"},"Approved",{who:"Codex"});
 const out=await pumpOnce(ctx,deps as any);expect(out.find(e=>e.type==="alert"&&e.data.key==="strategySaved-new-one")).toMatchObject({data:{title:'New strategy "new-one" saved',body:"Codex first, Claude keeps 15% · by Codex"}});
 expect((await pumpOnce(ctx,deps as any)).some(e=>e.type==="alert"&&e.data.key.startsWith("strategySaved"))).toBe(false);
});

test("preview and saved YAML use identical indented blocks and a final newline",async()=>{
 const ctx=await setup(), draft={from:"default",set:{"pacing.planner_reserve":25}};
 const result=await s.preview(ctx,draft);
 const expected="planner: claude-code\nproviders: \n  claude-code: \n    usage: reactive\n  codex: \n    usage: reactive\n  agy: \n    usage: reactive\npacing: \n  order: \n    - codex\n    - agy\n  planner_reserve: 25\nrouting: \n  - default: \n      - codex\n      - agy\n";
 expect(result.yaml).toBe(expected);
 s.save(ctx,"block",draft,"approved");
 expect(s.show(ctx,"block").yaml.split("\n").slice(2).join("\n")).toBe(expected);
 expect(validateStrategy(Bun.YAML.parse(expected),"test").pacing.plannerReserve).toBe(25);
});
test("unknown set and unset paths name the rejected key and suggest the nearest known key",()=>{
 for(const key of ["junk.x","pacing.planer_reserve","providers.codex.usag","execution.bakend","classifier.adapters.ollama.modle"]){
  for(const op of [{set:{[key]:1}},{unset:[key]}]){
   expect(()=>s.applyDraft({}, {from:"default",...op})).toThrow(key);
   expect(()=>s.applyDraft({}, {from:"default",...op})).toThrow("known key");
  }
 }
 expect(()=>s.applyDraft({}, {from:"default",set:{"pacing.planer_reserve":20}})).toThrow("pacing.planner_reserve");
});
test("active overwrite requires explicit approval with CLI-specific flags",async()=>{
 const ctx=await setup();s.save(ctx,"live",{from:"default"},"approved");await s.use({...ctx,which:()=>null},"live");
 expect(()=>s.save(ctx,"live",{from:"default"},"approved",{overwrite:true})).toThrow("activeOk");
 expect((await main(["strategy","save","live","--reason","approved"],ctx)).err).toContain("--overwrite");
 expect((await main(["strategy","save","live","--reason","approved","--overwrite"],ctx)).err).toContain("--allow-active");
 expect((await main(["strategy","save","live","--reason","approved","--overwrite","--allow-active"],ctx)).code).toBe(0);
});
test("existing strategy names remain selectable and starter comments are not descriptions",async()=>{
 const ctx=await setup();mkdirSync(join(ctx.pacerHome,"strategies"));writeFileSync(join(ctx.pacerHome,"strategies","Legacy_name.yaml"),yaml);
 expect((await main(["use","Legacy_name"],{...ctx,which:()=>null})).code).toBe(0);
 expect(s.show(ctx,"Legacy_name").active).toBe(true);
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"# pacer starter strategy: edit me\n"+yaml);
 expect(s.list(ctx).find(x=>x.name==="default")?.description).toBe("");
});
test("launcher creates private briefs and prunes only expired session files",async()=>{
 const ctx=await setup(), dir=join(ctx.pacerHome,"link","sessions");mkdirSync(dir,{recursive:true});
 for(const file of ["old.md","recent.md","keep.txt"]){writeFileSync(join(dir,file),"private");utimesSync(join(dir,file),ctx.now-8*86400,ctx.now-8*86400);}
 utimesSync(join(dir,"recent.md"),ctx.now,ctx.now);
 const result=await build({...ctx,which:()=>null});
 expect(statSync(result.path).mode&0o777).toBe(0o600);expect(existsSync(join(dir,"old.md"))).toBe(false);expect(existsSync(join(dir,"recent.md"))).toBe(true);expect(existsSync(join(dir,"keep.txt"))).toBe(true);
});
test("pump persists seen fingerprints only after publishing and only when changed",async()=>{
 const ctx=await setup();const deps={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),tasks:()=>[],publish:async()=>({seq:1,transports:["outbox"],errors:[]})};
 const path=join(ctx.pacerHome,"link","strategy-seen.json");await pumpOnce(ctx,deps as any);const before=statSync(path).mtimeMs;
 await Bun.sleep(10);await pumpOnce(ctx,deps as any);expect(statSync(path).mtimeMs).toBe(before);
 s.save(ctx,"new",{from:"default"},"approved");
 await pumpOnce(ctx,{...deps,publish:async()=>({seq:0,transports:[],errors:["outbox: failure"]})} as any);
 const retry=await pumpOnce(ctx,deps as any);expect(retry.some(e=>e.type==="alert"&&e.data.key==="strategySaved-new")).toBe(true);
 s.save(ctx,"new",{from:"default",set:{"pacing.planner_reserve":25}},"approved",{overwrite:true});
 expect((await pumpOnce(ctx,deps as any)).find(e=>e.type==="alert"&&e.data.key==="strategySaved-new")).toMatchObject({data:{title:'Strategy "new" updated'}});
});

test("pump detects identical overwrites and migrates the old name-only ledger",async()=>{
 const ctx=await setup();const deps={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),tasks:()=>[],publish:async()=>({seq:1,transports:["outbox"],errors:[]})};
 s.save(ctx,"same",{from:"default"},"approved");
 mkdirSync(join(ctx.pacerHome,"link"),{recursive:true});writeFileSync(join(ctx.pacerHome,"link","strategy-seen.json"),JSON.stringify(["default","same"]));
 const first=await pumpOnce(ctx,deps as any);expect(first.some(e=>e.type==="alert"&&e.data.key.startsWith("strategySaved"))).toBe(false);
 const before=s.show(ctx,"same").yaml;s.save(ctx,"same",{from:"default"},"approved",{overwrite:true});expect(s.show(ctx,"same").yaml).toBe(before);
 expect((await pumpOnce(ctx,deps as any)).find(e=>e.type==="alert"&&e.data.key==="strategySaved-same")).toMatchObject({data:{title:'Strategy "same" updated'}});
});

test("CLI strategy save attributes user while service/MCP retain agent identity",async()=>{
 const ctx=await setup();
 expect((await main(["strategy","save","user-draft","--reason","approved"],ctx)).code).toBe(0);
 expect(s.show(ctx,"user-draft").yaml).toContain("created by user");
 s.save(ctx,"agent-draft",{from:"default"},"approved",{who:"Codex"});expect(s.show(ctx,"agent-draft").yaml).toContain("created by Codex");
});
