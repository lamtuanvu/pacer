import {expect,test} from "bun:test";
import {writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpDir} from "./helpers";

test("cached policy fixtures release each file's real child with immutable ownership",async()=>{
 const root=resolve(import.meta.dir,".."),dir=tmpDir(),modulePath=(path:string)=>JSON.stringify(join(root,path));
 writeFileSync(join(dir,"owned.ts"),"export const owned:number[]=[];export const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};");
 for(const name of ["a","b"])writeFileSync(join(dir,`${name}.test.ts`),`
 import {test,expect} from "bun:test";
 import {join} from "node:path";
 import {policyGateFixture} from ${modulePath("test/fixtures/policy-host.ts")};
 import {applyPolicy} from ${modulePath("src/plugins/policy.ts")};
 import {pluginRegistry} from ${modulePath("src/plugins/index.ts")};
 import {owned} from "./owned";
 test("policy child ${name}",async()=>{
  const f=policyGateFixture({verdict:"allow"});
  await applyPolicy(f.ctx,"delegate",{goal:"work",repo:f.repo,kind:null,requestedExecutor:null,placement:"auto"},{contextFingerprint:()=>"fixture"});
  const pid=pluginRegistry(f.ctx).list(f.ctx).find(p=>p.id==="fx-policy")!.pid!;
  expect(pid).toBeGreaterThan(0);owned.push(pid);
  f.ctx.pacerHome=join(f.ctx.home,"changed-after-creation");
 });`);
 writeFileSync(join(dir,"c.test.ts"),`import {test,expect} from "bun:test";import {owned,alive} from "./owned";test("earlier policy children were released",()=>{expect(owned).toHaveLength(2);expect(owned.map(alive)).toEqual([false,false]);});`);
 const child=Bun.spawn([process.execPath,"test","--timeout","30000","--preload",join(root,"test/setup.ts"),...["a","b","c"].map(name=>join(dir,`${name}.test.ts`))],{cwd:root,env:{...process.env},stdout:"pipe",stderr:"pipe",timeout:20000});
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect(code,stderr||stdout).toBe(0);expect(stderr).toContain("3 pass");
},25000);
