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

test("real URL-rooted worker writes only its own live panel in development and marketplace installs", async () => {
 const root=mkdtempSync(join(tmpdir(),"pacer-worker-"));
 let worker:any; const logs:string[]=[];
 try {
  mkdirSync(join(root,"panel")); writeFileSync(join(root,".pacer-managed"),"pacer");
  await Bun.build({entrypoints:["orca-plugin/src/worker.ts"],outdir:root,naming:"worker.mjs",target:"node"});
  // Import-time dependencies capture this isolated environment. This fixture must
  // never execute an installed binary, use real HOME, or download from the network.
  const previous={HOME:process.env.HOME,PACER_BIN:process.env.PACER_BIN,PACER_RELEASE_BASE:process.env.PACER_RELEASE_BASE};
  const dummy=join(root,"not-executable");writeFileSync(dummy,"fixture",{mode:0o600});
  process.env.HOME=root;process.env.PACER_BIN=dummy;process.env.PACER_RELEASE_BASE=pathToFileURL(join(root,"release")).href;
  try {worker=await import(pathToFileURL(join(root,"worker.mjs")).href);}
  finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await until(()=>existsSync(join(root,"panel/live.html")));
  expect(readFileSync(join(root,"panel/live.html"),"utf8")).toContain("pacer");
  await worker.deactivate();
  rmSync(join(root,".pacer-managed"));
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await until(()=>existsSync(join(root,"panel/live.html")));
  expect(logs.some(s=>s.includes("refused panel write"))).toBe(false);
 } finally {await worker?.deactivate();rmSync(root,{recursive:true,force:true});}
},30000);
