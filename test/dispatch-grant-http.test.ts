import {expect,test} from "bun:test";
import {fakeCtx,tmpDir} from "./helpers";
import {createTask,updateTask} from "../src/tasks/store";
import {registerWork,issueWorkGrant} from "../src/dispatch/work";
import {startServer} from "../src/serve/http";

test("task grant reaches only scoped v3 operations through internal auth",async()=>{
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const own=createTask(ctx,{brief:{goal:"own",repo},kind:"feature",requestedExecutor:null,timeoutS:600});
 registerWork(ctx,own.id,{allowDelegation:true});updateTask(ctx,own.id,t=>{t.state="running";});
 const token=issueWorkGrant(ctx,own.id,1);
 const other=createTask(ctx,{brief:{goal:"other",repo},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,other.id);
 const server=startServer(()=>({...ctx,now:Date.now()/1000}),{port:0,listener:false,pumpMs:0,internal:{token:"i".repeat(64)}});
 const base=`http://127.0.0.1:${server.port}`;
 const headers={authorization:`Bearer ${"i".repeat(64)}`,"x-pacer-auth":"task","x-pacer-work-grant":`Bearer ${token}`,host:`127.0.0.1:${server.port}`};
 try{
  const call=(op:string,body:unknown)=>fetch(`${base}/v3/ops/${op}`,{method:"POST",headers,body:JSON.stringify(body)});
  const ownResponse=await call("dispatch.tree",{id:own.id});expect(ownResponse.status).toBe(200);expect((await ownResponse.json()).result.nodes).toHaveLength(1);
  expect((await call("dispatch.tree",{id:other.id})).status).toBe(403);
  expect((await call("strategy.list",{})).status).toBe(403);
  expect((await fetch(`${base}/v3/snapshot`,{headers})).status).toBe(403);
  expect((await fetch(`${base}/v3/ops/dispatch.tree`,{method:"POST",headers:{...headers,"x-pacer-work-grant":"Bearer forged"},body:JSON.stringify({id:own.id})})).status).toBe(403);
 }finally{server.stop();}
});
