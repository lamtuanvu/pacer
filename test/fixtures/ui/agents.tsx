import { renderToString } from 'preact-render-to-string';
import type { ComponentChildren } from 'preact';
import { AgentsTab } from '../../../app/src/screens/settings/Agents';
import { SettingsPageContext, SettingsQueryContext } from '../../../app/src/screens/settings/shared';
import { TaskContext } from '../../../app/src/screens/task-shared';
import { DensityContext } from '../../../app/src/ds/Density';
import type { AgentsTabProps } from '../../../app/src/screens/settings/agents-tab-props';
import type { RouteQuery } from '../../../app/src/router';

/** Dispatcher › Agents as SettingsGeneral mounts it, without the lazy chunk boundary. */
export function AgentsPage({ query = { repo: null, scope: null }, ...props }: AgentsTabProps & { query?: RouteQuery }) {
  return <DensityContext.Provider value="settings"><SettingsPageContext.Provider value="dispatcher"><SettingsQueryContext.Provider value={query}>
    <div className="u3-settings u3-settings-page"><AgentsTab {...props} /></div>
  </SettingsQueryContext.Provider></SettingsPageContext.Provider></DensityContext.Provider>;
}
export const renderAgents = (state: unknown, props: AgentsTabProps & { query?: RouteQuery } = {}, api: unknown = { call: async () => ({}) }, wrap: (child: ComponentChildren) => ComponentChildren = child => child) =>
  renderToString(<TaskContext.Provider value={{ state: state as never, api: api as never }}>{wrap(<AgentsPage {...props} />)}</TaskContext.Provider>);
