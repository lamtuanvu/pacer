import {afterEach,expect,test} from "bun:test";
import {chmodSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {fakeCtx} from "./helpers";
import {pluginRegistry,shutdownPlugins} from "../src/plugins";
import {applyPolicy,policySummary} from "../src/plugins/policy";
import {readActivity} from "../src/activity/log";

const homes:ReturnType<typeof fakeCtx>[]=[];
afterEach(async()=>{await Promise.all(homes.splice(0).map(ctx=>shutdownPlugins(ctx)));});
const input={goal:"private task goal",repo:"repo",kind:null,requestedExecutor:null,placement:"auto"} as const;
function fixture(mode="open") {
  const ctx=fakeCtx({now:Date.now()/1000,env:{PATH:process.env.PATH}});homes.push(ctx);
  mkdirSync(ctx.pacerHome,{recursive:true});
  let starts=0;
  const registry=pluginRegistry(ctx,{bundled:[],spawnBundled:()=>{throw Error("no bundles");},sleep:async()=>{},spawn:((...args:Parameters<typeof spawn>)=>{starts++;return spawn(...args);}) as typeof spawn});
  const configure=(nextMode=mode,extra:Record<string,unknown>={})=>writeFileSync(join(ctx.pacerHome,"strategy.yaml"),JSON.stringify({planner:"claude-code",providers:{"claude-code":{}},plugins:{policy:{mode:nextMode},installed:{"fx-policy":{version:"1.0.0",capabilities:[]}},...extra}}));
  configure();
  const install=(verdict:unknown={verdict:"allow"},delay=0,capabilities:string[]=[])=>{
    const dir=join(ctx.pacerHome,"plugins","fx-policy");mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,"pacer-plugin.json"),JSON.stringify({id:"fx-policy",version:"1.0.0",publisher:"test",host:"^1.6",entry:"main.ts",capabilities:capabilities.map(name=>({name})),contributes:{policy:{}}}));
    writeFileSync(join(dir,"settings.json"),JSON.stringify({verdict,delay}));
    writeFileSync(join(dir,"main.ts"),`#!${process.execPath}\nimport {readFileSync,appendFileSync} from "node:fs";\nfor await(const line of console) {const r=JSON.parse(line); if(!r.id)continue;let result;if(r.method==="plugin.hello")result={protocol:r.params.protocol,id:"fx-policy",version:"1.0.0",contributes:["policy"]};else if(r.method==="policy.before"){appendFileSync("calls.jsonl",JSON.stringify(r.params)+"\\n");const s=JSON.parse(readFileSync("settings.json","utf8"));await Bun.sleep(s.delay);result=s.verdict;}else result={ok:true};console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));}\n`);
    chmodSync(join(dir,"main.ts"),0o755);return dir;
  };
  return {ctx,registry,configure,install,starts:()=>starts};
}

test("closed mode treats a missing unmarked grant as an unavailable policy",async()=>{
  const f=fixture("closed");
  expect(policySummary(f.ctx)).toEqual({mode:"closed",plugins:0});
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed"});
  expect(f.starts()).toBe(0);
  f.install();expect(policySummary(f.ctx)).toEqual({mode:"closed",plugins:1});expect(f.starts()).toBe(0);
});

test("actual installed policy call starts once without invalidating stable metadata receipt",async()=>{
  const f=fixture();const dir=f.install();let context="before";
  const receipt=await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>context});
  expect(f.starts()).toBe(1);
  const wire=JSON.parse(readFileSync(join(dir,"calls.jsonl"),"utf8"));
  expect(wire.input.goal).toBe("");expect(wire.input.repo).not.toBe(input.repo);
  expect(wire.input.goalLength).toBe(input.goal.length);expect(wire.input.goalHash).toHaveLength(64);
  receipt.revalidate();context="after";expect(()=>receipt.revalidate()).toThrow("changed");
});
test("only a declared and granted tasks.read policy receives goal and repo detail",async()=>{
  const f=fixture();
  f.configure("open",{installed:{"fx-policy":{version:"1.0.0",capabilities:["tasks.read"],policy:true}}});
  const dir=f.install({verdict:"allow"},0,["tasks.read"]);
  await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"detail"});
  expect(JSON.parse(readFileSync(join(dir,"calls.jsonl"),"utf8"))).toEqual({decision:"delegate",input});
});
test("review notes require declared and granted tasks.read",async()=>{
  const review={taskId:"task",revision:1,state:"done" as const,verdict:"accept" as const,note:"private review feedback"};
  const f=fixture(),dir=f.install();
  await applyPolicy(f.ctx,"review",review,{contextFingerprint:()=>"review"});
  const redacted=JSON.parse(readFileSync(join(dir,"calls.jsonl"),"utf8"));
  expect(redacted.input.note).toBeUndefined();
  expect(redacted.input.noteLength).toBe(review.note.length);
  expect(redacted.input.noteHash).toHaveLength(64);
  f.configure("open",{installed:{"fx-policy":{version:"1.0.0",capabilities:["tasks.read"],policy:true}}});
  const manifest=JSON.parse(readFileSync(join(dir,"pacer-plugin.json"),"utf8"));
  manifest.capabilities=[{name:"tasks.read"}];writeFileSync(join(dir,"pacer-plugin.json"),JSON.stringify(manifest));
  await applyPolicy(f.ctx,"review",review,{contextFingerprint:()=>"review"});
  expect(JSON.parse(readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").at(-1)!)).toEqual({decision:"review",input:review});
});
test("opaque goal and repository digests differ between policy plugins",async()=>{
  const f=fixture(),dir=f.install();
  const other=join(f.ctx.pacerHome,"plugins","other-policy");mkdirSync(other,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(dir,"pacer-plugin.json"),"utf8"));manifest.id="other-policy";
  writeFileSync(join(other,"pacer-plugin.json"),JSON.stringify(manifest));
  writeFileSync(join(other,"settings.json"),readFileSync(join(dir,"settings.json")));
  writeFileSync(join(other,"main.ts"),readFileSync(join(dir,"main.ts"),"utf8").replaceAll("fx-policy","other-policy"));
  chmodSync(join(other,"main.ts"),0o755);
  f.configure("open",{installed:{"fx-policy":{version:"1.0.0",capabilities:[],policy:true},"other-policy":{version:"1.0.0",capabilities:[],policy:true}}});
  await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"two"});
  const first=JSON.parse(readFileSync(join(dir,"calls.jsonl"),"utf8")),second=JSON.parse(readFileSync(join(other,"calls.jsonl"),"utf8"));
  expect(first.input.goalHash).not.toBe(second.input.goalHash);
  expect(first.input.repoKey).not.toBe(second.input.repoKey);
});

test("mode config grant and full manifest edits invalidate receipts",async()=>{
  for(const change of ["mode","config","grant","manifest"]){
    const f=fixture();const dir=f.install();
    const receipt=await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
    if(change==="mode")f.configure("closed");
    if(change==="config")f.configure("open",{config:{"fx-policy":{limit:7}}});
    if(change==="grant")f.configure("open",{installed:{}});
    if(change==="manifest"){const path=join(dir,"pacer-plugin.json");const m=JSON.parse(readFileSync(path,"utf8"));m.contributes.policy={revision:2};writeFileSync(path,JSON.stringify(m));}
    expect(()=>receipt.revalidate()).toThrow("changed");
  }
});

test("veto logs bounded policy warning without raw decision input",async()=>{
  const f=fixture();f.install({verdict:"veto",reason:"budget denied"});
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
  const entry=readActivity(f.ctx).entries.find(e=>e.kind==="policy");
  expect(entry).toMatchObject({level:"warn"});expect(entry?.text).toContain("fx-policy");expect(entry?.text).toContain("delegate");expect(entry?.text).toContain("budget denied");expect(entry?.text).not.toContain(input.goal);
});

test("known enabled failing policy remains counted and fail-closed cannot bypass it",async()=>{
  const f=fixture("closed");const dir=f.install();writeFileSync(join(dir,"main.ts"),`#!${process.execPath}\nprocess.exit(2);\n`);
  for(let i=0;i<3;i++) await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed"});
  expect(f.registry.list(f.ctx).find(p=>p.id==="fx-policy")?.state).toBe("failing");
  expect(policySummary(f.ctx)).toEqual({mode:"closed",plugins:1});
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed"});
  expect(f.starts()).toBe(3);
});

test("ungranted and disabled policies neither count nor receive decision calls",async()=>{
  for(const extra of [{installed:{}},{disabled:["fx-policy"]}]) {
    const f=fixture("closed");f.install();f.configure("closed",extra);
    expect(policySummary(f.ctx)).toEqual({mode:"closed",plugins:0});
    await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});expect(f.starts()).toBe(0);
  }
});

test("a context race during an actual call conflicts before returning authorization",async()=>{
  const f=fixture();const dir=f.install({verdict:"allow"},30);let context="before";
  const pending=applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>context});
  const until=Date.now()+2000;while(!existsSync(join(dir,"calls.jsonl"))&&Date.now()<until)await Bun.sleep(5);
  context="after";await expect(pending).rejects.toMatchObject({code:"conflict"});
});

test("actual delegate amendment requires complete host eligibility validation",async()=>{
  const f=fixture("closed");f.install({verdict:"amend",amend:{placement:"new",kind:"tests"}});
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context",eligibleRunnerIds:["runner"],allowedPlacements:["new"]})).rejects.toMatchObject({code:"not_allowed"});
  const receipt=await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context",eligibleRunnerIds:["runner"],allowedPlacements:["new"],validateDelegate:next=>next.requestedExecutor===null&&next.placement==="new"&&next.kind==="tests"});
  expect(receipt.params).toEqual({decision:"delegate",input:{...input,placement:"new",kind:"tests"}});
});

test("cancellation and caller deadline propagate through actual registry call",async()=>{
  const f=fixture();f.install({verdict:"allow"},100);
  const abort=new AbortController();
  const pending=applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context",signal:abort.signal});
  abort.abort();await expect(pending).rejects.toMatchObject({code:"not_allowed"});expect(f.starts()).toBe(0);
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context",deadline:Date.now()+20})).rejects.toMatchObject({code:"not_allowed"});
});

test("metadata changes during an actual policy call never return stale authorization",async()=>{
  const f=fixture();const dir=f.install({verdict:"allow"},30);
  const pending=applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
  const until=Date.now()+2000;while(!existsSync(join(dir,"calls.jsonl"))&&Date.now()<until)await Bun.sleep(5);
  f.configure("closed");await expect(pending).rejects.toMatchObject({code:"conflict"});
});

test("open mode ignores known failing policy without hiding count or starting it again",async()=>{
  const f=fixture("closed");const dir=f.install();writeFileSync(join(dir,"main.ts"),`#!${process.execPath}\nprocess.exit(2);\n`);
  for(let i=0;i<3;i++)await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed"});
  f.configure("open");const receipt=await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
  expect(receipt.params).toEqual({decision:"delegate",input});expect(policySummary(f.ctx)).toEqual({mode:"open",plugins:1});expect(f.starts()).toBe(3);
});

test("closed mode preserves a local pre-call conflict without starting or logging veto",async()=>{
  const f=fixture("closed");f.install();let captures=0;
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>++captures===1?"before":"after"})).rejects.toMatchObject({code:"conflict"});
  expect(f.starts()).toBe(0);
  expect(readActivity(f.ctx).entries.filter(entry=>entry.kind==="policy")).toEqual([]);
});

test("policy process retirement during a closed decision remains a host conflict",async()=>{
  const f=fixture("closed"),dir=f.install({verdict:"allow"},100);
  const pending=applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
  const until=Date.now()+2000;while(!existsSync(join(dir,"calls.jsonl"))&&Date.now()<until)await Bun.sleep(5);
  const path=join(dir,"pacer-plugin.json"),manifest=JSON.parse(readFileSync(path,"utf8"));manifest.contributes.policy={revision:2};writeFileSync(path,JSON.stringify(manifest));f.registry.list(f.ctx);
  await expect(pending).rejects.toMatchObject({code:"conflict",message:"Policy context changed"});
  expect(readActivity(f.ctx).entries.filter(entry=>entry.kind==="policy")).toEqual([]);
});

test("closed mode refuses while a granted policy plugin cannot load, with a visible reason (B2)",async()=>{
  const granted={installed:{"fx-policy":{version:"1.0.0",capabilities:[],policy:true}}};
  const cases:Record<string,(dir:string)=>void>={
    needsGrant:dir=>{const path=join(dir,"pacer-plugin.json");const m=JSON.parse(readFileSync(path,"utf8"));m.capabilities=[{name:"tasks.read"}];writeFileSync(path,JSON.stringify(m));},
    unreadable:dir=>writeFileSync(join(dir,"pacer-plugin.json"),"{not json"),
    incompatible:dir=>{const path=join(dir,"pacer-plugin.json");const m=JSON.parse(readFileSync(path,"utf8"));m.host="^99.0";writeFileSync(path,JSON.stringify(m));},
    deleted:dir=>rmSync(dir,{recursive:true,force:true}),
  };
  for(const [name,breakIt] of Object.entries(cases)) {
    const f=fixture("closed");const dir=f.install();f.configure("closed",granted);breakIt(dir);
    await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"}),name).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
    const entry=readActivity(f.ctx).entries.find(e=>e.kind==="policy");
    expect(entry?.text,name).toContain("cannot be verified");expect(f.starts()).toBe(0);
    // Open mode keeps going but leaves the same trace (F5).
    f.configure("open",granted);
    await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
    expect(readActivity(f.ctx).entries.filter(e=>e.kind==="policy").length,name).toBe(2);
    // A user who disables or removes the grant opts out of the refusal.
    f.configure("closed",{...granted,disabled:["fx-policy"]});
    await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
  }
});
test("closed mode refuses an old unmarked grant with an unreadable manifest",async()=>{
  const f=fixture("closed"),dir=f.install();
  writeFileSync(join(dir,"pacer-plugin.json"),"{not json");
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"old-grant"})).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
  expect(f.starts()).toBe(0);
});
test("closed mode ignores a missing grant marked non-policy",async()=>{
  const f=fixture("closed");
  f.configure("closed",{installed:{"missing-tool":{version:"1.0.0",capabilities:[],policy:false}}});
  const receipt=await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"non-policy"});
  expect(receipt.params.input).toEqual(input);
  expect(readActivity(f.ctx).entries.filter(e=>e.kind==="policy")).toEqual([]);
});

test("closed mode refuses an updated policy manifest that needs a new grant even without a recorded marker (B2)",async()=>{
  const f=fixture("closed");const dir=f.install();const path=join(dir,"pacer-plugin.json");const m=JSON.parse(readFileSync(path,"utf8"));m.capabilities=[{name:"tasks.read"}];writeFileSync(path,JSON.stringify(m));
  await expect(applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"})).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
});

test("enabling a policy plugin records the policy marker in its grant (B2)",async()=>{
  const f=fixture("closed");f.install();f.configure("closed",{installed:{}});
  await f.registry.enable(f.ctx,"fx-policy",true);
  expect(readFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"utf8")).toMatch(/policy: true/);
});

test("open mode records a trace when it ignores a failing policy plugin (F5)",async()=>{
  const f=fixture("open");f.install({verdict:"not-a-verdict"});
  await applyPolicy(f.ctx,"delegate",input,{contextFingerprint:()=>"context"});
  const entry=readActivity(f.ctx).entries.find(e=>e.kind==="policy");
  expect(entry).toMatchObject({level:"warn"});expect(entry?.text).toContain("fx-policy");expect(entry?.text).toContain("ignored in open mode");expect(entry?.text).not.toContain(input.goal);
});
