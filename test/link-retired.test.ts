import { expect, test, spyOn } from "bun:test";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { emptySnapshot } from "../src/link/envelope";
import { renderStatusPage } from "../orca-plugin/src/panel";

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

test("panel without API offers plugin update command", () => {
 const page = renderStatusPage(emptySnapshot(), {nowS:1,reachable:false,transport:null});
 expect(page).toContain("Update the pacer plugin");
 expect(page).toContain("pacer update");
});

test("plugin bundle has no link storage reads or retired transports", async () => {
 const worker = await Bun.file("orca-plugin/dist/worker.mjs").text();
 expect(/storage\.get[\s\S]{0,40}key:\s*["']link["']/.test(worker)).toBe(false);
 for (const name of ["bridgeTransport", "channelTransport", "httpTransport"]) expect(worker).not.toContain(name);
});

test("API update notice survives a completed bootstrap state",()=>{
 const page=renderStatusPage(emptySnapshot(),{nowS:1,reachable:false,transport:null,bootstrap:{install:{status:"done"},start:{status:"done"},agents:[]}});
 expect(page).toContain("Update the pacer plugin");
 expect(page).toContain("pacer update");
});
