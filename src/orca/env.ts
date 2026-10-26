/** Remove caller attestation: pacer owns its coordinator identity. */
export function sanitizedOrcaEnv(source: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env = { ...source }, named = source.ORCA_AGENT_SESSION_ID_ENV;
  for (const key of Object.keys(env)) {
    if (["ORCA_AGENT_SESSION_ID", "ORCA_AGENT_SESSION_ID_ENV", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_TAB_ID", "ORCA_WORKTREE_ID", "ORCA_AGENT_LAUNCH_TOKEN", named].includes(key) ||
      key.startsWith("ORCA_AGENT_HOOK_") || key.startsWith("ORCA_SESSION_")) delete env[key];
  }
  return env;
}
