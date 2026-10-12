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
export async function sendToConsole(host: OrcaHost, s: LinkSnapshot, data: CmdData, nowS: number): Promise<SendResult> {
  const console = await focusedConsole(host, s, nowS);
  if (!console) return "no-console";
  try {
    return (await host.call("terminal.sendText", { terminalId: console.handle!, text: encodeCmdLine(data), enter: true })).accepted ? "sent" : "rejected";
  } catch { return "rejected"; }
}

export const NO_CONSOLE = { title: "No pacer console in this worktree", body: "Type `pacer console` into a terminal in this worktree and press Enter, then retry." };
