import { createServer } from "node:net";

/** The default service port: a spawned test process must never reach the maintainer's real pacer on it. */
export const REAL_SERVICE_PORT = "4317";

/**
 * A loopback port nothing listens on. Core clients, guards and setup checks target `PACER_PORT ?? 4317` whenever a
 * token or work grant is present, so a disposable HOME is not network isolation: give children this port instead.
 */
export function closedPort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => port === Number(REAL_SERVICE_PORT) ? reject(new Error("ephemeral port collided with 4317")) : resolve(String(port)));
    });
  });
}

/** Refuses a spawn environment that could fall back to, or names, the real service port. */
export function pinnedEnv<T extends Record<string, string | undefined>>(env: T): T {
  if (!env.PACER_PORT || env.PACER_PORT === REAL_SERVICE_PORT) {
    throw new Error("spawned test processes must set PACER_PORT to their own server or a closed port, never 4317");
  }
  return env;
}
