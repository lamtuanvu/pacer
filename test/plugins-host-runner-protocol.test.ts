import {enableReviewed} from "./fixtures/plugin-consent";
import {expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {installFixture} from "../conformance/install";
import {fakeCtx} from "./helpers";
import {PluginRegistry} from "../src/plugins/registry";
import {EXTENSION_METHODS,hostRunnerContribution,manifestSchema} from "../src/plugins/protocol";
import {HOST_RUNNER_SCRIPTS} from "../src/plugins/host-runner-protocol";
import {SCRIPTS} from "../src/remote/scripts";

const methods=["hostRunner.check","hostRunner.open","hostRunner.run","hostRunner.stream","hostRunner.fetch","hostRunner.close"];
const request={session:"s".repeat(32),script:"PROBE",args:[],timeoutMs:1000};
test("fixed host-runner scripts and six bounded method contracts",()=>{
  expect(Object.keys(SCRIPTS).sort()).toEqual([...HOST_RUNNER_SCRIPTS].sort());
  expect(hostRunnerContribution.safeParse({kinds:["ssh"]}).success).toBe(true);
  expect(hostRunnerContribution.safeParse({kinds:["ssh","shell"]}).success).toBe(false);
  expect(manifestSchema.safeParse({id:"fx-host-runner",version:"1.0.0",publisher:"test",host:"^1.5",contributes:{hostRunner:{kinds:["shell"]}}}).success).toBe(false);
  expect(manifestSchema.safeParse({id:"fx-host-runner",version:"1.0.0",publisher:"test",host:"^1.5",contributes:{unknown:{}}}).success).toBe(false);
  const longAlias="a".repeat(256),longRepo="/"+"r".repeat(8192);
  expect(EXTENSION_METHODS["hostRunner.check"].params.safeParse({alias:longAlias,repo:longRepo}).success).toBe(true);
  expect(EXTENSION_METHODS["hostRunner.check"].params.safeParse({alias:"box",repo:"~/repo",sshTarget:"host.example",controlPath:"/tmp/private/cm-%C"}).success).toBe(true);
  expect(EXTENSION_METHODS["hostRunner.check"].params.safeParse({alias:"box",sshTarget:"$(id)",controlPath:"/tmp/private/cm-%C"}).success).toBe(false);
  expect(EXTENSION_METHODS["hostRunner.check"].params.safeParse({alias:"box",repo:"   "}).success).toBe(false);
  const published=JSON.parse(readFileSync(join(import.meta.dir,"..","docs","plugin-protocol.schema.json"),"utf8"));
  expect(published.$defs.manifest.properties.contributes.properties.hostRunner.properties.kinds.prefixItems[0].const).toBe("ssh");
  expect(published.$defs["hostRunner.check.params"].properties.repo.pattern).toBe("\\S");
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:longAlias,sshTarget:"host.example"}).success).toBe(true);
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:"box",sshTarget:"host.example",controlPath:"/tmp/private/cm-%C"}).success).toBe(true);
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:"box",sshTarget:"host.example",controlPath:"relative/cm-%C"}).success).toBe(false);
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:"box",sshTarget:"host.example",controlPath:"/tmp/other"}).success).toBe(false);
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:"box"}).success).toBe(false);
  expect(EXTENSION_METHODS["hostRunner.open"].params.safeParse({alias:"box",sshTarget:"$(id)"}).success).toBe(false);
  for(const method of methods)expect(EXTENSION_METHODS[method]?.deadlineMs).toBeGreaterThan(0);
  const run=EXTENSION_METHODS["hostRunner.run"].params;
  for(const bad of [{...request,script:"$(id)",maxBytes:1},{...request,args:["a\0b"],maxBytes:1},{...request,timeoutMs:0,maxBytes:1},{...request,maxBytes:0}])expect(run.safeParse(bad).success).toBe(false);
  expect(run.safeParse({...request,maxBytes:1024}).success).toBe(true);
  expect(EXTENSION_METHODS["hostRunner.fetch"].result.safeParse({name:"/tmp/out.bundle",bytes:1,sha256:"a".repeat(64)}).success).toBe(false);
});

test("installed fake runner validates input and every result without SSH",async()=>{
  const home=mkdtempSync(join(tmpdir(),"pacer-host-runner-"));
  symlinkSync(join(import.meta.dir,"..","node_modules"),join(home,"node_modules"),"dir");
  const ctx=fakeCtx({home,pacerHome:join(home,".pacer"),env:{PATH:`${dirname(process.execPath)}:/usr/bin:/bin`},now:Date.now()/1000});
  mkdirSync(ctx.pacerHome,{recursive:true});writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}}\n");
  const folder=installFixture("host-runner",join(ctx.pacerHome,"plugins"));
  const registry=new PluginRegistry({bundled:[],spawnBundled:()=>{throw Error("no bundle");},eventPumpMs:0});
  try{
    await enableReviewed(registry, ctx, "fx-host-runner");
    expect(registry.list(ctx)[0]?.pid).toBeNull();
    const doctor=(await registry.doctor(ctx,"fx-host-runner"))[0];expect(doctor?.ok).toBe(true);expect(doctor?.served).toContain("hostRunner");
    const args:Record<string,unknown>={
      "hostRunner.check":{alias:"box"},"hostRunner.open":{alias:"box",sshTarget:"host.example"},
      "hostRunner.run":{...request,maxBytes:1024},"hostRunner.stream":{...request,maxBytes:1024},
      "hostRunner.fetch":{...request,maxBytes:1024},"hostRunner.close":{session:request.session},
    };
    await expect(registry.call(ctx,"fx-host-runner","hostRunner.check",args["hostRunner.check"]))
      .rejects.toMatchObject({code:"capability_denied"});
    for(const method of methods.filter(method=>method!=="hostRunner.check"&&method!=="hostRunner.fetch"))
      await expect(registry.call(ctx,"fx-host-runner",method,args[method])).resolves.toBeDefined();
    await expect(registry.call(ctx,"fx-host-runner","hostRunner.fetch",args["hostRunner.fetch"]))
      .rejects.toMatchObject({code:"capability_denied"});
    await expect(registry.call(ctx,"fx-host-runner","hostRunner.run",{...request,maxBytes:0})).rejects.toMatchObject({code:"invalid_input"});
    await expect(registry.call(ctx,"fx-host-runner","hostRunner.run",{...request,args:["too-long"],maxBytes:1})).rejects.toMatchObject({code:"plugin_refused"});
    await expect(registry.call(ctx,"fx-host-runner","hostRunner.run",args["hostRunner.run"],{deadlineMs:0})).rejects.toMatchObject({code:"invalid_input"});
    writeFileSync(join(folder,"fixture.json"),JSON.stringify({malformedMethod:"hostRunner.fetch"}));
    // A new process observes the fixture setting, without an SSH side effect.
    await registry.shutdown();
    const fresh=new PluginRegistry({bundled:[],spawnBundled:()=>{throw Error("no bundle");},eventPumpMs:0});
    try{await expect(fresh.call(ctx,"fx-host-runner","hostRunner.fetch",args["hostRunner.fetch"])).rejects.toMatchObject({code:"capability_denied"});}
    finally{await fresh.shutdown();}
    writeFileSync(join(folder,"fixture.json"),JSON.stringify({delayMs:3000}));
    const timed=new PluginRegistry({bundled:[],spawnBundled:()=>{throw Error("no bundle");},eventPumpMs:0});
    try{
      expect((await timed.doctor(ctx,"fx-host-runner"))[0]?.ok).toBe(true);
      await expect(timed.call(ctx,"fx-host-runner","hostRunner.run",args["hostRunner.run"],{deadlineMs:1000})).rejects.toMatchObject({code:"plugin_timeout"});
      const log=join(folder,"calls.jsonl"),until=Date.now()+1000;
      while((!existsSync(log)||readFileSync(log,"utf8").trim().split("\n").length<2)&&Date.now()<until)await Bun.sleep(10);
      const receipts=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
      expect(receipts).toEqual([{method:"hostRunner.run",phase:"enter"},{method:"hostRunner.run",phase:"cancelled"}]);
      await expect(timed.call(ctx,"fx-host-runner","hostRunner.run",args["hostRunner.run"],{deadlineMs:1000})).resolves.toMatchObject({code:0,stdout:""});
    }finally{await timed.shutdown();}
  }finally{await registry.shutdown();rmSync(home,{recursive:true,force:true});}
});
