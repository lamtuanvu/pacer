import { ApiError, type ApiClient } from "../api/client";
import type { ApiEvent } from "../api/protocol";

/** Keep the dashboard usable after its daemon disappears. */
export function withFallback(primary: ApiClient, makeLocal: () => ApiClient, onSwitch: () => void): ApiClient {
  let current = primary, closed = false, seq = 0;
  const subscriptions = new Set<{ since: number; onEvent: (e: ApiEvent) => void; stop: () => void }>();
  const subscribe = (subscription: { since: number; onEvent: (e: ApiEvent) => void; stop: () => void }) => {
    subscription.stop = current.subscribe(Math.max(seq, subscription.since), event => {
      subscription.since = event.seq;
      subscription.onEvent(event);
    });
  };
  // Reads retry on the local client; operations only switch, because the daemon may already have applied them.
  const request = async <T>(run: (client: ApiClient) => Promise<T>, retry = true): Promise<T> => {
    const source = current;
    try { return await run(source); }
    catch (error) {
      if (closed || source.kind !== "http" || error instanceof ApiError) throw error;
      if (current === source) {
        current = makeLocal();
        for (const subscription of subscriptions) subscription.stop();
        source.close();
        for (const subscription of subscriptions) subscribe(subscription);
        onSwitch();
      }
      if (!retry) throw error;
      return await run(current);
    }
  };
  return {
    get kind() { return current.kind; },
    hello: () => request(client => client.hello()),
    snapshot: async () => {
      const result = await request(client => client.snapshot());
      seq = result.seq;
      return result;
    },
    call: <T>(op: string, params?: unknown) => request(client => client.call<T>(op, params), false),
    subscribe: (since, onEvent) => {
      if (closed) return () => {};
      const subscription = { since, onEvent, stop: () => {} };
      subscriptions.add(subscription);
      subscribe(subscription);
      return () => { subscription.stop(); subscriptions.delete(subscription); };
    },
    close: () => {
      closed = true;
      for (const subscription of subscriptions) subscription.stop();
      subscriptions.clear();
      current.close();
    },
  };
}
