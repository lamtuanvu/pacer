/** A native PTY advertises its own capabilities. Automation's NO_COLOR/forced
 * color flags must not flatten the agent UI; `keep` names the ones the user's
 * login profile set, which stay as in a terminal. This does not change Pacer's TUI. */
export function nativeTerminalEnv(base: Record<string, string | undefined>, keep: readonly string[] = []) {
  const env: Record<string, string | undefined> = {...base, TERM: "xterm-256color", COLORTERM: "truecolor"};
  if (!keep.includes("NO_COLOR")) delete env.NO_COLOR;
  if (!keep.includes("FORCE_COLOR")) delete env.FORCE_COLOR;
  return env;
}
