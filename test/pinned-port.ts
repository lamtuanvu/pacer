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

/** Throws unless `env` pins PACER_PORT to a decimal port other than the real service's. */
export function assertPinnedPort(env: Record<string, string | undefined> | undefined): void {
  const port = env?.PACER_PORT;
  if (!port || !/^\d+$/.test(port) || Number(port) === REAL_SERVICE_PORT) {
    throw new Error(`spawned test process needs PACER_PORT other than ${REAL_SERVICE_PORT}, got ${port ?? "none"}`);
  }
  return { ...env, PACER_PORT: String(port) };
}
