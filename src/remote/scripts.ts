/** Fixed remote programs; user text is carried only over stdin. */
export const SCRIPTS = {
  PROBE: `printf 'git=%s\\n' "$(git --version)"
printf 'codex=%s\\n' "$(command -v codex || true)"
printf 'claude=%s\\n' "$(command -v claude || true)"
printf 'setsid=%s\\n' "$(command -v setsid || true)"
printf 'home=%s\\n' "$HOME"`,
  // Used only by tests and host check to verify the stdin channel.
  ECHO_STDIN: "cat",
} as const;
