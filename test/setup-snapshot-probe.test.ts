import {expect,mock,test,spyOn} from "bun:test";
import {join} from "node:path";
import {checkSetup} from "../src/setup/check";
import {fakeCtx} from "./helpers";
import {readModelContext} from "../src/api/read-model";
import {ensureToken} from "../src/serve/http";
test("snapshot setup probes do not recursively request their own snapshot",async()=>{
 const ctx=fakeCtx();ensureToken(ctx);let snapshots=0;
 const request=spyOn(globalThis,"fetch").mockImplementation((async(input:unknown)=>{
  if(String(input).endsWith("/health"))return Response.json({ok:true},{headers:{"x-pacer":"1"}});
  expect(String(input)).toEndWith("/v2/snapshot");snapshots++;
  if(snapshots===1)await readModelContext(ctx);
  return Response.json({snapshot:{}},{headers:{"x-pacer":"1"}});
 }) as typeof fetch);
 try{await checkSetup(ctx);expect(snapshots).toBe(1);}finally{request.mockRestore();}
});

test("a snapshot can compute setup without awaiting its own cached context",async()=>{
 const ctx=fakeCtx();ensureToken(ctx);
 const request=spyOn(globalThis,"fetch").mockImplementation((async(input:unknown)=>{
  if(String(input).endsWith("/v2/snapshot"))await readModelContext(ctx);
  return Response.json({ok:true},{headers:{"x-pacer":"1"}});
 }) as typeof fetch);
 try{
  const result=await Promise.race([readModelContext(ctx).then(()=>"ready"),Bun.sleep(100).then(()=>"hung")]);
  expect(result).toBe("ready");
 }finally{request.mockRestore();}
});

for(const major of [2,3]) test(`serve-side v${major} setup.check skips loopback probes on a custom port`,async()=>{
 const {startServer}=await import("../src/serve/http");
 const ctx=fakeCtx({env:{PACER_PORT:undefined}}),port=54321;
 // Exercise the real serve handler without requiring a listening socket.
 let handler!:(request:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:{fetch:typeof handler})=>{
  handler=options.fetch;
  return {port,stop(){}};
 }) as unknown as typeof Bun.serve);
 const request=spyOn(globalThis,"fetch").mockImplementation((async(_input:unknown):Promise<Response>=>{throw new DOMException("probe timed out","TimeoutError");}) as typeof fetch);
 let server:ReturnType<typeof startServer>|undefined;
 try{
  server=startServer(()=>ctx,{port,pumpMs:0});
  expect(ctx.env.PACER_PORT).toBeUndefined();
  const response=await handler(new Request(`http://127.0.0.1:${port}/v${major}/ops/setup.check`,{method:"POST",headers:{Host:`127.0.0.1:${port}`,Authorization:`Bearer ${server.token}`,"Content-Type":"application/json"},body:"{}"}),{port});
  expect(response.status).toBe(200);
  const {result}=await response.json();
  expect(result.items.find((i:{id:string})=>i.id==="link")).toMatchObject({status:"done"});
  expect(request).not.toHaveBeenCalled();
 }finally{server?.stop();request.mockRestore();listener.mockRestore();}
});

for(const endpoint of ["/health","/v2/snapshot"]){
 test(`standalone setup reports a ${endpoint} timeout as failed`,async()=>{
  const ctx=fakeCtx();ensureToken(ctx);
  const request=spyOn(globalThis,"fetch").mockImplementation((async(input:unknown)=>{
   if(String(input).endsWith(endpoint))throw new DOMException("probe timed out","TimeoutError");
   return Response.json({ok:true},{headers:{"x-pacer":"1"}});
  }) as typeof fetch);
  try{
   const result=await checkSetup(ctx);
   expect(result.items.find(i=>i.id==="link")).toMatchObject({status:"failed",detail:"probe timed out"});
  }finally{request.mockRestore();}
 });
}

test("standalone setup retains pending for an unsuccessful link response",async()=>{
 const ctx=fakeCtx();
 const request=spyOn(globalThis,"fetch").mockResolvedValue(new Response(null,{status:503}));
 try{expect((await checkSetup(ctx)).items.find(i=>i.id==="link")?.status).toBe("pending");}
 finally{request.mockRestore();}
});

test("snapshot probe opts are strict about the optional status flag",async()=>{
 const {parseSnapshotProbeOpts}=await import("../src/api/snapshot-probe-bridge");
 expect(parseSnapshotProbeOpts(undefined)).toEqual({});
 expect(parseSnapshotProbeOpts({})).toEqual({});
 expect(parseSnapshotProbeOpts({status:false})).toEqual({status:false});
 expect(parseSnapshotProbeOpts({status:true})).toEqual({status:true});
 expect(()=>parseSnapshotProbeOpts(null)).toThrow("params: Invalid input: expected object, received null");
 expect(()=>parseSnapshotProbeOpts([])).toThrow("params: Invalid input: expected object, received array");
 expect(()=>parseSnapshotProbeOpts({status:"false"})).toThrow("status: Invalid input: expected boolean, received string");
 expect(()=>parseSnapshotProbeOpts({status:false,x:1})).toThrow("params: Unrecognized key(s) in object: 'x'");
});

test("the snapshot probe route maps an invalid JSON body to invalid_input",async()=>{
 const {startServer}=await import("../src/serve/http");
 const ctx=fakeCtx(),port=54324,token=ensureToken(ctx);
 let handler!:(request:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:{fetch:typeof handler})=>{
  handler=options.fetch;return {port,stop(){}};
 }) as unknown as typeof Bun.serve);
 const request=spyOn(globalThis,"fetch").mockImplementation((async()=>{throw new DOMException("probe timed out","TimeoutError");}) as unknown as typeof fetch);
 let server:ReturnType<typeof startServer>|undefined;
 try{
  server=startServer(()=>ctx,{port,pumpMs:0,internal:{token}});
  const response=await handler(new Request(`http://127.0.0.1:${port}/_internal/snapshot-probe-parts`,{method:"POST",headers:{Host:`127.0.0.1:${port}`,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:"{not json"}),{port});
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_input");
 }finally{server?.stop();request.mockRestore();listener.mockRestore();}
});

test("snapshot probe parts skip the status computation when status is false",async()=>{
 const statusPath=join(import.meta.dir,"../src/engine/status.ts");
 const actual=await import(statusPath);
 const original=actual.computeStatus;
 let calls=0;
 mock.module(statusPath,()=>({...actual,computeStatus:async(...args:Parameters<typeof original>)=>{
  calls++;return original(...args);
 }}));
 const {snapshotProbeParts}=await import("../src/api/snapshot-probe-bridge");
 const ctx=fakeCtx();
 const without=await snapshotProbeParts(ctx,{status:false});
 expect(calls).toBe(0);
 expect("status" in without).toBe(false);
 expect("statusError" in without).toBe(false);
 const withStatus=await snapshotProbeParts(ctx);
 expect(calls).toBe(1);
 expect("status" in withStatus).toBe(true);
});
