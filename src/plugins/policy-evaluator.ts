import {CoreError} from "../core/errors";
import {PolicyHashKeyError} from "./policy-key-error";
import {policyBeforeParams, policyDelegateAmend, policyRouteAmend, policyVerdict, type PolicyBeforeParams} from "./policy-protocol";

const MAX_BYTES = 1024 * 1024;
const POLICY_AGGREGATE_MS = 10_000;
export interface PolicyIdentity { readonly id: string; readonly generation: string }
export interface PolicySnapshot {
  readonly mode: "open" | "closed";
  /** Adapter fingerprint includes mode, manifest, grants and config generations. */
  readonly fingerprint: string;
  /** All configured enabled policy plugins, including unavailable processes. */
  readonly policies: readonly PolicyIdentity[];
  /** Granted, non-disabled policy plugins that cannot be loaded; closed mode refuses while any is listed. */
  readonly unavailable?: readonly {readonly id: string; readonly reason: string}[];
}
type DelegateInput = Extract<PolicyBeforeParams, {decision:"delegate"}>["input"];
export interface PolicyEvaluationOptions {
  call(policy: PolicyIdentity, params: PolicyBeforeParams, options: {signal: AbortSignal; deadlineMs: number}): Promise<unknown>;
  eligibleRunnerIds?: readonly string[];
  allowedPlacements?: readonly DelegateInput["placement"][];
  /** Pure synchronous project/executor/placement constraint check; false rejects amendment. */
  validateDelegate?: (input: Readonly<DelegateInput>) => boolean;
  signal?: AbortSignal;
  /** Absolute wall-clock deadline shared with the outer operation. */
  deadline?: number;
  /** Shared policy budget for a queue drain; expiry skips later policies in open mode. */
  budgetDeadline?: number;
  now?: () => number;
  onVeto?: (event: {pluginId:string; decision:PolicyBeforeParams["decision"]; reason:string}) => void;
  /** Open mode ignored a failed or unavailable policy; the sink records a trace. */
  onFailure?: (event: {pluginId:string; decision:PolicyBeforeParams["decision"]; reason:string}) => void;
}
function failureReason(error:unknown):string {
  const text=error instanceof CoreError?`${error.code}: ${error.message}`:error instanceof Error?error.message:"invalid verdict";
  return text.length>200?text.slice(0,200)+"…":text;
}

function boundedClone<T>(value:T):T {
  const serialized=JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized)>MAX_BYTES) throw new CoreError("too_large", "Policy decision exceeds transport limit");
  return JSON.parse(serialized) as T;
}
export function freezePolicySnapshot(source:PolicySnapshot):PolicySnapshot {
  const copy=boundedClone(source);
  if (!(["open","closed"] as const).includes(copy.mode) || typeof copy.fingerprint!=="string" || !copy.fingerprint || !Array.isArray(copy.policies)) throw new CoreError("invalid_input","Invalid policy snapshot");
  const ids=new Set<string>();
  const policies=copy.policies.map(p=>{
    if(typeof p.id!=="string" || !p.id || p.id.length>128 || typeof p.generation!=="string" || !p.generation || ids.has(p.id)) throw new CoreError("invalid_input","Invalid policy identity");
    ids.add(p.id);
    return Object.freeze({id:p.id,generation:p.generation});
  }).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  if(copy.unavailable!==undefined && (!Array.isArray(copy.unavailable) || copy.unavailable.some(u=>typeof u?.id!=="string" || !u.id || typeof u.reason!=="string"))) throw new CoreError("invalid_input","Invalid policy snapshot");
  const unavailable=(copy.unavailable??[]).map(u=>Object.freeze({id:u.id,reason:u.reason}));
  return Object.freeze({mode:copy.mode,fingerprint:copy.fingerprint,policies:Object.freeze(policies),unavailable:Object.freeze(unavailable)});
}
function checkCancelled(signal?:AbortSignal) {
  if(signal?.aborted) throw new CoreError("not_allowed","Policy operation cancelled");
}
async function invoke(policy:PolicyIdentity,params:PolicyBeforeParams,options:PolicyEvaluationOptions,deadlineMs:number):Promise<unknown> {
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  let cancel:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{
    cancel=()=>{controller.abort();reject(new CoreError("not_allowed","Policy operation cancelled"));};
    options.signal?.addEventListener("abort",cancel,{once:true});
    timer=setTimeout(()=>{controller.abort();reject(new CoreError("plugin_timeout","Policy call timed out"));},deadlineMs);
  });
  try {
    checkCancelled(options.signal);
    return await Promise.race([Promise.resolve().then(()=>{
      checkCancelled(options.signal);
      checkCancelled(controller.signal);
      return options.call(policy,boundedClone(params),{signal:controller.signal,deadlineMs});
    }),stopped]);
  } finally {
    if(timer!==undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort",cancel);
    controller.abort();
  }
}

/** No state writes or locks: callers must revalidate the receipt immediately before final effects. */
export async function evaluatePolicy(source:PolicySnapshot,input:unknown,options:PolicyEvaluationOptions) {
  const snapshot=freezePolicySnapshot(source);
  let params:PolicyBeforeParams;
  try {params=policyBeforeParams.parse(input);}
  catch(error) {if(error instanceof CoreError) throw error;throw new CoreError("invalid_input","Invalid policy decision input");}
  const excludedBy:Record<string,string>=Object.create(null);
  const now=options.now??Date.now;
  const aggregateDeadline=Math.min(options.deadline??Infinity,options.budgetDeadline??Infinity,now()+POLICY_AGGREGATE_MS);
  const eligibleRunnerIds=options.eligibleRunnerIds ? [...options.eligibleRunnerIds] : undefined;
  const allowedPlacements=options.allowedPlacements ? [...options.allowedPlacements] : undefined;
  const veto=(policy:PolicyIdentity,reason:string):never=>{
    // Activity sinks cannot replace or suppress the authoritative denial.
    try {options.onVeto?.({pluginId:policy.id,decision:params.decision,reason});} catch { /* Denial still propagates. */ }
    throw new CoreError("not_allowed",reason,`plugin ${policy.id}`);
  };
  const ignored=(policy:{id:string},reason:string)=>{
    try {options.onFailure?.({pluginId:policy.id,decision:params.decision,reason});} catch { /* Tracing never changes the decision. */ }
  };
  for(const missing of snapshot.unavailable??[]) {
    const reason=`Granted plugin ${missing.id} cannot be verified (${missing.reason})`;
    if(snapshot.mode==="closed") veto({id:missing.id,generation:""},reason);
    ignored(missing,reason);
  }
  for(const policy of snapshot.policies) {
    checkCancelled(options.signal);
    let explicitVeto:string|undefined;
    try {
      const remaining=Math.min(3000,aggregateDeadline-now());
      if(remaining<=0) throw new CoreError("plugin_timeout",`Policy ${policy.id} skipped: shared deadline expired`);
      const raw=await invoke(policy,params,options,remaining);
      checkCancelled(options.signal);
      const verdict=policyVerdict.parse(boundedClone(raw));
      if(verdict.verdict==="veto") explicitVeto=verdict.reason??"Policy vetoed decision";
      if(verdict.verdict==="amend") {
        if(params.decision==="review") throw Error("Review amendments are forbidden");
        if(params.decision==="delegate") {
          const amend=policyDelegateAmend.parse(verdict.amend);
          // Policy may only restrict: routing stays host-owned and isolation never weakens.
          if(amend.requestedExecutor!==undefined && amend.requestedExecutor!==params.input.requestedExecutor) throw Error("Executor amendments are refused: the host chooses the executor");
          if(amend.placement!==undefined && amend.placement!==params.input.placement && amend.placement!=="new") throw Error("Placement amendments may only move to an isolated worktree");
          const next={...params.input,...amend};
          if(amend.requestedExecutor!==undefined && amend.requestedExecutor!==null && !eligibleRunnerIds?.includes(amend.requestedExecutor)) throw Error("Executor is not eligible");
          if(amend.placement!==undefined && !allowedPlacements?.includes(amend.placement)) throw Error("Placement is not eligible");
          const changed=next.kind!==params.input.kind || next.requestedExecutor!==params.input.requestedExecutor || next.placement!==params.input.placement;
          if(changed && (!options.validateDelegate || !options.validateDelegate(Object.freeze({...next})))) throw Error("Delegate amendment is not eligible");
          params=policyBeforeParams.parse(boundedClone({decision:"delegate",input:next}));
        } else {
          const amend=policyRouteAmend.parse(verdict.amend);
          if(amend.exclude.some(id=>!params.input || params.decision!=="route" || !params.input.candidates.includes(id))) throw Error("Unknown candidate exclusion");
          const removed=new Set(amend.exclude);
          const next=policyBeforeParams.parse(boundedClone({decision:"route",input:{...params.input,candidates:params.input.candidates.filter(id=>!removed.has(id))}}));
          for(const id of removed) excludedBy[id]=policy.id;
          params=next;
        }
      }
    } catch(error) {
      checkCancelled(options.signal);
      if(error instanceof PolicyHashKeyError) throw new CoreError("not_allowed",error.message);
      if(snapshot.mode==="closed") veto(policy,"Policy decision failed");
      ignored(policy,`Policy decision failed and was ignored in open mode (${failureReason(error)})`);
    }
    if(explicitVeto!==undefined) veto(policy,explicitVeto);
  }
  checkCancelled(options.signal);
  return {
    params:policyBeforeParams.parse(params),excludedBy:{...excludedBy},snapshot,
    /** Synchronous final commit guard: call under the operation's normal commit lock. */
    revalidate(currentFingerprint:string) {
      checkCancelled(options.signal);
      if(currentFingerprint!==snapshot.fingerprint) throw new CoreError("conflict","Policy context changed");
      if(options.deadline!==undefined && now()>=options.deadline) throw new CoreError("not_allowed","Policy operation deadline expired");
    },
  };
}
