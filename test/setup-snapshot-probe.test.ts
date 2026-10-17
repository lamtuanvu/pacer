import {expect,test,spyOn} from "bun:test";
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
