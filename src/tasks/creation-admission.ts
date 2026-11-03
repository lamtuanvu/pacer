import {CoreError} from "../core/errors";
import {repoFs,withTimeout} from "../core/path-probe";
import type {Ctx} from "../types";
import type {PolicyBeforeParams} from "../plugins/policy-protocol";
import {withTaskPreparation} from "./store";

type CreationInput=Extract<PolicyBeforeParams,{decision:"delegate"}>["input"];
interface CreationAdmissionOptions {
  contextFingerprint:()=>string;
  /** Each caller keeps its actual existing eligibility rules; no fallback strategy. */
  validateCurrent:(input:Readonly<CreationInput>,policyCount:number)=>void;
  validateAmend:(input:Readonly<CreationInput>)=>boolean;
  strictAmendments?:boolean;
  eligibleRunnerIds?:readonly string[];
  allowedPlacements?:readonly CreationInput["placement"][];
  additionalDirectories?:readonly string[];
  taskLock?:string;
  /** Bounded host artifact reads only; policy has already finished. */
  validateArtifacts?:()=>Promise<void>;
  signal?:AbortSignal;
  deadline?:number;
}

/** Trusted request lifetime; explicit child bounds can only tighten it. */
export function admissionLifetime(ctx:Ctx,signal?:AbortSignal,deadline?:number) {
  const signals=[ctx.operation?.signal,signal].filter((value):value is AbortSignal=>value!==undefined);
  const deadlines=[ctx.operation?.deadline,deadline].filter((value):value is number=>value!==undefined);
  if(deadlines.some(value=>!Number.isFinite(value)))throw new CoreError("invalid_input","Admission deadline must be finite");
  return {signal:signals.length>1?AbortSignal.any(signals):signals[0],deadline:deadlines.length?Math.min(...deadlines):undefined};
}

/** Shared creation/restart policy receipt and final artifact/commit boundary.
 * Policy always finishes before any existing-task file lock is acquired. */
export async function prepareCreationAdmission(ctx:Ctx,input:CreationInput,options:CreationAdmissionOptions) {
  const {applyPolicy,policySummary}=await import("../plugins/policy");
  options.validateCurrent(input,policySummary(ctx).plugins);
  const directories=[...new Set([input.repo,...(options.additionalDirectories??[])])];
  const directorySnapshot=()=>Promise.all(directories.map(async path=>{
    let stat:Awaited<ReturnType<typeof repoFs.stat>>;
    try {stat=await withTimeout(()=>repoFs.stat(path));}
    catch(error) {
      if(["ENOENT","ENOTDIR"].includes((error as NodeJS.ErrnoException).code??"")) throw new CoreError("invalid_input",`repo does not exist: ${path}`);
      throw new CoreError("invalid_input",`repo folder is not responding: ${path}`);
    }
    if(!stat.isDirectory()) throw new CoreError("invalid_input","Admission checkout is not a directory");
    return [stat.dev,stat.ino,stat.isDirectory()];
  }));
  const originalDirectory=await directorySnapshot();
  const verifyDirectories=async()=>{
    let current:Awaited<ReturnType<typeof directorySnapshot>>;
    try {current=await directorySnapshot();}
    catch {throw new CoreError("conflict","Repository became unavailable during delegation admission");}
    if(JSON.stringify(current)!==JSON.stringify(originalDirectory)) throw new CoreError("conflict","Repository changed during delegation admission");
  };
  const receipt=await applyPolicy(ctx,"delegate",input,{
    contextFingerprint:options.contextFingerprint,eligibleRunnerIds:options.eligibleRunnerIds,allowedPlacements:options.allowedPlacements,
    validateDelegate:options.validateAmend,strictAmendments:options.strictAmendments,...admissionLifetime(ctx,options.signal,options.deadline),
  });
  if(receipt.params.decision!=="delegate") throw new CoreError("invalid_input","Invalid creation policy receipt");
  const authorized=structuredClone(receipt.params.input),policyCount=receipt.snapshot.policies.length;
  await verifyDirectories();receipt.revalidate();options.validateCurrent(authorized,policyCount);
  let used=false;
  return {
    input:structuredClone(authorized),policies:policyCount,
    /** Early preparation guard only; final effects still require consume. */
    revalidate:()=>{receipt.revalidate();options.validateCurrent(authorized,policyCount);},
    async consume<T>(effect:(permit:{input:Readonly<CreationInput>;revalidate:()=>void})=>T):Promise<T> {
      if(used) throw new CoreError("conflict","Delegation admission was already consumed");
      if(effect.constructor.name==="AsyncFunction") throw new CoreError("invalid_input","Admission effect must be synchronous");
      used=true;
      const prepare=async()=>{await options.validateArtifacts?.();await verifyDirectories();receipt.revalidate();options.validateCurrent(authorized,policyCount);};
      const perform=()=>{
        let inside=true;
        const guard=()=>{
          if(!inside) throw new CoreError("conflict","Admission effect is no longer active");
          receipt.revalidate();options.validateCurrent(authorized,policyCount);
        };
        try {
          guard();
          const result=effect({input:structuredClone(authorized),revalidate:guard});
          if(result!==null&&(typeof result==="object"||typeof result==="function")&&typeof (result as {then?:unknown}).then==="function") throw new CoreError("invalid_input","Admission effect must be synchronous");
          return result;
        } finally {inside=false;}
      };
      if(options.taskLock) return withTaskPreparation(ctx,options.taskLock,prepare,perform);
      await prepare();return perform();
    },
  };
}
