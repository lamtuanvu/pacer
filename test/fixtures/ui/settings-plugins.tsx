import { render } from 'preact';
import { useState } from 'preact/hooks';
import { PluginsPage } from '../../../app/src/screens/settings/PluginsPage';
import { PluginsSection } from '../../../app/src/screens/settings/Plugins';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { ActionContext } from '../../../app/src/data/action-context';
import { createActionRunner } from '../../../app/src/data/actions';
import { initialState } from '../../../app/src/data/store';
import { DensityContext } from '../../../app/src/ds/Density';

const fixture = (window as any).fixture;
const calls: { op: string; params: any }[] = [];
(window as any).calls = calls;
let invalidate = () => {};
let listCalls = 0;
const api = { call: async (op: string, params: any) => {
  calls.push({ op, params });
  if (op === 'plugin.list') {
    const reload = listCalls++ > 0;
    if (reload && fixture.listDelay) await new Promise(resolve => setTimeout(resolve, fixture.listDelay));
    if (fixture.failList || reload && fixture.failReload) throw Error('Could not load plugins');
    (window as any).listsSettled = listCalls;
    (window as any).lastListedPlugins = structuredClone(fixture.plugins);
    return { plugins: structuredClone(fixture.plugins) };
  }
  if (fixture.actionDelay) await new Promise(resolve => setTimeout(resolve, fixture.actionDelay));
  if (fixture.delayedInvalidation) setTimeout(() => invalidate(), 1000);
  if (fixture.failAction || fixture.failGrant && params?.grant) throw Error('Could not change plugin');
  if (op === 'plugin.enable' && fixture.needsGrant && !params.grant) return { state: 'needs_grant', needs: ['config.read'], surfaces: ['settings'] };
  const plugin = fixture.plugins.find((p: any) => p.id === params.id);
  plugin.enabled = op === 'plugin.enable';
  return { id: params.id, state: plugin.enabled ? 'idle' : 'disabled' };
} } as any;
const runner = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
function Fixture() {
  const [state, setState] = useState(initialState);
  invalidate = () => setState(current => ({ ...current, invalidations: { plugin: (current.invalidations.plugin ?? 0) + 1 } }));
  return <ActionContext.Provider value={runner}><TaskContext.Provider value={{ state, api }}><DensityContext.Provider value="settings">{fixture.page ? <PluginsPage /> : <PluginsSection />}</DensityContext.Provider></TaskContext.Provider></ActionContext.Provider>;
}
render(<Fixture />, document.getElementById('app')!);
