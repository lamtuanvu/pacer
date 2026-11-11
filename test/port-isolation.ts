import { DEFAULT_PORT } from "../src/serve/constants";

// Without PACER_PORT, the core and its clients fall back to DEFAULT_PORT, where the maintainer's real service listens.
export function closedPort(): string {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = String(reservation.port);
  reservation.stop(true);
  return port;
}

export function assertPinnedPort(env: Record<string, string | undefined>): void {
  const port = env.PACER_PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) === DEFAULT_PORT) {
    throw new Error(`spawned test processes need PACER_PORT set to a test-owned port, got ${JSON.stringify(port)}`);
  }
}

export function spawnPinned<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(argv: string[], options: Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { env: Record<string, string | undefined> }) {
  assertPinnedPort(options.env);
  return Bun.spawn(argv, options);
}
