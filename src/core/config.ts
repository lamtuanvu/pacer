import { isTerminalPreset, TERMINAL_PRESET_ERROR } from '../session/terminal-presets';
import { Document } from 'yaml';
import { publishConfigChange } from "./events";
import { readFileSync } from "node:fs";
import { atomicStrategyWrite, editStrategy, StrategyDoc } from "../config/edit";
import { formatRunnerId, parseRunnerId, runnerDefaults } from "../config/runner-id";
import { loadStrategy, strategyPath, validateStrategy, type Strategy } from "../config/strategy";
import { readManifest } from "../install/manifest";
import { installPlanner } from "../install";
import { pacerArgv } from "../install/self";
import { uninstallPlanner } from "../install/uninstall";
import { shq } from "../install/fsx";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import { PLANNERS } from "../config/strategy";
import { plannerAccounts } from "../install/init";

import { validateExecution } from '../config/execution';

const pendingEdits = new Set<string>();

export const CONFIG_KEYS = ['task_retention_days','execution.local_max_tasks','planner','pacing.order','pacing.policy','pacing.planner_reserve','pacing.accounts','pacing.fill_threshold','update_check','terminal.app','terminal.open'] as const;
export type ConfigKey = typeof CONFIG_KEYS[number];
function plannerId(s: Strategy): string {
  return formatRunnerId({...s.planner,host:null},{...runnerDefaults(s.accounts),opencode:undefined});
}
function effective(s: Strategy, raw: StrategyDoc): Record<ConfigKey, unknown> {
  return {task_retention_days:s.taskRetentionDays ?? 14,'execution.local_max_tasks':validateExecution(s.execution).localMaxTasks ?? 2,'terminal.open':s.terminal?.open ?? '',planner:plannerId(s),'pacing.order':s.pacing.order,'pacing.policy':s.pacing.policy,
    'pacing.planner_reserve':s.pacing.plannerReserve,'pacing.accounts':s.pacing.accounts,
    'pacing.fill_threshold':s.pacing.fillThreshold,update_check:raw.getIn(['update_check']) ?? true,'terminal.app':raw.getIn(['terminal','app']) ?? 'Terminal'};
}
function parseValue(key:ConfigKey, value:string): unknown {
  if (key === 'task_retention_days') {
    const days = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(days) || days < 0) throw new CoreError('invalid_input', 'task_retention_days must be a non-negative integer');
    return days;
  }
  if(key==='terminal.app' && !['Terminal','iTerm','Ghostty'].includes(value)) throw Error('terminal.app must be Terminal, iTerm or Ghostty');
  if(key==='execution.local_max_tasks') {
    const n = Number(value);
    if(!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 16) throw new CoreError('invalid_input', 'execution.local_max_tasks must be an integer from 1 to 16');
    return n;
  }
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
/** Effective allow-listed configuration and compatible planner candidates. */
export function get(ctx: Ctx) {
  try {
    const s = loadStrategy(ctx), path = strategyPath(ctx), doc = new StrategyDoc(readFileSync(path, 'utf8')), values = effective(s, doc);
    return {
      keys: Object.fromEntries(CONFIG_KEYS.map(key => [key, {value: values[key], source: doc.getIn(key.split('.')) === undefined ? 'default' : path}])),
      planners: PLANNERS.flatMap(agent => plannerAccounts(ctx, s, agent).map(a => formatRunnerId({agent, account: a.name, host: null}, {...runnerDefaults(s.accounts), opencode: undefined}))),
    };
  } catch (e) { throw toCoreError(e); }
}

/** Validate before writing; integration failure rolls back our strategy edit. */
export async function set(ctx: Ctx, keyInput: string, input: unknown, options: {integrations?: "install" | "skip"; terminalPresetsOnly?: boolean} = {}) {
  const editKey = `${strategyPath(ctx)}:${keyInput}`;
  if (pendingEdits.has(editKey)) throw new CoreError('conflict', 'This setting is already being changed', 'Refresh and retry.');
  pendingEdits.add(editKey);
  try {
    const path=strategyPath(ctx), s=loadStrategy(ctx), before=readFileSync(path,'utf8'), doc=new StrategyDoc(before), values=effective(s,doc);
    const applyEdit = (change: Parameters<typeof editStrategy>[1]) => {
      if (readFileSync(path, 'utf8') !== before) throw new CoreError('conflict', 'Strategy changed during edit', 'Refresh and retry.');
      const result = editStrategy(path, change);
      if (!result.ok) throw new CoreError(result.error.includes("strategy changed during edit") ? "conflict" : "invalid_input", result.error);
      return result.diff;
    };
    const k = keyInput;
    if (k === "planner" && !["install", "skip"].includes(options.integrations ?? "")) throw new CoreError("invalid_input", "planner requires an integration choice", 'integrations: "install" or "skip"');
    if(!(CONFIG_KEYS as readonly string[]).includes(k)) throw Error(`unknown config key: ${k}`);
    const key=k as ConfigKey;
    if (Array.isArray(input) && k !== 'pacing.order') throw new CoreError("invalid_input", `${k} requires a scalar value`, "Use a list only for pacing.order");
    const v = Array.isArray(input) ? input.join(',') : String(input);
    if (typeof input !== 'string' && typeof input !== 'number' && typeof input !== 'boolean' && !(Array.isArray(input) && input.every(v => typeof v === 'string'))) throw new CoreError("invalid_input", "config value must be a scalar or string list");
    if(key==='terminal.open' && options.terminalPresetsOnly && !isTerminalPreset(v))
      throw new CoreError("invalid_input", TERMINAL_PRESET_ERROR, 'Use pacer config set terminal.open to configure a custom template.');
    const value=parseValue(key,v),undo=`pacer config set ${key} ${undoValue(values[key])}`;
    const setValue=(target:StrategyDoc)=>{
      if(key==='terminal.open' && target.getIn(['terminal','open'])!==undefined){
        // A template may contain braces inside an existing flow mapping.
        const node=new Document().createNode(String(value));node.type='QUOTE_DOUBLE';
        target.replaceNode(['terminal','open'],node);
      }else target.setIn(key.split('.'),value);
    };
    // Preflight the whole result before any integration or strategy writes.
    setValue(doc);
    const next=validateStrategy(Bun.YAML.parse(doc.toString()),path);
    let diff=''; const notes: string[]=[];
    if(key==='planner' && options.integrations !== 'skip') {
      if(!s.accounts[next.planner.account]) throw Error('planner account not found');
      if(next.planner.agent!==s.planner.agent || next.planner.account!==s.planner.account) {
        const manifest=readManifest(ctx);
        const oldRecord=manifest.planners[`${s.planner.agent}#${s.planner.account}`] ?? manifest.planners[s.planner.agent];
        diff=applyEdit(d=>d.setIn(['planner'],value));
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
    } else diff=applyEdit(d=>Array.isArray(value)?d.setList(key.split('.'),value):setValue(d));
    await publishConfigChange(ctx, "config");
    return {key, value: effective(next,doc)[key], previous: values[key], diff, undo, notes};
  } catch (e) { throw toCoreError(e); } finally { pendingEdits.delete(editKey); }
}
