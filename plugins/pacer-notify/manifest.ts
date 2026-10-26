import type { PluginManifest } from '@pacer/plugin';

export const manifest = {
  id: 'pacer-notify', version: '0.1.0', publisher: 'pacer', host: '^1.3',
  contributes: { notifier: { kinds: ['os'] } },
  capabilities: [{ name: 'process.spawn' as const, scopes: ['osascript', 'notify-send'] }, { name: 'config.get' as const }, { name: 'log' as const }],
  reentrant: false, tier: 'free' as const,
} satisfies PluginManifest;
