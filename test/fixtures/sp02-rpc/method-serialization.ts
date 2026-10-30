// Isolated process fault injection: canonical FS method25ms, serialization80ms, parent1000ms.
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PluginRegistry} from "../../../src/plugins/registry";
import {CAPABILITY_METHODS} from "../../../src/plugins/protocol";
CAPABILITY_METHODS["capability.fs.read"]!.deadlineMs=25;
const stringify=JSON.stringify;let delayed=false;
JSON.stringify=function(value:any,...rest:any[]){
 if(typeof value?.id==="string"&&value.id.startsWith("read-")&&value.result?.text){delayed=true;const until=Date.now()+80;while(Date.now()<until){}}
 return (stringify as any)(value,...rest);
} as typeof JSON.stringify;
const root=mkdtempSync(join(tmpdir(),"pacer-method-serialization-")),path=join(root,"telemetry.json");writeFileSync(path,"public fixture");
const ctx={home:root,pacerHome:join(root,".pacer"),now:100,env:{},which:()=>null,run:async()=>({code:127,stdout:"",stderr:""})};
const manifest={id:"review",publisher:"fixture",version:"0.2.0",host:"^1.6",contributes:{usage:{}},capabilities:[{name:"fs.read" as const,scopes:["$HOME/telemetry.json"]}],reentrant:false,tier:"free" as const};
const registry=new PluginRegistry({bundled:[{manifest,main:async()=>({handlers:{}})}],spawnBundled:()=>({argv:[process.execPath,join(import.meta.dir,"budget-peer.ts")],cwd:root,env:{}})});
const started=Date.now();let output:unknown;
try{
 try{const value=await registry.call(ctx,"review","usage.read",{provider:"fixture",usage:"quota",account:null,accountHome:root,model:null,weeklyTokens:null,weeklyUsd:null,quotaSource:null,now:100,readOnly:true,refresh:false},{deadlineMs:1000,accountHome:root,resources:{reads:[{path,kind:"file"}],commands:[],stores:[]}});output={accepted:true,value};}
 catch(error){output={accepted:false,code:(error as any).code,message:(error as Error).message};}
}finally{await registry.shutdown();JSON.stringify=stringify;rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({fresh:true,delayed,elapsed:Date.now()-started,output},null,2));
