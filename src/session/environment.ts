/** A native PTY advertises its own capabilities. Automation's NO_COLOR/forced
 * color flags must not flatten the agent UI. This does not change Pacer's TUI. */
export function nativeTerminalEnv(base: Record<string, string | undefined>) {
  const env: Record<string, string | undefined> = {...base, TERM: "xterm-256color", COLORTERM: "truecolor"};
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}
