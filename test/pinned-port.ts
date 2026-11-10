// Spawned pacer processes (front door, core, CLI, detached runners) reach the service at
// 127.0.0.1:${PACER_PORT ?? 4317} whenever PACER_HOME holds a token. A disposable home is not
// network isolation, so every test child gets its own port and never the user's real service.
export const REAL_SERVICE_PORT = 4317;

/** A loopback port nothing listens on. */
export function closedPort(): number {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  return port;
}

/** Throws unless `env` pins PACER_PORT to a decimal port other than the real service's. */
export function assertPinnedPort(env: Record<string, string | undefined> | undefined): void {
  const port = env?.PACER_PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) === REAL_SERVICE_PORT) {
    throw new Error(`spawned test process needs PACER_PORT other than ${REAL_SERVICE_PORT}, got ${port ?? "none"}`);
  }
}

/** `env` with PACER_PORT set to `port` (default: its own PACER_PORT, else a closed port). */
export function pinnedEnv<T extends Record<string, string | undefined>>(env: T, port?: number): T & { PACER_PORT: string } {
  const pinned = { ...env, PACER_PORT: port === undefined ? env.PACER_PORT ?? String(closedPort()) : String(port) };
  assertPinnedPort(pinned);
  return pinned;
}

/** `Bun.spawn` that refuses a child environment without a pinned PACER_PORT; children inherit it. */
export function spawnPinned<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(argv: string[], options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { env: Record<string, string | undefined> }): Bun.Subprocess<In, Out, Err> {
  assertPinnedPort(options.env);
  return Bun.spawn(argv, options);
}
