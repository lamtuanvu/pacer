export interface TerminalRequest { id: string; cwd: string }

/** Keep the same launch identity across a lost response, but use a new one for a changed folder. */
export function terminalRequest(previous: TerminalRequest | null, cwd: string, generate: () => string): TerminalRequest {
  return previous?.cwd === cwd ? previous : { id: generate(), cwd };
}

/** A definite API refusal cannot have launched a process; a lost response may have. */
export function pendingAfterFailure(previous: TerminalRequest | null, status?: number): TerminalRequest | null {
  return status && status >= 400 && status < 500 ? null : previous;
}
