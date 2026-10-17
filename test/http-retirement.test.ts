import {expect,test,spyOn} from "bun:test";
import {startServer} from "../src/serve/http";
import {fakeCtx} from "./helpers";

test("HTTP handler retires unused routes and marks legacy reads",async()=>{
 const ctx=fakeCtx();let handler!:(req:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:any)=>{handler=options.fetch;return {port:4317,stop(){}};}) as typeof Bun.serve);
 let stop:(()=>void)|undefined;
 try{
  const service=startServer(()=>ctx,{port:4317,pumpMs:0});stop=service.stop;
  const request=(path:string,method="GET")=>handler(new Request(`http://127.0.0.1:4317${path}`,{method,headers:{host:"127.0.0.1:4317",authorization:`Bearer ${service.token}`}}),{port:4317});
  for(const path of ["/state","/console/open","/console/forget"]){const response=await request(path,path.startsWith("/console")?"POST":"GET");expect(response.status).toBe(404);}
  for(const path of ["/link","/events"]){const response=await request(path);expect(response.status).toBe(200);expect(response.headers.get("Deprecation")).toBe("true");expect(response.headers.get("Sunset")).toBe("3.0");await response.body?.cancel();}
  const response=await request("/v2/hello");expect(response.headers.get("x-pacer")).toBe("1");
 }finally{stop?.();listener.mockRestore();}
});

test("legacy events waits for the initial status instead of emitting a warmup error",async()=>{
 const ctx=fakeCtx();
 await Bun.write(`${ctx.pacerHome}/strategy.yaml`,"planner: claude-code\nproviders:\n  claude-code: {}\n");
 let handler!:(req:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:any)=>{handler=options.fetch;return {port:4317,stop(){}};}) as typeof Bun.serve);
 let stop:(()=>void)|undefined;
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const service=startServer(()=>ctx,{port:4317,pumpMs:0});stop=service.stop;
  const response=await handler(new Request("http://127.0.0.1:4317/events",{headers:{host:"127.0.0.1:4317",authorization:`Bearer ${service.token}`}}),{port:4317});
  reader=response.body!.getReader();
  const first=await reader.read();
  expect(JSON.parse(new TextDecoder().decode(first.value).slice(6).trim())).toMatchObject({v:1,type:"budget",data:{planner:"claude-code"}});
 }finally{await reader?.cancel();stop?.();listener.mockRestore();}
});
