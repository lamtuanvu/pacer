import { PluginError, type ObservationClient, type PolicyEvent } from '@pacer/plugin';

type BudgetHandler = (params: unknown, host: ObservationClient, signal: AbortSignal) => Promise<unknown>;
const eventTypes = ['task', 'activity', 'reset'] as const;
function notCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new PluginError('plugin_cancelled', 'Policy check cancelled');
}

/** An observational example, not an atomic reservation or a task-writing client. */
export function createBudgetPolicy() {
  let subscribed = false;
  let subscribing: Promise<void> | undefined;
  const startedAt = Date.now();
  async function subscribe(host: ObservationClient, signal?: AbortSignal) {
    notCancelled(signal);
    if (!subscribed) {
      subscribing ??= host.events.subscribe([...eventTypes]).then(() => { subscribed = true; }).finally(() => { subscribing = undefined; });
      await subscribing;
    }
    notCancelled(signal);
  }
  async function running(host: ObservationClient, signal?: AbortSignal) {
    notCancelled(signal);
    const config = await host.config();
    notCancelled(signal);
    const limit = config.N === undefined ? 3 : config.N;
    // A single bounded task-list response supports at most 500 observations.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new PluginError('invalid_input', 'N must be an integer from 1 to 500');
    }
    const tasks = await host.tasks.list({ states: ['running'], limit });
    notCancelled(signal);
    return { limit, count: tasks.length };
  }
  const handlers = {
    'diagnostic.ping': async (_params, host, signal) => {
      await subscribe(host, signal);
      await running(host, signal);
      return { ok: true, uptimeS: Math.max(0, (Date.now() - startedAt) / 1000) };
    },
    'policy.before': async (params, host, signal) => {
      notCancelled(signal);
      const decision = params && typeof params === 'object' && !Array.isArray(params) ? (params as { decision?: unknown }).decision : undefined;
      if (decision !== 'delegate' && decision !== 'route' && decision !== 'review') throw new PluginError('invalid_input', 'Unknown policy decision');
      await subscribe(host, signal);
      if (decision !== 'delegate') return { verdict: 'allow' };
      // Always read at admission; asynchronous event observations are not authority.
      const { limit, count } = await running(host, signal);
      return count >= limit ? { verdict: 'veto', reason: `Running task limit reached (${limit}).` } : { verdict: 'allow' };
    },
  } satisfies Record<string, BudgetHandler>;
  async function onEvent(event: PolicyEvent, host: ObservationClient) {
    if (!eventTypes.includes(event.type as typeof eventTypes[number])) return;
    if (event.type === 'reset') {
      subscribed = false;
      await subscribe(host);
    }
    const { count, limit } = await running(host);
    await host.log('debug', `Budget policy observation: ${count} running observed; limit ${limit}.`);
  }
  return { handlers, onEvent };
}
