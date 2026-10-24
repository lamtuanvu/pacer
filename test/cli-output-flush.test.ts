import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const source=resolve(import.meta.dir, "../src/cli.ts");
test("actual CLI preserves complete large JSON when stdout is piped", async()=>{
 const home=mkdtempSync(join(tmpdir(),"pacer-cli-flush-"));
 try {
  const directory=join(home,"plugins/flush-fixture");mkdirSync(directory,{recursive:true});
  const scope="marker-"+"界".repeat(256*1024);
  writeFileSync(join(directory,"pacer-plugin.json"),JSON.stringify({id:"flush-fixture",version:"1.0.0",publisher:"fixture",host:"^1.1",entry:"unused.ts",contributes:{diagnostic:{}},capabilities:[{name:"fs.read",scopes:[scope]}]}));
  const child=Bun.spawn([process.execPath,source,"plugin","list","--json"],{env:{HOME:home,PACER_HOME:home,PATH:"/usr/bin:/bin",PACER_NO_UPDATE_CHECK:"1"},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code).toBe(0);expect(stderr).toBe("");expect(Buffer.byteLength(stdout)).toBeGreaterThan(700_000);
  const data=JSON.parse(stdout);expect(data.plugins.find((p:any)=>p.id==="flush-fixture").capabilities[0].scopes[0]).toBe(scope);
 } finally {rmSync(home,{recursive:true,force:true});}
},10000);

test("actual CLI reports closed stdout as exit1 without a raw stack", async()=>{
 const script = `import os,subprocess,json,sys
rd,wr=os.pipe();os.close(rd)
p=subprocess.run([sys.argv[1],sys.argv[2],"--version"],stdout=wr,stderr=subprocess.PIPE)
os.close(wr)
print(json.dumps({"code":p.returncode,"stderr":p.stderr.decode()}))`;
 const child=Bun.spawn(["python3","-c",script,process.execPath,resolve(source)],{stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(code).toBe(0);expect(stderr).toBe("");expect(JSON.parse(stdout)).toEqual({code:1,stderr:""});
});
