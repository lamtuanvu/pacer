import type { DispatchConfig, DispatchPreview, ModelRecord } from "../../../../src/dispatch/types";
import { executorLabel } from "../../../../src/view-model/words";
import type { RouteExplanation } from "../../../../src/core/dispatch-explain";
import { explainHeadline, modelCopy, plannerCopy, reasonCopy, type ExplainLabels } from "../../../../src/view-model/route-explain";
import type { StrategyDraft } from "../../model/dispatcher-setup";
import type { RouteQuery } from "../../router";
import type { BrowserApi } from "../../data/api";
import { useEffect, useRef, useState } from "preact/hooks";
import { SortableList, useStableKeys } from "../../ds/SortableList";
import { DispatcherGuidedSetup, SavedSetups } from "./DispatcherSetup";
import { Button, TextAction } from "../../ds/Button";
import { Checkbox, Disclosure, Field, TextInput } from "../../ds/Controls";
import { ChoicePicker } from "../../ds/ChoicePicker";
import { SectionHeading } from "../../ds/SectionHeading";
import { ErrorMessage, useTaskContext } from "../task-shared";
import { Section, useResource } from "./shared";

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
interface EnforcementReading {repo:string;scope:string;runners:{runner:string;account:string;agent:string;version:string|null;probeSupported:boolean;state:"certified"|"uncertified"|"stale";reason?:string;probedAt?:number;expiresAt?:number}[]}
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
export function scopedEnforcementReading(reading:EnforcementReading|undefined,repo:string,repos:readonly {key:string;path:string}[]):EnforcementReading|undefined {
  const path=repos.find(item=>item.key===repo)?.path??repo;
  return reading?.repo===path?reading:undefined;
}
export function DispatcherEnforcementRows({reading,canProbe,probing,onProbe}:{reading:EnforcementReading;canProbe:boolean;probing:string|null;onProbe:(runner:string)=>void}){
  return <>{reading.runners.map(item=><div className="u3-setting" key={item.runner}><div><strong>{executorLabel(item.runner)}</strong><div className="u3-muted">Account {item.account} · {item.version??"version unknown"} · {!item.probeSupported&&item.state!=="certified"?"Unavailable":enforcementStateCopy[item.state]}{item.reason?` · ${nativeControlReasonCopy(item.reason,item.probeSupported)}`:""}{!item.probeSupported&&item.state!=="certified"?<> · <TextAction href="#/settings/executors">View executor setup</TextAction>, then refresh status.</>:null}</div></div>{canProbe&&item.probeSupported&&item.state!=="certified"?<Button size="sm" busy={probing===item.runner} disabled={!!probing} onClick={()=>onProbe(item.runner)}>Verify control</Button>:null}</div>)}</>;
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
/** A `dispatch.explain` answer: the choice, why, who else was considered and what could change it. */
export function RouteExplanationResult({result}:{result:RouteExplanation}) {
  const labels:ExplainLabels={executor:executorLabel,step:stepTitle,now:Date.now()/1000};
  const fallbacks=result.fallbacks.filter(item=>item.executor!==result.chosen?.executor||item.runner!==result.chosen?.runner);
  return <div className="pc-card pc-stack pc-stack--compact" role="status" aria-live="polite">
    <SectionHeading>{explainHeadline(result,labels)}</SectionHeading>
    {result.chosen&&<p>{modelCopy(result.chosen)} · {result.chosen.host?`Host ${result.chosen.host}`:"This machine"}{result.step?` · ${stepTitle(result.step.id)} step`:""}</p>}
    {result.strategy.draft&&<p className="u3-muted">Uses your unsaved choice ladder.</p>}
    {!!result.reasons.length&&<ul>{result.reasons.map((item,index)=><li key={`${item.code}:${index}`}>{reasonCopy(item,labels)}</li>)}</ul>}
    {!!fallbacks.length&&<div><strong>Also considered</strong><ul>{fallbacks.map((item,index)=><li key={`${item.runner}:${index}`}>{executorLabel(item.runner)}: {item.state==="eligible"?"Could take it if the choice above cannot.":item.reason?reasonCopy(item.reason,labels):"Left out."}</li>)}</ul></div>}
    <p className="u3-muted">{plannerCopy(result.planner,labels)}</p>
    {!!result.uncertainty.length&&<Disclosure summary="What could change this"><ul>{result.uncertainty.map((item,index)=><li key={`${item.code}:${index}`}>{reasonCopy(item,labels)}</li>)}</ul></Disclosure>}
  </div>;
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
    <SortableList label="Ladder steps, first match wins" disabled={disabled} onReorder={reorder} onRemove={config.steps.length>1?remove:undefined}
      items={config.steps.map((step,index)=>({key:keys.current[index]!,label:stepTitle(step.id),detail:<span className="u3-muted">Step {index+1} · {capacityLabel(step.capacity)}{step.match.kind?` · ${step.match.kind} tasks`:" · any task kind"} · Rank by {step.rank.map(rankLabel).join(", ")}</span>}))}
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

export function DispatcherOverview({view}:{view:DispatcherConfigView}) {
  return <Section id="dispatcher" title="Dispatcher" detail="See who plans work and how Pacer chooses an executor and model.">
    <div className="pc-stack pc-stack--section">
      <div className="pc-card">
        <SectionHeading>Who plans work</SectionHeading>
        <p><strong>{executorLabel(view.planner)}</strong> on account <strong>{view.plannerAccount}</strong> is the default planner for a new session. Any executor with a valid work grant can plan child work by asking Pacer to delegate it. Pacer still chooses the child's executor and model.</p>
        <p>The active setup uses {view.source === "built-in" ? "built-in defaults" : "saved configuration"} and {view.config.engine==="ladder"?"the ordered ladder":`the plugin ${view.config.engine.replace(/^plugin:/,"")}`}. Pacer uses a repository's own order, else the global rules, then ranks with the ladder.</p>
      </div>
    </div>
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
  return config.data?<><DispatcherReadError error={config.error} reload={config.reload} subject="dispatcher settings"/><DispatcherOverview view={config.data}/>
    <SavedSetups key={setupsRevision} onActivated={()=>{config.reload();models.reload();}}/>
    <DispatcherGuidedSetup view={config.data} onLadderDraft={setLadderDraft} onSaved={()=>{config.reload();models.reload();setSetupsRevision(value=>value+1);}}/>
    {(state.features.ops.has("dispatch.explain")||state.features.ops.has("dispatch.preview"))&&<DispatcherPreviewForm query={query} draft={ladderDraft}/>}
    {state.features.ops.has("dispatch.enforcement")?<DispatcherEnforcement query={query}/>:<Section id="native-control" title="Native subagent control"><p>Update the service to inspect managed delegation enforcement.</p></Section>}
    <Section id="model-choices" title="Model choices" actions={state.features.ops.has("dispatch.refresh")?<Button busy={refreshing} onClick={()=>void refresh()}>Refresh readings</Button>:undefined}>
      <DispatcherReadError error={models.error&&models.data?models.error:undefined} reload={models.reload} subject="model choices"/>
      {models.data?<DispatcherModelInventory inventory={models.data}/>:<p role={models.error?"alert":undefined}>{models.error?"Model choices could not be loaded.":"Loading model choices…"}</p>}
      <ErrorMessage error={refreshError}/>
    </Section>
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
  return <Section id="native-control" title="Native subagent control" detail="Pacer checks native child blocking before admitting strict managed work.">
    <div className="pc-card pc-stack pc-stack--normal">
      <p>New managed work requires verified native subagent control. Executors can ask Pacer to delegate child work; Pacer selects and records it. This check covers supported native subagent tools when work starts, not arbitrary AI commands run through a shell.</p>
      {repos.length?<Field label="Repository"><ChoicePicker value={repo} searchable options={repos.map(item=>({value:item.key,label:item.label}))} onValueChange={setRepo}/></Field>:<p>Select a repository to inspect its executor controls.</p>}
      <div><Button size="sm" onClick={()=>reading.reload()} disabled={!repo}>Refresh status</Button></div>
      <DispatcherReadError error={reading.error&&currentReading?reading.error:undefined} reload={reading.reload} subject="native subagent control"/>
      {currentReading&&<DispatcherEnforcementRows reading={currentReading} canProbe={state.features.ops.has("dispatch.enforcement.probe")&&!!repo} probing={probing} onProbe={runner=>void probe(runner)}/>}
      {!currentReading&&<p role={reading.error?"alert":undefined}>{reading.error?"Native control status could not be loaded.":"Loading native control status…"}</p>}
      <p className="u3-muted">Verification starts the selected agent in a disposable repository and may use account quota.</p>
      {probeNotice&&<p role="status">{probeNotice}</p>}<ErrorMessage error={probeError}/>
    </div>
  </Section>;
}

export function DispatcherPreviewForm({query,draft}:{query:RouteQuery;draft?:StrategyDraft}) {
  const {state,api}=useTaskContext();
  const repos=state.snapshot?.repos??[];
  const [repo,setRepo]=useState(query.repo??""),[goal,setGoal]=useState(""),[kind,setKind]=useState(""),[tier,setTier]=useState(""),[tools,setTools]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[result,setResult]=useState<DispatchPreview>(),[explained,setExplained]=useState<RouteExplanation>();
  const explain=state.features.ops.has("dispatch.explain"),[useDraft,setUseDraft]=useState(true);
  useEffect(()=>{if(!repo&&repos.length)setRepo(repos[0]!.key);},[repo,repos.length]);
  const submit=async(event:Event)=>{event.preventDefault();if(!repo||!goal.trim()||busy)return;setBusy(true);setError(undefined);setResult(undefined);setExplained(undefined);
    const params={repo,goal:goal.trim(),...(kind.trim()?{kind:kind.trim()}:{}),requirements:{...(tier?{minTier:tier}:{}),...(tools?{tools:true}:{})}};
    try{if(explain)setExplained(await api.call<RouteExplanation>("dispatch.explain",{...params,...(draft?.from&&useDraft?{strategyDraft:draft}:{})}));else setResult(await api.call<DispatchPreview>("dispatch.preview",params));}catch(failure){setError(failure);}finally{setBusy(false);}};
  return <Section id="dispatch-preview" title="4. Try a task" detail="See where a task would go, using recent readings. This does not start work or reserve capacity.">
    <form className="pc-card pc-stack pc-stack--normal" onSubmit={event=>void submit(event)}>
      {repos.length?<Field label="Repository"><ChoicePicker value={repo} searchable options={repos.map(item=>({value:item.key,label:item.label}))} onValueChange={setRepo}/></Field>:<p>Choose a repository from the repository picker before previewing.</p>}
      <Field label="Task"><TextInput value={goal} maxLength={8000} placeholder="What work should Pacer assign?" onInput={event=>setGoal(event.currentTarget.value)}/></Field>
      <Field label="Task kind" help="Optional. Use this to check a specialist step."><TextInput value={kind} maxLength={256} placeholder="For example, architecture" onInput={event=>setKind(event.currentTarget.value)}/></Field>
      <Field label="Minimum model tier"><ChoicePicker value={tier} options={tierOptions} onValueChange={setTier}/></Field>
      <Checkbox label="Needs tools" checked={tools} onChange={event=>setTools(event.currentTarget.checked)}/>
      {explain&&draft?.from&&<Checkbox label="Use my unsaved choice ladder" help="Executor rule changes count once they are saved." checked={useDraft} onChange={event=>setUseDraft(event.currentTarget.checked)}/>}
      <div><Button type="submit" variant="primary" busy={busy} disabled={!repo||!goal.trim()}>Preview selection</Button></div>
    </form>
    <ErrorMessage error={error}/>
    {result&&<DispatcherPreviewResult preview={result}/>}
    {explained&&<RouteExplanationResult result={explained}/>}
  </Section>;
}
