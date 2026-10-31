import {createHash,createHmac,randomBytes} from "node:crypto";
import {chmodSync,closeSync,constants,fstatSync,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,unlinkSync,writeSync} from "node:fs";
import {join} from "node:path";
import {appendActivity} from "../activity/log";
import {CoreError} from "../core/errors";
import type {Ctx} from "../types";
import {pluginRegistry} from "./index";
import {pluginsConfig} from "./config";
import {evaluatePolicy,type PolicyEvaluationOptions} from "./policy-evaluator";
import type {PolicyBeforeParams} from "./policy-protocol";
import {PolicyHashKeyError} from "./policy-key-error";

type Decision = PolicyBeforeParams["decision"];
type Input<D extends Decision> = Extract<PolicyBeforeParams,{decision:D}>["input"];
export interface ApplyPolicyOptions extends Pick<PolicyEvaluationOptions,"eligibleRunnerIds"|"allowedPlacements"|"validateDelegate"|"signal"|"deadline"|"budgetDeadline"> {
  /** Fresh synchronous task/project/candidate/authority context, checked again before effects. */
  contextFingerprint: () => string;
}

/** Canonical object ordering avoids incidental YAML key ordering changing a generation. */
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value!==null && typeof value==="object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,canonical(child)]));
  return value;
}
const fingerprint=(value:unknown)=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function readPolicyKey(ctx:Ctx,id:string):Buffer {
  const dir=join(ctx.pacerHome,"state"),path=join(dir,"policy-hmac.key");
  mkdirSync(dir,{recursive:true,mode:0o700});
  const owner=typeof process.getuid==="function"?process.getuid():undefined;
  const parent=lstatSync(dir);
  if(!parent.isDirectory()||(owner!==undefined&&parent.uid!==owner)) throw new PolicyHashKeyError("Policy hash key directory is not private");
  chmodSync(dir,0o700);
  const temp=join(dir,`policy-hmac.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let created=false;
  try {
    try {lstatSync(path);} catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") created=true;else throw error;}
    if(created) {
      const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {
        const bytes=randomBytes(32);
        for(let offset=0;offset<bytes.length;)offset+=writeSync(fd,bytes,offset,bytes.length-offset);
        fsyncSync(fd);
      } finally {closeSync(fd);}
      try {linkSync(temp,path);} catch(error) {if((error as NodeJS.ErrnoException).code!=="EEXIST") throw error;}
    }
  } finally {try {unlinkSync(temp);} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}}
  let fd:number;
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);} catch {throw new PolicyHashKeyError("Policy hash key must be a private regular file");}
  let master:Buffer;
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o777)!==0o600||(owner!==undefined&&stat.uid!==owner)||stat.size!==32) throw new PolicyHashKeyError("Policy hash key must be an owned mode-0600 regular file with 32 bytes");
    master=readFileSync(fd);
  } finally {closeSync(fd);}
  if(master.length!==32) throw new PolicyHashKeyError("Policy hash key is invalid");
  return createHmac("sha256",master).update(id).digest();
}
function policyKey(ctx:Ctx,id:string):Buffer {
  try {return readPolicyKey(ctx,id);}
  catch(error) {
    if(error instanceof PolicyHashKeyError) throw error;
    throw new PolicyHashKeyError("Policy hash key cannot be accessed safely");
  }
}
function opaque(key:Buffer,value:unknown):string {return createHmac("sha256",key).update(JSON.stringify(canonical(value))).digest("hex");}
function metadata(ctx:Ctx) {
  const registry=pluginRegistry(ctx);
  const policies=registry.policySnapshot(ctx);
  const unavailable=registry.policyUnavailable(ctx);
  const config=pluginsConfig(ctx);
  // Hashes bind the complete persisted config, grants and manifest. No runtime
  // state/PID participates: lazy first start cannot invalidate authorization.
  return {registry,mode:config.policy.mode,policies,unavailable,fingerprint:fingerprint({config,policies,unavailable})};
}

/** Cheap discovery only: no doctor, usage refresh, handshake or process start. */
export function policySummary(ctx:Ctx):{mode:"open"|"closed";plugins:number} {
  const snapshot=metadata(ctx);
  return {mode:snapshot.mode,plugins:snapshot.policies.length};
}

/** Await outside commit locks; call the returned synchronous revalidate under the final commit discipline. */
export async function applyPolicy<D extends Decision>(ctx:Ctx,decision:D,input:Input<D>,options:ApplyPolicyOptions) {
  if(typeof options.contextFingerprint!=="function") throw new CoreError("invalid_input","Policy context fingerprint is required");
  const initial=metadata(ctx);
  const capture=()=>{
    const current=metadata(ctx);
    const context=options.contextFingerprint();
    if(typeof context!=="string") throw new CoreError("invalid_input","Policy context fingerprint must be a string");
    return fingerprint({metadata:current.fingerprint,context});
  };
  const context=options.contextFingerprint();
  if(typeof context!=="string") throw new CoreError("invalid_input","Policy context fingerprint must be a string");
  const frozenFingerprint=fingerprint({metadata:initial.fingerprint,context});
  const changed=()=>{
    try {return capture()!==frozenFingerprint;}
    catch {return true;}
  };
  let contextConflict=false;
  const receipt=await evaluatePolicy({mode:initial.mode,fingerprint:frozenFingerprint,policies:initial.policies.map(policy=>({id:policy.id,generation:fingerprint(policy)})),unavailable:initial.unavailable},{decision,input},{
    ...options,
    call:(policy,params,callOptions)=>{
      if(contextConflict || capture()!==frozenFingerprint) {
        contextConflict=true;
        throw new CoreError("conflict","Policy context changed");
      }
      const entry=initial.policies.find(value=>value.id===policy.id);
      const canReadDetail=!!entry?.manifest.capabilities.some(capability=>capability.name==="tasks.read") && (entry.bundled||entry.grant?.capabilities.includes("tasks.read"));
      const key=canReadDetail||params.decision==="route"||(params.decision==="review"&&params.input.note===undefined)?null:policyKey(ctx,policy.id);
      const wire=params.decision==="delegate"&&key ? {
        ...params,
        input:{...params.input,goal:"",repo:`repo:${opaque(key,params.input.repo)}`,goalLength:params.input.goal.length,goalHash:opaque(key,params.input.goal),repoKey:opaque(key,params.input.repo)},
      } : params.decision==="review"&&key&&params.input.note!==undefined ? {
        ...params,input:{...params.input,note:undefined,noteLength:params.input.note.length,noteHash:opaque(key,params.input.note)},
      } : params;
      return initial.registry.call(ctx,policy.id,"policy.before",wire,callOptions);
    },
    onVeto:({pluginId,decision,reason})=>{
      if(contextConflict||changed()) {contextConflict=true;return;}
      appendActivity(ctx,{kind:"policy",level:"warn",text:`plugin ${pluginId}: ${decision}: ${reason}`});
    },
    onFailure:({pluginId,decision,reason})=>{
      if(contextConflict||changed()) {contextConflict=true;return;}
      appendActivity(ctx,{kind:"policy",level:"warn",text:`plugin ${pluginId}: ${decision}: ${reason}`});
    },
  }).catch(error=>{
    // A host-side generation conflict is independent of plugin failure mode.
    if(contextConflict||changed()) throw new CoreError("conflict","Policy context changed");
    throw error;
  });
  if(contextConflict) throw new CoreError("conflict","Policy context changed");
  const revalidate=()=>{
    let current:string;
    try {current=capture();}
    catch {throw new CoreError("conflict","Policy context changed");}
    receipt.revalidate(current);
  };
  revalidate();
  return {...receipt,revalidate};
}
