import { PluginError, serve, type Handler } from '@pacer/plugin';
import { z } from 'zod';

import { manifest } from './manifest';
export { manifest } from './manifest';

const notification = z.object({
  key: z.string(), title: z.string().max(256), body: z.string().max(2048), url: z.string(),
});
const configuration = z.object({ platform: z.string().optional() });
interface SpawnResult { code: number; timedOut: boolean }

export const handlers = {
  'notifier.deliver': async (params, host, signal) => {
    const parsed = notification.safeParse(params);
    if (!parsed.success) throw new PluginError('invalid_input', 'invalid notifier input');
    if (signal.aborted) return { delivered: false };
    try {
      // Only the host chooses platform and pins the fixed command's executable.
      const config = configuration.safeParse(await host.config());
      if (!config.success || signal.aborted) return { delivered: false };
      const platform = config.data.platform;
      if (platform !== 'darwin' && platform !== 'linux') return { delivered: false };
      const { title, body } = parsed.data;
      const argv = platform === 'darwin'
        ? ['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
        : ['notify-send', '--', title, body];
      const result = await host.call<SpawnResult>('capability.process.spawn', { argv, timeoutMs: 5000 });
      return { delivered: !signal.aborted && result.code === 0 && !result.timedOut };
    } catch {
      try { await host.log('warn', 'OS notification delivery failed'); } catch { /* Delivery failure must not fail the pump. */ }
      return { delivered: false };
    }
  },
} satisfies Record<string, Handler>;

if (import.meta.main) await serve({ manifest, handlers });
