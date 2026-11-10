import { createServer, type AddressInfo } from "node:net";

/** The default service port; on a developer machine it is the real pacer install. */
export const REAL_SERVICE_PORT = 4317;

/**
 * A loopback port nothing listens on. A spawned pacer process without `PACER_PORT` probes and can call the service on
 * 4317, whatever its `HOME` and `PACER_HOME`, so a test's children get this port unless the test runs its own server.
 */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** `env` for a spawned test process, with `PACER_PORT` pinned to `port`; refuses a missing port or the real service's. */
export function pinnedEnv<T extends Record<string, string | undefined>>(env: T, port: number): T & { PACER_PORT: string } {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === REAL_SERVICE_PORT) {
    throw new Error(`a spawned test process needs PACER_PORT pinned away from ${REAL_SERVICE_PORT}, got ${port}`);
  }
  return { ...env, PACER_PORT: String(port) };
}
