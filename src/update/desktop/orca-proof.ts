import type { OrcaReply, TerminalRow, WorkerClosureResult } from "../../exec/orca/client";

/** A settled worker alone says nothing about its surviving terminal. */
export function workerClosureProof(reply: OrcaReply<WorkerClosureResult>, dispatchId: string, terminal: string | null): boolean {
  if (!reply.ok) return false;
  const result = reply.result;
  if (result.dispatchId !== dispatchId || !["stopped", "released"].includes(result.state ?? "") || result.processAction !== "closed_agent_terminal") return false;
  if (result.close && (result.close.handle !== terminal || result.close.ptyKilled !== true)) return false;
  return true;
}

export function terminalClosureProof(reply: OrcaReply<{ terminal?: TerminalRow }>, handle: string, incarnationId?: string): boolean {
  if (!reply.ok || !incarnationId) return false;
  const terminal = reply.result.terminal;
  return terminal?.handle === handle && terminal.incarnationId === incarnationId &&
    terminal.connected === false && terminal.writable === false && terminal.exitCause?.kind === "operator_close";
}
