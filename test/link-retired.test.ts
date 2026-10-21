import { expect, test, spyOn } from "bun:test";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

test("retired bearer routes return 404", async () => {
 const ctx = fakeCtx();
 let handler!: (req:Request,server:{port:number})=>Promise<Response>;
 const listener=spyOn(Bun,"serve").mockImplementation(((options:any)=>{handler=options.fetch;return {port:4317,stop(){}};}) as typeof Bun.serve);
 let stop: (()=>void)|undefined;
 try {
  const server=startServer(()=>ctx,{port:4317,pumpMs:0,listener:false});stop=server.stop;
  for (const path of ["/link", "/events"]) {
   const response=await handler(new Request(`http://127.0.0.1:4317${path}`,{headers:{host:"127.0.0.1:4317",authorization:`Bearer ${server.token}`}}),{port:4317});
   expect(response.status).toBe(404);
   expect(response.headers.has("Deprecation")).toBe(false);
  }
 } finally { stop?.();listener.mockRestore(); }
});
