const DEFAULT_SERVICE_PORT = 4317;

/** A loopback port that nothing listens on once this returns. */
export function closedPort(): number {
  for (;;) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = server.port!;
    server.stop(true);
    if (port !== DEFAULT_SERVICE_PORT) return port;
  }
}

/**
 * Environment for a spawned pacer process (and every descendant that inherits it). A disposable
 * home does not isolate the network: without PACER_PORT, clients probe the real service on 4317.
 */
export function isolatedEnv<T extends Record<string, string | undefined>>(env: T, port: number = closedPort()): T & { PACER_PORT: string } {
  if (!Number.isSafeInteger(port) || port <= 0 || port === DEFAULT_SERVICE_PORT) throw Error(`unsafe PACER_PORT for a test process: ${port}`);
  return { ...env, PACER_PORT: String(port) };
}

export function assertIsolatedEnv(env: Record<string, string | undefined>): void {
  const port = Number(env.PACER_PORT);
  if (!env.PACER_PORT || !Number.isSafeInteger(port) || port <= 0 || port === DEFAULT_SERVICE_PORT) {
    throw Error(`test process environment must pin PACER_PORT away from ${DEFAULT_SERVICE_PORT}, got ${env.PACER_PORT ?? "unset"}`);
  }
}
