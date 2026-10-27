import type { IconName } from './ds/icons';
import type { ClientSnapshot } from '../../src/view-model/snapshot';
import type { Counts } from '../../src/api/read-model/types';
import { desktopUpdateIndicator } from '../../src/view-model/updates';

export type SettingsGroupId = 'dispatch' | 'app';
export interface SettingsPage { id: string; label: string; icon: IconName; group: SettingsGroupId; description?: string }

export const SETTINGS_GROUPS: readonly { id: SettingsGroupId; label: string }[] = [
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'app', label: 'App' },
];

/** One navigation catalog for the settings menu, the Overview page and shell page titles, in menu order. */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  { id: '', label: 'Overview', icon: 'sliders', group: 'dispatch' },
  { id: 'executors', label: 'Executors', icon: 'executors', group: 'dispatch', description: 'Agents that take delegated work, their order and limits.' },
  { id: 'add-executor', label: 'Add executor', icon: 'plus', group: 'dispatch' },
  { id: 'accounts', label: 'Accounts', icon: 'accounts', group: 'dispatch', description: 'Sign-ins and usage for each agent account.' },
  { id: 'dispatcher', label: 'Dispatcher', icon: 'routing', group: 'dispatch', description: 'Saved profiles and the rules that choose an executor.' },
  { id: 'planner', label: 'Budget & pacing', icon: 'gauge', group: 'dispatch', description: 'The planner, how work spreads and the reserve kept for planning.' },
  { id: 'machine', label: 'This machine', icon: 'hosts', group: 'dispatch', description: 'Parallel tasks and the terminal used on this machine.' },
  { id: 'hosts', label: 'Remote hosts', icon: 'servers', group: 'dispatch', description: 'SSH hosts that can run executors.' },
  { id: 'app', label: 'App preferences', icon: 'palette', group: 'app', description: 'Updates, notifications and appearance.' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'diagnostics', group: 'app', description: 'Check setup and repair supported integrations.' },
];

/** Sections that are now part of another page; their deep links keep working. */
const SETTINGS_PAGE_OF: Readonly<Record<string, string>> = { updates: 'app', notifications: 'app', appearance: 'app' };

export function settingsPageId(section = ''): string {
  return SETTINGS_PAGE_OF[section] ?? section;
}

export function settingsPageTitle(section = ''): string {
  return SETTINGS_PAGES.find(page => page.id === settingsPageId(section))?.label ?? 'Overview';
}

export interface SettingsAttention { text: string; label: string; tone: 'good' | 'warn' | 'bad' | 'info' | 'neutral' }

/** Page badges shared by the settings menu and the Overview rows, so they never disagree. */
export function settingsAttention(snapshot?: ClientSnapshot | null, counts?: Counts | null): Partial<Record<string, SettingsAttention>> {
  const hosts = snapshot?.hosts ? snapshot.hosts.filter(host => host.state === 'needs_setup').length : counts?.hostsWithProblems ?? 0;
  const down = snapshot?.executors?.filter(e => e.state === 'down' || e.state === 'failing').length ?? 0;
  const blocked = snapshot?.executors?.filter(e => e.state === 'blocked').length ?? 0;
  const update = desktopUpdateIndicator(snapshot?.desktopUpdates);
  const result: Partial<Record<string, SettingsAttention>> = {};
  if (down + blocked) result.executors = { text: String(down + blocked), label: `${down} need attention; ${blocked} blocked`, tone: 'bad' };
  if (snapshot?.accounts?.length) result.accounts = { text: String(snapshot.accounts.length), label: `${snapshot.accounts.length} ${snapshot.accounts.length === 1 ? 'account' : 'accounts'}`, tone: 'neutral' };
  if (hosts) result.hosts = { text: `${hosts} needs setup`, label: `${hosts} needs setup`, tone: 'warn' };
  if (update?.glyph) result.app = { text: update.glyph, label: update.label, tone: (['bad', 'warn', 'info'] as const).find(tone => tone === update.tone) ?? 'neutral' };
  return result;
}
