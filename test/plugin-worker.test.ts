import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emptySnapshot } from "../src/link/envelope";

test("real URL-rooted worker writes its managed live panel and logs refused writes", async () => {
 const root=mkdtempSync(join(tmpdir(),"pacer-worker-"));
 let worker:any; const logs:string[]=[];
 try {
  mkdirSync(join(root,"panel")); writeFileSync(join(root,".pacer-managed"),"pacer");
  await Bun.build({entrypoints:["orca-plugin/src/worker.ts"],outdir:root,naming:"worker.mjs",target:"node"});
  worker=await import(pathToFileURL(join(root,"worker.mjs")).href);
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await Bun.sleep(2100);
  expect(readFileSync(join(root,"panel/live.html"),"utf8")).toContain("pacer");
  await worker.deactivate();
  rmSync(join(root,".pacer-managed"));
  await worker.default({host:{call:async(m:string)=>m==="settings.get"?{settings:{transport:"bridge"}}:m==="storage.get"?{value:emptySnapshot()}:{subscribed:[]}},commands:{register(){}},events:{on(){}},log:(s:string)=>logs.push(s)});
  await Bun.sleep(2100);
  expect(logs.some(s=>s.includes("refused"))).toBe(true);
 } finally {await worker?.deactivate();rmSync(root,{recursive:true,force:true});}
},10000);
