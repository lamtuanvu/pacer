import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isNode } from 'yaml';
import { loadStrategy, strategyPath, type Strategy } from '../config/strategy';
import { orderedExecutorIds, resolveRunner } from '../config/runner-id';
import { ensureAccounts } from './accounts';
import { slotLimit } from '../engine/slots';
import { withLock } from './lock';
import { CoreError } from './errors';
import type { Ctx } from '../types';

export interface ExecutorSettings {
  revision: string;
  order: string[];
  runners: {id: string; enabled: boolean; maxTasks: number}[];
}
export interface ExecutorSettingsInput {
  expectedRevision: string;
  order: string[];
  runners: ExecutorSettings['runners'];
}
const revision = (text: string) => createHash('sha256').update(text).digest('hex');
function projection(s: Strategy, text: string): ExecutorSettings {
  const order = orderedExecutorIds(s);
  return {revision: revision(text), order, runners: order.map(id => {
    const r = s.runners[id];
    return {id, enabled: r.enabled !== false, maxTasks: slotLimit(s,id).executor};
  })};
}
export function readExecutorSettings(ctx: Ctx): ExecutorSettings {
  const path = strategyPath(ctx), text = readFileSync(path, 'utf8'), s = loadStrategy(ctx);
  if (readFileSync(path, 'utf8') !== text) throw new CoreError('conflict', 'Executor settings changed. Reload saved settings.');
  return projection(s, text);
}
/** Validate the complete draft before one strategy write; competing saves share a process-safe lock. */
export async function saveExecutorSettings(ctx: Ctx, input: ExecutorSettingsInput): Promise<ExecutorSettings & {warnings: string[]}> {
  return withLock(ctx, 'executor-settings', async () => {
    const path = strategyPath(ctx), text = readFileSync(path, 'utf8'), s = loadStrategy(ctx);
    if (input.expectedRevision !== revision(text)) throw new CoreError('conflict', 'Executor settings changed elsewhere.', 'Reload saved settings, then reapply your changes.');
    const ids = orderedExecutorIds(s);
    const permutation = (values: string[]) => values.length === ids.length && new Set(values).size === ids.length && values.every(id => ids.includes(id));
    if (!permutation(input.order) || !permutation(input.runners.map(r => r.id)) || input.runners.some(r => typeof r.enabled !== 'boolean' || !Number.isInteger(r.maxTasks) || r.maxTasks < 1 || r.maxTasks > 16)) {
      throw new CoreError('invalid_input', 'Provide every executor once, with parallel tasks from 1 to 16.');
    }
    // Migration preserves old values and creates its established backup. Draft
    // validation precedes it; all editable fields still commit in one edit.
    const prepared = ensureAccounts(ctx), source = readFileSync(path, 'utf8');
    if (!prepared.migrated && source !== text) throw new CoreError('conflict', 'Executor settings changed. Reload saved settings.');
    prepared.edit(doc => {
      if (doc.toString() !== source) throw new Error('strategy changed during edit; retry');
      const raw = doc.getIn(['runners']);
      const declarations = (isNode(raw) ? raw.toJSON() : raw) as Record<string, unknown> | undefined;
      for (const r of input.runners) {
        const key = Object.keys(declarations ?? {}).find(key => resolveRunner(s, key)?.id === r.id) ?? r.id;
        doc.setIn(['runners', key, 'enabled'], r.enabled);
        doc.setIn(['runners', key, 'max_tasks'], r.maxTasks);
      }
      doc.setList(['pacing', 'order'], input.order);
    });
    const updated = loadStrategy(ctx);
    const warnings = updated.routing.filter(rule => !rule.executors.some(ref => {
      const r = resolveRunner(updated, ref);
      return r && ids.includes(r.id) && r.enabled !== false;
    })).map(rule => `Routing rule '${rule.kinds?.join(', ') ?? 'default'}' has no enabled executor left.`);
    return {...projection(updated, readFileSync(path, 'utf8')), warnings};
  });
}
