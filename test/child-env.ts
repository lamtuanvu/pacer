import { join } from "node:path";

/** Obtain a currently closed ephemeral port, avoiding the real service's default. */
export function closedPort(): number {
  while (true) {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = listener.port;
    listener.stop(true);
    if (port && port !== 4317) return port;
  }
}

/** Build an isolated child environment, targeting its test server or a closed port. */
export function childEnv(home: string, port?: number): NodeJS.ProcessEnv & { HOME: string; PACER_HOME: string; PACER_PORT: string } {
  if (port === undefined) {
    port = closedPort();
  }
  if (!port || port === 4317 || port > 65535 || port < 1 || !Number.isInteger(port)) {
    throw new Error("Invalid test service port");
  }
  return { HOME: home, PACER_HOME: join(home, ".pacer"), PACER_PORT: String(port) };
}
