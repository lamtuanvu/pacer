import type { CallResources } from './authority';

/** Security projection only: the host grants one literal vector, never performs delivery. */
export function notifierResources(platform: string, title: string, body: string): CallResources {
  const argv = platform === 'darwin'
    ? ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
    : platform === 'linux' ? ['notify-send', '--', title, body] : null;
  return { reads: [], commands: argv ? [{ argv, timeoutMs: 5000 }] : [], stores: [] };
}
