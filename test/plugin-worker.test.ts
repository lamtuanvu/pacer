import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emptySnapshot } from "../src/link/envelope";

async function until(ready:()=>boolean):Promise<void> {
 const deadline=Date.now()+10000;
 while(!ready() && Date.now()<deadline)await Bun.sleep(20);
 expect(ready()).toBe(true);
}

test("real URL-rooted worker writes its managed live panel and logs refused writes", async () => {
 const root=mkdtempSync(join(tmpdir(),"pacer-worker-"));
 let worker:any; const logs:string[]=[];
 try {
  mkdirSync(join(root,"panel")); writeFileSync(join(root,".pacer-managed"),"pacer");
  await Bun.build({entrypoints:["orca-plugin/src/worker.ts"],outdir:root,naming:"worker.mjs",target:"node"});
  worker=await import(pathToFileURL(join(root,"worker.mjs")).href);
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await until(()=>existsSync(join(root,"panel/live.html")));
  expect(readFileSync(join(root,"panel/live.html"),"utf8")).toContain("pacer");
  await worker.deactivate();
  rmSync(join(root,".pacer-managed"));
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await until(()=>logs.some(s=>s.includes("refused")));
  expect(logs.some(s=>s.includes("refused"))).toBe(true);
 } finally {await worker?.deactivate();rmSync(root,{recursive:true,force:true});}
},30000);
