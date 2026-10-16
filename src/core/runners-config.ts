import { isNode, isSeq, type Node } from "yaml";
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
function change(ctx: Ctx, verb: "add" | "rm", reference: string, model?: string) {
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
        if (model) doc.addMappingEntry('runners',id,{model});
        // Materialize the effective routing before adding a runner, preserving every rule.
        const raw=docValue(doc,['routing']);
        if(!Array.isArray(raw)) doc.setIn(['routing'],s.routing.map(r=>r.kinds?{kinds:r.kinds,executors:r.executors}:{default:r.executors}));
        const rules=docValue(doc,['routing']) as Record<string,unknown>[];
        const index=rules.findIndex(r=>Array.isArray(r.default));
        if(index<0) doc.setIn(['routing'],[...rules,{default:[id]}]);
        else doc.setList(['routing',index,'default'],[...(rules[index].default as string[]),id]);
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
export function add(ctx: Ctx, options: {agent: AgentId; account?: string; host?: string; model?: string}) {
  const reference = options.agent + (options.account ? `#${options.account}` : "") + (options.host ? `@${options.host}` : "");
  return change(ctx, "add", reference, options.model);
}
export function remove(ctx: Ctx, id: string) { return change(ctx, "rm", id); }
