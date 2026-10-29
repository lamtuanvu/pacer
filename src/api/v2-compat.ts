/** The overlap adapter. Conversions are pure and never mutate the v3 model. */
import { sortItems } from "../attention/rules";
import { legacySetup, legacyCheck } from "../setup/v2";
import type { LinkSnapshot, BudgetData } from '../link/envelope';
import type { SnapshotV2, SnapshotV3 } from './read-model/types';
import { callOp, opJsonSchemas, LEGACY_TASK_LIST, type OpDeps } from './ops';
import { CoreError } from '../core/errors';
import type { Ctx } from '../types';
import { helloBody, type ApiEventV2, type ApiEventV3 } from './protocol';

// The current 2.x service is 2.8.0; PREVIOUS names the promised 2.7 overlap baseline.
export const V2_PROTOCOL = '2.8.0';
export const V2_EVENT_TYPES = ['budget','task','mode','alert','config','pause','reset','executor','account','host','repo','counts','attention','activity','job','notify'];
export const V2_STATE = Symbol('v2 snapshot state');
export const V2_EVENT = Symbol('v2 event');
export type CompatSnapshot = SnapshotV3 & { [V2_STATE]?: Pick<LinkSnapshot,'budget'|'alerts'|'console'|'consoles'|'serviceInstalled'> };
export type CompatEvent = ApiEventV3 & { [V2_EVENT]?: ApiEventV2 | null };

/** Operations added after 2.8.0. 2.x is frozen, so they exist only in v3. */
export const V3_ONLY_OPS = new Set(['snapshot.get','client.control.enroll','client.control.targets','client.control.request','client.control.result','client.control.claim','client.control.complete','api.list','api.describe','runner.settings.get','runner.settings.save','desktop.capture.register','desktop.capture.targets','desktop.capture.request','desktop.capture.claim','desktop.capture.complete','desktop.capture.result','desktop.update.adopt','desktop.update.adoptCancel','desktop.update.status','desktop.update.check','desktop.update.download','desktop.update.restart','desktop.update.cancel','desktop.update.configure','task.takeover','service.install','onboarding.skip','onboarding.try','doctor.run','project.strategy.list','project.strategy.get','project.strategy.set','project.strategy.remove','task.prune','task.restore','plugin.list','plugin.enable','plugin.disable','plugin.remove','plugin.doctor','plugin.ui.list','plugin.ui.render','plugin.ui.action','plugin.ui.visibility','plugin.settings.get','plugin.settings.set','files.search','issue.import','issue.search']);

for (const op of ['dispatch.config.get','dispatch.preview','dispatch.explain','dispatch.submit','dispatch.child','dispatch.tree','dispatch.list','dispatch.events','dispatch.wait','dispatch.review','dispatch.retry','dispatch.answer','dispatch.stop','dispatch.dependencies','dispatch.dependencies.waive','dispatch.models','dispatch.refresh','dispatch.analytics','dispatch.enforcement','dispatch.enforcement.probe','dispatch.enforcement.denied','dispatch.enforcement.consent','dispatch.learning.reset']) V3_ONLY_OPS.add(op);

export function v2Hello() {
 const {previous:_,...hello}=helloBody();
 return {...hello,protocol:V2_PROTOCOL,ops:hello.ops.filter(op=>!V3_ONLY_OPS.has(op)),events:[...V2_EVENT_TYPES]};
}

for (const op of ["limits.refresh", "session.draft.create", "session.prepare", "session.create", "session.context", "session.end", "session.resume", "session.attachment.prepare", "session.file.read"]) V3_ONLY_OPS.add(op);
for (const op of ["insights.summary"]) V3_ONLY_OPS.add(op);
for (const op of ["machine.get", "machine.set", "machine.rotate"]) V3_ONLY_OPS.add(op);
for (const op of ["discovery.list", "discovery.set", "discovery.respond", "discovery.network.get", "discovery.network.set"]) V3_ONLY_OPS.add(op);
for (const op of ["terminal.list", "terminal.create", "terminal.rename", "terminal.close"]) V3_ONLY_OPS.add(op);
for (const op of ["assistant.status", "assistant.ask", "assistant.cancel", "assistant.conversations", "assistant.conversation", "assistant.turn", "assistant.delete", "assistant.settings.get", "assistant.settings.set", "assistant.candidates", "assistant.card.record", "assistant.card.refresh"]) V3_ONLY_OPS.add(op);

function budget(s: SnapshotV3): BudgetData | null {
 if(!s.planner)return null;
 return {generatedAt:s.at,strategy:s.strategies.flatMap(x=>typeof x!=='string'&&x.active?[x.name]:[])[0]??'default',planner:s.planner.runner,mode:s.planner.mode,
 providers:s.executors.map(e=>{const a=s.accounts.find(a=>a.name===e.account);return {...(e.eligibility?{eligibility:e.eligibility}:{}),id:e.id,agent:e.agent,account:e.account,verdict:a?.verdict??'UNKNOWN',usedPct:e.usedPct,pacePct:e.pacePct,resetsAt:a?.resetsAt??null,window:a?.window??null,stale:e.rank==='planner'?s.planner!.stale:false,...(e.state==='blocked'?{blockedReason:e.reason??e.sub}:{}),...(e.state==='down'?{brokenReason:e.reason??e.sub}:{})};}),
 ranked:s.executors.filter(e=>e.rank!=='planner'&&e.enabled&&e.eligibility?.state!=='ineligible'&&['ready','busy'].includes(e.state)).sort((a,b)=>Number(a.rank)-Number(b.rank)).map(e=>({id:e.id,verdict:s.accounts.find(a=>a.name===e.account)?.verdict??'UNKNOWN'}))};
}
export function toV2Snapshot(s: CompatSnapshot): SnapshotV2 {
 const legacy=s[V2_STATE],setup=legacySetup(s.setup);
 const {desktopUpdates: _desktopUpdates, ...compatible}=s;
 const attention=sortItems(s.attention.flatMap(a=>{
  if(a.id==="setup:connect"||isDiscoveryItemId(a.id))return [];
  const id=a.id==="setup:planner"?"setup:strategy":a.id;
  const item=setup.items.find(i=>`setup:${i.id}`===id);
  if(!item)return [a]; // Plugin reload notices are independent of the checklist.
  if(item.status==="done")return [];
  return [{...a,id,title:item.title,actions:a.actions.map(action=>action.op==="ui.open"?{...action,params:{...action.params,section:item.id}}:action)}];
 }));
 const counts={...s.counts,attention:attention.length,problems:attention.filter(a=>a.severity!=="decide").length,setupOpen:setup.open};
 // 2.x clients read machine.max as a number. Without a fixed local cap, the effective
 // ceiling is the sum of the local executors' own limits.
 const machine=s.machine?.unlimited?{...s.machine,max:Math.max(1,s.executors.filter(e=>e.rank!=='planner'&&e.host===null&&e.enabled).reduce((n,e)=>n+e.slots.max,0))}:s.machine;
 return {...compatible,machine,setup,attention,counts,seq:s.seq>=V3_CURSOR_BASE?s.seq-V3_CURSOR_BASE:s.seq,v:1,budget:legacy?legacy.budget:budget(s),alerts:legacy?legacy.alerts:s.attention.map(a=>({key:a.id,level:a.severity==='blocked'?'error' as const:a.severity==='problem'?'warn' as const:'info' as const,title:a.title,body:a.detail,at:a.raisedAt})),
 console:legacy?.console??null,consoles:legacy?.consoles??[],serviceInstalled:legacy?.serviceInstalled??s.setup.items.some(i=>i.id==='service'&&i.status==='done'),service:{...s.service,protocol:V2_PROTOCOL}};
}
/** LAN discovery is v3-only: its event, its config area and its attention items never reach v2 clients. */
export function v3OnlyEvent(e: {type: string; data: unknown}): boolean {
 const d=e.data as {area?:unknown;id?:unknown}|null;
 return e.type==='discovery.found'||e.type==='config'&&d?.area==='discovery'||e.type==='attention'&&isDiscoveryItemId(d?.id);
}
const isDiscoveryItemId=(id:unknown)=>typeof id==='string'&&(id.startsWith('discovery:')||id.startsWith('discovery-network:'));
export function toV2Event(e: CompatEvent): ApiEventV2 | null {
 if(e.type==='desktop.update')return null;
 if(V2_EVENT in e)return e[V2_EVENT]??null;
 if(e.type==='planner'||e.type==='assistant'||e.type==='machine'||e.type==='discovery.found')return null;
 // The machine and discovery operations are v3-only, so v2 clients have no area to refetch.
 if(e.type==='config'&&['machine','discovery'].includes(String((e.data as {area?:unknown}|null)?.area)))return null;
 return {...e,type:e.type,seq:e.seq>=V3_CURSOR_BASE?e.seq-V3_CURSOR_BASE:e.seq};
}
// A disjoint safe-integer cursor namespace makes persisted 2.x cursors detectable,
// including empty outboxes and upgrades with no retention gap.
export const V3_CURSOR_BASE = 3_000_000_000_000;

export function v2Params(name:string,params:unknown):unknown {
 if(name==='task.delegate'&&params&&typeof params==='object'&&!Array.isArray(params)){
  const {dispatch:_,...legacy}=params as Record<string,unknown>;return legacy;
 }
 if(name==='client.register'&&params&&typeof params==='object'&&!Array.isArray(params)){
  const {capture:_,...legacy}=params as Record<string,unknown>;
  return legacy;
 }
 if(name!=='task.review'||!params||typeof params!=='object'||Array.isArray(params))return params;
 const p=params as Record<string,unknown>;
 if(p.accepted!==undefined&&typeof p.accepted!=='boolean')throw new CoreError('invalid_input','accepted: expected boolean');
 const {accepted,...rest}=p;
 return {...rest,...(p.verdict===undefined&&typeof accepted==='boolean'?{verdict:accepted?'accept':'reject'}:{})};
}
export function toV2OpResult(name:string,result:any):unknown {
 if(name==='client.register'&&result&&typeof result==='object'){
  const {capture_worker:_,...rest}=result;
  return rest;
 }
 if(name==='setup.check')return legacyCheck(result);
 if(name==='version.get')return {...result,protocol:V2_PROTOCOL};
 if(name==='task.diff')return {...result,diff:result.patch};
 // `fullTitle` and `derived` are 3.x additions; 2.x responses stay byte-identical.
 const legacyTask=(task:any)=>{if(!task||typeof task!=='object')return task;const {fullTitle:_,...rest}=task;return rest;};
 if(name==='task.list'){const list=result?.[LEGACY_TASK_LIST]??result;if(Array.isArray(list))return list.map(legacyTask);return list&&Array.isArray(list.tasks)?{...list,tasks:list.tasks.map(legacyTask)}:list;}
 if(name==='task.get'&&result&&typeof result==='object'){const {derived:_,work:__,...rest}=legacyTask(result);return rest;}
 if(name==='task.review'&&result&&typeof result==='object'&&!Array.isArray(result))return 'task' in result?{...result,task:legacyTask(result.task)}:legacyTask(result);
 return result;
}
export async function callV2Op(ctx:Ctx,name:string,params:unknown,deps?:OpDeps):Promise<unknown> {
 if(V3_ONLY_OPS.has(name))throw new CoreError('unknown_op',`unknown operation "${name}"`,`${name} requires protocol 3`);
 if(name==='client.register' && params && typeof params==='object')params=Object.fromEntries(Object.entries(params).filter(([key])=>key!=='capture'));
 return toV2OpResult(name,await callOp(ctx,name,v2Params(name,params),deps));
}

/** Keep the existing v2 document/schema check stable until the documentation task. */
export function v2OpJsonSchemas():ReturnType<typeof opJsonSchemas> {
 const schemas=opJsonSchemas();
 delete (schemas['task.delegate'].params as {properties:Record<string,unknown>}).properties.dispatch;
 delete (schemas['client.register'].params as {properties:Record<string,unknown>}).properties.capture;
 for(const op of V3_ONLY_OPS)delete schemas[op];
 schemas['task.list'].description="Recent tasks, newest first. Cursor/filter params return a page; limit alone keeps the legacy array until 3.0.";
 const registration=schemas['client.register'].params as {properties:Record<string,unknown>};
 delete registration.properties.capture;
 schemas['client.register'].description="Register a client with an optional notifier lease; heartbeat every 30 seconds.";
 const review=schemas['task.review'].params as {properties:Record<string,unknown>;required:string[]};
 review.properties.accepted={type:'boolean'};
 // Property order is part of the generated document.
 const {executor,kind,note,expect_state,...first}=review.properties;
 review.properties={...first,executor,kind,note,expect_state};
 review.required=review.required.filter(k=>k!=='verdict');
 return schemas;
}
