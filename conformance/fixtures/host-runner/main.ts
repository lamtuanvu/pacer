#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { PluginError, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

const manifest=JSON.parse(readFileSync("pacer-plugin.json","utf8")) as PluginManifest;
const fixture=JSON.parse(readFileSync("fixture.json","utf8")) as {delayMs?:number;delayMethod?:string;malformedMethod?:string|null;fetchStageHandle?:string};
const session="s".repeat(32),hash="a".repeat(64);
let delayed=false;
const reply=async(method:string,result:unknown,signal:AbortSignal)=>{
  if(fixture.delayMs&&!delayed&&(!fixture.delayMethod||fixture.delayMethod===method)){
    delayed=true;appendFileSync("calls.jsonl",JSON.stringify({method,phase:"enter"})+"\n",{mode:0o600});
    await new Promise<void>(resolve=>{
      const timer=setTimeout(resolve,fixture.delayMs);
      signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});
    });
  }
  if(signal.aborted){appendFileSync("calls.jsonl",JSON.stringify({method,phase:"cancelled"})+"\n",{mode:0o600});throw new PluginError("plugin_timeout","fixed fixture call cancelled");}
  return fixture.malformedMethod===method?{unsafe:"fixture"}:result;
};
await serve({manifest,input:stdinLines(),handlers:{
  "hostRunner.check":(_p,_h,s)=>reply("hostRunner.check",{ok:true,checks:[{name:"fixture",ok:true,detail:"no SSH used"}]},s),
  "hostRunner.open":(_p,_h,s)=>reply("hostRunner.open",{session},s),
  "hostRunner.run":(p,_h,s)=>reply("hostRunner.run",{code:0,stdout:(p as {args:string[]}).args.join(" "),stderr:"",timedOut:false},s),
  "hostRunner.stream":(_p,_h,s)=>reply("hostRunner.stream",{code:0,bytes:0},s),
  "hostRunner.fetch":(_p,_h,s)=>reply("hostRunner.fetch",fixture.fetchStageHandle
    ? {handle:fixture.fetchStageHandle,bytes:0,sha256:hash}
    : {name:`${hash}.bundle`,bytes:0,sha256:hash},s),
  "hostRunner.close":(_p,_h,s)=>reply("hostRunner.close",{ok:true},s),
}});
