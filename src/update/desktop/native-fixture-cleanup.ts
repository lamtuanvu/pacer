/** Fixed compiled-fixture diagnostic. Never an API operation or production authority. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { makeCtx } from "../../ctx";
import { CoreError } from "../../core/errors";
import { parseDesktopServiceRegistration } from "../../service";
import { reserveIdle } from "./admission";
import { withDesktopCoordinator } from "./coordinator";
import { compiledNativeFixture, compiledNativeFixtureSha256, verifyNativeFixture } from "./native-fixture";
import { DarwinAuthority, enumerateNativeProcesses } from "./native-os";
import { nativeProcessSchema, privateNativeBytes, sameNativeValue } from "./native-record";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "./process-identity";
const denied = () => new CoreError("not_allowed", "Fixture startup cleanup proof is unavailable");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const diagnosticsSchema = z.object({schema:z.literal(1),policySha256:hash,cliSha256:hash,helperSha256:hash,nativeShimSha256:hash.optional()}).strict();
export function startupCleanupIncarnations(value: unknown): ProcessIdentity[] {
  const record=z.object({exercise:z.null(),runtime:z.object({schema:z.literal(1),state:z.literal("starting"),request:z.null(),driver:nativeProcessSchema,sourceService:nativeProcessSchema,desktop:nativeProcessSchema}).strict()}).passthrough().parse(value);
  const identities=[record.runtime.driver,record.runtime.sourceService,record.runtime.desktop];
  if(new Set(identities.map(p=>p.pid)).size!==3)throw denied();
  return identities;
}
function privateDirectory(path:string) {
 const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.mode&0o077||realpathSync(path)!==path)throw denied();
}
function binaryDigest(path:string):string {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd);if(!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||before.mode&0o077||before.size>512*1024*1024)throw denied();
  const digest=createHash("sha256"),buffer=Buffer.alloc(65536);let total=0,count;
  while((count=readSync(fd,buffer,0,buffer.length,null))>0){total+=count;if(total>512*1024*1024)throw denied();digest.update(buffer.subarray(0,count));}
  const after=fstatSync(fd),pathStat=lstatSync(path);
  if(total!==before.size||after.ino!==before.ino||after.mtimeMs!==before.mtimeMs||pathStat.ino!==before.ino||pathStat.dev!==before.dev)throw denied();
  return digest.digest("hex");
 } finally {closeSync(fd);}
}
function exited(identity:ProcessIdentity):boolean {
 const current=processIdentity(identity.pid);
 if(current)return !sameProcess(current,identity);
 try {process.kill(identity.pid,0);return false;}catch(error){return(error as NodeJS.ErrnoException).code==="ESRCH";}
}
export async function reserveFixtureStartupCleanup() {
 const policy=compiledNativeFixture(),authority=DarwinAuthority.configured(),own=ownProcessIdentity();
 if(!policy||!authority||!own)throw denied();
 const reservationId=`fixture-cleanup-${policy.nonce}`,directory=join(policy.root,"diagnostics"),cli=join(directory,"pacer-startup-cleanup"),helper=join(directory,"pacer-update-helper");
 const ctx=makeCtx({home:policy.home,pacerHome:policy.home,env:{HOME:policy.home,PACER_HOME:policy.home,PACER_PORT:String(policy.port),PATH:"/usr/bin:/bin:/usr/sbin:/sbin"}});
 const verify=()=>{
  verifyNativeFixture(policy);privateDirectory(directory);
  const record=JSON.parse(privateNativeBytes(join(policy.root,"record.json")).toString());
  const descriptor=diagnosticsSchema.parse(JSON.parse(privateNativeBytes(join(directory,"build.json")).toString()));
  const files=["build.json","pacer-startup-cleanup","pacer-update-helper",...(descriptor.nativeShimSha256?["libpacer-native.dylib"]:[])];
  if(readdirSync(directory).sort().join("\n")!==files.sort().join("\n"))throw denied();
  if(descriptor.nativeShimSha256){const shim=join(directory,"libpacer-native.dylib");if(binaryDigest(shim)!==descriptor.nativeShimSha256)throw denied();authority.verifyNativeShim(shim);}
  if(!sameNativeValue(descriptor,diagnosticsSchema.parse(record.diagnostics))||descriptor.policySha256!==compiledNativeFixtureSha256()||binaryDigest(cli)!==descriptor.cliSha256||binaryDigest(helper)!==descriptor.helperSha256)throw denied();
  if(realpathSync(process.execPath)!==cli)throw denied();
  authority.verifyProcess(own,"cli");authority.verifyStatic(cli,"cli");authority.verifyStatic(helper,"helper");
  const parent=processIdentity(process.ppid);if(!parent||authority.verifyProcess(parent,"helper").executable!==helper)throw denied();
  for(const identity of startupCleanupIncarnations(record))if(identity.bootId!==own.bootId||!exited(identity))throw denied();
  if(enumerateNativeProcesses().some(p=>p.executable===join(policy.currentApp,"Contents/MacOS/pacer")))throw denied();
  authority.verifyStatic(policy.currentApp,"desktop");authority.verifyStatic(join(policy.currentApp,"Contents/Resources/pacer"),"cli");
  const rows=z.array(z.object({label:z.string(),path:z.string(),sha256:hash.nullable(),state:z.string(),processes:z.array(nativeProcessSchema)}).strict()).length(2).parse(record.registrations);
  const row=rows.find(r=>r.label===policy.serviceLabel),recovery=rows.find(r=>r.label===policy.recoveryLabel);
  const path=join(policy.root,"registrations",policy.serviceLabel+".plist");
  if(!row||row.path!==path||!["loaded","intent"].includes(row.state)||!recovery||recovery.state!=="reserved"||recovery.sha256!==null||recovery.processes.length)throw denied();
  const bytes=privateNativeBytes(path);if(createHash("sha256").update(bytes).digest("hex")!==row.sha256)throw denied();
  const registration=parseDesktopServiceRegistration(bytes.toString(),policy.serviceLabel);
  if(!sameNativeValue(registration.argv,[join(policy.currentApp,"Contents/Resources/pacer"),"serve"])||registration.home!==policy.home||registration.pacerHome!==policy.home||registration.port!==policy.port)throw denied();
  const updates=join(policy.home,"desktop-updates");privateDirectory(updates);
  if(readdirSync(updates).some(name=>!["admission.sqlite","admission.sqlite-journal"].includes(name)))throw denied();
  privateNativeBytes(join(updates,"admission.sqlite"));
  withDesktopCoordinator(ctx,db=>{
   const tables=db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all();
   for(const table of tables){
    if(table.name==="desktop_adoptions"){if(db.query("SELECT 1 FROM desktop_adoptions LIMIT 1").get())throw denied();}
    else if(table.name!=="admission")throw denied();
   }
   if(tables.some(t=>t.name==="admission")){
    const row=db.query<{state:string},[]>("SELECT state FROM admission WHERE id=1").get();
    if(row){const state=JSON.parse(row.state);if(state.schema!==1||!Array.isArray(state.leases)||state.leases.length||![null,reservationId].includes(state.reservation))throw denied();}
   }
  });
 };
 verify();
 const result=await reserveIdle(ctx,reservationId);if(!result.reserved||result.blockers.length)throw denied();
 verify();
 return {schema:1,kind:"fixture-startup-cleanup",nonce:policy.nonce,policySha256:compiledNativeFixtureSha256(),reservationId};
}
