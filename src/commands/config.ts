import { readFileSync } from "node:fs";
import { atomicStrategyWrite, StrategyDoc } from "../config/edit";
import { migrateStrategy, migrationLines } from "../config/migrate";
import { formatRunnerId, parseRunnerId, runnerDefaults } from "../config/runner-id";
import { loadStrategy, strategyPath, validateStrategy, type Strategy } from "../config/strategy";
import { readManifest } from "../install/manifest";
import { installPlanner } from "../install";
import { pacerArgv } from "../install/self";
import { uninstallPlanner } from "../install/uninstall";
import { shq } from "../install/fsx";
import type { Ctx } from "../types";
import type { Result } from "./types";
import { applyEdit, commandArgs } from "./accounts";

export const CONFIG_KEYS = ['planner','pacing.order','pacing.policy','pacing.planner_reserve','pacing.accounts','pacing.fill_threshold','update_check'] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];
function plannerId(s: Strategy): string {
  return formatRunnerId({...s.planner,host:null},{...runnerDefaults(s.accounts),opencode:undefined});
}
function effective(s: Strategy, raw: StrategyDoc): Record<ConfigKey, unknown> {
  return {planner:plannerId(s),'pacing.order':s.pacing.order,'pacing.policy':s.pacing.policy,
    'pacing.planner_reserve':s.pacing.plannerReserve,'pacing.accounts':s.pacing.accounts,
    'pacing.fill_threshold':s.pacing.fillThreshold,update_check:raw.getIn(['update_check']) ?? true};
}
function parseValue(key:ConfigKey, value:string): unknown {
  if(key==='pacing.order') {
    if(value==='') return [];
    const ids=value.split(',').map(v=>v.trim()); if(ids.some(v=>!v)) throw Error('pacing.order requires comma-separated runner ids');
    return ids;
  }
  if(key==='update_check') {if(!['true','false'].includes(value)) throw Error('update_check must be true or false'); return value==='true';}
  if(key==='pacing.planner_reserve' || key==='pacing.fill_threshold') {
    if(!/^\d+(?:\.\d+)?$/.test(value)) throw Error(`${key} requires a finite number`);
    return Number(value);
  }
  if(key==='planner' && !parseRunnerId(value)) throw Error('planner requires a runner id');
  return value;
}
function undoValue(value: unknown): string {
  const v=Array.isArray(value)?value.join(','):String(value);
  return /^[a-zA-Z0-9#@.,_-]+$/.test(v)?v:shq(v);
}
/** Shared, allow-listed settings writer for the CLI and later settings surfaces. */
export async function configCmd(args:string[],ctx:Ctx): Promise<Result> {
  try {
    const [verb,...rest]=args;
    const {pos,flags}=commandArgs(rest,[],verb==='get'?['json']:[]);
    const path=strategyPath(ctx);
    if(verb==='migrate' && !pos.length) {
      const result=migrateStrategy(path);
      return {code:0,out:result.changed?migrationLines(path,result).join('\n'):'Strategy already uses accounts and runners; nothing changed.',err:''};
    }
    const s=loadStrategy(ctx),before=readFileSync(path,'utf8'),doc=new StrategyDoc(before),values=effective(s,doc);
    if(verb==='get' && pos.length<=1) {
      if(pos[0] && !(CONFIG_KEYS as readonly string[]).includes(pos[0])) throw Error(`unknown config key: ${pos[0]}`);
      const entries=Object.fromEntries(CONFIG_KEYS.map(key=>[key,{value:values[key],source:doc.getIn(key.split('.'))===undefined?'default':path}]));
      const result=pos[0]?entries[pos[0]]:entries;
      return {code:0,out:flags.json?JSON.stringify(result,null,2):(pos[0]?[`${pos[0]}: ${JSON.stringify(result.value)} (${result.source})`]:Object.entries(entries).map(([key,v])=>`${key}: ${JSON.stringify(v.value)} (${v.source})`)).join('\n'),err:''};
    }
    if(verb==='set' && pos.length===2) {
      const [k,v]=pos;
      if(!(CONFIG_KEYS as readonly string[]).includes(k)) throw Error(`unknown config key: ${k}`);
      const key=k as ConfigKey, value=parseValue(key,v),undo=`Undo: pacer config set ${key} ${undoValue(values[key])}`;
      // Preflight the whole result before any integration or strategy writes.
      doc.setIn(key.split('.'),value);
      const next=validateStrategy(Bun.YAML.parse(doc.toString()),path);
      let diff=''; const notes: string[]=[];
      if(key==='planner') {
        if(!s.accounts[next.planner.account]) throw Error('planner account not found');
        if(next.planner.agent!==s.planner.agent || next.planner.account!==s.planner.account) {
          const manifest=readManifest(ctx);
          const oldRecord=manifest.planners[`${s.planner.agent}#${s.planner.account}`] ?? manifest.planners[s.planner.agent];
          diff=applyEdit(ctx,d=>d.setIn(['planner'],value));
          try {
            const report=await installPlanner({ctx,pacerArgv:pacerArgv(ctx.env)},next.planner);
            notes.push(...report.notes);
            const removed=await uninstallPlanner(ctx,s.planner);
            if(removed) notes.push(...removed.notes);
            // OpenCode endpoints share a config folder. Removing the old
            // recorded install may remove files the new install reused.
            if(oldRecord?.folder && oldRecord.folder===report.record.folder) {
              const refreshed=await installPlanner({ctx,pacerArgv:pacerArgv(ctx.env)},next.planner);
              notes.push(...refreshed.notes);
            }
          } catch(e) {
            // Roll back only our own write; do not overwrite a concurrent editor.
            if(readFileSync(path,'utf8')===doc.toString()) atomicStrategyWrite(path,before);
            throw e;
          }
        }
      } else diff=applyEdit(ctx,d=>Array.isArray(value)?d.setList(key.split('.'),value):d.setIn(key.split('.'),value));
      return {code:0,out:[`${key}: ${JSON.stringify(values[key])} → ${JSON.stringify(effective(next,doc)[key])}`,diff,...notes,undo].filter(Boolean).join('\n'),err:''};
    }
    throw Error('usage: pacer config get [key] [--json] | set <key> <value> | migrate');
  } catch(e) {return {code:2,out:'',err:`pacer: ${e instanceof Error?e.message:String(e)}`};}
}
