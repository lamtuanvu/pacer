import {createHash} from "node:crypto";
import {appendActivity} from "../activity/log";
import {CoreError} from "../core/errors";
import type {Ctx} from "../types";
import {pluginRegistry} from "./index";
import {pluginsConfig} from "./config";
import {evaluatePolicy,type PolicyEvaluationOptions} from "./policy-evaluator";
import type {PolicyBeforeParams} from "./policy-protocol";

type Decision = PolicyBeforeParams["decision"];
type Input<D extends Decision> = Extract<PolicyBeforeParams,{decision:D}>["input"];
export interface ApplyPolicyOptions extends Pick<PolicyEvaluationOptions,"eligibleRunnerIds"|"allowedPlacements"|"validateDelegate"|"signal"|"deadline"> {
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
      const wire=params.decision==="delegate"&&!canReadDetail ? {
        ...params,
        input:{...params.input,goal:"",repo:`repo:${fingerprint(params.input.repo)}`,goalLength:params.input.goal.length,goalHash:fingerprint(params.input.goal),repoKey:fingerprint(params.input.repo)},
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
