import type { DispatchConfig, DispatchPreview, ModelRecord } from "../../../../src/dispatch/types";
import { MAX_PROBES_PER_DAY, MAX_COST_PCT } from "../../../../src/view-model/certification-schedule";
import { executorLabel } from "../../../../src/view-model/words";
import { clock } from "../../../../src/view-model/time";
import type { RouteQuery } from "../../router";
import type { BrowserApi } from "../../data/api";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button, TextAction } from "../../ds/Button";
import { Checkbox, Disclosure, Field, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Section, useResource } from "./shared";

const now = () => Date.now() / 1000;
const formatTime = (seconds: number | null): string => seconds === null ? "Never" : clock(seconds, now());
const formatDuration = (at: number, from: number): string => {
  if (at <= 0) return "—";
  const seconds = Math.max(0, Math.round(at - from));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  const days = Math.floor(seconds / 86400);
  return `${days}d ${Math.floor((seconds % 86400) / 3600)}h`;
};

export interface DispatcherConfigView {
  strategy: string;
  planner: string;
  plannerAccount: string;
  source: "built-in" | "strategy";
  config: DispatchConfig;
}

const stepNames:Record<string,string>={"capable-with-headroom":"Capable model with spare capacity","usable-fallback":"Usable fallback"};
function stepTitle(id:string):string {return stepNames[id]??id.replaceAll("-"," ").replace(/\b\w/g,letter=>letter.toUpperCase());}
function capacityLabel(value:string):string {return value==="comfortable"?"Spare capacity":value==="usable"?"Some capacity":"Unknown capacity allowed";}
function modelLabel(model:Pick<ModelRecord,"binding">):string {return model.binding.kind==="exact"?model.binding.id:"Agent default";}
export interface DispatcherInventory {models:ModelRecord[];advertised:{runner:string;account:string;model:{id:string};authorized:boolean}[];observedAt:number|null}
interface EnforcementRunner {
  runner:string;account:string;agent:string;version:string|null;
  probeSupported:boolean;unsupportedReason:string|null;probeMode:"ask"|"auto"|"off";
  state:"certified"|"uncertified"|"stale";reason?:string;
  lastProbedAt:number|null;expiresAt:number|null;
  nextEligibleAt:number;probesToday:number;lastCostPct:number|null;
  consent:"granted"|"declined"|"unasked";
  /** Absent from a service older than this app. */
  scheduleReason?:string|null;
  scheduleRepo?:string|null;
  scheduleUnsupportedReason?:string|null;
  /** A maximum-length pause, as the doctor reports it. Absent from a service older than this app. */
  schedulePaused?:boolean|null;
}
interface EnforcementReading {repo:string;scope:string;runners:EnforcementRunner[]}
const enforcementStateCopy={certified:"Verified",uncertified:"Needs verification",stale:"Verification expired"};
function nativeControlReasonCopy(reason:string,probeSupported=true):string {
  if(reason.includes("no resolvable configuration folder"))return "Connect this account before verification";
  if(!probeSupported||reason.includes("interactive launches")||reason.includes("conversation launches")||reason.includes("Project-level native control overrides"))return "Verification is not available for this executor yet";
  if(reason.includes("not been verified")||reason.includes("is unverified"))return "Run verification before assigning managed work";
  if(reason.includes("verification expired"))return "Run verification again";
  if(reason.includes("configuration changed"))return "Executor settings changed; run verification again";
  if(reason.includes("tool-result observation")||reason.includes("no native tool-result observer")||reason.includes("does not yet have a host-observed canary"))return "Verification is not available for this executor yet";
  return "This executor cannot be verified in its current setup";
}
function consentLabel(consent:"granted"|"declined"|"unasked"):string {
  if(consent==="granted")return "consent: granted";
  if(consent==="declined")return "consent: declined";
  return "";
}
export interface ConsentAction {label:string;ariaLabel:string;send:readonly [account:string,granted:boolean];variant:"secondary"|"quiet"}
/**
 * The buttons each consent state offers, and the exact arguments each one
 * sends. The control passes `send` through unchanged, so an inverted boolean
 * or a wrong account here is one on screen, and a test of this is a test of
 * the wiring.
 */
export function consentActions(account:string, consent:"granted"|"declined"|"unasked"):ConsentAction[]{
  const grant:ConsentAction={label:"Grant consent",ariaLabel:`Grant consent for ${account}`,send:[account,true],variant:"secondary"};
  // Withdrawing is the only way to stop recurring spend, so it is as visible as granting.
  if(consent==="granted")return [{label:"Withdraw consent",ariaLabel:`Withdraw consent for ${account}`,send:[account,false],variant:"secondary"}];
  if(consent==="declined")return [grant];
  return [grant,{label:"Decline",ariaLabel:`Decline probes for ${account}`,send:[account,false],variant:"quiet"}];
}
export function scopedEnforcementReading(reading:EnforcementReading|undefined,repo:string,repos:readonly {key:string;path:string}[]):EnforcementReading|undefined {
  const path=repos.find(item=>item.key===repo)?.path??repo;
  return reading?.repo===path?reading:undefined;
}
function CertificationSchedule({item}:{item:EnforcementRunner}){
  const t=now();
  const parts:string[]=[];
  if(item.scheduleRepo)parts.push(`scheduled probing certifies ${item.scheduleRepo}, not this repository`);
  // Turning scheduling off is a setting, not a fault, so it reads as plain state.
  if(item.probeMode==="off")parts.push("scheduled probing: off");
  if(item.lastProbedAt)parts.push(`last probe: ${formatTime(item.lastProbedAt)}`);
  if(item.expiresAt&&item.expiresAt>t)parts.push(`expires: ${formatTime(item.expiresAt)}`);
  if(item.probeMode!=="off"&&item.nextEligibleAt>t)parts.push(`next eligible: in ${formatDuration(item.nextEligibleAt,t)}`);
  if(item.probesToday>0)parts.push(`probes today: ${item.probesToday}`);
  // A measured delta carries full float precision; one decimal is all a reader needs.
  if(item.lastCostPct!==null)parts.push(`last probe cost: ${item.lastCostPct.toFixed(1)}% of account window`);
  const consentText=consentLabel(item.consent);
  if(consentText)parts.push(consentText);
  // Why renewal is not happening, in the doctor's words. A pause is Pacer's own
  // decision, so it reads as plain state; "off" and a current certificate
  // already say it above.
  const reason=item.scheduleReason??(item.scheduleUnsupportedReason?nativeControlReasonCopy(item.scheduleUnsupportedReason,false):null);
  if(reason&&item.probeMode!=="off"&&item.state!=="certified")
    parts.push(`${item.schedulePaused?"probing paused":"not probing now"}: ${reason}`);
  if(!parts.length)return null;
  return <div className="u3-muted">{parts.join(" · ")}</div>;
}
function ConsentControl({item,onConsent}:{item:EnforcementRunner;onConsent:(account:string,granted:boolean)=>void}){
  // With scheduling off, consent decides nothing: offering it would be a control
  // that cannot take effect.
  if(!item.probeSupported||item.probeMode==="off")return null;

  const actions=consentActions(item.account,item.consent);
  // Every button that can start quota spend carries its price, whatever state led here.
  const offersGrant=actions.some(action=>action.send[1]);
  return <div className="u3-setting-consent pc-stack pc-stack--compact">
    {offersGrant&&<div className="u3-muted">
      Scheduled certification probes spend <strong>{item.account}</strong>'s quota to verify native child blocking.
      Certificates expire within 24 hours, so this recurs automatically.
      At most {MAX_PROBES_PER_DAY} probes per day. Pacer pauses probing for at least 24 hours if one costs more than {MAX_COST_PCT}% of the account's window, then retries when eligible.
      Probes start only when the account's measured headroom is above the certification headroom floor.
    </div>}
    <div className="pc-cluster">
      {actions.map(action=><Button key={action.label} size="sm" variant={action.variant}
        onClick={()=>onConsent(...action.send)} aria-label={action.ariaLabel}>{action.label}</Button>)}
    </div>
  </div>;
}
export function DispatcherEnforcementRows({reading,canProbe,canConsent=true,probing,onProbe,onConsent}:{
  reading:EnforcementReading;canProbe:boolean;canConsent?:boolean;probing:string|null;
  onProbe:(runner:string)=>void;onConsent:(account:string,granted:boolean)=>void;
}){
  return <>{reading.runners.map(item=><div className="u3-setting" key={item.runner}>
    <div>
      <strong>{executorLabel(item.runner)}</strong>
      <div className="u3-muted">
        Account {item.account} · {item.version??"version unknown"} · {!item.probeSupported&&item.state!=="certified"?"Unavailable":enforcementStateCopy[item.state]}
        {item.reason?` · ${nativeControlReasonCopy(item.reason,item.probeSupported)}`:""}
      </div>
      {item.probeSupported?<CertificationSchedule item={item}/>:null}
      {/* The reason is already on the line above; repeating it only adds noise. */}
      {!item.probeSupported&&item.state!=="certified"?
        <div className="u3-muted"><TextAction href="#/settings/executors">View executor setup</TextAction>, then refresh status.</div>
      :null}
    </div>
    {canProbe&&item.probeSupported&&item.state!=="certified"?
      <Button size="sm" busy={probing===item.runner} disabled={!!probing} onClick={()=>onProbe(item.runner)}>Verify control</Button>
    :null}
    {/* A direct child of the row grid, so the disclosure spans both columns instead of the narrow first one. */}
    {canConsent?<ConsentControl item={item} onConsent={onConsent}/>:null}
  </div>)}</>;
}

export function DispatcherModelInventory({inventory}:{inventory:DispatcherInventory}) {
  return <div className="pc-card">
    <p>These models can be considered by the dispatcher. A declared tier is a configuration choice, not a measured quality score. <TextAction href="#/settings/executors">View executors</TextAction></p>
    {inventory.models.length?<div className="pc-stack pc-stack--compact">{inventory.models.map(model=><div className="u3-setting" key={`${model.runner}:${modelLabel(model)}`}><div><strong>{executorLabel(model.executor)}</strong> · {modelLabel(model)}<div className="u3-muted">Account {model.account} · {model.tier==="unknown"?"Tier unknown":`${model.tier} tier`} · {model.actualModel?`Observed model ${model.actualModel}`:"Exact model unknown"}</div></div><div>{model.provenance==="observed"?"Allowed from discovery":"Configured"}</div></div>)}</div>:<p>No allowed models are configured for this profile.</p>}
    {!!inventory.advertised.filter(model=>!model.authorized).length&&<p className="u3-muted">Other advertised models are suggestions only; they are not enabled automatically.</p>}
  </div>;
}

function excludedCopy(reason:string):string {
  if(reason==="Task requirements not satisfied")return "Does not meet the task's requirements";
  if(reason==="Runner unavailable or disabled")return "Executor is unavailable or disabled";
  if(reason==="Quota exhausted")return "Account capacity is exhausted";
  if(reason==="Runner not healthy")return "Executor health check failed";
  if(reason==="Different pinned model")return "A different model was requested";
  if(reason.startsWith("Native subagent control")||reason.includes("native control"))return nativeControlReasonCopy(reason);
  return "This executor is not eligible for this task";
}
export function DispatcherPreviewResult({preview}:{preview:DispatchPreview}) {
  const proposal=preview.proposal;
  const top=proposal?.state==="ranked"?preview.request.candidates.find(candidate=>candidate.id===proposal.choices[0]?.id):undefined;
  return <div className="pc-card" role="status" aria-live="polite">
    <SectionHeading>Preview result</SectionHeading>
    {preview.validation!=="valid"?<p>{preview.validation==="timeout"?"The decision engine timed out.":"The decision engine returned an invalid choice."} Pacer {preview.recommendedAction==="queue"?"would queue this work.":"cannot select an executor."}</p>:proposal?.state==="ranked"&&top?<><p><strong>{executorLabel(top.executor)}</strong> · {modelLabel(top)} · {top.headroom===null?"Capacity unknown":`${Math.round(top.headroom)}% spare capacity`}</p><p>Matched step: {stepTitle(proposal.step)}. {top.actualModel?`Observed model ${top.actualModel}.`:"Exact model unknown."}</p>{proposal.choices.length>1&&<p>{proposal.choices.length-1} other eligible choice{proposal.choices.length===2?"":"s"}.</p>}</>:<p>{preview.recommendedAction==="queue"?"No eligible choice now. Pacer would queue this work.":"No eligible choice is available."}</p>}
    {!!preview.excluded.length&&<div><strong>Not considered</strong><ul>{preview.excluded.map((item,index)=><li key={`${item.id}:${index}`}>{executorLabel(item.id)}: {excludedCopy(item.reason)}</li>)}</ul></div>}
    {!!preview.uncertainty.length&&<p className="u3-muted">Some model or capacity readings are unknown. This preview uses cached readings and does not reserve an executor; the actual choice may change.</p>}
  </div>;
}

const rankOptions=[
  {value:"task-fit",label:"Task fit"},{value:"spare-capacity",label:"Spare capacity"},
  {value:"burn-before-reset",label:"Use capacity before reset"},{value:"cheapest-first",label:"Lower cost"},{value:"preference",label:"Model preference"},
];
const capacityOptions=[{value:"comfortable",label:"Spare capacity"},{value:"usable",label:"Some capacity"},{value:"unknown",label:"Allow unknown capacity"}];
const tierOptions=[{value:"",label:"Any tier"},{value:"small",label:"Small"},{value:"medium",label:"Medium"},{value:"frontier",label:"Frontier"}];
const splitList=(value:string)=>value.split(",").map(item=>item.trim()).filter(Boolean);
const optionalList=(value:string)=>{const items=splitList(value);return items.length?items:undefined;};
export const candidateRestriction=(candidate: LadderStep["candidates"], field:"executors"|"models", value:string):LadderStep["candidates"]=>({...candidate,[field]:optionalList(value)});
const rankLabel=(value:string)=>rankOptions.find(option=>option.value===value)?.label??"Other criterion";
type LadderStep=DispatchConfig["steps"][number];
export function DispatcherLadderFields({config,onChange}:{config:DispatchConfig;onChange:(config:DispatchConfig)=>void}) {
  const patch=(index:number,change:(step:LadderStep)=>LadderStep)=>onChange({...config,steps:config.steps.map((step,at)=>at===index?change(step):step)});
  const reorder=(index:number,direction:-1|1)=>{const steps=[...config.steps],next=index+direction;[steps[index],steps[next]]=[steps[next]!,steps[index]!];onChange({...config,steps});};
  const add=()=>{let number=config.steps.length+1;while(config.steps.some(step=>step.id===`step-${number}`))number++;onChange({...config,steps:[...config.steps,{id:`step-${number}`,match:{},require:{},prefer:{models:[],strengths:[]},candidates:{},capacity:"comfortable",rank:["task-fit","spare-capacity"]}]});};
  return <div className="pc-stack pc-stack--section">
    <Field label="Spare capacity threshold" help="A step requiring spare capacity uses this percentage as its minimum."><TextInput type="number" min="0" max="100" value={String(config.comfortablePct)} onInput={event=>onChange({...config,comfortablePct:Number(event.currentTarget.value)})}/></Field>
    <Field label="Keep capacity in reserve" help="Percentage Pacer leaves unused when selecting a model."><TextInput type="number" min="0" max="100" value={String(config.reservePct)} onInput={event=>onChange({...config,reservePct:Number(event.currentTarget.value)})}/></Field>
    {config.steps.map((step,index)=><div className="pc-card pc-stack pc-stack--normal" key={index}>
      <div className="u3-row"><strong>Step {index+1}: {stepTitle(step.id)}</strong><div className="u3-actions">{index>0&&<Button size="sm" onClick={()=>reorder(index,-1)}>Move up</Button>}{index<config.steps.length-1&&<Button size="sm" onClick={()=>reorder(index,1)}>Move down</Button>}{config.steps.length>1&&<Button size="sm" onClick={()=>onChange({...config,steps:config.steps.filter((_,at)=>at!==index)})}>Remove</Button>}</div></div>
      <Field label={`Step ${index+1} name`}><TextInput value={step.id} maxLength={256} onInput={event=>patch(index,item=>({...item,id:event.currentTarget.value}))}/></Field>
      <Field label="Task kind" help="Optional. Leave empty to match any task kind."><TextInput value={step.match.kind??""} onInput={event=>patch(index,item=>({...item,match:event.currentTarget.value.trim()?{kind:event.currentTarget.value.trim()}:{}}))}/></Field>
      <Field label="Capacity needed"><ChoicePicker value={step.capacity} options={capacityOptions} onValueChange={value=>patch(index,item=>({...item,capacity:value as LadderStep["capacity"]}))}/></Field>
      <Field label="Minimum model tier"><ChoicePicker value={step.require.minTier??""} options={tierOptions} onValueChange={value=>patch(index,item=>({...item,require:{...item.require,minTier:value?value as NonNullable<LadderStep["require"]["minTier"]>:undefined}}))}/></Field>
      <Checkbox label="Model must support tools" checked={step.require.tools===true} onChange={event=>patch(index,item=>({...item,require:{...item.require,tools:event.currentTarget.checked?true:undefined}}))}/>
      <Field label="Only these executors" help="Optional hard restriction. Use executor IDs separated by commas."><TextInput value={step.candidates.executors?.join(", ")??""} onInput={event=>patch(index,item=>({...item,candidates:candidateRestriction(item.candidates,"executors",event.currentTarget.value)}))}/></Field>
      <Field label="Only these models" help="Optional hard restriction. Model IDs must already be allowed by the strategy."><TextInput value={step.candidates.models?.join(", ")??""} onInput={event=>patch(index,item=>({...item,candidates:candidateRestriction(item.candidates,"models",event.currentTarget.value)}))}/></Field>
      <Field label="Prefer these models" help="A preference ranks eligible models but does not exclude others."><TextInput value={step.prefer.models.join(", ")} onInput={event=>patch(index,item=>({...item,prefer:{...item.prefer,models:splitList(event.currentTarget.value)}}))}/></Field>
      <Field label="Rank first by"><ChoicePicker value={step.rank[0]} options={rankOptions} onValueChange={value=>patch(index,item=>({...item,rank:[value as LadderStep["rank"][number],...item.rank.filter(rank=>rank!==value)]}))}/></Field>
    </div>)}
    <div><Button onClick={add}>Add ladder step</Button></div>
    <Field label="When no step matches"><ChoicePicker value={config.onNoMatch} options={[{value:"queue",label:"Queue the work"},{value:"fail",label:"Report no eligible choice"}]} onValueChange={value=>onChange({...config,onNoMatch:value as DispatchConfig["onNoMatch"]})}/></Field>
  </div>;
}

export function DispatcherEditor({view,onActivated,call}:{view:DispatcherConfigView;onActivated:(name:string)=>void;call:BrowserApi["call"]}) {
  const [draft,setDraft]=useState<DispatchConfig>(()=>structuredClone(view.config));
  const [name,setName]=useState(""),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const changed=JSON.stringify(draft)!==JSON.stringify(view.config);
  const save=async(event:Event)=>{
    event.preventDefault();if(busy||!changed)return;
    setBusy(true);setError("");setNotice("");
    try{
      if(!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)||name==="default")throw new Error("Choose a new profile name using lowercase letters, numbers or hyphens.");
      if(!reason.trim())throw new Error("Explain why you are changing the dispatcher.");
      const latest=await call<DispatcherConfigView>("dispatch.config.get",{});
      if(latest.strategy!==view.strategy||JSON.stringify(latest.config)!==JSON.stringify(view.config))throw new Error("The active profile changed in another client. Reload this page before saving.");
      const strategyDraft={from:view.strategy,set:{dispatch:draft}};
      const validation=await call<{ok:boolean;errors:string[]}>("strategy.preview",{draft:strategyDraft});
      if(!validation.ok)throw new Error(validation.errors.join(" ")||"The ladder needs changes before it can be saved.");
      await call("strategy.save",{name,draft:strategyDraft,reason:reason.trim()});
      setNotice(`Saved ${name}. Activating it…`);
      try{await call("strategy.use",{name});onActivated(name);}
      catch(failure){throw new Error(`Saved ${name}, but activation failed: ${failure instanceof Error?failure.message:String(failure)}`);}
    }catch(failure){setError(failure instanceof Error?failure.message:String(failure));}
    finally{setBusy(false);}
  };
  return <Disclosure className="pc-disclosure-panel" summary="Edit decision ladder">
    <div className="pc-disclosure-panel__body">
      {view.config.engine!=="ladder"?<p>This profile uses a plugin decision engine. Edit its plugin configuration in the strategy file; the ladder shown here is not active.</p>:<form className="pc-stack pc-stack--section" onSubmit={event=>void save(event)}>
        <p>Change the steps, validate them, then save as a new profile. The current profile remains active until the new one is saved and activated.</p>
        <DispatcherLadderFields config={draft} onChange={setDraft}/>
        <div className="pc-card pc-stack pc-stack--normal">
          <SectionHeading>Save and use a new profile</SectionHeading>
          <Field label="Profile name" help="Lowercase letters, numbers and hyphens. The default profile stays unchanged."><TextInput value={name} maxLength={40} onInput={event=>setName(event.currentTarget.value)}/></Field>
          <Field label="Reason for change"><TextInput value={reason} maxLength={500} onInput={event=>setReason(event.currentTarget.value)}/></Field>
          {!changed&&<p className="u3-muted">Change at least one ladder setting before saving.</p>}
          <div><Button type="submit" variant="primary" busy={busy} disabled={!changed||!name||!reason.trim()}>Validate and activate</Button></div>
          {notice&&<p role="status" aria-live="polite">{notice}</p>}{error&&<p role="alert">{error}</p>}
        </div>
      </form>}
    </div>
  </Disclosure>;
}

export function DispatcherOverview({view}:{view:DispatcherConfigView}) {
  const ladderActive=view.config.engine==="ladder",ladderFallback=view.config.engineFallback==="ladder";
  return <Section id="dispatcher" title="Dispatcher" detail="See who plans work and how Pacer chooses an executor and model.">
    <div className="pc-stack pc-stack--section">
      <div className="pc-card">
        <SectionHeading>Who plans work</SectionHeading>
        <p><strong>{executorLabel(view.planner)}</strong> on account <strong>{view.plannerAccount}</strong> is the default planner for a new session. Any executor with a valid work grant can plan child work by asking Pacer to delegate it. Pacer still chooses the child's executor and model.</p>
      </div>
      <div className="pc-card">
        <SectionHeading>How a choice is made</SectionHeading>
        <ol>
          <li><strong>Project override</strong> limits executors for a repository when one is selected.</li>
          <li><strong>Global eligibility rules</strong> choose the executor list by task kind when no project override is selected.</li>
          <li><strong>Dispatcher decision engine</strong> ranks eligible accounts and models from that list. The default engine uses the first matching ladder step.</li>
        </ol>
        <p>Manage saved profiles and executor eligibility below.</p>
      </div>
      <div className="pc-card">
        <SectionHeading>{ladderActive?"Decision ladder":"Decision engine"}</SectionHeading>
        <p>Active profile: <strong>{view.strategy}</strong> · {view.source === "built-in" ? "built-in defaults" : "saved configuration"} · {ladderActive?"ordered ladder":`plugin ${view.config.engine.slice(7)}`}</p>
        {!ladderActive&&<p>{ladderFallback?"If the plugin cannot decide, Pacer uses this fallback ladder.":"If the plugin cannot decide, Pacer queues the work."}</p>}
        {(ladderActive||ladderFallback)&&<><ol>{view.config.steps.map(step=><li key={step.id}><strong>{stepTitle(step.id)}</strong> · {capacityLabel(step.capacity)}{step.match.kind?` · ${step.match.kind} tasks`:" · any task kind"}<br/><span className="u3-muted">Rank by {step.rank.map(rankLabel).join(", ")}</span></li>)}</ol>
        <p>If no step matches, Pacer {view.config.onNoMatch === "queue" ? "queues the work" : "reports that no eligible executor is available"}.</p></>}
      </div>
    </div>
  </Section>;
}

export function DispatcherSection({query,children}:{query:RouteQuery;children?:ComponentChildren}) {
  const {state}=useTaskContext();
  if(!state.features.ops.has("dispatch.config.get"))return <><Section id="dispatcher" title="Dispatcher"><p>This service does not support dispatcher settings yet. Update the service to view the decision ladder.</p></Section>{children}</>;
  return <DispatcherContent query={query}>{children}</DispatcherContent>;
}
export function DispatcherReadError({error,reload,subject}:{error:unknown;reload:()=>void;subject:string}){
  if(!error)return null;
  return <div className="pc-stack pc-stack--compact"><p>Could not refresh {subject}. Showing the last loaded reading.</p><ErrorMessage error={error}/><div><Button onClick={reload}>Try again</Button></div></div>;
}
function DispatcherContent({query,children}:{query:RouteQuery;children?:ComponentChildren}){
  const {state,api}=useTaskContext();
  const config=useResource<DispatcherConfigView>("dispatch.config.get");
  const models=useResource<DispatcherInventory>("dispatch.models");
  const [refreshing,setRefreshing]=useState(false),[refreshError,setRefreshError]=useState<unknown>();
  const [activationNotice,setActivationNotice]=useState("");
  const refresh=async()=>{setRefreshing(true);setRefreshError(undefined);try{await api.call("dispatch.refresh",{});models.reload();}catch(error){setRefreshError(error);}finally{setRefreshing(false);}};
  return config.data?<><DispatcherReadError error={config.error} reload={config.reload} subject="dispatcher settings"/><DispatcherOverview view={config.data}/>
    {children}
    <DispatcherEditor key={config.data.strategy} view={config.data} call={api.call.bind(api)} onActivated={name=>{setActivationNotice(`${name} is active. Future dispatch decisions use this ladder.`);config.reload();models.reload();}}/>
    {activationNotice&&<p role="status" aria-live="polite">{activationNotice}</p>}
    {state.features.ops.has("dispatch.enforcement")?<DispatcherEnforcement query={query}/>:<Section id="native-control" title="Native subagent control"><p>Update the service to inspect managed delegation enforcement.</p></Section>}
    <Section id="model-choices" title="Model choices" actions={state.features.ops.has("dispatch.refresh")?<Button busy={refreshing} onClick={()=>void refresh()}>Refresh readings</Button>:undefined}>
      <DispatcherReadError error={models.error&&models.data?models.error:undefined} reload={models.reload} subject="model choices"/>
      {models.data?<DispatcherModelInventory inventory={models.data}/>:<p role={models.error?"alert":undefined}>{models.error?"Model choices could not be loaded.":"Loading model choices…"}</p>}
      <ErrorMessage error={refreshError}/>
    </Section>
    {state.features.ops.has("dispatch.preview")&&<DispatcherPreviewForm query={query}/>}
  </>:<><Section id="dispatcher" title="Dispatcher"><p role={config.error?"alert":undefined}>{config.error?"Dispatcher settings could not be loaded.":"Loading dispatcher settings…"}</p></Section>{children}</>;
}

function DispatcherEnforcement({query}:{query:RouteQuery}){
  const {state,api}=useTaskContext();
  const repos=state.snapshot?.repos??[];
  const [repo,setRepo]=useState(query.repo??repos[0]?.key??"");
  const reading=useResource<EnforcementReading>("dispatch.enforcement",repo?{repo}:{repo:"."});
  const currentReading=scopedEnforcementReading(reading.data,repo,repos);
  const [probing,setProbing]=useState<string|null>(null),[probeError,setProbeError]=useState<unknown>(),[probeNotice,setProbeNotice]=useState("");
  useEffect(()=>{if(!repo&&repos.length)setRepo(repos[0]!.key);},[repo,repos.length]);
  const probe=async(runner:string)=>{
    if(probing||!repo)return;
    setProbing(runner);setProbeError(undefined);setProbeNotice("");
    try{
      const started=await api.call<{job:{id:string}}>("dispatch.enforcement.probe",{repo,runner});
      setProbeNotice(`${executorLabel(runner)}: checking native child blocking…`);
      const deadline=Date.now()+300000;
      for(;;){
        const job=await api.call<{state:string;error?:{message:string}}>("job.get",{id:started.job.id});
        if(job.state!=="running"){
          setProbeNotice(job.state==="passed"?`${executorLabel(runner)}: native child blocking verified.`:`${executorLabel(runner)}: verification could not complete. Review executor setup and try again.`);
          reading.reload();break;
        }
        if(Date.now()>deadline)throw new Error("Control verification is still running. Refresh the status to see its result.");
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
    }
    catch{setProbeError(new Error("Verification could not complete. Review executor setup and try again."));}finally{setProbing(null);}
  };
  const consent=async(account:string,granted:boolean)=>{
    try{
      setProbeNotice(`${granted?"Granting":"Declining"} consent for ${account}…`);
      await api.call("dispatch.enforcement.consent",{account,granted});
      setProbeNotice(granted?`Consent granted for ${account}. The next schedule check will consider probes.`:`Consent declined for ${account}. No automatic probes will run.`);
      reading.reload();
    }catch(error){
      setProbeError(error instanceof Error?error:new Error(String(error)));
    }
  };
  return <Section id="native-control" title="Native subagent control" detail="Pacer checks native child blocking before admitting strict managed work.">
    <div className="pc-card pc-stack pc-stack--normal">
      <p>New managed work requires verified native subagent control. Executors can ask Pacer to delegate child work; Pacer selects and records it. This check covers supported native subagent tools when work starts, not arbitrary AI commands run through a shell.</p>
      {repos.length?<Field label="Repository"><ChoicePicker value={repo} searchable options={repos.map(item=>({value:item.key,label:item.label}))} onValueChange={setRepo}/></Field>:<p>Select a repository to inspect its executor controls.</p>}
      <div><Button size="sm" onClick={()=>reading.reload()} disabled={!repo}>Refresh status</Button></div>
      <DispatcherReadError error={reading.error&&currentReading?reading.error:undefined} reload={reading.reload} subject="native subagent control"/>
      {currentReading&&<DispatcherEnforcementRows reading={currentReading} canProbe={state.features.ops.has("dispatch.enforcement.probe")&&!!repo} probing={probing} onProbe={runner=>void probe(runner)} canConsent={state.features.ops.has("dispatch.enforcement.consent")} onConsent={consent}/>}
      {!currentReading&&<p role={reading.error?"alert":undefined}>{reading.error?"Native control status could not be loaded.":"Loading native control status…"}</p>}
      <p className="u3-muted">Verification starts the selected agent in a disposable repository and may use account quota.</p>
      {probeNotice&&<p role="status" aria-live="polite">{probeNotice}</p>}<ErrorMessage error={probeError}/>
    </div>
  </Section>;
}

function DispatcherPreviewForm({query}:{query:RouteQuery}) {
  const {state,api}=useTaskContext();
  const repos=state.snapshot?.repos??[];
  const [repo,setRepo]=useState(query.repo??""),[goal,setGoal]=useState(""),[kind,setKind]=useState(""),[tier,setTier]=useState(""),[tools,setTools]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[result,setResult]=useState<DispatchPreview>();
  useEffect(()=>{if(!repo&&repos.length)setRepo(repos[0]!.key);},[repo,repos.length]);
  const submit=async(event:Event)=>{event.preventDefault();if(!repo||!goal.trim()||busy)return;setBusy(true);setError(undefined);setResult(undefined);try{setResult(await api.call<DispatchPreview>("dispatch.preview",{repo,goal:goal.trim(),...(kind.trim()?{kind:kind.trim()}:{}),requirements:{...(tier?{minTier:tier}:{}),...(tools?{tools:true}:{})}}));}catch(failure){setError(failure);}finally{setBusy(false);}};
  return <Section id="dispatch-preview" title="Try a task" detail="Preview a choice using recent readings. This does not start work or reserve capacity.">
    <form className="pc-card pc-stack pc-stack--normal" onSubmit={event=>void submit(event)}>
      {repos.length?<Field label="Repository"><ChoicePicker value={repo} searchable options={repos.map(item=>({value:item.key,label:item.label}))} onValueChange={setRepo}/></Field>:<p>Choose a repository from the repository picker before previewing.</p>}
      <Field label="Task"><TextInput value={goal} maxLength={8000} placeholder="What work should Pacer assign?" onInput={event=>setGoal(event.currentTarget.value)}/></Field>
      <Field label="Task kind" help="Optional. Use this to check a specialist step."><TextInput value={kind} maxLength={256} placeholder="For example, architecture" onInput={event=>setKind(event.currentTarget.value)}/></Field>
      <Field label="Minimum model tier"><ChoicePicker value={tier} options={[{value:"",label:"Any tier"},{value:"small",label:"Small"},{value:"medium",label:"Medium"},{value:"frontier",label:"Frontier"}]} onValueChange={setTier}/></Field>
      <Checkbox label="Needs tools" checked={tools} onChange={event=>setTools(event.currentTarget.checked)}/>
      <div><Button type="submit" variant="primary" busy={busy} disabled={!repo||!goal.trim()}>Preview selection</Button></div>
    </form>
    <ErrorMessage error={error}/>
    {result&&<DispatcherPreviewResult preview={result}/>}
  </Section>;
}
