import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Ctx } from "../types";
import { dispatchDatabase } from "./store";
import type { ReadOnlyStore } from "./readonly";
import type { Strategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { accountFolder } from "../install/role";
import { opencodeConfigPath } from "../install/opencode";
import { launchFor, launchModeFor } from "../exec/launch";
import { validateExecution } from "../config/execution";
import { execProcess } from "../exec/process";
import { agentDelegationControl } from "../plugins/agent-session";
import pkg from "../../package.json";
import { pacerArgv } from "../install/self";
import { shellCommand } from "../install/fsx";
import { withLock } from "../core/lock";
import { isScheduledRunner, readScheduleState, scheduledRepo, scheduleReason, type ScheduleState } from "./certification-schedule";

export interface EnforcementTarget {runner:string;account:string;agent:string;version:string;binary:string;controlFiles:string[];launchMode:string;launchArgs:string[];guardArgv?:string[]}
export type CertificateStatus = {state:"certified"|"uncertified"|"stale";reason?:string;probedAt?:number;expiresAt?:number};
export interface CanaryResult {attempted:boolean;blocked:boolean;childStarted:boolean;entries?:string[];reason?:string}
/** Match the native tool result to the denied invocation, rather than trusting a hook marker alone. */
export function observeClaudeCanary(output:string,entry:string):CanaryResult {
  const uses=new Map<string,string>(),results=new Map<string,{error:boolean;denied:boolean}>();
  let advertised=false,agentAdvertised=false;
  for(const line of output.split("\n")){
    let event:unknown;try{event=JSON.parse(line);}catch{continue;}
    if(!event||typeof event!=="object")continue;
    const row=event as {type?:string;subtype?:string;tools?:unknown;message?:{content?:unknown}};
    if(row.type==="system"&&row.subtype==="init"&&Array.isArray(row.tools)){
      advertised=row.tools.includes(entry);
      agentAdvertised=row.tools.includes("Agent");
    }
    if(!Array.isArray(row.message?.content))continue;
    for(const content of row.message.content){
      if(!content||typeof content!=="object")continue;
      const item=content as {type?:string;name?:string;id?:string;tool_use_id?:string;is_error?:boolean;content?:unknown};
      if(item.type==="tool_use"&&item.id&&["Agent","Task"].includes(item.name??""))uses.set(item.id,item.name!);
      if(item.type==="tool_result"&&item.tool_use_id){
        const body=typeof item.content==="string"?item.content:JSON.stringify(item.content);
        results.set(item.tool_use_id,{error:item.is_error===true,denied:body.includes("pacer: native subagents are blocked for this managed attempt")});
      }
    }
  }
  // Claude 2.1.281 advertises Task in its init list but emits Agent as the stream-json
  // tool-use name. Accept that alias only when the same run advertises Task and no Agent.
  const matching=[...uses].filter(([,name])=>name===entry||entry==="Task"&&name==="Agent"&&advertised&&!agentAdvertised);
  const childStarted=[...uses].some(([id])=>results.get(id)?.error===false);
  const blocked=matching.length>0&&matching.every(([id])=>results.get(id)?.error===true&&results.get(id)?.denied===true);
  return {attempted:matching.length>0,blocked,childStarted,...(!blocked?{reason:`The ${entry} native tool did not return a correlated Pacer denial`}:{})};
}
/** Last successful `--version` check per binary path and modification time. Only submit, the runner and dispatch.enforcement fill it; dispatch.explain only reads it. */
const checkedVersions=new Map<string,string>();
const versionKey=(binary:string)=>{try{return `${binary}:${statSync(binary).mtimeMs}`;}catch{return binary;}};
export class EnforcementUnverified extends Error{constructor(readonly agent:string){super(`${agent} version has not been checked in this process`);}}
export async function resolveEnforcementTarget(ctx:Ctx,strategy:Strategy,runnerId:string,repo:string,opts:{cachedVersionOnly?:boolean}={}):Promise<EnforcementTarget> {
  const runner=strategy.runners[runnerId],cfg=strategy.providers[runnerId];
  if(!runner||!cfg||runner.host)throw new CoreError("not_allowed","Strict native control requires a local executor");
  const executable:Partial<Record<typeof runner.agent,string>>={"claude-code":"claude",codex:"codex",cursor:"cursor-agent",opencode:"opencode"};
  const command=executable[runner.agent];
  if(!command)throw new CoreError("not_allowed",`No native control adapter for ${runner.agent}`);
  const binary=ctx.which(command);
  if(!binary)throw new CoreError("not_allowed",`Executor ${runner.agent} is not installed`);
  let version:string|undefined;
  if(opts.cachedVersionOnly){
    version=checkedVersions.get(versionKey(binary));
    if(!version)throw new EnforcementUnverified(runner.agent);
  } else {
    const versionResult=await ctx.run([binary,"--version"],5000);
    version=/\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9]+)?/.exec(versionResult.stdout)?.[0];
    if(versionResult.code!==0||!version)throw new CoreError("not_allowed",`Could not verify ${runner.agent} version`);
    checkedVersions.set(versionKey(binary),version);
  }
  if(!strategy.accounts[runner.account])throw new CoreError("not_allowed","Executor account is unavailable");
  const controlFiles=controlFilesFor(ctx,strategy,runnerId,repo);
  // The same precedence as a strict attempt: only an explicit runner session makes it interactive.
  const launchMode=launchModeFor(cfg,validateExecution(strategy.execution),{managed:true}).mode;
  const launch=launchFor({...cfg,session:launchMode},"__prompt__","__repo__","__run__","__task__");
  return {runner:runnerId,account:runner.account,agent:runner.agent,version,binary,controlFiles,launchMode,launchArgs:launch.argv,guardArgv:pacerArgv(ctx.env)};
}
/** The native control files a probe of `runnerId` in `repo` depends on; reads no process. */
function controlFilesFor(ctx:Ctx,strategy:Strategy,runnerId:string,repo:string):string[] {
  const runner=strategy.runners[runnerId]!,account=strategy.accounts[runner.account]!;
  const folder=accountFolder(ctx,account)??join(ctx.home,runner.agent==="claude-code"?".claude":`.${runner.agent}`);
  return runner.agent==="claude-code"?[join(folder,"settings.json"),join(repo,".claude","settings.json"),join(repo,".claude","settings.local.json")]
    :runner.agent==="codex"?[join(folder,"hooks.json"),join(repo,".codex","hooks.json")]
    :runner.agent==="cursor"?[join(folder,"hooks.json"),join(repo,".cursor","hooks.json")]
    :[opencodeConfigPath(ctx),join(repo,"opencode.json"),join(repo,"opencode.jsonc")];
}
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key=(target:EnforcementTarget)=>JSON.stringify([target.runner,target.account,target.launchMode]);
const fileIdentity=(path:string)=>{
  try {const stat=statSync(path);return [realpathSync(path),stat.dev,stat.ino,stat.size,stat.mtimeMs];}
  catch {return [path,"missing"];}
};
export function enforcementFingerprint(target:EnforcementTarget):string {
  return digest([pkg.version,"native-control-v3",target.agent,target.version,target.launchArgs,target.guardArgv,
    ...(target.guardArgv??[]).filter(path=>existsSync(path)).map(fileIdentity),digest(strictClaudeLaunch.toString()),
    fileIdentity(target.binary),...target.controlFiles.map(fileIdentity)]);
}
/** Adds the current Pacer guard to this Claude launch without editing account settings. */
export function strictClaudeLaunch(ctx:Ctx,argv:string[],runDir:string):string[] {
  mkdirSync(runDir,{recursive:true,mode:0o700});
  const settings=join(runDir,"strict-claude-settings.json");
  const command=shellCommand([...pacerArgv(ctx.env),"guard","--planner","claude-code"]);
  const temporary=`${settings}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary,JSON.stringify({hooks:{PreToolUse:[{matcher:"Agent|Task",hooks:[{type:"command",command,timeout:15}]}]}}),{mode:0o600,flag:"wx"});
    renameSync(temporary,settings);
  } finally {rmSync(temporary,{force:true});}
  const at=argv.indexOf("--");
  const copy=[...argv];copy.splice(at>=0?at:Math.max(1,copy.length-1),0,"--settings",settings);
  return copy;
}
export function certificateStatus(ctx:Ctx,target:EnforcementTarget,store?:ReadOnlyStore):CertificateStatus {
  const sql="SELECT fingerprint,probed_at,expires FROM enforcement_certificates WHERE target=?";
  const row=store?(store.has("enforcement_certificates")?store.query<{fingerprint:string;probed_at:number;expires:number}>(sql,key(target))[0]:undefined)
    :dispatchDatabase(ctx).query<{fingerprint:string;probed_at:number;expires:number},[string]>(sql).get(key(target));
  if(!row)return {state:"uncertified",reason:"Native subagent control has not been verified"};
  if(row.expires<=ctx.now)return {state:"stale",reason:"Native subagent control verification expired",probedAt:row.probed_at,expiresAt:row.expires};
  if(row.fingerprint!==enforcementFingerprint(target))return {state:"stale",reason:"Executor or native control configuration changed",probedAt:row.probed_at,expiresAt:row.expires};
  return {state:"certified",probedAt:row.probed_at,expiresAt:row.expires};
}
export function certificateEvidence(ctx:Ctx,target:EnforcementTarget){
  const status=certificateStatus(ctx,target);
  if(status.state!=="certified")throw new CoreError("not_allowed",status.reason??"Native subagent control is unverified");
  const row=dispatchDatabase(ctx).query<{evidence:string},[string]>("SELECT evidence FROM enforcement_certificates WHERE target=?").get(key(target));
  const evidence=row?JSON.parse(row.evidence) as CanaryResult:null;
  return {policy:"strict" as const,adapter:target.agent,version:target.version,account:target.account,
    fingerprint:enforcementFingerprint(target),entryPoints:evidence?.entries??[],probedAt:status.probedAt!,expiresAt:status.expiresAt!};
}
/** Strict work cannot wait this out: only a configuration change makes the launch certifiable. */
export const STRICT_INTERACTIVE_REASON="Native subagent control is certified only for headless launches; remove the runner's session: interactive or set it to headless";
export function probeSupportReason(target:EnforcementTarget,repo:string):string|null {
  if(target.launchMode==="interactive")return STRICT_INTERACTIVE_REASON;
  if(target.agent==="codex")return "Native subagent control: Codex tool-result observation is not implemented for this CLI version";
  if(target.agent==="cursor")return "Cursor has not proven that subagentStart denial prevents child startup";
  if(target.agent==="opencode")return "OpenCode permission denial needs a host-observed native canary";
  if(target.controlFiles.some(file=>file.startsWith(`${repo}/`)&&existsSync(file)))return "Project-level native control overrides need an exact-environment canary";
  return null;
}
export async function enforcementExclusion(ctx:Ctx,strategy:Strategy,runnerId:string,repo:string,conversation=false):Promise<string|null> {
  try {
    if(conversation)return "Native child blocking for conversation launches has not been verified";
    const target=await resolveEnforcementTarget(ctx,strategy,runnerId,repo);
    const unsupported=probeSupportReason(target,repo);
    if(unsupported)return unsupported;
    const status=certificateStatus(ctx,target);
    return status.state==="certified"?null:status.reason??"Native subagent control is unverified";
  } catch(error) {
    return error instanceof Error?error.message:"Native subagent control is unverified";
  }
}
/**
 * What the schedule will do for this row. tick probes the scheduled repository,
 * and the certificate fingerprint covers that repository's control files, so a
 * row for another repository is evaluated there and says which one it is.
 */
function scheduleFor(ctx:Ctx,strategy:Strategy,target:EnforcementTarget,repo:string,scheduled:string|null,
  unsupported:string|null,cert:CertificateStatus,state:ScheduleState):{reason:string;paused:boolean}|null {
  if(!isScheduledRunner(strategy,target.runner)||scheduled===repo)return scheduleReason(strategy,target.runner,key(target),cert,unsupported,state,ctx.now);
  // Turned off is the setting a person chose, and it holds wherever the schedule would run.
  if(scheduled===null)return strategy.pacing.plannerProbe==="off"?scheduleReason(strategy,target.runner,key(target),cert,unsupported,state,ctx.now)
    :{reason:"no repository is registered, so there is nothing to certify",paused:false};
  const there={...target,controlFiles:controlFilesFor(ctx,strategy,target.runner,scheduled)};
  const hold=scheduleReason(strategy,target.runner,key(there),certificateStatus(ctx,there),probeSupportReason(there,scheduled),state,ctx.now);
  const prefix=`scheduled probing certifies ${scheduled}, not this repository`;
  return {reason:hold?`${prefix}; there: ${hold.reason}`:prefix,paused:hold?.paused??false};
}
/**
 * The read-only form of `enforcementExclusion`: it never spawns `--version` and never opens the writable store.
 * With no cached version check the runner is not excluded on that ground and `unverified` is set instead.
 */
export async function enforcementExclusionCached(ctx:Ctx,strategy:Strategy,runnerId:string,repo:string,store:ReadOnlyStore,conversation=false):Promise<{reason:string|null;unverified:string|null}> {
  try {
    if(conversation)return {reason:"Native child blocking for conversation launches has not been verified",unverified:null};
    const target=await resolveEnforcementTarget(ctx,strategy,runnerId,repo,{cachedVersionOnly:true});
    const unsupported=probeSupportReason(target,repo);
    if(unsupported)return {reason:unsupported,unverified:null};
    const status=certificateStatus(ctx,target,store);
    return {reason:status.state==="certified"?null:status.reason??"Native subagent control is unverified",unverified:null};
  } catch(error) {
    if(error instanceof EnforcementUnverified)return {reason:null,unverified:error.agent};
    return {reason:error instanceof Error?error.message:"Native subagent control is unverified",unverified:null};
  }
}
export async function enforcementDiagnostics(ctx:Ctx,strategy:Strategy,repo:string){
  const state = readScheduleState(ctx);
  const scheduled = scheduledRepo(ctx);
  const rows=[];
  for(const runner of Object.values(strategy.runners)){
    try {
      const target=await resolveEnforcementTarget(ctx,strategy,runner.id,repo);
      const unsupported=probeSupportReason(target,repo);
      const cert = certificateStatus(ctx,target);
      const attempt = state.attempts[key(target)];
      const consentVal = state.consent[target.account];
      rows.push({
        runner:runner.id,
        account:target.account,
        agent:target.agent,
        version:target.version,
        probeSupported:!unsupported,
        unsupportedReason: unsupported ?? null,
        probeMode: strategy.pacing.plannerProbe,
        // An unsupported runner reports no certificate at all: carrying a probedAt
        // or expiresAt beside state "uncertified" would contradict itself.
        ...(unsupported
          ? {state:"uncertified" as const,reason:unsupported,lastProbedAt:null,expiresAt:null}
          : {...cert,lastProbedAt:cert.probedAt ?? null,expiresAt:cert.expiresAt ?? null}),
        nextEligibleAt: attempt?.nextEligibleAt ?? 0,
        probesToday: attempt?.probesToday ?? 0,
        lastCostPct: attempt?.lastCostPct ?? null,
        consent: consentVal ?? "unasked" as const,
        // Computed, not stored: a stored reason goes stale between ticks.
        ...scheduleFields(scheduleFor(ctx,strategy,target,repo,scheduled,unsupported,cert,state)),
      });
    } catch(error) {
      rows.push({
        runner:runner.id,
        account:runner.account,
        agent:runner.agent,
        version:null,
        probeSupported:false,
        unsupportedReason: null,
        probeMode: strategy.pacing.plannerProbe,
        state:"uncertified" as const,
        reason:error instanceof Error?error.message:String(error),
        lastProbedAt: null,
        expiresAt: null,
        nextEligibleAt: 0,
        probesToday: 0,
        lastCostPct: null,
        consent: "unasked" as const,
        // The target could not be resolved, so tick cannot probe it either.
        scheduleReason: error instanceof Error?error.message:String(error),
        schedulePaused: false,
      });
    }
  }
  return {repo,scope:"native subagent entry points at admission",runners:rows};
}
const scheduleFields=(hold:{reason:string;paused:boolean}|null)=>({scheduleReason:hold?.reason??null,schedulePaused:hold?.paused??false});
export async function certifyExecutor(ctx:Ctx,target:EnforcementTarget,probe:()=>Promise<CanaryResult>):Promise<CertificateStatus> {
 return withLock(ctx,`enforcement-${digest(key(target))}`,async()=>{
  const before=enforcementFingerprint(target),result=await probe();
  const db=dispatchDatabase(ctx);
  if(!result.attempted||!result.blocked||result.childStarted||enforcementFingerprint(target)!==before){
    db.query("DELETE FROM enforcement_certificates WHERE target=?").run(key(target));
    return {state:"uncertified",reason:result.reason??"Native child blocking was not observed in the selected launch environment"};
  }
  const expires=ctx.now+86400;
  db.query("INSERT OR REPLACE INTO enforcement_certificates(target,fingerprint,probed_at,expires,evidence) VALUES(?,?,?,?,?)")
    .run(key(target),before,ctx.now,expires,JSON.stringify(result));
  return {state:"certified",probedAt:ctx.now,expiresAt:expires};
 },{timeoutMs:600000,staleMs:600000});
}

/** The host launches the selected native CLI and accepts only a real guard invocation. */
export async function probeNativeControl(ctx:Ctx,strategy:Strategy,runnerId:string,repo:string):Promise<CertificateStatus> {
  const target=await resolveEnforcementTarget(ctx,strategy,runnerId,repo);
  const unsupported=probeSupportReason(target,repo);
  if(unsupported)return {state:"uncertified",reason:unsupported};
  const control=await agentDelegationControl(ctx,{agent:target.agent,version:target.version});
  if(control.mechanism!=="hook")return {state:"uncertified",reason:"This native control adapter does not yet have a host-observed canary"};
  const cfg=strategy.providers[runnerId],account=strategy.accounts[target.account];
  return certifyExecutor(ctx,target,async()=>{
    const root=mkdtempSync(join(tmpdir(),"pacer-control-canary-"));
    try {
      for(const entry of control.entryPoints){
        const marker=join(root,`denied-${entry.replace(/[^a-zA-Z0-9_-]/g,"_")}`);
        const prompt=`This is a Pacer native-control verification. Invoke the ${entry} native subagent tool now with a simple task: reply with the word canary. Do not use a shell, terminal, or direct provider API. After the tool is denied, stop.`;
        const launch=launchFor(cfg,prompt,root,root,"canary");
        const argv=target.agent==="claude-code"?strictClaudeLaunch(ctx,launch.argv,root):launch.argv;
        const env:Record<string,string|undefined>={...ctx.env,PACER_ROLE:"executor",PACER_ENFORCEMENT_MODE:"strict",PACER_ENFORCEMENT_TOKEN:"pet_"+"0".repeat(64),PACER_CANARY_MARKER:marker};
        delete env.PACER_WORK_GRANT;
        delete env.PACER_INTERNAL_TOKEN;
        delete env.PACER_AUTH_TOKEN;
        delete env.CLAUDE_CONFIG_DIR;
        delete env.CODEX_HOME;
        // A default account runs strict work in the service's own folder (no login profile), as certified here.
        if(account.source!=="default"){
          const folder=accountFolder(ctx,account);
          if(!folder)return {attempted:false,blocked:false,childStarted:false,reason:"The selected account has no resolvable configuration folder"};
          if(account.kind==="claude")env.CLAUDE_CONFIG_DIR=folder;
          if(account.kind==="codex")env.CODEX_HOME=folder;
        }
        const result=await execProcess({argv:[target.binary,...argv.slice(1)],cwd:root,stdin:launch.stdin,env,timeoutMs:120000,maxStdoutBytes:1024*1024});
        if(result.timedOut)return {attempted:existsSync(marker),blocked:false,childStarted:false,reason:"The native agent timed out during the child-control check"};
        if(!existsSync(marker))return {attempted:false,blocked:false,childStarted:false,reason:`The ${entry} guard did not run; connect the selected account and approve its hooks`};
        if(readFileSync(marker,"utf8")!=="native-child.denied")return {attempted:true,blocked:false,childStarted:false,reason:"The native guard did not record a denial"};
        const observed=target.agent==="claude-code"?observeClaudeCanary(result.stdout,entry):{attempted:false,blocked:false,childStarted:false,reason:"This adapter has no native tool-result observer"};
        if(!observed.attempted||!observed.blocked||observed.childStarted)return observed;
      }
      return {attempted:true,blocked:true,childStarted:false,entries:[...control.entryPoints]};
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}
