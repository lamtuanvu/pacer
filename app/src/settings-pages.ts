import type { IconName } from './ds/icons';
import type { ClientSnapshot } from '../../src/view-model/snapshot';
import type { Counts } from '../../src/api/read-model/types';
import { desktopUpdateIndicator } from '../../src/view-model/updates';

export type SettingsGroupId = 'dispatch' | 'extend' | 'app';
export interface SettingsPage { id: string; label: string; icon: IconName; group: SettingsGroupId; description?: string; title?: string }

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'extend', label: 'Extend' },
  { id: 'app', label: 'App' },
];

/** One navigation catalog for the settings menu, the Overview page and shell page titles, in menu order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: '', label: 'Overview', icon: 'settings-home', group: 'dispatch' },
  { id: 'executors', label: 'Agents', icon: 'settings-agents', group: 'dispatch', description: 'Agents that take delegated work, their order and limits.' },
  { id: 'dispatcher', label: 'Dispatcher', icon: 'settings-routing', group: 'dispatch', description: 'Saved profiles and the rules that choose an executor.' },
  { id: 'planner', label: 'Budget & pacing', icon: 'settings-budget', group: 'dispatch', description: 'The planner, how work spreads and the reserve kept for planning.' },
  { id: 'machine', label: 'Machines', title: 'This machine', icon: 'settings-machines', group: 'dispatch', description: 'Parallel tasks and the terminal used on this machine.' },
  { id: 'plugins', label: 'Plugins', icon: 'settings-plugins', group: 'extend', description: 'Add capabilities and choose where they appear.' },
  { id: 'app', label: 'App preferences', icon: 'settings-app', group: 'app', description: 'Updates, notifications and appearance.' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'settings-diagnostics', group: 'app', description: 'Check setup and repair supported integrations.' },
];

/** Sections that are now part of another page; their deep links keep working. */
const SETTINGS_PAGE_OF: Readonly<Record<string, string>> = { updates: 'app', notifications: 'app', appearance: 'app' };

export function settingsPageId(section = ''): string {
  return SETTINGS_PAGE_OF[section] ?? section;
}

/** Secondary pages keep their routes and select their parent navigation category. */
export function settingsNavId(section = ''): string {
  return section === 'accounts' || section === 'add-executor' ? 'executors' : section === 'hosts' ? 'machine' : section === 'assistant' ? 'app' : settingsPageId(section);
}

/** App preferences already shows update status, so the floating update notice stays hidden there. */
export function updateNoticeHiddenOn(route: { name: string; section?: string }): boolean {
  return route.name === 'settings' && settingsPageId(route.section) === 'app';
}

export function settingsPageTitle(section = ''): string {
  if (section === 'accounts') return 'Accounts';
  if (section === 'assistant') return 'Assistant';
  const page = SETTINGS_PAGES.find(page => page.id === settingsPageId(section));
  return page?.title ?? page?.label ?? 'Overview';
}

export interface SettingsAttention { text: string; label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }

/** Real page attention for Overview; the navigation shows only the Agents count from the board. */
export function settingsAttention(snapshot?: ClientSnapshot | null, counts?: Counts | null): Partial<Record<string, SettingsAttention>> {
  const hosts = snapshot?.hosts ? snapshot.hosts.filter(host => host.state === 'needs_setup').length : counts?.hostsWithProblems ?? 0;
  const down = snapshot?.executors?.filter(e => e.state === 'down' || e.state === 'failing').length ?? 0;
  const blocked = snapshot?.executors?.filter(e => e.state === 'blocked').length ?? 0;
  const update = desktopUpdateIndicator(snapshot?.desktopUpdates);
  const result: Partial<Record<string, SettingsAttention>> = {};
  const executorWords = [down && `${down} ${down === 1 ? 'needs' : 'need'} attention`, blocked && `${blocked} blocked`].filter(Boolean).join(', ');
  if (executorWords) result.executors = { text: String(down + blocked), label: executorWords, tone: 'bad' };
  if (hosts) result.machine = { text: `${hosts} ${hosts === 1 ? 'needs' : 'need'} setup`, label: `${hosts} ${hosts === 1 ? 'needs' : 'need'} setup`, tone: 'warn' };
  if (update?.glyph) result.app = { text: update.glyph, label: update.label, tone: (['bad', 'warn', 'info'] as const).find(tone => tone === update.tone) ?? 'neutral' };
  return result;
}
