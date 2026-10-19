import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { callOp } from "../src/api/ops";
import { callV2Op, v2Hello } from "../src/api/v2-compat";
import { eventsSince, liveSnapshot } from "../src/api/events";
import { toV2Snapshot } from "../src/api/v2-compat";
import { publish } from "../src/link/publish";
import { startServer } from "../src/serve/http";
import { HttpClient } from "../src/api/http-client";
import { helloBody } from "../src/api/protocol";
import { createDesktopUpdateRuntime, bindDesktopUpdateRuntime, type NativeAuthorityProvider, type VerifiedNativeSession } from "../src/update/desktop/service";
import { FrameDecoder, encodeFrame, parseAdapterCommand, type VerifiedPipeFactory, type AdapterCommand } from "../src/update/desktop/adapter";
import { requestRestart } from "../src/update/desktop/policy";
import { readUpdate, writeUpdate } from "../src/update/desktop/store";
import type { Candidate, Installation } from "../src/update/desktop/types";
import { fakeCtx } from "./helpers";

const candidate: Candidate = { version: "1.1.0", arch: "aarch64", sha256: "a".repeat(64), signature: "private-signature", url: "https://example.invalid/private-archive", protocolMajors: [3], rollbackCompatible: true, notes: "New release" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function deferred<T>() { let resolve!: (v:T) => void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
function fixture(options: { autoDownload?:boolean; ownership?: "managed"|"attached"; hold?: Promise<void>; authorize?: Promise<boolean>; late?: boolean; lostAck?: boolean; reservation?: Promise<void> } = {}) {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome);
  const installation: Installation = { id: "desktop", appPath: "/tmp/private-desktop.app", bundleId:"dev.pacer.desktop", ownerUid:process.getuid?.()??0, arch:"aarch64", pacerHome:ctx.pacerHome, port:7433, serviceLabel:"com.pacer.serve", ownership:options.ownership??"managed", version:"1.0.0" };
  const closed=deferred<void>(); let visible=!options.late; let alive=true, boot="boot-1", now=100;
  const session: VerifiedNativeSession = { installation, desktopClientId:"native-desktop", sessionId:"native-session", bootId:boot,
    desktop:{pid:101,bootId:boot,birth:"desktop-birth"},service:{pid:102,bootId:boot,birth:"service-birth"}, alive:()=>alive, closed:closed.promise };
  const calls:string[]=[], commands:AdapterCommand[]=[], publications:unknown[]=[], scheduled:{delay:number;callback:()=>void}[]=[];
  const native: NativeAuthorityProvider = { sessions:()=>visible?[session]:[], subscribe:()=>()=>{}, reverify:async()=>{if(!alive)throw Error("gone");},
    authorizeInstall:async()=>options.authorize ? options.authorize : true,
    verifyOutcome:async(_s,_r,outcome)=>({ ...installation, version:outcome==="committed"?candidate.version:installation.version }),
  };
  const factory: VerifiedPipeFactory = { capabilities:new Set(["check","download","install","recover"]), async open() {
    let out!:ReadableStreamDefaultController<Uint8Array>, command:AdapterCommand, seq=0;
    const exited=deferred<number>(),decoder=new FrameDecoder();
    const emit=(data:Record<string,unknown>)=>out.enqueue(encodeFrame({schema:command.schema,commandId:command.commandId,installationId:command.installationId,transactionId:command.transactionId,revision:command.revision,nonce:command.nonce,sequence:seq++,...data}));
    const finish=()=>{out.close();exited.resolve(0);};
    return {identity:{version:"1.0.0",bundleId:"dev.pacer.desktop",arch:"aarch64"},stdout:new ReadableStream({start(c){out=c;}}),exited:exited.promise,abort(){calls.push("abort");},stdin:new WritableStream({async write(bytes){
      for(const value of decoder.push(bytes)){
        if((value as any).kind==="authorize-install") {if(options.lostAck){finish();continue;}emit({kind:"authorized",reservationId:command.transactionId,journalSha256:"b".repeat(64)});emit({kind:"outcome",outcome:"committed"});finish();continue;}
        command=parseAdapterCommand(value);commands.push(command);emit({kind:"hello",version:"1.0.0",bundleId:"dev.pacer.desktop",arch:"aarch64"});
        await options.hold;
        if(command.command==="check"){emit({kind:"checked",candidate});finish();}
        if(command.command==="download"){emit({kind:"progress",downloadedBytes:5,totalBytes:10});emit({kind:"downloaded",candidate,downloadedBytes:10,totalBytes:10});finish();}
        if(command.command==="recover"){emit({kind:"outcome",outcome:"committed"});finish();}
        if(command.command==="install")emit({kind:"prepared",reservationId:command.transactionId,journalSha256:"b".repeat(64)});
      }
    }})};
  }};
  const runtime=createDesktopUpdateRuntime(()=>ctx,{native,adapter:factory,clock:{nowS:()=>now,monotonicMs:()=>now*1000,bootId:()=>boot},random:()=>0,
    schedule:(callback,delay)=>{scheduled.push({callback,delay});return()=>{};},publish:async status=>{publications.push(status);},
    admission:{reserveIdle:async()=>{calls.push("reserve");await options.reservation;return{reserved:true,blockers:[]};},releaseReservation:async()=>{calls.push("release");},reconcileAdmission:async()=>{}},
  });
  if(options.autoDownload===false){const record=readUpdate(ctx,installation.id);writeUpdate(ctx,{...record,autoDownload:false},record.revision);}
  const unbind=bindDesktopUpdateRuntime(ctx,runtime);cleanups.push(runtime.stop); cleanups.push(unbind);
  return {ctx,runtime,session,native,factory,unbind,commands,calls,publications,scheduled,
    register(){visible=true;},
    seedPending(phase:"waiting"|"installing"){const value=readUpdate(ctx,"desktop");const ready=writeUpdate(ctx,{...value,phase:"ready",candidate,downloadedBytes:10,totalBytes:10,checkedAt:100},value.revision);const waiting=requestRestart(ready,{installationId:"desktop",requestId:"old-restart",expectRevision:ready.revision,version:candidate.version,clientId:"native-desktop"},boot);writeUpdate(ctx,{...waiting,phase},ready.revision);},
    stopDesktop(){alive=false;closed.resolve();},setBoot(value:string){boot=value;},setNow(value:number){now=value;},
    request(id:string){return{installationId:"desktop",requestId:id,expectRevision:runtime.status("desktop").revision};},
    async ready(){await runtime.start();await runtime.check(this.request("check"));await runtime.settled();if(runtime.status("desktop").phase!=="ready"){await runtime.download(this.request("download"));await runtime.settled();}},
  };
}

test("new operations are v3 only; public desktop registration never establishes native authority", async()=>{
  const ctx=fakeCtx();
  expect(helloBody().ops).toContain("desktop.update.check");expect(v2Hello().ops).not.toContain("desktop.update.check");
  await callOp(ctx,"client.register",{kind:"desktop",version:"1.0.0"});
  await expect(callOp(ctx,"desktop.update.status",{installationId:"desktop"})).rejects.toMatchObject({code:"not_allowed"});
  await expect(callV2Op(ctx,"desktop.update.status",{installationId:"desktop"})).rejects.toMatchObject({code:"unknown_op"});
  for(const extra of [{appPath:"/tmp/forged.app"},{url:"https://evil.invalid"},{publicKey:"forged"},{clientId:"forged"}]){
    await expect(callOp(ctx,"desktop.update.restart",{installationId:"desktop",requestId:"restart",expectRevision:0,version:"1.1.0",...extra})).rejects.toMatchObject({code:"invalid_input"});
  }
});

test("duplicate concurrent checks launch once, stale revisions conflict and status never exposes private payloads",async()=>{
  const gate=deferred<void>(), f=fixture({autoDownload:false,hold:gate.promise});await f.runtime.start();
  const request=f.request("same");const [a,b]=await Promise.all([f.runtime.check(request),f.runtime.check(request)]);
  expect(a.revision).toBe(b.revision);expect(f.commands).toHaveLength(1);
  expect(()=>f.runtime.configure({...request,autoDownload:true})).toThrow();
  expect(()=>f.runtime.configure({...request,requestId:"stale",autoDownload:true})).toThrow();
  gate.resolve();await f.runtime.settled();
  const status=f.runtime.status("desktop");expect(status.target).toBe("1.1.0");expect(status.actions).toContain("download");
  const serialized=JSON.stringify([status,...f.publications]);
  for(const secret of [candidate.url,candidate.signature,candidate.sha256,f.session.installation.appPath,f.session.installation.pacerHome])expect(serialized).not.toContain(secret);
});

test("automatic download reaches ready; public restart derives the verified native client and commits after outcome proof",async()=>{
  const f=fixture();await f.ready();expect(f.runtime.status("desktop").phase).toBe("ready");
  const request={...f.request("restart"),version:"1.1.0"};
  const started=await callOp(f.ctx,"desktop.update.restart",request) as any;
  expect(started.phase).toBe("waiting");expect(readUpdate(f.ctx,"desktop").requestedBy).toBe("native-desktop");
  await f.runtime.tick();await f.runtime.settled();
  expect(f.calls).toEqual(["reserve","release"]);expect(f.runtime.status("desktop")).toMatchObject({phase:"complete",current:"1.1.0"});
});

test("waiting cancellation and desktop closure revoke intent; replay cannot rearm",async()=>{
  const f=fixture();await f.ready();
  const request={...f.request("restart"),version:"1.1.0",clientId:"native-desktop"};await f.runtime.restart(request);
  await f.runtime.cancel(f.request("cancel"));await expect(f.runtime.restart(request)).rejects.toMatchObject({code:"conflict"});
  await f.runtime.restart({...f.request("new-restart"),version:"1.1.0",clientId:"native-desktop"});f.stopDesktop();await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop").phase).toBe("ready");expect(f.calls).not.toContain("reserve");
});

test("attached installation never reserves or releases the external service",async()=>{
  const f=fixture({ownership:"attached"});await f.ready();await f.runtime.restart({...f.request("restart"),version:"1.1.0",clientId:"native-desktop"});
  await f.runtime.tick();await f.runtime.settled();expect(f.calls).toEqual([]);expect(f.runtime.status("desktop").phase).toBe("complete");
});

test("boot changes invalidate waiting permission before reservation",async()=>{
  const f=fixture();await f.ready();await f.runtime.restart({...f.request("restart"),version:"1.1.0",clientId:"native-desktop"});f.setBoot("boot-2");
  await f.runtime.tick();expect(readUpdate(f.ctx,"desktop").phase).toBe("ready");expect(f.calls).not.toContain("reserve");
});

test("automatic checks obey opt-outs and cache; explicit check bypasses cache",async()=>{
  const f=fixture({autoDownload:false});await f.runtime.start();await f.runtime.tick();await f.runtime.settled();expect(f.commands.filter(c=>c.command==="check")).toHaveLength(1);
  await f.runtime.tick();expect(f.commands.filter(c=>c.command==="check")).toHaveLength(1);
  await f.runtime.check(f.request("manual"));await f.runtime.settled();expect(f.commands.filter(c=>c.command==="check")).toHaveLength(2);
  f.ctx.env.PACER_NO_UPDATE_CHECK="1";f.setNow(100+86400*2);await f.runtime.tick();
  await expect(f.runtime.check(f.request("disabled"))).rejects.toMatchObject({code:"not_allowed"});expect(f.commands).toHaveLength(2);
});


test("late native registration cancels persisted waiting permission and releases only that reservation",async()=>{
  const f=fixture({late:true});f.seedPending("waiting");await f.runtime.start();expect(f.runtime.listStatuses()).toEqual([]);
  f.register();await f.runtime.tick();await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop").phase).toBe("ready");expect(f.calls).toEqual(["release"]);expect(f.commands).toEqual([]);
});

test("late native registration recovers the recorded transaction without replaying restart",async()=>{
  const f=fixture({late:true});f.seedPending("installing");const tx=readUpdate(f.ctx,"desktop").transactionId;await f.runtime.start();
  f.register();await f.runtime.tick();await f.runtime.settled();
  expect(f.commands.map(c=>c.command)).toEqual(["recover"]);expect(f.commands[0].transactionId).toBe(tx);
  expect(readUpdate(f.ctx,"desktop").phase).toBe("complete");expect(f.calls).toEqual(["release"]);
});

test("cancellation during reservation cannot dispatch install",async()=>{
  const reservation=deferred<void>(),f=fixture({reservation:reservation.promise});await f.ready();
  await f.runtime.restart({...f.request("restart"),version:candidate.version,clientId:"native-desktop"});
  const tick=f.runtime.tick();await Promise.resolve();await f.runtime.cancel(f.request("cancel"));reservation.resolve();await tick;await f.runtime.settled();
  expect(f.commands.map(c=>c.command)).not.toContain("install");expect(readUpdate(f.ctx,"desktop").phase).toBe("ready");
  expect(f.calls).toEqual(["reserve","release"]);
});

test("desktop closure at prepared aborts before authorization and releases the reservation",async()=>{
  const authorize=deferred<boolean>(),f=fixture({authorize:authorize.promise});await f.ready();
  await f.runtime.restart({...f.request("restart"),version:candidate.version,clientId:"native-desktop"});await f.runtime.tick();
  f.stopDesktop();authorize.resolve(true);await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop").phase).toBe("error");expect(f.calls).toContain("release");
});

test("missing authorization acknowledgement preserves the reservation for recovery",async()=>{
  const f=fixture({lostAck:true});await f.ready();await f.runtime.restart({...f.request("restart"),version:candidate.version,clientId:"native-desktop"});await f.runtime.tick();await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop")).toMatchObject({phase:"recovery-failed",error:{code:"handoff_uncertain"}});expect(f.calls).toEqual(["reserve"]);
});

test("outcome proof cannot change any immutable installation identity",async()=>{
  for(const changed of [{port:7434},{ownership:"attached" as const},{ownerUid:999},{arch:"x86_64" as const},{serviceLabel:"forged"},{bundleId:"forged"}]){
    const f=fixture();f.native.verifyOutcome=async()=>({...f.session.installation,version:candidate.version,...changed});
    await f.ready();await f.runtime.restart({...f.request("restart"),version:candidate.version,clientId:"native-desktop"});await f.runtime.tick();await f.runtime.settled();
    expect(readUpdate(f.ctx,"desktop").phase).toBe("recovery-failed");expect(f.calls).toEqual(["reserve"]);
  }
});


test("two independent runtimes cannot launch the same recorded request twice",async()=>{
  const hold=deferred<void>(),f=fixture({autoDownload:false,hold:hold.promise});await f.runtime.start();
  const second=createDesktopUpdateRuntime(()=>f.ctx,{native:f.native,adapter:f.factory,clock:{nowS:()=>100,monotonicMs:()=>100000,bootId:()=>"boot-1"},schedule:()=>()=>{},publish:async()=>{}});cleanups.push(second.stop);await second.start();
  const request=f.request("shared-request");await Promise.all([f.runtime.check(request),second.check(request)]);expect(f.commands).toHaveLength(1);
  hold.resolve();await f.runtime.settled();await second.settled();expect(second.status("desktop").target).toBe(candidate.version);
});

test("disabling automatic download wins while its native verification is queued",async()=>{
  const f=fixture(),verification=deferred<void>(),entered=deferred<void>();let calls=0;
  f.native.reverify=async()=>{if(++calls===3){entered.resolve();await verification.promise;}};
  await f.runtime.start();await f.runtime.check(f.request("check"));await entered.promise;
  f.runtime.configure({...f.request("disable"),autoDownload:false});verification.resolve();await f.runtime.settled();
  expect(f.commands.map(c=>c.command)).toEqual(["check"]);expect(f.runtime.status("desktop").phase).toBe("idle");
});

test("failed versions remain quarantined from automatic downloads but permit explicit download",async()=>{
  const f=fixture();const value=readUpdate(f.ctx,"desktop");writeUpdate(f.ctx,{...value,failedVersion:candidate.version},value.revision);
  await f.runtime.start();await f.runtime.check(f.request("check"));await f.runtime.settled();expect(f.commands.map(c=>c.command)).toEqual(["check"]);
  await f.runtime.download(f.request("explicit"));await f.runtime.settled();expect(f.runtime.status("desktop").phase).toBe("ready");
});

test("transient checks back off, while explicit checks bypass the retry timer",async()=>{
  const f=fixture({autoDownload:false});let opens=0;f.factory.open=async()=>{opens++;throw Error("private helper failure");};
  await f.runtime.start();await f.runtime.tick();await f.runtime.settled();expect(opens).toBe(1);
  f.setNow(159);await f.runtime.tick();expect(opens).toBe(1);f.setNow(161);await f.runtime.tick();await f.runtime.settled();expect(opens).toBe(2);
  await f.runtime.check(f.request("manual"));await f.runtime.settled();expect(opens).toBe(3);expect(JSON.stringify(f.runtime.status("desktop"))).not.toContain("private helper failure");
});

test("failed startup stays unavailable and never arms automatic work",async()=>{
  const f=fixture();f.native.reverify=async()=>{throw Error("private identity failure");};
  await expect(f.runtime.start()).rejects.toMatchObject({code:"not_allowed"});await f.runtime.tick();
  await expect(f.runtime.check({installationId:"desktop",requestId:"check",expectRevision:0})).rejects.toMatchObject({code:"not_allowed"});
  expect(f.commands).toEqual([]);expect(f.runtime.status("desktop").actions).toEqual([]);expect(JSON.stringify(f.runtime.status("desktop"))).not.toContain("private identity failure");
});

test("v3 snapshot and events expose safe state; v2 remains frozen",async()=>{
  const f=fixture();await f.ready();const status=f.runtime.status("desktop");
  const model=await liveSnapshot(f.ctx);expect(model.snapshot.desktopUpdates).toEqual([status]);expect(toV2Snapshot(model.snapshot)).not.toHaveProperty("desktopUpdates");
  await publish(f.ctx,[{type:"entity",data:{kind:"desktop.update",id:"desktop",value:status}}]);
  const v3=eventsSince(f.ctx,0,3),v2=eventsSince(f.ctx,0,2);
  expect(v3.events.find(e=>e.type==="desktop.update")?.data).toEqual(status);expect(v2.events.some(e=>e.type==="desktop.update")).toBe(false);
  const wire=JSON.stringify({desktopUpdates:model.snapshot.desktopUpdates,events:v3.events});
  for(const secret of [candidate.url,candidate.signature,candidate.sha256,f.session.installation.appPath,f.session.installation.pacerHome])expect(wire).not.toContain(secret);
});

test("HTTP v3 transport reaches the service engine; v2 and forged authority remain refused",async()=>{
  const f=fixture({autoDownload:false});f.unbind();const server=startServer(()=>f.ctx,{port:0,pumpMs:0,opDeps:{desktopUpdates:f.runtime}});cleanups.push(server.stop);await f.runtime.start();
  const v3=new HttpClient(`http://127.0.0.1:${server.port}`,server.token,{protocol:3}),v2=new HttpClient(`http://127.0.0.1:${server.port}`,server.token);cleanups.push(()=>{v3.close();v2.close();});
  expect((await v3.hello()).ops).toContain("desktop.update.status");expect((await v2.hello()).ops).not.toContain("desktop.update.status");
  expect(await v3.call("desktop.update.status",{installationId:"desktop"})).toMatchObject({phase:"idle",revision:1});
  await expect(v2.call("desktop.update.status",{installationId:"desktop"})).rejects.toMatchObject({code:"unknown_op"});
  await expect(v3.call("desktop.update.check",{...f.request("forged"),appPath:"/tmp/forged.app"})).rejects.toMatchObject({code:"invalid_input"});
  await v3.call("desktop.update.check",f.request("check"));await f.runtime.settled();expect((await v3.snapshot()).snapshot).toHaveProperty("desktopUpdates");expect((await v2.snapshot()).snapshot).not.toHaveProperty("desktopUpdates");
});

test("recovery acquisition failure retains an already-authorized reservation",async()=>{
  const f=fixture({late:true});f.seedPending("installing");f.factory.open=async()=>{throw Error("helper unavailable");};
  await f.runtime.start();f.register();await f.runtime.tick();await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop")).toMatchObject({phase:"recovery-failed",error:{code:"handoff_uncertain"}});
  expect(f.calls).toEqual([]);
});

test("a scheduled check losing CAS to configuration does not disable the runtime",async()=>{
  const f=fixture({autoDownload:false}),verification=deferred<void>(),entered=deferred<void>();let calls=0;
  f.native.reverify=async()=>{if(++calls===2){entered.resolve();await verification.promise;}};
  await f.runtime.start();const scheduled=f.runtime.tick();await entered.promise;
  f.runtime.configure({...f.request("configure"),autoDownload:false});verification.resolve();await scheduled;
  expect(f.commands).toEqual([]);await f.runtime.tick();await f.runtime.settled();expect(f.commands.map(c=>c.command)).toEqual(["check"]);
});
