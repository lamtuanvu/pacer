import { expect, test } from "bun:test";
import { desktopUpdateCommand } from "../src/commands/desktop-update";
import type { ApiClient } from "../src/api/client-types";
import { fakeCtx } from "./helpers";
const status = { installationId:"desktop", current:"1.0.0", target:"1.1.0", phase:"ready", revision:7 };
function client(kind: ApiClient["kind"]="http") {
  const calls:{op:string;params:unknown}[]=[];
  const api:ApiClient={kind,hello:async()=>({protocol:"3.0.0",pacer:"1.0.0",ops:["status","check","download","restart","cancel","configure"].map(s=>`desktop.update.${s}`),events:[]}),snapshot:async()=>{throw Error("unused");},call:async<T>(op:string,params:unknown)=>{calls.push({op,params});return status as T;},subscribe:()=>()=>{},close(){}};
  return{api,calls};
}
test("desktop update subcommands use only the matching service operation and exact requested revision",async()=>{
  for(const action of ["status","check","download","restart","cancel","configure"]){
    const f=client(), args=[action,"--installation","desktop","--json"];
    if(action!=="status")args.push("--revision","7","--request-id","explicit-request");
    if(action==="restart")args.push("--version","1.1.0");
    if(action==="configure")args.push("--auto-download","off");
    const result=await desktopUpdateCommand(args,fakeCtx(),async()=>f.api);
    expect(result.code).toBe(0);expect(JSON.parse(result.out)).toEqual(status);
    expect(f.calls).toEqual([{op:`desktop.update.${action}`,params:action==="status"?{installationId:"desktop"}:{installationId:"desktop",expectRevision:7,requestId:"explicit-request",...(action==="restart"?{version:"1.1.0"}:{}),...(action==="configure"?{autoDownload:false}:{})}}]);
  }
});
test("restart never silently reads a newer offer or infers consent; arbitrary authority flags reject",async()=>{
  for(const extra of [[],["--version","1.1.0"],["--revision","7"],["--version","1.1.0","--revision","7","--app-path","/tmp/forged"],["--version","1.1.0","--revision","7","--client-id","forged"]]){
    const f=client();expect((await desktopUpdateCommand(["restart","--installation","desktop",...extra],fakeCtx(),async()=>f.api)).code).toBe(2);expect(f.calls).toEqual([]);
  }
});
test("non-restart mutation can observe a fresh revision; no inprocess fallback is allowed",async()=>{
  const f=client();expect((await desktopUpdateCommand(["check","--installation","desktop"],fakeCtx(),async()=>f.api)).code).toBe(0);
  expect(f.calls[0]).toEqual({op:"desktop.update.status",params:{installationId:"desktop"}});expect(f.calls[1]).toMatchObject({op:"desktop.update.check",params:{expectRevision:7,requestId:expect.any(String)}});
  const local=client("inprocess");expect((await desktopUpdateCommand(["status","--installation","desktop"],fakeCtx(),async()=>local.api)).err).toContain("service");expect(local.calls).toEqual([]);
});
