/** Private tmux socket name for a live sandbox — never the default server. */
export function liveTmuxSocket(sessionId: string): string {
  return `pacer-live-${sessionId}`;
}

/** Prefix argv so every tmux call targets only this sandbox's private server. */
export function liveTmuxArgs(sessionId: string, args: readonly string[]): string[] {
  return ["-L", liveTmuxSocket(sessionId), ...args];
}
