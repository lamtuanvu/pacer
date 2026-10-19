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
test('adoption requires confirmation of inspected paths and cancellation uses adoption revision',async()=>{
 const {desktopStatus,adoptionStatus}=await import('./fixtures/desktop-update/status');
 const inspected=desktopStatus({revision:7,adoption:adoptionStatus(),actions:['adopt']});
 const f=client();f.api.hello=async()=>({protocol:'3.0.0',pacer:'1.0.0',ops:['desktop.update.adopt','desktop.update.adoptCancel','desktop.update.status'],events:[]});
 f.api.call=async<T>(op:string,params:unknown)=>{f.calls.push({op,params});return inspected as T;};
 const args=['adopt','--installation','desktop'];
 const preview=await desktopUpdateCommand(args,fakeCtx(),async()=>f.api);
 expect(preview.code).toBe(2);expect(preview.err).toContain(inspected.adoption!.currentServiceExecutable);expect(preview.err).toContain('--from-service');
 expect(f.calls.every(call=>call.op==='desktop.update.status')).toBe(true);
 f.calls.length=0;
 const confirm=[...args,'--from-service',inspected.adoption!.currentServiceExecutable,'--to-service',inspected.adoption!.replacementServiceExecutable,'--request-id','adopt-request'];
 expect((await desktopUpdateCommand(confirm,fakeCtx(),async()=>f.api)).code).toBe(0);
 expect(f.calls.at(-1)).toEqual({op:'desktop.update.adopt',params:{installationId:'desktop',requestId:'adopt-request',expectRevision:7}});
 f.calls.length=0;expect((await desktopUpdateCommand([...confirm.slice(0,3),'--from-service','/wrong','--to-service',inspected.adoption!.replacementServiceExecutable],fakeCtx(),async()=>f.api)).code).toBe(2);
 expect(f.calls.every(call=>call.op==='desktop.update.status')).toBe(true);
 inspected.adoption=adoptionStatus({phase:'waiting',revision:3});inspected.actions=['adoptCancel'];f.calls.length=0;
 expect((await desktopUpdateCommand(['adopt-cancel','--installation','desktop','--request-id','cancel-request'],fakeCtx(),async()=>f.api)).code).toBe(0);
 expect(f.calls.at(-1)).toEqual({op:'desktop.update.adoptCancel',params:{installationId:'desktop',requestId:'cancel-request',expectRevision:3}});
});
