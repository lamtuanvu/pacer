import { cmdToOp, runMappedCmd } from "../api/cmd";
export { cmdToOp, CMD_SUCCESS, runMappedCmd } from "../api/cmd";
import { ApiError, type ApiClient } from "../api/client";
import type { ApiEvent } from "../api/protocol";
import type { CmdData, LinkSnapshot } from "../link/envelope";
import { cards } from "./model";

export async function refreshView(
  client: ApiClient,
  view: { snapshot: LinkSnapshot; selected: number; now: number; ops?:readonly string[] },
): Promise<{ snapshot: LinkSnapshot; selected: number }> {
  const selectedId = cards(view.snapshot, view.now, view.ops).flatMap(g => g.cards)[view.selected]?.id;
  const { snapshot } = await client.snapshot();
  const updated = cards(snapshot, view.now, view.ops).flatMap(g => g.cards);
  const index = updated.findIndex(card => card.id === selectedId);
  return { snapshot, selected: index >= 0 ? index : Math.max(0, Math.min(view.selected, updated.length - 1)) };
}



function reportApiError(error: unknown, report: (s: string) => void): void {
  if (!(error instanceof ApiError)) throw error;
  report(`pacer: ${error.message}${error.hint ? ` (${error.hint})` : ""}`);
}

export async function runCommand(
  client: ApiClient,
  data: CmdData,
  fallback: (d: CmdData) => Promise<void>,
  report: (s: string) => void,
): Promise<void> {
  const result = await runMappedCmd((op, params) => client.call(op, params), data);
  if (result.handled) report(result.message);
  else await fallback(data);
}

export async function delegateViaClient(
  client: ApiClient,
  input: { goal: string; repo: string; kind?: string },
  report: (s: string) => void,
): Promise<void> {
  try {
    const result = await client.call<{ task_id: string }>("task.delegate", {
      goal: input.goal, repo: input.repo, source: "ui", ...(input.kind ? { kind: input.kind } : {}),
    });
    report(`${result.task_id} queued`);
  } catch (error) { reportApiError(error, report); }
}


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

/** Console-local commands need no advertised op. */
export function commandAvailable(data:CmdData,ops:readonly string[]):boolean {
 const mapped=cmdToOp(data);
 return !mapped || ops.includes(mapped.op);
}
