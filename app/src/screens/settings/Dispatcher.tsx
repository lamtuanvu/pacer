import type { DispatchConfig, DispatchPreview, ModelRecord } from "../../../../src/dispatch/types";
import { MAX_PROBES_PER_DAY, MAX_COST_PCT } from "../../../../src/view-model/certification-schedule";
import { executorLabel } from "../../../../src/view-model/words";
import type { RouteExplanation } from "../../../../src/core/dispatch-explain";
import { explainHeadline, modelCopy, plannerCopy, reasonCopy, reasonSeverity, type ExplainLabels } from "../../../../src/view-model/route-explain";
import type { StrategyDraft } from "../../model/dispatcher-setup";
import { clock } from "../../../../src/view-model/time";
import type { RouteQuery } from "../../router";
import type { BrowserApi } from "../../data/api";
import { useEffect, useLayoutEffect, useRef, useState, useId } from "preact/hooks";
import { SortableList, useStableKeys } from "../../ds/SortableList";
import { DispatcherGuidedSetup } from "./DispatcherSetup";
import { Button, TextAction } from "../../ds/Button";
import { Checkbox, Disclosure, Field, TextInput, TextArea } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { AgentMark } from "../../ds/AgentMark";
import { Identicon } from "../../ds/Identicon";
import { Pill } from "../../ds/Pill";
import type { StrategyRow } from "../../model/strategy";
import type { ProjectStrategyView } from "../../model/project-strategies";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Section, useResource, useOperation, ResourceState, Feedback } from "./shared";

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
  if(item.scheduleReason&&item.probeMode!=="off"&&item.state!=="certified")
    parts.push(`${item.schedulePaused?"probing paused":"not probing now"}: ${item.scheduleReason}`);
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
    {inventory.models.length?<div className="pc-stack pc-stack--compact">{inventory.models.map(model=><div className="u3-setting" key={`${model.runner}:${modelLabel(model)}`}><div><strong>{executorLabel(model.executor)}</strong> · {modelLabel(model)}<div className="u3-muted">Account {model.account} · {model.tier==="unknown"?"Tier unknown":`${model.tier} tier`} · {model.actualModel?`Observed model ${model.actualModel}`:"Exact model unknown"}</div></div><div>{model.provenance==="observed"?"Allowed from discovery":"Configured"}</div></div>)}</div>:<p>No allowed models are configured for this saved setup.</p>}
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
/** A `dispatch.explain` answer: the choice, why, who else was considered and what could change it. */
export function RouteExplanationResult({result}:{result:RouteExplanation}) {
  const labels:ExplainLabels={executor:executorLabel,step:stepTitle,now:Date.now()/1000,outcome:result.outcome};
  const copyReason=(item:RouteExplanation["reasons"][number])=>reasonCopy(item,labels,item.subject&&(item.subject!==result.chosen?.runner||item.code==="capacity_unmeasured"||item.code==="default_model_unresolved")?executorLabel(item.subject):undefined);
  const fallbacks=result.fallbacks.filter(item=>item.executor!==result.chosen?.executor||item.runner!==result.chosen?.runner);
  return <div className="pc-route-result">
    <div className="pc-route-result__header">{result.chosen?<div className="pc-route-result__choice"><span className="pc-current-setup__label">Would go to</span><strong className="pc-route-result__name">{executorLabel(result.chosen.runner)}</strong><span className="u3-muted">{result.chosen.account} · {modelCopy(result.chosen)} · {result.chosen.host?`Host ${result.chosen.host}`:"This machine"}</span></div>:<p><strong>{explainHeadline(result,labels)}</strong></p>}
    {result.step&&<p>Matched: Step {result.step.index+1} · {stepTitle(result.step.id)}</p>}</div>
    <div className="pc-route-result__body pc-stack pc-stack--compact">
    {result.strategy.draft&&<p className="u3-muted">Uses your unsaved choice ladder.</p>}
    {!!result.reasons.length&&<ul>{result.reasons.map((item,index)=><li key={`${item.code}:${index}`}>{copyReason(item)}</li>)}</ul>}
    {!!fallbacks.length&&<div><strong>Also considered</strong><ul className="pc-route-result__candidates">{fallbacks.map((item,index)=>{
      const severity=item.state==="eligible"?"good":reasonSeverity(item.reason?.code);
      return <li key={`${item.runner}:${index}`}><span aria-hidden="true" className={`pc-route-result__glyph pc-route-result__glyph--${severity}`}>{({good:"✓",neutral:"–",soft:"◐",hard:"✕"})[severity]}</span><span><strong>{executorLabel(item.runner)}</strong>: {item.state==="eligible"?(result.chosen?"Could take it if the choice above cannot.":"Could take it."):item.reason?reasonCopy(item.reason,labels):"Left out."}</span></li>;
    })}</ul></div>}
    <p className="u3-muted">{plannerCopy(result.planner,labels)}</p>
    {!!result.uncertainty.length&&<Disclosure summary="What could change this"><ul>{result.uncertainty.map((item,index)=><li key={`${item.code}:${index}`}>{copyReason(item)}</li>)}</ul></Disclosure>}
    </div>
  </div>;
}

function previewHeadline(preview:DispatchPreview):string {
  const proposal=preview.proposal;
  const top=preview.validation==="valid"&&proposal?.state==="ranked"?preview.request.candidates.find(candidate=>candidate.id===proposal.choices[0]?.id):undefined;
  if(top)return `Pacer would choose ${executorLabel(top.runner??top.executor)}`;
  return preview.recommendedAction==="queue"?"Pacer would hold this task until an executor can take it":"No executor can take this task now";
}

export function DispatcherPreviewResult({preview}:{preview:DispatchPreview}) {
  const proposal=preview.proposal;
  const top=proposal?.state==="ranked"?preview.request.candidates.find(candidate=>candidate.id===proposal.choices[0]?.id):undefined;
  return <div className="pc-card">
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
/** A comma-separated list field: keeps the typed text (commas, spaces) while focused and reports it on each input. */
export function ListField({label,help,value,onText,disabled,placeholder,marker}:{label:string;help?:string;value:readonly string[]|undefined;onText:(text:string)=>void;disabled?:boolean;placeholder?:string;marker?:string}){
  const joined=value?.join(", ")??"",[text,setText]=useState(joined),focused=useRef(false);
  useEffect(()=>{if(!focused.current)setText(joined);},[joined]);
  return <Field label={label} help={help}><TextInput value={text} disabled={disabled} placeholder={placeholder} data-list-field={marker}
    onFocus={()=>{focused.current=true;}} onBlur={()=>{focused.current=false;setText(joined);}}
    onInput={event=>{const next=event.currentTarget.value;setText(next);onText(next);}}/></Field>;
}
type LadderStep=DispatchConfig["steps"][number];
const listFields:[string,string,(step:LadderStep)=>string[]|undefined,(step:LadderStep,value:string)=>LadderStep][]=[
  ["Only these executors","Optional hard restriction. Use executor IDs separated by commas.",step=>step.candidates.executors,(step,value)=>({...step,candidates:candidateRestriction(step.candidates,"executors",value)})],
  ["Only these models","Optional hard restriction. Model IDs must already be allowed by the strategy.",step=>step.candidates.models,(step,value)=>({...step,candidates:candidateRestriction(step.candidates,"models",value)})],
  ["Prefer these models","A preference ranks eligible models but does not exclude others.",step=>step.prefer.models,(step,value)=>({...step,prefer:{...step.prefer,models:splitList(value)}})],
];
export function DispatcherLadderFields({config,onChange,disabled}:{config:DispatchConfig;onChange:(config:DispatchConfig)=>void;disabled?:boolean}) {
  const keys=useStableKeys(config.steps.length);
  const patch=(index:number,change:(step:LadderStep)=>LadderStep)=>onChange({...config,steps:config.steps.map((step,at)=>at===index?change(step):step)});
  const reorder=(order:string[])=>{const byKey=new Map(keys.current.map((key,at)=>[key,config.steps[at]!]));keys.current=order;onChange({...config,steps:order.map(key=>byKey.get(key)!)});};
  const remove=(key:string)=>{const at=keys.current.indexOf(key);if(at<0)return;keys.current=keys.current.filter(item=>item!==key);onChange({...config,steps:config.steps.filter((_,index)=>index!==at)});};
  const add=()=>{let number=config.steps.length+1;while(config.steps.some(step=>step.id===`step-${number}`))number++;onChange({...config,steps:[...config.steps,{id:`step-${number}`,match:{},require:{},prefer:{models:[],strengths:[]},candidates:{},capacity:"comfortable",rank:["task-fit","spare-capacity"]}]});};
  return <div className="pc-stack pc-stack--section">
    <Field label="Spare capacity threshold" help="A step requiring spare capacity uses this percentage as its minimum."><TextInput type="number" min="0" max="100" disabled={disabled} value={String(config.comfortablePct)} onInput={event=>onChange({...config,comfortablePct:Number(event.currentTarget.value)})}/></Field>
    <Field label="Keep capacity in reserve" help="Percentage Pacer leaves unused when selecting a model."><TextInput type="number" min="0" max="100" disabled={disabled} value={String(config.reservePct)} onInput={event=>onChange({...config,reservePct:Number(event.currentTarget.value)})}/></Field>
    <SortableList iconControls label="Ladder steps, first match wins" disabled={disabled} onReorder={reorder} onRemove={config.steps.length>1?remove:undefined}
      items={config.steps.map((step,index)=>({key:keys.current[index]!,label:stepTitle(step.id),leading:<span className={`pc-ladder-number pc-ladder-number--${step.capacity==="comfortable"?"good":step.capacity==="usable"?"warn":"muted"}`} aria-hidden="true">{index+1}</span>,detail:<span className="u3-muted">Step {index+1} · {capacityLabel(step.capacity)}{step.match.kind?` · ${step.match.kind} tasks`:" · any task kind"} · Rank by {step.rank.map(rankLabel).join(", ")}</span>}))}
      renderExtra={(_,index)=>{const step=config.steps[index]!;return <Disclosure className="pc-disclosure-panel" summary={`Edit step ${index+1}`}><div className="pc-disclosure-panel__body pc-stack pc-stack--normal">
      <Field label={`Step ${index+1} name`}><TextInput value={step.id} maxLength={256} disabled={disabled} onInput={event=>patch(index,item=>({...item,id:event.currentTarget.value}))}/></Field>
      <Field label="Task kind" help="Optional. Leave empty to match any task kind."><TextInput value={step.match.kind??""} disabled={disabled} onInput={event=>patch(index,item=>({...item,match:event.currentTarget.value.trim()?{kind:event.currentTarget.value.trim()}:{}}))}/></Field>
      <Field label="Capacity needed"><ChoicePicker value={step.capacity} disabled={disabled} options={capacityOptions} onValueChange={value=>patch(index,item=>({...item,capacity:value as LadderStep["capacity"]}))}/></Field>
      <Field label="Minimum model tier"><ChoicePicker value={step.require.minTier??""} disabled={disabled} options={tierOptions} onValueChange={value=>patch(index,item=>({...item,require:{...item.require,minTier:value?value as NonNullable<LadderStep["require"]["minTier"]>:undefined}}))}/></Field>
      <Checkbox label="Model must support tools" disabled={disabled} checked={step.require.tools===true} onChange={event=>patch(index,item=>({...item,require:{...item.require,tools:event.currentTarget.checked?true:undefined}}))}/>
      {listFields.map(([label,help,read,write])=><ListField key={label} label={label} help={help} value={read(step)} disabled={disabled} onText={value=>patch(index,item=>write(item,value))}/>)}
      <Field label="Rank first by"><ChoicePicker value={step.rank[0]} disabled={disabled} options={rankOptions} onValueChange={value=>patch(index,item=>({...item,rank:[value as LadderStep["rank"][number],...item.rank.filter(rank=>rank!==value)]}))}/></Field>
    </div></Disclosure>;}}/>
    <div><Button disabled={disabled} onClick={add}>Add ladder step</Button></div>
    <Field label="When no step matches"><ChoicePicker value={config.onNoMatch} disabled={disabled} options={[{value:"queue",label:"Queue the work"},{value:"fail",label:"Report no eligible choice"}]} onValueChange={value=>onChange({...config,onNoMatch:value as DispatchConfig["onNoMatch"]})}/></Field>
  </div>;
}

function RepositoryChoices() {
  const query=useResource<ProjectStrategyView[]>("project.strategy.list");
  const count=query.data?.filter(item=>!!item.executors).length;
  return <>
    {query.error&&(query.data?<DispatcherReadError error={query.error} reload={query.reload} subject="repository choices"/>:<div><p role="alert">Repository choices could not be loaded.</p><Button onClick={query.reload}>Try again</Button></div>)}
    {count!==undefined&&<div className="pc-current-setup__cell"><div><span className="pc-current-setup__label">Repository choices</span><strong>{count?`${count} ${count===1?"repository":"repositories"}`:"No repository lists"}</strong></div><span className="u3-muted">Kept when setup changes</span></div>}
  </>;
}
export function DispatcherOverview({view,repositoryChoices=false}:{view:DispatcherConfigView;repositoryChoices?:boolean}) {
  return <Section id="dispatcher" title="Dispatcher" detail="See who plans work and how Pacer chooses an executor and model.">
    <section aria-label="Current setup" className="pc-current-setup">
      <div className="pc-current-setup__cell"><AgentMark agent={view.planner} size={28} labelled={false}/><div><span className="pc-current-setup__label">Planner</span><strong>{executorLabel(view.planner)}</strong></div><TextAction href="#/settings/planner">Planner &amp; pacing</TextAction></div>
      <div className="pc-current-setup__cell"><span className="pc-setup-icon"><Identicon seed={view.strategy}/></span><div><span className="pc-current-setup__label">Active saved setup</span><strong>{view.strategy}</strong></div><TextAction href="#saved-profiles" onClick={event=>{
        const target=document.getElementById("saved-profiles");
        if(target){event.preventDefault();target.tabIndex=-1;target.focus();target.scrollIntoView({block:"start"});}
      }}>Switch setup</TextAction></div>
      {repositoryChoices&&<RepositoryChoices/>}
    </section>
  </Section>;
}

/** Same saved-profile operations as the guided setup, composed as the board's bordered list. */
export function SavedSetups({onActivated,initialData}:{onActivated?:()=>void;initialData?:StrategyRow[]}) {
  const query=useResource<StrategyRow[]>("strategy.list",{},initialData),action=useOperation(query.reload);
  const [building,setBuilding]=useState(false),[brief,setBrief]=useState("");
  return <Section id="saved-profiles" title="Saved setups" detail="Each setup saves global planner, pacing, eligibility and dispatcher settings. Repository choices are kept when you switch."
    actions={<Button size="sm" onClick={()=>setBuilding(value=>!value)} aria-expanded={building}>New from a brief</Button>}>
    <ResourceState resource={query} empty="No saved setups yet.">
      <div className="pc-saved-setups">{query.data?.map(strategy=><div key={strategy.name} className={`pc-saved-setups__row${strategy.active?" pc-saved-setups__row--active":""}`}>
        <span className="pc-setup-icon"><Identicon seed={strategy.name}/></span><strong>{strategy.name}</strong><span>{strategy.summary}</span>
        <div>{strategy.active?<Pill tone="good">Active</Pill>:<Button size="sm" aria-label={`Use ${strategy.name}`} disabled={action.busy} onClick={()=>void action.run("strategy.use",{name:strategy.name},onActivated)}>Use</Button>}</div>
      </div>)}</div>
    </ResourceState>
    {building&&<form className="pc-card" onSubmit={event=>{event.preventDefault();void action.run("strategy.build",{brief});}}>
      <Field label="What should this setup do?"><TextArea value={brief} maxLength={2000} required onInput={event=>setBrief(event.currentTarget.value)}/></Field>
      <div><Button type="submit" disabled={action.busy}>Build setup</Button></div><p className="u3-muted">Opens a planning session or returns a command to run.</p>
    </form>}
    <Feedback action={action}/>
  </Section>;
}

export function DispatcherSection({query}:{query:RouteQuery}) {
  const {state}=useTaskContext();
  if(!state.features.ops.has("dispatch.config.get"))return <><Section id="dispatcher" title="Dispatcher"><p>This service does not support dispatcher settings yet. Update the service to view the decision ladder.</p></Section><SavedSetups/></>;
  return <DispatcherContent query={query}/>;
}
export function DispatcherReadError({error,reload,subject}:{error:unknown;reload:()=>void;subject:string}){
  if(!error)return null;
  return <div className="pc-stack pc-stack--compact"><p>Could not refresh {subject}. Showing the last loaded reading.</p><ErrorMessage error={error}/><div><Button onClick={reload}>Try again</Button></div></div>;
}
function DispatcherContent({query}:{query:RouteQuery}){
  const {state,api}=useTaskContext();
  const config=useResource<DispatcherConfigView>("dispatch.config.get");
  const models=useResource<DispatcherInventory>("dispatch.models");
  const [setupsRevision,setSetupsRevision]=useState(0),[ladderDraft,setLadderDraft]=useState<StrategyDraft>();
  const [refreshing,setRefreshing]=useState(false),[refreshError,setRefreshError]=useState<unknown>();
  const refresh=async()=>{setRefreshing(true);setRefreshError(undefined);try{await api.call("dispatch.refresh",{});models.reload();}catch(error){setRefreshError(error);}finally{setRefreshing(false);}};
  return config.data?<><DispatcherReadError error={config.error} reload={config.reload} subject="dispatcher settings"/><DispatcherOverview view={config.data} repositoryChoices={state.features.ops.has("project.strategy.list")}/>
    <DispatcherGuidedSetup view={config.data} onLadderDraft={setLadderDraft} onSaved={()=>{config.reload();models.reload();setSetupsRevision(value=>value+1);}}/>
    {(state.features.ops.has("dispatch.explain")||state.features.ops.has("dispatch.preview"))&&<DispatcherPreviewForm query={query} draft={ladderDraft}/>}
    {state.features.ops.has("dispatch.enforcement")?<DispatcherEnforcement query={query}/>:<Section id="native-control" title="Native subagent control"><p>Update the service to inspect managed delegation enforcement.</p></Section>}
    <Section id="model-choices" title="Model choices" actions={state.features.ops.has("dispatch.refresh")?<Button busy={refreshing} onClick={()=>void refresh()}>Refresh readings</Button>:undefined}>
      <DispatcherReadError error={models.error&&models.data?models.error:undefined} reload={models.reload} subject="model choices"/>
      {models.data?<DispatcherModelInventory inventory={models.data}/>:<p role={models.error?"alert":undefined}>{models.error?"Model choices could not be loaded.":"Loading model choices…"}</p>}
      <ErrorMessage error={refreshError}/>
    </Section>
    <SavedSetups key={setupsRevision} onActivated={()=>{config.reload();models.reload();}}/>
  </>:<><Section id="dispatcher" title="Dispatcher"><p role={config.error?"alert":undefined}>{config.error?"Dispatcher settings could not be loaded.":"Loading dispatcher settings…"}</p></Section><SavedSetups/></>;
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

export function DispatcherPreviewForm({query,draft}:{query:RouteQuery;draft?:StrategyDraft}) {
  const {state,api}=useTaskContext();
  const repos=state.snapshot?.repos??[];
  const [repo,setRepo]=useState(query.repo??""),[goal,setGoal]=useState(""),[kind,setKind]=useState(""),[tier,setTier]=useState(""),[tools,setTools]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[result,setResult]=useState<DispatchPreview>(),[explained,setExplained]=useState<RouteExplanation>();
  const explain=state.features.ops.has("dispatch.explain"),[useDraft,setUseDraft]=useState(true);
  const request=useRef(0),inFlight=useRef(false);
  const [announcement,setAnnouncement]=useState("");
  const [goalError,setGoalError]=useState("");
  const draftHelpId=useId();
  useEffect(()=>{if(!repo&&repos.length)setRepo(repos[0]!.key);},[repo,repos.length]);
  useLayoutEffect(()=>{
    request.current++;inFlight.current=false;setBusy(false);setResult(undefined);setExplained(undefined);setError(undefined);setAnnouncement("");
    return ()=>{request.current++;};
  },[draft,useDraft,repo,goal,kind,tier,tools,explain]);
  const submit=async(event:Event)=>{
    event.preventDefault();if(inFlight.current)return;
    if(!goal.trim()){setGoalError("Describe the task to preview where it would go.");return;}
    setGoalError("");if(!repo)return;
    const id=++request.current;inFlight.current=true;setBusy(true);setError(undefined);setResult(undefined);setExplained(undefined);setAnnouncement("Previewing…");
    const params={repo,goal:goal.trim(),...(kind.trim()?{kind:kind.trim()}:{}),requirements:{...(tier?{minTier:tier}:{}),...(tools?{tools:true}:{})}};
    try{
      if(explain){
        const next=await api.call<RouteExplanation>("dispatch.explain",{...params,...(draft?.from&&useDraft?{strategyDraft:draft}:{})});
        if(id===request.current){setExplained(next);setAnnouncement(explainHeadline(next,{executor:executorLabel,step:stepTitle,now:Date.now()/1000,outcome:next.outcome}));}
      }else{
        const next=await api.call<DispatchPreview>("dispatch.preview",params);
        if(id===request.current){setResult(next);setAnnouncement(previewHeadline(next));}
      }
    }catch(failure){if(id===request.current){setError(failure);setAnnouncement("Preview could not be loaded.");}}
    finally{if(id===request.current){inFlight.current=false;setBusy(false);}}
  };
  return <Section step={4} id="dispatch-preview" title="Try a task" detail={explain?"See where a task would go, using recent readings. This does not start work or reserve capacity.":"See where a task would go, using saved settings and recent readings. This does not start work or reserve capacity."}>
    <span className="sr-only" role="status">{announcement}</span>
    <form className="dispatcher-preview-form pc-dispatcher-preview" onSubmit={event=>void submit(event)}>
      <div className="dispatcher-preview-row">
        {repos.length?<Field label="Repository"><ChoicePicker className="pc-choice-picker--mono" value={repo} searchable options={repos.map(item=>({value:item.key,label:item.label}))} onValueChange={setRepo}/></Field>:<p>Choose a repository from the repository picker before previewing.</p>}
        <Field label="Task kind"><TextInput value={kind} maxLength={256} placeholder="Any kind" onInput={event=>setKind(event.currentTarget.value)}/></Field>
        <Field label="Task" error={goalError}><TextInput value={goal} maxLength={8000} placeholder="What work should Pacer assign?" onInput={event=>{setGoal(event.currentTarget.value);setGoalError("");}}/></Field>
        <div className="dispatcher-preview-submit"><Button type="submit" variant="primary" busy={busy}>Preview selection</Button></div>
      </div>
      <div className="dispatcher-preview-options">
        <Field label="Minimum model tier"><ChoicePicker value={tier} options={tierOptions} onValueChange={setTier}/></Field>
        <Checkbox label="Needs tools" checked={tools} onChange={event=>setTools(event.currentTarget.checked)}/>
        {explain&&draft?.from&&<div className="pc-stack pc-stack--compact"><Checkbox label="Use my unsaved choice ladder" aria-describedby={draftHelpId} checked={useDraft} onChange={event=>setUseDraft(event.currentTarget.checked)}/><small id={draftHelpId} className="u3-muted">Changes to Who may do the work count only after you save them.</small></div>}
        {explain&&draft&&!draft.from&&<p className="u3-muted">Save the choice ladder once to try unsaved changes here.</p>}
      </div>
    </form>
    <ErrorMessage error={error}/>
    {result&&<DispatcherPreviewResult preview={result}/>}
    {explained&&<RouteExplanationResult result={explained}/>}
  </Section>;
}
