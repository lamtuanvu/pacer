import { Document, isNode, isSeq, type Node } from "yaml";
import { allowedPair, type AgentId } from "../config/accounts";
import { StrategyDoc } from "../config/edit";
import { formatRunnerId, parseRunnerId, resolveRunner, runnerDefaults } from "../config/runner-id";
import { loadStrategy } from "../config/strategy";
import { applyEdit, requireAccounts } from "./accounts";
import { CoreError, toCoreError } from "./errors";
import type { Ctx } from "../types";

function docValue(doc: StrategyDoc, path: (string | number)[]): any {
  const value = doc.getIn(path); return isNode(value) ? value.toJSON() : value;
}
function change(ctx: Ctx, verb: "add" | "rm", reference: string, options: AddOptions = {}) {
  try {
    const s = loadStrategy(ctx);
    requireAccounts(s);
    const parsed=parseRunnerId(reference); if(!parsed) throw Error('invalid runner id');
    // Remote rules (agents, account homes) are enforced when the edited strategy is validated.
    if(parsed.host && !Object.hasOwn(s.hosts,parsed.host)) throw Error(`unknown host ${parsed.host} (hosts: ${Object.keys(s.hosts).join(', ') || 'none'})`);
    const defaults=runnerDefaults(s.accounts); delete defaults.opencode;
    const name=parsed.account ?? defaults[parsed.agent],a=s.accounts[name ?? ''];
    if(!a || !allowedPair(parsed.agent,a.kind)) throw Error('agent/account pairing not allowed or account not found');
    const id=formatRunnerId({...parsed,account:a.name},defaults);
    if(verb==='add') {
      if(s.runners[id]) throw Error(`runner ${id} already exists`);
      const diff=applyEdit(ctx,doc=>{
        const settings = {...(options.model ? {model:options.model} : {}), ...(options.max_tasks !== undefined ? {max_tasks:options.max_tasks}:{}), ...(options.test !== undefined ? {test:options.test}:{})};
        if(Object.keys(settings).length) doc.addMappingEntry('runners',id,settings);
        // Materialize the effective routing before adding a runner, preserving every rule.
        const raw=docValue(doc,['routing']);
        if(!Array.isArray(raw)) doc.setIn(['routing'],s.routing.map(r=>r.kinds?{kinds:r.kinds,executors:r.executors}:{default:r.executors}));
        const rules=docValue(doc,['routing']) as Record<string,unknown>[];
        const kinds=options.kinds;
        const index=rules.findIndex(r=>kinds ? Array.isArray(r.kinds) && r.kinds.length===kinds.length && kinds.every(k=>(r.kinds as string[]).includes(k)) : Array.isArray(r.default));
        if(index>=0) {
          const key=kinds?'executors':'default';
          doc.setList(['routing',index,key],[...(rules[index][key] as string[]),id]);
        } else if(kinds) {
          const at=rules.findIndex(r=>Array.isArray(r.default));
          const node=doc.getIn(['routing']);
          if(!isSeq(node)) throw Error('routing must be a list');
          const updated=node.clone();
          updated.items.splice(at<0?rules.length:at,0,new Document().createNode({kinds,executors:[id]}));
          doc.replaceNode(['routing'],updated as Node);
        } else doc.setIn(['routing'],[...rules,{default:[id]}]);
        if(options.rank!==undefined) moveRank(doc,s,id,options.rank);
      });
      return {id, diff};
    }
    if(verb==='rm') {
      const r=resolveRunner(s,id); if(!r) throw Error('unknown runner');
      if(r.agent===s.planner.agent && r.account===s.planner.account) throw Error('planner runner is in use');
      if(Object.keys(s.runners).length<=1) throw Error('cannot remove the last runner');
      const diff=applyEdit(ctx,doc=>{
        const declarations=docValue(doc,['runners']) as Record<string,unknown>|undefined;
        for(const key of Object.keys(declarations ?? {})) if(resolveRunner(s,key)?.id===id) doc.removeMappingEntry('runners',key);
        const rules=docValue(doc,['routing']);
        const sourceRules=Array.isArray(rules) ? rules : s.routing.map(rule=>rule.kinds?{kinds:rule.kinds,executors:rule.executors}:{default:rule.executors});
        const remainingRules=sourceRules.map((rule: Record<string, any>)=>{
          const key=Array.isArray(rule.default)?'default':'executors';
          return {...rule,[key]:rule[key].filter((v:string)=>resolveRunner(s,v)?.id!==id)};
        }).filter((rule: Record<string, any>)=>(rule.default ?? rule.executors).length);
        if(!Array.isArray(rules)) doc.setIn(['routing'],remainingRules);
        else {
          // Edit list values in place, then retain the YAML nodes (and comments)
          // of surviving rules when removing a now-empty rule.
          sourceRules.forEach((rule: Record<string, any>,i:number)=>{
            const key=Array.isArray(rule.default)?'default':'executors';
            doc.setList(['routing',i,key],rule[key].filter((v:string)=>resolveRunner(s,v)?.id!==id));
          });
          if(remainingRules.length!==sourceRules.length) {
            const node=doc.getIn(['routing']);
            if(!isSeq(node)) throw Error('routing must be a list');
            const updated=node.clone();
            updated.items=updated.items.filter(item=>{
              const rule=isNode(item)?item.toJSON():item;
              return (rule.default ?? rule.executors).length;
            });
            doc.replaceNode(['routing'],updated as Node);
          }
        }
        const order=docValue(doc,['pacing','order']);
        if(Array.isArray(order)) doc.setList(['pacing','order'],order.filter(v=>resolveRunner(s,String(v))?.id!==id));
      });
      return {id, removed: true as const, diff};
    }
    throw Error("unknown runner action");
  } catch (e) {
    const error = toCoreError(e);
    throw new CoreError(error.code, error.message, error.hint ?? "Check the runner id, account and host configuration.");
  }
}
export interface AddOptions {agent?: AgentId; account?: string; host?: string; model?: string; rank?: number; kinds?: string[]; max_tasks?: number; test?: boolean}
export function add(ctx: Ctx, options: AddOptions & {agent:AgentId}) {
  if(options.rank!==undefined) validRank(options.rank);
  if(options.kinds && (!options.kinds.length || new Set(options.kinds).size!==options.kinds.length)) throw new CoreError("invalid_input","kinds must be a nonempty set");
  const reference = options.agent + (options.account ? `#${options.account}` : "") + (options.host ? `@${options.host}` : "");
  return change(ctx, "add", reference, options);
}
export function remove(ctx: Ctx, id: string) { return change(ctx, "rm", id); }
function executorIds(s: ReturnType<typeof loadStrategy>) {
  return Object.values(s.runners).filter(r=>!(r.agent===s.planner.agent && r.account===s.planner.account)).map(r=>r.id);
}
function validRank(rank:number) { if(!Number.isInteger(rank) || rank<0) throw new CoreError("invalid_input","rank must be a nonnegative integer"); }
function moveRank(doc:StrategyDoc,s:ReturnType<typeof loadStrategy>,id:string,rank:number) {
  validRank(rank);
  const ids=executorIds(s);
  const order=[...new Set([...s.pacing.order.flatMap(ref=>ref==='opencode'?ids.filter(v=>s.runners[v].agent==='opencode'):[resolveRunner(s,ref)?.id ?? ref]),...ids])].filter(v=>v!==id && ids.includes(v));
  order.splice(Math.min(rank,order.length),0,id); doc.setList(['pacing','order'],order);
}
export function set(ctx:Ctx,reference:string,o:{enabled?:boolean;model?:string|null;max_tasks?:number;rank?:number}) {
  const s=loadStrategy(ctx); requireAccounts(s);
  const r=resolveRunner(s,reference); if(!r) throw new CoreError("invalid_input","unknown runner");
  if(r.agent===s.planner.agent && r.account===s.planner.account) throw new CoreError("not_allowed","cannot edit the planner runner");
  if(o.rank!==undefined) validRank(o.rank);
  applyEdit(ctx,doc=>{
    // Update the existing declaration even when it uses a transitional alias.
    const raw=docValue(doc,['runners']) ?? {};
    const key=Object.keys(raw).find(key=>resolveRunner(s,key)?.id===r.id) ?? r.id;
    for(const name of ['enabled','model','max_tasks'] as const) if(o[name]!==undefined) doc.setIn(['runners',key,name],o[name]);
    if(o.rank!==undefined) moveRank(doc,s,r.id,o.rank);
  });
  const updated=loadStrategy(ctx);
  const warnings=o.enabled===false ? updated.routing.filter(rule=>rule.executors.some(id=>resolveRunner(updated,id)?.id===r.id) && !rule.executors.some(id=>{const candidate=resolveRunner(updated,id);return candidate && candidate.enabled!==false && !(candidate.agent===s.planner.agent && candidate.account===s.planner.account);})).map(rule=>`routing rule '${rule.kinds?.join(',') ?? 'default'}' has no enabled executor left`) : [];
  return {id:r.id,warnings};
}
export function reorder(ctx:Ctx,ids:string[]) {
  const s=loadStrategy(ctx); requireAccounts(s); const expected=executorIds(s);
  if(ids.length!==expected.length || new Set(ids).size!==ids.length || ids.some(id=>!expected.includes(id))) throw new CoreError("invalid_input","ids must be a permutation of the non-planner runners");
  applyEdit(ctx,doc=>doc.setList(['pacing','order'],ids)); return {order:ids};
}
