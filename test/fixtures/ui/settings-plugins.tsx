import { render } from 'preact';
import { PluginsSection } from '../../../app/src/screens/settings/Plugins';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { initialState } from '../../../app/src/data/store';
import { DensityContext } from '../../../app/src/ds/Density';

const fixture = (window as any).fixture;
const calls: { op: string; params: any }[] = [];
(window as any).calls = calls;
const api = { call: async (op: string, params: any) => {
  calls.push({ op, params });
  if (fixture.failList && op === 'plugin.list') throw Error('Not allowed');
  if (op === 'plugin.list') return { plugins: structuredClone(fixture.plugins) };
  if (fixture.failAction) throw Error('Could not change plugin');
  if (op === 'plugin.enable' && fixture.needsGrant && !params.grant) return { state: 'needs_grant', needs: ['config.read'], surfaces: ['settings'] };
  const plugin = fixture.plugins.find((p: any) => p.id === params.id);
  plugin.enabled = op === 'plugin.enable';
  return { id: params.id, state: plugin.enabled ? 'idle' : 'disabled' };
} } as any;
const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
render(<ActionContext.Provider value={runner}><TaskContext.Provider value={{ state: initialState(), api }}><DensityContext.Provider value="settings"><PluginsSection /></DensityContext.Provider></TaskContext.Provider></ActionContext.Provider>, document.getElementById('app')!);
