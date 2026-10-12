import { liveConsole, encodeCmdLine, type LinkSnapshot, type CmdData } from "../../src/link/envelope";
import type { OrcaHost } from "./orca-api";
export type SendResult = "sent" | "no-console" | "rejected";
export async function sendToConsole(host: OrcaHost, s: LinkSnapshot, data: CmdData, nowS: number): Promise<SendResult> {
  const console = liveConsole(s, nowS); if (!console) return "no-console";
  try { return (await host.call("terminal.sendText", { terminalId: console.handle!, text: encodeCmdLine(data), enter: true })).accepted ? "sent" : "rejected"; } catch { return "rejected"; }
}
export const NO_CONSOLE = { title: "pacer console is not running", body: "Run `pacer console --open` (or start `pacer console` in an Orca terminal), then retry." };
