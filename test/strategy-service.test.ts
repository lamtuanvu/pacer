import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as s from "../src/strategy/service";
import { build } from "../src/strategy/launcher";
import { parseStrategyArgs } from "../src/commands/plan7";
import { main } from "../src/cli";
import { parseCmd, parseSnapshot, emptySnapshot } from "../src/link/envelope";
import { pumpOnce } from "../src/link/pump";
import { loadStrategy } from "../src/config/strategy";
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
 expect(s.applyDraft({pacing:{order:["a"],x:2},routing:[1]}, {from:"default",set:{"pacing.order":["b","c"],routing:[{default:["b"]}]},unset:["pacing.x"]})).toEqual({pacing:{order:["b","c"]},routing:[{default:["b"]}]});
 expect(()=>s.applyDraft({}, {from:"default",set:{"__proto__.polluted":true}})).toThrow("invalid dotted path");
 expect(()=>s.applyDraft({a:[]},{from:"default",set:{"a.0":1}})).toThrow("replace wholesale");
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
 expect(readFileSync(join(ctx.pacerHome,"link","latest.json"),"utf8")).toContain("Strategy switched to default");
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
test("launcher writes complete brief and exact shell-safe argv, restricts agent and falls back",async()=>{
 const ctx=await setup();let argv:string[]=[];ctx.run=async a=>{argv=a;return {code:0,stdout:'{"ok":true,"result":{}}',stderr:""};};
 const result=await build(ctx,{agent:"codex",from:"default",brief:'Protect Claude; $(touch /tmp/nope)',worktree:"id:wt"});
 expect(argv).toEqual(["orca","terminal","create","--worktree","id:wt","--title","pacer strategy","--command",`codex "$(cat '${result.path}')"`,"--json"]);
 const text=readFileSync(result.path,"utf8");expect(text).toContain(yaml);expect(text).toContain("Protect Claude; $(touch /tmp/nope)");expect(text).toContain("Codex first, Claude keeps 15%");expect(text).toContain("Current status:");expect(text).toContain("Save only after explicit approval");expect(text).toContain("Never switch");
 const fallback=await build({...ctx,which:()=>null});expect(fallback.message).toContain(`claude "$(cat '${fallback.path}')"`);
 for(const agent of ["agy","cursor","opencode","evil"])expect(build(ctx,{agent})).rejects.toThrow("configured planner");
 expect(build({...ctx,pacerHome:ctx.pacerHome+" unsafe"})).rejects.toThrow("unsafe characters");
 expect(build({...ctx,run:async()=>({code:0,stdout:'{"ok":false}',stderr:"failed"})})).rejects.toThrow("could not open");
});
test("strategy build commands reject malformed input and snapshots accept both shapes",()=>{
 const data={cmd:"strategy-build" as const,agent:"codex",from:"default",brief:"Protect Claude",worktreeId:"wt",branch:"main"};const wrap=(data:unknown)=>({v:1,type:"cmd",data});
 expect(parseCmd(wrap(data))?.data).toEqual(data);
 for(const change of [{agent:"agy"},{from:"../bad"},{brief:""},{brief:"x".repeat(2001)}])expect(parseCmd(wrap({...data,...change}))).toBeNull();
 expect(parseSnapshot({...emptySnapshot(),strategies:["default",{name:"custom",active:true,summary:"Codex first",description:"Custom"}]} )?.strategies).toHaveLength(2);
});
test("pump alerts once when a new strategy appears and includes header author",async()=>{
 const ctx=await setup();const deps={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled:false,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}} as const),tasks:()=>[],publish:async()=>({seq:1,transports:[],errors:[]})};
 await pumpOnce(ctx,deps as any);s.save(ctx,"new-one",{from:"default"},"Approved",{who:"Codex"});
 const out=await pumpOnce(ctx,deps as any);expect(out.find(e=>e.type==="alert"&&e.data.key==="strategySaved-new-one")).toMatchObject({data:{title:'New strategy "new-one" saved',body:"Codex first, Claude keeps 15% · by Codex"}});
 expect((await pumpOnce(ctx,deps as any)).some(e=>e.type==="alert"&&e.data.key.startsWith("strategySaved"))).toBe(false);
});
