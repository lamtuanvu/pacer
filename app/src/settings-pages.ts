import type { IconName } from './ds/icons';

/** One navigation catalog for the sidebar, General links and shell page titles. */
export const SETTINGS_PAGES: readonly { id: string; label: string; icon: IconName }[] = [
  { id: '', label: 'General', icon: 'sliders' },
  { id: 'planner', label: 'Planner & pacing', icon: 'gauge' },
  { id: 'accounts', label: 'Accounts', icon: 'accounts' },
  { id: 'executors', label: 'Executors', icon: 'executors' },
  { id: 'machine', label: 'This machine', icon: 'hosts' },
  { id: 'hosts', label: 'Remote hosts', icon: 'servers' },
  { id: 'dispatcher', label: 'Dispatcher', icon: 'routing' },
  { id: 'updates', label: 'Updates', icon: 'download' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'diagnostics' },
  { id: 'add-executor', label: 'Add executor', icon: 'plus' },
];

export function settingsPageTitle(section = ''): string {
  return SETTINGS_PAGES.find(page => page.id === section)?.label ?? 'General';
}
