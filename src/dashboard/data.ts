import { cmdToOp, runMappedCmd } from "../api/cmd";
export { cmdToOp, CMD_SUCCESS, runMappedCmd } from "../api/cmd";
import { ApiError, type ApiClient } from "../api/client";
import type { ApiEvent } from "../api/protocol";
import type { CmdData } from "../link/envelope";
import { cards, type DashboardAction } from "./model";
import type { ClientSnapshot } from "../view-model/snapshot";

export async function refreshView(
  client: ApiClient,
  view: { snapshot: ClientSnapshot; selected: number; now: number; ops?:readonly string[] },
): Promise<{ snapshot: ClientSnapshot; selected: number }> {
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
  data: DashboardAction,
  fallback: (d: CmdData) => Promise<void>,
  report: (s: string) => void,
  open: (screen: string) => Promise<void> = async screen => { report(`pacer open ${screen}`); },
): Promise<void> {
  if ("op" in data) {
    if(data.op==="ui.open") {
      const id=typeof data.params.id==="string"?`/${encodeURIComponent(data.params.id)}`:"";
      const screen=data.params.view==="review"?`review${id}`:["task","session"].includes(String(data.params.view))?`sessions${id}`:data.params.view==="settings"?`settings${typeof data.params.section==="string"?`/${encodeURIComponent(data.params.section)}`:""}`:"";
      await open(screen);return;
    }
    try {
      const result=await client.call<{job?:{id:string}}|null>(data.op, data.params);
      report(result?.job?`${data.label}: job ${result.job.id}`:`${data.label}: done`);
    } catch (error) { reportApiError(error, report); }
    return;
  }
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

/** Here attaches locally in the suspended dashboard; other viewers go through the service. */
export async function attachViewer(client: ApiClient, viewer: {id:string;target:"here"|"terminal"|"tmux"}, attachHere:()=>Promise<void>, report:(text:string)=>void):Promise<void> {
 if(viewer.target==="here") {
  const info=await client.call<{host:string}>("task.session",{id:viewer.id});
  if(info.host==="builtin"){await attachHere();return;}
 }
 const result=await client.call<{opened:boolean;command?:string}>("task.attach",{id:viewer.id,target:viewer.target==="here"?"orca":viewer.target});
 report(result.opened?"Opened task session.":result.command??`pacer attach ${viewer.id}`);
}
