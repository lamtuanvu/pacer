import {expect,test,spyOn} from "bun:test";
import {startServer} from "../src/serve/http";
import {fakeCtx} from "./helpers";

test("HTTP handler retires unused routes including legacy reads",async()=>{
 const ctx=fakeCtx();let handler!:(req:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:any)=>{handler=options.fetch;return {port:4317,stop(){}};}) as typeof Bun.serve);
 let stop:(()=>void)|undefined;
 try{
  const service=startServer(()=>ctx,{port:4317,pumpMs:0,listener:false});stop=service.stop;
  const request=(path:string,method="GET")=>handler(new Request(`http://127.0.0.1:4317${path}`,{method,headers:{host:"127.0.0.1:4317",authorization:`Bearer ${service.token}`}}),{port:4317});
  for(const path of ["/state","/console/open","/console/forget"]){const response=await request(path,path.startsWith("/console")?"POST":"GET");expect(response.status).toBe(404);}
  for(const path of ["/link","/events"]){const response=await request(path);expect(response.status).toBe(404);expect(response.headers.has("Deprecation")).toBe(false);await response.body?.cancel();}
  const response=await request("/v2/hello");expect(response.headers.get("x-pacer")).toBe("1");
 }finally{stop?.();listener.mockRestore();}
});
