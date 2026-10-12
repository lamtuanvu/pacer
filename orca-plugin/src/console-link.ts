import { encodeCmdLine, type LinkSnapshot, type CmdData } from "../../src/link/envelope";
import type { OrcaHost } from "./orca-api";
export type SendResult = "sent" | "no-console" | "rejected";
export async function focusedConsole(host: OrcaHost, s: LinkSnapshot, nowS: number) {
  try {
    const context = await host.call("workspace.readContext");
    const ids = new Set(context?.terminals.map(t=>t.id) ?? []);
    return [...(s.consoles ?? []), ...(s.console ? [s.console] : [])]
      .filter(c=>c.handle && ids.has(c.handle) && nowS-c.heartbeatAt<=30)
      .sort((a,b)=>b.heartbeatAt-a.heartbeatAt)[0] ?? null;
  } catch { return null; }
}
const queues=new WeakMap<OrcaHost,Map<string,{tail:Promise<unknown>;at:number}>>();
/** Terminal IPC is serialized with a one-second quiet period between sends. */
export async function sendToConsole(host: OrcaHost, s: LinkSnapshot, data: CmdData, nowS: number): Promise<SendResult> {
  const console = await focusedConsole(host, s, nowS);
  if (!console) return "no-console";
  let byTerminal=queues.get(host);if(!byTerminal){byTerminal=new Map();queues.set(host,byTerminal);}
  const key=console.handle!,queue=byTerminal.get(key)??{tail:Promise.resolve(),at:-Infinity};
  byTerminal.set(key,queue);
  const send=queue.tail.catch(()=>{}).then(async():Promise<SendResult>=>{
    const delay=Math.max(0,1000-(Date.now()-queue.at),Math.min(1000,((console.busyUntil??nowS)-nowS)*1000));
    if(delay)await new Promise(r=>setTimeout(r,delay));
    try {return (await host.call("terminal.sendText",{terminalId:key,text:encodeCmdLine(data),enter:true})).accepted?"sent":"rejected";}
    catch{return "rejected";}
    finally{queue.at=Date.now();}
  });
  queue.tail=send;return send;
}

export const NO_CONSOLE = { title: "No console in this worktree", body: "Type `pacer console` into a terminal in this worktree and press Enter, then retry." };
