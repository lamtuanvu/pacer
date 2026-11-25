import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { callV2Op, v2Hello } from "../src/api/v2-compat";
import { eventsSince, liveSnapshot } from "../src/api/events";
import { toV2Snapshot } from "../src/api/v2-compat";
import { publish } from "../src/link/publish";
import { startServer } from "../src/serve/http";
import { HttpClient } from "../src/api/http-client";
import { helloBody } from "../src/api/protocol";
import { createDesktopUpdateRuntime, bindDesktopUpdateRuntime, NIGHTLY_HELPER_TOO_OLD, type NativeAuthorityProvider, type VerifiedNativeSession } from "../src/update/desktop/service";
import { FrameDecoder, encodeFrame, parseAdapterCommand, type VerifiedPipeFactory, type AdapterCommand } from "../src/update/desktop/adapter";
import { requestRestart } from "../src/update/desktop/policy";
import { readUpdate, writeUpdate } from "../src/update/desktop/store";
import type { Candidate, Installation, UpdateStatus } from "../src/update/desktop/types";
import { fakeCtx } from "./helpers";

const candidate: Candidate = { version: "1.1.0", arch: "aarch64", sha256: "a".repeat(64), signature: "private-signature", url: "https://example.invalid/private-archive", protocolMajors: [3], rollbackCompatible: true, notes: "New release" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
function deferred<T>() { let resolve!: (v:T) => void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
function fixture(options: { autoDownload?:boolean; ownership?: "managed"|"attached"; hold?: Promise<void>; holdDownload?: Promise<void>; afterAuthorized?: Promise<void>; authorize?: Promise<boolean>; late?: boolean; lostAck?: boolean; reservation?: Promise<void>; outcome?: "committed"|"restored"|"recovery-failed"; attempted?: boolean; publish?: (status: UpdateStatus) => Promise<void>; release?: () => Promise<void>; rejectChannel?: boolean } = {}) {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome);
  const installation: Installation = { id: "desktop", appPath: "/tmp/private-desktop.app", bundleId:"dev.pacer.desktop", ownerUid:process.getuid?.()??0, arch:"aarch64", pacerHome:ctx.pacerHome, port:7433, serviceLabel:"com.pacer.serve", ownership:options.ownership??"managed", version:"1.0.0" };
  const closed=deferred<void>(); let visible=!options.late; let alive=true, boot="boot-1", now=100, reconnects=0;
  const session: VerifiedNativeSession = { installation, desktopClientId:"native-desktop", sessionId:"native-session", bootId:boot,
    desktop:{pid:101,bootId:boot,birth:"desktop-birth"},service:{pid:102,bootId:boot,birth:"service-birth"}, alive:()=>alive, closed:closed.promise };
  const reserveEntered=deferred<void>();
  const calls:string[]=[], commands:AdapterCommand[]=[], raw:Record<string,unknown>[]=[], publications:unknown[]=[], scheduled:{delay:number;callback:()=>void}[]=[];
  let currentSession = session;
  const native: NativeAuthorityProvider = { sessions:()=>visible?[currentSession]:[], subscribe:()=>()=>{}, reverify:async()=>{if(!alive)throw Error("gone");},
    authorizeInstall:async()=>options.authorize ? options.authorize : true,
    verifyOutcome:async(_s,_r,outcome)=>({ installation:{ ...installation, version:outcome==="committed"?candidate.version:installation.version }, attempted:options.attempted??true }),
    broadcastEvent: async () => {},
  };
  const factory: VerifiedPipeFactory = { capabilities:new Set(["check","download","install","recover"]), async open() {
    let out!:ReadableStreamDefaultController<Uint8Array>, command:AdapterCommand, seq=0;
    const exited=deferred<number>(),decoder=new FrameDecoder();
    const emit=(data:Record<string,unknown>)=>out.enqueue(encodeFrame({schema:command.schema,commandId:command.commandId,installationId:command.installationId,transactionId:command.transactionId,revision:command.revision,nonce:command.nonce,sequence:seq++,...data}));
    const finish=()=>{out.close();exited.resolve(0);};
    return {identity:{version:"1.0.0",bundleId:"dev.pacer.desktop",arch:"aarch64"},stdout:new ReadableStream({start(c){out=c;}}),exited:exited.promise,abort(){calls.push("abort");},stdin:new WritableStream({async write(bytes){
      for(const value of decoder.push(bytes)){
        if((value as any).kind==="authorize-install") {if(options.lostAck){finish();continue;}emit({kind:"authorized",reservationId:command.transactionId,journalSha256:"b".repeat(64)});await options.afterAuthorized;emit({kind:"outcome",outcome:options.outcome??"committed"});finish();continue;}
        raw.push(value as Record<string,unknown>);
        // A helper from before channels fails the strict shape check and exits without a frame.
        if(options.rejectChannel&&"channel" in (value as object)){out.close();exited.resolve(1);continue;}
        command=parseAdapterCommand(value);commands.push(command);emit({kind:"hello",version:"1.0.0",bundleId:"dev.pacer.desktop",arch:"aarch64"});
        await (command.command==="download" && options.holdDownload ? options.holdDownload : options.hold);
        if(command.command==="check"){emit({kind:"checked",candidate});finish();}
        if(command.command==="download"){emit({kind:"progress",downloadedBytes:5,totalBytes:10});emit({kind:"downloaded",candidate,downloadedBytes:10,totalBytes:10});finish();}
        if(command.command==="recover"){emit({kind:"outcome",outcome:options.outcome??"committed"});finish();}
        if(command.command==="install")emit({kind:"prepared",reservationId:command.transactionId,journalSha256:"b".repeat(64)});
      }
    }})};
  }};
  const runtime=createDesktopUpdateRuntime(()=>ctx,{native,adapter:factory,clock:{nowS:()=>now,monotonicMs:()=>now*1000,bootId:()=>boot},random:()=>0,
    schedule:(callback,delay)=>{scheduled.push({callback,delay});return()=>{};},publish:async status=>{await options.publish?.(status);publications.push(status);},
    admission:{reserveIdle:async()=>{calls.push("reserve");reserveEntered.resolve();await options.reservation;return{reserved:true,blockers:[]};},releaseReservation:async()=>{calls.push("release");await options.release?.();},reconcileAdmission:async()=>{}},
  });
  if(options.autoDownload===false){const record=readUpdate(ctx,installation.id);writeUpdate(ctx,{...record,autoDownload:false},record.revision);}
  const unbind=bindDesktopUpdateRuntime(ctx,runtime);cleanups.push(runtime.stop); cleanups.push(unbind);
  return {ctx,runtime,session,native,factory,unbind,commands,raw,calls,publications,scheduled,reserveEntered:reserveEntered.promise,
    register(){visible=true;},
    seedPending(phase:"waiting"|"reserved"|"installing"){const value=readUpdate(ctx,"desktop");const ready=writeUpdate(ctx,{...value,phase:"ready",candidate,downloadedBytes:10,totalBytes:10,checkedAt:100},value.revision);const waiting=requestRestart(ready,{installationId:"desktop",requestId:"old-restart",expectRevision:ready.revision,version:candidate.version,clientId:"native-desktop"},boot);writeUpdate(ctx,{...waiting,phase},ready.revision);},
    stopDesktop(){alive=false;closed.resolve();},reconnectDesktop(){currentSession={...session,sessionId:`native-session-${++reconnects+1}`};alive=true;visible=true;},setBoot(value:string){boot=value;},setNow(value:number){now=value;},
    request(id:string){return{installationId:"desktop",requestId:id,expectRevision:runtime.status("desktop").revision};},
    async ready(){await runtime.start();await runtime.check(this.request("check"));await runtime.settled();if(runtime.status("desktop").phase!=="ready"){await runtime.download(this.request("download"));await runtime.settled();}},
  };
}

test("late native discovery retries failed verification without enabling mutations", async()=>{
  const f=fixture({late:true,autoDownload:false});
  await f.runtime.start();
  const verify=f.native.reverify;
  f.native.reverify=async()=>{throw Error("native startup still settling");};
  f.register();
  await f.runtime.tick();
  expect(f.runtime.status("desktop").actions).toEqual([]);
  await expect(f.runtime.check(f.request("unverified"))).rejects.toMatchObject({code:"not_allowed"});
  expect(f.commands).toEqual([]);
  f.native.reverify=verify;
  await f.runtime.tick();
  expect(f.runtime.status("desktop").actions).toContain("check");
  await f.runtime.check(f.request("verified"));
  await f.runtime.settled();
  expect(f.commands).toHaveLength(1);
});

test("notification outages retain update controls and retry the latest status without repeating work", async () => {
  let offline = true;
  const f = fixture({ autoDownload: false, publish: async () => { if (offline) throw Error("private outbox failure"); } });
  await f.runtime.start();
  await f.runtime.check(f.request("check-during-outage"));
  await f.runtime.settled();
  expect(f.runtime.status("desktop").actions).toContain("download");
  expect(f.runtime.status("desktop").error?.code).not.toBe("coordination_failed");
  await f.runtime.download(f.request("download-during-outage"));
  await f.runtime.settled();
  expect(f.runtime.status("desktop").phase).toBe("ready");
  offline = false;
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.publications.at(-1)).toMatchObject({ phase: "ready", actions: expect.arrayContaining(["restart"]) });
  expect(f.commands.map(c => c.command)).toEqual(["check", "download"]);
  expect(JSON.stringify(f.runtime.status("desktop"))).not.toContain("private outbox failure");
});

test("scheduled coordination failure recovers with fresh proof and fresh restart consent", async () => {
  const f = fixture();
  await f.ready();
  await f.runtime.restart({ ...f.request("restart"), version: candidate.version, clientId: "native-desktop" });
  const reverify = f.native.reverify;
  f.native.reverify = async () => { throw Error("private native observation failure"); };
  f.scheduled.at(-1)!.callback();
  await Bun.sleep(0);
  expect(f.runtime.status("desktop")).toMatchObject({ error: { code: "coordination_failed" } });
  expect(f.runtime.status("desktop").error?.hint).toContain("automatically");
  await expect(f.runtime.check(f.request("unsafe-check"))).rejects.toMatchObject({ code: "not_allowed" });
  await f.runtime.tick();
  expect(f.runtime.status("desktop").actions).toEqual([]);
  f.native.reverify = reverify;
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "ready", error: null });
  expect(f.publications.at(-1)).toMatchObject({ actions: expect.arrayContaining(["restart"]) });
  expect(f.commands.map(c => c.command)).toEqual(["check", "download"]);
  await f.runtime.restart({ ...f.request("fresh-restart"), version: candidate.version, clientId: "native-desktop" });
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.runtime.status("desktop").phase).toBe("complete");
  expect(f.commands.filter(c => c.command === "install")).toHaveLength(1);
});

test("failed terminal reservation release retries cleanup without reinstalling", async () => {
  let blocked = true;
  const f = fixture({ release: async () => { if (blocked) throw Error("temporary admission failure"); } });
  await f.ready();
  await f.runtime.restart({ ...f.request("restart"), version: candidate.version, clientId: "native-desktop" });
  await f.runtime.tick();
  await f.runtime.settled();
  const transactionId = readUpdate(f.ctx, "desktop").transactionId;
  expect(f.runtime.status("desktop").error?.code).toBe("coordination_failed");
  blocked = false;
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "complete", error: null, transactionId });
  expect(f.runtime.status("desktop").actions).toContain("check");
  expect(f.calls.filter(c => c === "release")).toHaveLength(2);
  expect(f.commands.filter(c => c.command === "install")).toHaveLength(1);
  expect(f.commands.filter(c => c.command === "recover")).toHaveLength(0);
});

test("a failed installation does not revoke another installation's controls", async () => {
  const f = fixture();
  const other: VerifiedNativeSession = { ...f.session, sessionId: "other-session", desktopClientId: "other-client",
    installation: { ...f.session.installation, id: "other-desktop", appPath: "/tmp/other-desktop.app" } };
  f.native.sessions = () => [f.session, other];
  await f.ready();
  await f.runtime.restart({ ...f.request("restart"), version: candidate.version, clientId: "native-desktop" });
  const reverify = f.native.reverify;
  f.native.reverify = async session => { if (session.installation.id === "desktop") throw Error("temporary observation failure"); };
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.runtime.status("desktop").actions).toEqual([]);
  expect(f.runtime.status("other-desktop").actions).toContain("check");
  await f.runtime.check({ installationId: "other-desktop", requestId: "other-check", expectRevision: f.runtime.status("other-desktop").revision });
  await f.runtime.settled();
  expect(f.runtime.status("other-desktop").phase).toBe("ready");
  f.native.reverify = reverify;
});

test("global observation recovery keeps the failure visible until fresh native verification succeeds", async () => {
  const f = fixture();
  await f.ready();
  const sessions = f.native.sessions, reverify = f.native.reverify;
  f.native.sessions = () => { throw Error("private native registry failure"); };
  f.scheduled.at(-1)!.callback();
  await Bun.sleep(0);
  f.native.sessions = sessions;
  f.native.reverify = async () => { throw Error("native connection not yet verified"); };
  await f.runtime.tick();
  expect(f.runtime.status("desktop")).toMatchObject({ actions: [], error: { code: "coordination_failed" } });
  f.native.reverify = reverify;
  await f.runtime.tick();
  await f.runtime.settled();
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "ready", error: null });
  expect(f.runtime.status("desktop").actions).toContain("restart");
  expect(f.commands.map(c => c.command)).toEqual(["check", "download"]);
});

test("failed startup retains a scheduled recovery path", async () => {
  let blocked = true;
  const f = fixture({ release: async () => { if (blocked) throw Error("temporary startup cleanup failure"); } });
  f.seedPending("waiting");
  await expect(f.runtime.start()).rejects.toMatchObject({ code: "not_allowed" });
  expect(f.scheduled.length).toBeGreaterThan(0);
  expect(f.runtime.status("desktop").actions).toEqual([]);
  blocked = false;
  f.scheduled.at(-1)!.callback();
  await Bun.sleep(0);
  await f.runtime.settled();
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "ready", error: null });
  expect(f.runtime.status("desktop").actions).toContain("restart");
  expect(f.calls).toEqual(["release", "release"]);
  expect(f.commands).toEqual([]);
});

test("global failures invalidate native proof even while a network job is still running", async () => {
  const held = deferred<void>(), f = fixture({ hold: held.promise, autoDownload: false });
  await f.runtime.start();
  await f.runtime.check(f.request("held-check"));
  const sessions = f.native.sessions, reverify = f.native.reverify;
  f.native.sessions = () => { throw Error("observation unavailable"); };
  await f.runtime.tick();
  f.native.sessions = sessions;
  let proofs = 0;
  f.native.reverify = async () => { proofs++; throw Error("not verified"); };
  await f.runtime.tick();
  held.resolve();
  await f.runtime.settled();
  await f.runtime.tick();
  expect(proofs).toBeGreaterThan(0);
  expect(f.runtime.status("desktop").actions).toEqual([]);
  f.native.reverify = reverify;
  await f.runtime.tick();
  expect(f.runtime.status("desktop").actions).toContain("download");
  expect(f.commands.map(c => c.command)).toEqual(["check"]);
});

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
  const tick=f.runtime.tick();await f.reserveEntered;await f.runtime.cancel(f.request("cancel"));reservation.resolve();await tick;await f.runtime.settled();
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
    const f=fixture();f.native.verifyOutcome=async()=>({installation:{...f.session.installation,version:candidate.version,...changed},attempted:true});
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

test("check retries reach all three backoffs and then fall back to the daily cadence", async () => {
  const f=fixture({autoDownload:false}); let opens=0;
  f.factory.open=async()=>{opens++;throw Error("helper unavailable");};
  await f.runtime.start(); await f.runtime.tick(); await f.runtime.settled();
  expect(opens).toBe(1);
  // Failure 1 waits 1 minute, failure 2 waits 5, failure 3 waits 15: all three
  // CHECK_RETRY_DELAYS entries are reachable instead of jumping to 24 h on failure 3.
  for (const [at,expected] of [[159,1],[161,2],[460,2],[461,3],[1360,3],[1361,4]] as const) {
    f.setNow(at); await f.runtime.tick(); await f.runtime.settled();
    expect(opens).toBe(expected);
  }
  // The fourth failure spends the budget: the next automatic check is a day later.
  expect(readUpdate(f.ctx,"desktop").error?.code).toBe("check_unavailable");
  f.setNow(87760); await f.runtime.tick(); expect(opens).toBe(4);
  f.setNow(87761); await f.runtime.tick(); await f.runtime.settled(); expect(opens).toBe(5);
  expect(f.runtime.status("desktop").error?.message).not.toContain("helper unavailable");
});

test("a reconnect retry stops once the check budget is spent", async () => {
  const f=fixture({autoDownload:false}); let opens=0;
  f.factory.open=async()=>{opens++;throw Error("helper unavailable");};
  await f.runtime.start(); await f.runtime.tick(); await f.runtime.settled();
  expect(opens).toBe(1);
  f.setNow(161); await f.runtime.tick(); await f.runtime.settled();
  expect(opens).toBe(2);
  // A fresh native session can spend the last retry immediately.
  f.reconnectDesktop(); await f.runtime.tick(); await f.runtime.settled();
  expect(opens).toBe(3);
  // Once the three retries are used, further reconnects do not re-arm them.
  f.reconnectDesktop(); await f.runtime.tick(); await f.runtime.settled();
  expect(opens).toBe(3);
});

test("download and install failures never arm a check retry", async () => {
  const download=fixture(); const openDownload=download.factory.open; let attempts=0;
  download.factory.open=async(...args)=>{if(++attempts===2)throw Error("download helper failed");return openDownload(...args);};
  await download.runtime.start();
  await download.runtime.check(download.request("check")); await download.runtime.settled();
  // The download launch was attempted and refused; no command frame was written.
  expect(attempts).toBe(2);
  expect(download.runtime.status("desktop").error?.code).toBe("update_failed");
  download.reconnectDesktop(); await download.runtime.tick(); await download.runtime.settled();
  expect(attempts).toBe(2);
  expect(JSON.stringify(download.runtime.status("desktop"))).not.toContain("helper failed");

  const install=fixture({late:true}); install.seedPending("installing");
  install.factory.open=async()=>{throw Error("install helper failed");};
  await install.runtime.start(); install.register();
  await install.runtime.tick(); await install.runtime.settled();
  expect(install.runtime.status("desktop").phase).toBe("recovery-failed");
  install.reconnectDesktop(); await install.runtime.tick(); await install.runtime.settled();
  expect(install.commands).toEqual([]);
  expect(JSON.stringify(install.runtime.status("desktop"))).not.toContain("helper failed");
});

test("service stop aborts an in-flight check and download", async () => {
  const checkHold=deferred<void>(), f=fixture({autoDownload:false,hold:checkHold.promise});
  await f.runtime.start();
  void f.runtime.check(f.request("check"));
  for (let i=0;i<100 && f.commands.length===0;i++) await Bun.sleep(0);
  f.runtime.stop(); checkHold.resolve(); await f.runtime.settled();
  expect(f.calls).toContain("abort");
  // The aborted operation persists no result after shutdown.
  expect(readUpdate(f.ctx,"desktop").error).toBeNull();

  const downloadHold=deferred<void>(), g=fixture({holdDownload:downloadHold.promise});
  await g.runtime.start();
  void g.runtime.check(g.request("check"));
  for (let i=0;i<100 && g.commands.length<2;i++) await Bun.sleep(0);
  expect(g.commands.map(c=>c.command)).toEqual(["check","download"]);
  g.runtime.stop(); downloadHold.resolve(); await g.runtime.settled();
  expect(g.calls.filter(call=>call==="abort")).toHaveLength(1);
  expect(readUpdate(g.ctx,"desktop").error).toBeNull();
});

test("an interrupted check is retried automatically on the next desktop session", async () => {
  const f = fixture({ late: true, autoDownload: false });
  const value = readUpdate(f.ctx, "desktop");
  writeUpdate(f.ctx, { ...value, phase: "checking", error: null }, value.revision);
  await f.runtime.start();
  expect(f.runtime.listStatuses()).toEqual([]);
  f.register();
  await f.runtime.tick(); await f.runtime.settled();
  expect(readUpdate(f.ctx, "desktop").error?.code).toBe("check_interrupted");
  expect(f.commands).toEqual([]);
  // The next tick retries without a user click, at the current revision with a fresh request ID.
  await f.runtime.tick(); await f.runtime.settled();
  expect(f.commands.map(c => c.command)).toEqual(["check"]);
  expect(f.raw[0]).toMatchObject({ command: "check" });
  expect(readUpdate(f.ctx, "desktop")).toMatchObject({ phase: "idle", error: null });
});

test("a check in flight during desktop closure finishes instead of being cancelled", async () => {
  const hold = deferred<void>();
  const f = fixture({ autoDownload: false, hold: hold.promise });
  await f.runtime.start();
  void f.runtime.check(f.request("check"));
  for (let i = 0; i < 100 && f.commands.length === 0; i++) await Bun.sleep(0);
  // The copied helper is parented by the service, so closing the desktop session
  // must not abort its pipe: no raw adapter message and no error state.
  f.stopDesktop(); hold.resolve();
  await f.runtime.settled();
  const status = f.runtime.status("desktop");
  expect(status.phase).toBe("idle");
  expect(status.error).toBeNull();
  expect(JSON.stringify(status)).not.toContain("cancelled");
  expect(JSON.stringify(status)).not.toContain("adapter");
  f.reconnectDesktop();
  await f.runtime.tick(); await f.runtime.settled();
  expect(f.commands.map(c => c.command)).toEqual(["check"]);
});

test("a download in flight during desktop closure survives reconnect and stays ready", async () => {
  const hold = deferred<void>();
  const f = fixture({ holdDownload: hold.promise });
  await f.runtime.start();
  void f.runtime.check(f.request("check"));
  for (let i = 0; i < 100 && f.commands.length < 2; i++) await Bun.sleep(0);
  expect(f.commands.map(c => c.command)).toEqual(["check", "download"]);
  // Reconciliation on the new native session must not discard the active download.
  f.stopDesktop(); f.reconnectDesktop();
  await f.runtime.tick();
  hold.resolve();
  await f.runtime.settled();
  expect(readUpdate(f.ctx, "desktop").phase).toBe("ready");
  expect(f.runtime.status("desktop").error).toBeNull();
  expect(f.calls).not.toContain("abort");
  expect(f.commands.map(c => c.command)).toEqual(["check", "download"]);
});

test("failed startup stays unavailable and never arms automatic work",async()=>{
  const f=fixture();f.native.reverify=async()=>{throw Error("private identity failure");};
  await f.runtime.start();await f.runtime.tick();
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

test("transient recovery connection failure is retried with fresh proof and backoff", async () => {
  const f = fixture({ late: true, outcome: "restored" });
  f.seedPending("installing");
  const open = f.factory.open;
  let attempts = 0;
  f.factory.open = async (...args) => {
    if (++attempts === 1) throw Error("native recovery still settling");
    return open(...args);
  };
  await f.runtime.start(); f.register();
  await f.runtime.tick(); await f.runtime.settled();
  expect(f.runtime.status("desktop").phase).toBe("recovery-failed");
  expect(f.calls).toEqual([]);
  await f.runtime.tick(); await f.runtime.settled();
  expect(attempts).toBe(1);
  f.setNow(102);
  await f.runtime.tick(); await f.runtime.settled();
  expect(attempts).toBe(2);
  expect(f.runtime.status("desktop").phase).toBe("restored");
  expect(f.commands.map(command => command.command)).toEqual(["recover"]);
  expect(f.calls).toEqual(["release"]);
});

test("persistent recovery connection failures keep admission held and bound retries", async () => {
  const f = fixture({ late: true }); f.seedPending("installing");
  let attempts = 0;
  f.factory.open = async () => { attempts++; throw Error("unavailable"); };
  await f.runtime.start(); f.register();
  for (let i = 0; i < 10; i++) {
    f.setNow(100 + i * 60);
    await f.runtime.tick(); await f.runtime.settled();
  }
  expect(attempts).toBe(5);
  expect(f.calls).toEqual([]);
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "recovery-failed", actions: [] });
});

test("confirmed native recovery failure is not retried as a connection error", async () => {
  const f = fixture({ late: true, outcome: "recovery-failed" }); f.seedPending("installing");
  await f.runtime.start(); f.register();
  await f.runtime.tick(); await f.runtime.settled();
  f.setNow(1000);
  await f.runtime.tick(); await f.runtime.settled();
  expect(f.commands.map(command => command.command)).toEqual(["recover"]);
  expect(f.calls).toEqual([]);
  expect(f.runtime.status("desktop")).toMatchObject({ phase: "recovery-failed", error: { code: "recovery_failed" }, actions: [] });
});

test("a scheduled check losing CAS to configuration does not disable the runtime",async()=>{
  const f=fixture({autoDownload:false}),verification=deferred<void>(),entered=deferred<void>();let calls=0;
  f.native.reverify=async()=>{if(++calls===2){entered.resolve();await verification.promise;}};
  await f.runtime.start();const scheduled=f.runtime.tick();await entered.promise;
  f.runtime.configure({...f.request("configure"),autoDownload:false});verification.resolve();await scheduled;
  expect(f.commands).toEqual([]);await f.runtime.tick();await f.runtime.settled();expect(f.commands.map(c=>c.command)).toEqual(["check"]);
});

test("a concurrent duplicate restart winning CAS binds its persisted transaction to the session",async()=>{
  const f=fixture();await f.ready();
  const request={...f.request("same-restart"),version:candidate.version,clientId:"native-desktop"};
  let winningTransaction:string|null=null;
  // Inject the peer's durable CAS between this runtime's state read and write.
  // Accessors are test orchestration only; public API requests are plain JSON.
  const racingRequest={...request,get version(){
    if(winningTransaction===null){
      const current=readUpdate(f.ctx,"desktop");
      const winner=writeUpdate(f.ctx,requestRestart(current,request,"boot-1"),current.revision);
      winningTransaction=winner.transactionId;
    }
    return request.version;
  }};
  const result=await f.runtime.restart(racingRequest);
  expect(result).toMatchObject({phase:"waiting",transactionId:winningTransaction});
  expect(readUpdate(f.ctx,"desktop").requestHistory.filter(r=>r.requestId===request.requestId)).toHaveLength(1);
  await f.runtime.tick();await f.runtime.settled();
  expect(f.commands.filter(c=>c.command==="install").map(c=>c.transactionId)).toEqual([winningTransaction!]);
  expect(readUpdate(f.ctx,"desktop").phase).toBe("complete");
});


test("grantless preparation abort does not quarantine an unattempted candidate",async()=>{
 for(const attempted of [false,true]){
  const f=fixture({outcome:"restored",attempted});f.seedPending("installing");await f.runtime.start();await f.runtime.settled();
  expect(readUpdate(f.ctx,"desktop").phase).toBe("restored");
  expect(readUpdate(f.ctx,"desktop").failedVersion).toBe(attempted?candidate.version:null);
 }
});

test("adoption projects inspected ownership change and cancels with its separate revision",async()=>{
 const f=fixture({ownership:"attached",autoDownload:false});
 f.native.inspectAdoption=()=>({target:f.session.installation,nativeSessionId:f.session.sessionId,desktopClientId:f.session.desktopClientId,bootId:f.session.bootId,desktop:f.session.desktop,service:f.session.service,serviceVersion:"1.0.0",oldServiceExecutable:"/opt/pacer",newServiceExecutable:f.session.installation.appPath+"/Contents/Resources/pacer"});
 f.native.authorizeAdoption=async()=>true;f.native.verifyAdoptionOutcome=async()=>({installation:f.session.installation,attempted:false});
 (f.factory.capabilities as Set<string>).add("adopt");(f.factory.capabilities as Set<string>).add("recover-adoption");
 await f.runtime.start();expect(f.runtime.status("desktop").actions).toContain("adopt");
 expect(f.runtime.status("desktop").adoption).toMatchObject({phase:"available",currentServiceExecutable:"/opt/pacer",replacementServiceExecutable:"/tmp/private-desktop.app/Contents/Resources/pacer"});
 const status=await callOp(f.ctx,"desktop.update.adopt",f.request("adoption")) as ReturnType<typeof f.runtime.status>;
 expect(status.actions).toEqual(["adoptCancel"]);expect(status.adoption?.phase).toBe("waiting");
 await expect(f.runtime.check(f.request("blocked"))).rejects.toMatchObject({code:"conflict"});
 const cancelled=await callOp(f.ctx,"desktop.update.adoptCancel",{installationId:"desktop",requestId:"cancel-adoption",expectRevision:status.adoption!.revision}) as ReturnType<typeof f.runtime.status>;
 expect(cancelled.adoption?.phase).toBe("cancelled");expect(v2Hello().ops).not.toContain("desktop.update.adopt");
 expect(JSON.stringify(cancelled)).not.toContain("native-session");expect(JSON.stringify(cancelled)).not.toContain("desktop-birth");
});

test("old installation request replays its committed adoption after service restart without old native authority",async()=>{
 const f=fixture({ownership:"attached",autoDownload:false});const {beginAdoption,transitionAdoption}=await import("../src/update/desktop/adoption-store");
 const request={installationId:"desktop",requestId:"original-adopt",expectRevision:readUpdate(f.ctx,"desktop").revision};
 const source={target:f.session.installation,nativeSessionId:f.session.sessionId,desktopClientId:f.session.desktopClientId,bootId:f.session.bootId,desktop:f.session.desktop,service:f.session.service,serviceVersion:"1.0.0",oldServiceExecutable:"/opt/pacer",newServiceExecutable:f.session.installation.appPath+"/Contents/Resources/pacer"};
 let value=beginAdoption(f.ctx,request,source);value=transitionAdoption(f.ctx,"desktop",value.revision,"reserved");value=transitionAdoption(f.ctx,"desktop",value.revision,"verifying");transitionAdoption(f.ctx,"desktop",value.revision,"committed",{resultingInstallationId:"managed-installation"});f.unbind();
 const runtime=createDesktopUpdateRuntime(()=>f.ctx,{native:{sessions:()=>[],subscribe:()=>()=>{},reverify:async()=>{throw Error("no old native authority");},broadcastEvent:async()=>{}},schedule:()=>()=>{},publish:async()=>{}});const unbind=bindDesktopUpdateRuntime(f.ctx,runtime);cleanups.push(unbind,runtime.stop);await runtime.start();
 const result=await callOp(f.ctx,"desktop.update.adopt",request) as ReturnType<typeof runtime.status>;expect(result.adoption).toMatchObject({phase:"committed",previousInstallationId:"desktop",resultingInstallationId:"managed-installation"});expect(runtime.listStatuses()).toHaveLength(1);
 await expect(callOp(f.ctx,"desktop.update.adopt",{...request,requestId:"new-permission"})).rejects.toMatchObject({code:"not_allowed"});
});

test("terminal adoption history cannot authorize retry without a fresh native inspection", async () => {
 const f=fixture({ownership:"attached",autoDownload:false});
 const source={target:f.session.installation,nativeSessionId:f.session.sessionId,desktopClientId:f.session.desktopClientId,bootId:f.session.bootId,desktop:f.session.desktop,service:f.session.service,serviceVersion:"1.0.0",oldServiceExecutable:"/opt/pacer",newServiceExecutable:f.session.installation.appPath+"/Contents/Resources/pacer"};
 f.native.inspectAdoption=()=>source;
 f.native.authorizeAdoption=async()=>true;f.native.verifyAdoptionOutcome=async()=>({installation:f.session.installation,attempted:false});
 (f.factory.capabilities as Set<string>).add("adopt");(f.factory.capabilities as Set<string>).add("recover-adoption");
 await f.runtime.start();
 const waiting=await f.runtime.adopt(f.request("adopt-once"));
 await f.runtime.adoptCancel({installationId:"desktop",requestId:"cancel-once",expectRevision:waiting.adoption!.revision});
 let inspections=0;
 f.native.inspectAdoption=()=>{inspections++;return {...source,oldServiceExecutable:"/opt/verified-current-pacer"};};
 const retry=f.runtime.status("desktop");
 expect(inspections).toBe(1);expect(retry.actions).toContain("adopt");
 expect(retry.adoption?.currentServiceExecutable).toBe("/opt/verified-current-pacer");
 f.native.inspectAdoption=()=>{throw Error("native registration changed");};
 const unavailable=f.runtime.status("desktop");
 expect(unavailable.actions).not.toContain("adopt");
 expect(unavailable.adoption).toMatchObject({phase:"cancelled",currentServiceExecutable:"/opt/pacer"});
 expect(JSON.stringify(unavailable)).not.toContain("native registration changed");
});


test("authorized native install survives its planned desktop shutdown", async () => {
  const hold = deferred<void>(), f = fixture({ afterAuthorized: hold.promise });
  await f.ready();
  await f.runtime.restart({ ...f.request("planned-restart"), version: candidate.version, clientId: "native-desktop" });
  await f.runtime.tick();
  for (let i = 0; i < 100 && f.runtime.status("desktop").phase !== "installing"; i++) await Bun.sleep(1);
  expect(f.runtime.status("desktop").phase).toBe("installing");
  f.stopDesktop();
  await Bun.sleep(10);
  const phase = f.runtime.status("desktop").phase, aborted = f.calls.includes("abort");
  hold.resolve();
  await f.runtime.settled();
  expect(phase).toBe("installing");
  expect(aborted).toBe(false);
  expect(f.runtime.status("desktop").phase).toBe("complete");
});


test("recovery owns a reserved transaction even if its discovered desktop exits", async () => {
  const hold = deferred<void>(), f = fixture({ hold: hold.promise });
  f.seedPending("reserved");
  await f.runtime.start();
  for (let i = 0; i < 100 && f.commands.length === 0; i++) await Bun.sleep(1);
  expect(f.commands[0].command).toBe("recover");
  f.stopDesktop();
  await Bun.sleep(10);
  const aborted = f.calls.includes("abort");
  hold.resolve(); await f.runtime.settled();
  expect(aborted).toBe(false);
  expect(f.runtime.status("desktop").phase).toBe("complete");
});
test("check request carries the configured channel", async()=>{
  const f=fixture({autoDownload:false});writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"update_channel: nightly\n");
  await f.runtime.start();await f.runtime.check(f.request("nightly"));await f.runtime.settled();
  expect(f.commands.filter(c=>c.command==="check").map(c=>(c as {channel?:string}).channel)).toEqual(["nightly"]);
  // The channel is read on each check, so a change in Settings applies to the next one.
  writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"update_channel: stable\n");
  await f.runtime.check(f.request("stable"));await f.runtime.settled();
  // Stable omits `channel` on the wire, so a helper that predates channels still accepts it.
  expect(f.commands.filter(c=>c.command==="check").map(c=>"channel" in c ? c.channel : "omitted")).toEqual(["nightly","omitted"]);
});
test("channel defaults to stable when config is unreadable", async()=>{
  const f=fixture({autoDownload:false});mkdirSync(join(f.ctx.pacerHome,"strategy.yaml"));
  await f.runtime.start();await f.runtime.check(f.request("check"));await f.runtime.settled();
  expect(f.commands.filter(c=>c.command==="check").map(c=>"channel" in c ? c.channel : "omitted")).toEqual(["omitted"]);
});
test("a helper that predates channels rejecting a nightly check surfaces an update-the-app message and backs off", async()=>{
  const f=fixture({autoDownload:false,rejectChannel:true});writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),"update_channel: nightly\n");
  await f.runtime.start();await f.runtime.check(f.request("nightly"));await f.runtime.settled();
  const status=f.runtime.status("desktop");
  expect(status.phase).toBe("error");expect(status.error?.code).toBe("update_failed");expect(status.target).toBeNull();
  expect(status.error?.message).toBe(NIGHTLY_HELPER_TOO_OLD);
  // One attempt only: the failure schedules the normal retry backoff instead of rechecking at once.
  await f.runtime.tick();await f.runtime.settled();
  expect(f.raw.filter(c=>c.command==="check")).toEqual([expect.objectContaining({channel:"nightly"})]);
  expect(f.commands).toEqual([]);
});
