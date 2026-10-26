import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitInstall, recoverInstall, type JournalIO, type PendingFile } from "../packages/plugin-sdk/src/install/journal";
import { sha256 } from "../packages/plugin-sdk/src/install/helpers";
import * as host from "../src/install/journal";
import { readInstallFile, writeInstallFile } from "../src/install/atomic";
import { fakeCtx } from "./helpers";
function memory() {
  const files = new Map<string, {text:string;mode:number}>([["/a", {text:"old-a",mode:0o700}], ["/b",{text:"old-b",mode:0o600}]]);
  let journal:string|null=null,manifest:string|null="old-manifest";
  const effects:string[]=[];
  const faults:{write?:(path:string,text:string)=>void;removeJournal?:()=>void}={};
  const io:JournalIO={
    readJournal:async()=>journal,
    writeJournal:async text=>{effects.push("journal");journal=text;},
    removeJournal:async()=>{effects.push("remove-journal");faults.removeJournal?.();journal=null;},
    readManifest:async()=>manifest,
    writeManifest:async text=>{effects.push("manifest");manifest=text;},
    readFile:async path=>files.get(path)?.text??null,
    writeFile:async(path,text,mode)=>{effects.push(`write:${path}`);faults.write?.(path,text);files.set(path,{text,mode:mode??files.get(path)?.mode??0o600});},
    removeFile:async path=>{effects.push(`remove:${path}`);files.delete(path);},
  };
  return {io,files,effects,faults,get journal(){return journal;},set journal(v){journal=v;},get manifest(){return manifest;},set manifest(v){manifest=v;}};
}
const pending:PendingFile[]=[{path:"/a",before:"old-a",after:"new-a",beforeMode:0o700},{path:"/b",before:"old-b",after:"new-b",beforeMode:0o600}];
const journal=(files:PendingFile[]=pending,manifest="new-manifest")=>JSON.stringify({schema:1,files,manifestHash:sha256(manifest)});
test("commit writes exact schema1 journal, checks every before, then manifest last",async()=>{
 const f=memory();let captured="";
 const io={...f.io,writeJournal:async(text:string)=>{captured=text;await f.io.writeJournal(text);}};
 await commitInstall(io,pending,"new-manifest");
 expect(captured).toBe(journal());
 expect(f.effects).toEqual(["journal","write:/a","write:/b","manifest","remove-journal"]);
 expect(f.files.get("/a")).toEqual({text:"new-a",mode:0o700});expect(f.manifest).toBe("new-manifest");expect(f.journal).toBeNull();
});
test("all before preconditions precede journal effects",async()=>{
 const f=memory();f.files.set("/b",{text:"user",mode:0o600});
 await expect(commitInstall(f.io,pending,"new-manifest")).rejects.toThrow("changed while planning");
 expect(f.effects).toEqual([]);expect(f.files.get("/a")!.text).toBe("old-a");
});
test("midapply failure rolls back in reverse order before rejecting original error",async()=>{
 const f=memory(),failure=Object.assign(Error("owned apply failure"),{name:"AbortError"});let once=true;
 f.faults.write=(path,text)=>{if(path==="/b"&&text==="new-b"&&once){once=false;throw failure;}};
 await expect(commitInstall(f.io,pending,"new-manifest")).rejects.toBe(failure);
 expect(f.effects).toEqual(["journal","write:/a","write:/b","write:/b","write:/a","remove-journal"]);
 expect(f.files.get("/a")).toEqual({text:"old-a",mode:0o700});expect(f.files.get("/b")!.text).toBe("old-b");expect(f.journal).toBeNull();
});
test("apply recheck refuses an intervening edit and retains journal when recovery conflicts",async()=>{
 const f=memory();const io={...f.io,writeJournal:async(text:string)=>{await f.io.writeJournal(text);f.files.set("/b",{text:"user",mode:0o600});}};
 await expect(commitInstall(io,pending,"new-manifest")).rejects.toThrow("changed during recovery");
 expect(f.files.get("/b")!.text).toBe("user");expect(f.files.get("/a")!.text).toBe("new-a");expect(f.journal).not.toBeNull();
 expect(f.effects).toEqual(["journal","write:/a"]);
});
test("fresh recovery checks every destination before any reverse rollback",async()=>{
 const f=memory();f.journal=journal();f.files.set("/a",{text:"new-a",mode:0o700});f.files.set("/b",{text:"user",mode:0o600});
 await expect(recoverInstall({...f.io})).rejects.toThrow("changed during recovery");expect(f.effects).toEqual([]);expect(f.journal).not.toBeNull();
 f.files.set("/b",{text:"old-b",mode:0o600});await recoverInstall({...f.io});
 expect(f.effects).toEqual(["write:/b","write:/a","remove-journal"]);expect(f.files.get("/a")!.text).toBe("old-a");
});
test("committed manifest hash means cleanup only and failing cleanup remains retryable",async()=>{
 const f=memory();f.journal=journal();f.manifest="new-manifest";f.files.set("/a",{text:"user-after-commit",mode:0o700});
 f.faults.removeJournal=()=>{throw Error("cleanup failed");};
 await expect(recoverInstall(f.io)).rejects.toThrow("cleanup failed");expect(f.journal).not.toBeNull();
 f.faults.removeJournal=undefined;await recoverInstall(f.io);
 expect(f.effects).toEqual(["remove-journal","remove-journal"]);expect(f.files.get("/a")!.text).toBe("user-after-commit");
});
test("commit cleanup failure cannot cause rollback of committed files",async()=>{
 const f=memory();f.faults.removeJournal=()=>{throw Error("cleanup failed");};
 await expect(commitInstall(f.io,pending,"new-manifest")).rejects.toThrow("cleanup failed");
 expect(f.effects.slice(-2)).toEqual(["remove-journal","remove-journal"]);expect(f.files.get("/a")!.text).toBe("new-a");expect(f.journal).not.toBeNull();
});
test("rollback failure supersedes apply error and retains durable journal for later recovery",async()=>{
 const f=memory();f.faults.write=(_path,text)=>{if(text==="new-b")throw Error("apply failed");if(text==="old-b")throw Error("recovery failed");};
 await expect(commitInstall(f.io,pending,"new-manifest")).rejects.toThrow("recovery failed");expect(f.journal).not.toBeNull();
 f.faults.write=undefined;await recoverInstall(f.io);expect(f.files.get("/a")!.text).toBe("old-a");expect(f.journal).toBeNull();
});
test("persistent malformed metadata is refused before manifest or file effects",async()=>{
 for(const value of [null,{schema:2,files:[],manifestHash:sha256("")},{schema:1,files:[{path:"/x",before:0,after:null}],manifestHash:sha256("")},{schema:1,files:[{path:"/x",before:null,after:"x",mode:0o644}],manifestHash:sha256("")},{schema:1,files:[pending[0],pending[0]],manifestHash:sha256("")},{schema:1,files:[],manifestHash:"not-hash"}]){
  const f=memory();f.journal=JSON.stringify(value);let reads=0;
  await expect(recoverInstall({...f.io,readManifest:async()=>{reads++;return null;}})).rejects.toThrow("invalid installation recovery journal");
  expect(reads).toBe(0);expect(f.effects).toEqual([]);
 }
});
test("pending metadata snapshot and validation precede journal effects",async()=>{
 const f=memory();await expect(commitInstall(f.io,[{...pending[0]!,mode:0o755}],"new-manifest")).rejects.toThrow("invalid installation recovery journal");expect(f.effects).toEqual([]);
 const files=structuredClone(pending);const io={...f.io,readFile:async(path:string)=>{files[0]!.after="changed-by-caller";return await f.io.readFile(path);}};
 await commitInstall(io,files,"new-manifest");expect(f.files.get("/a")!.text).toBe("new-a");
});
test("actual owned-temp journal commit and recovery match existing host bytes and modes",async()=>{
 const ctx=fakeCtx(),path=join(ctx.home,"script"),created=join(ctx.home,"new"),jp=join(ctx.pacerHome,"install-transaction.json"),mp=join(ctx.pacerHome,"install-manifest.json");
 mkdirSync(ctx.pacerHome,{recursive:true});
 const original="\ufeff#!/bin/sh\n# 界\n",after=original+"exit 0\n\0";
 const files:PendingFile[]=[{path,before:original,after,beforeMode:0o700},{path:created,before:null,after:"界",mode:0o600}];
 const io:JournalIO={readJournal:async()=>readInstallFile(jp),writeJournal:async text=>writeInstallFile(jp,text),removeJournal:async()=>rmSync(jp),readManifest:async()=>readInstallFile(mp),writeManifest:async text=>writeInstallFile(mp,text),readFile:async file=>readInstallFile(file),writeFile:async(file,text,mode)=>writeInstallFile(file,text,mode),removeFile:async file=>rmSync(file,{force:true})};
 const reset=()=>{rmSync(mp,{force:true});rmSync(created,{force:true});writeFileSync(path,original,{mode:0o700});};
 const snapshot=()=>({text:readFileSync(path,"utf8"),mode:statSync(path).mode&0o777,created:existsSync(created)?readFileSync(created,"utf8"):null,manifest:readInstallFile(mp),journal:readInstallFile(jp)});
 try{
  reset();host.commitInstall(ctx,files,"new-manifest");const hostCommitted=snapshot();
  reset();await commitInstall(io,files,"new-manifest");expect(snapshot()).toEqual(hostCommitted);
  rmSync(mp);writeInstallFile(jp,journal(files));host.recoverInstall(ctx);const hostRecovered=snapshot();
  writeInstallFile(path,after,0o700);writeInstallFile(created,"界",0o600);writeInstallFile(jp,journal(files));await recoverInstall(io);
  expect(snapshot()).toEqual(hostRecovered);expect(readFileSync(path,"utf8")).toBe(original);expect(statSync(path).mode&0o777).toBe(0o700);
 }finally{rmSync(ctx.home,{recursive:true,force:true});}
});


test("backend destination refusal is propagated before any journal effect",async()=>{
 const f=memory(),denied=Error("owned backend refusal");
 await expect(commitInstall({...f.io,readFile:async()=>{throw denied;}},[{path:"/not-owned",before:null,after:"value"}],"manifest")).rejects.toBe(denied);
 expect(f.effects).toEqual([]);
});
