import { join } from "node:path";

/** Obtain a currently closed ephemeral port, avoiding the real service's default. */
export function closedPort(): number {
  for (let attempt = 0; attempt < 20; attempt++) {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = listener.port;
    listener.stop(true);
    if (port && ![4317, 11434, 1234, 41343].includes(port)) return port;
  }
  throw new Error("Could not reserve a safe test port");
}

/** Build an isolated child environment, targeting its test server or a closed port. */
export function childEnv(home: string, port?: number): NodeJS.ProcessEnv & { HOME: string; PACER_HOME: string; PACER_PORT: string } {
  if (port === undefined) {
    port = closedPort();
  }
  if (!port || port === 4317 || port > 65535 || port < 1 || !Number.isInteger(port)) {
    throw new Error("Invalid test service port");
  }
  return { HOME: home, PACER_HOME: join(home, ".pacer"), PACER_PORT: String(port), OLLAMA_HOST: `http://127.0.0.1:${closedPort()}`, LMS_API_SERVER_INFO_PATH: process.env.LMS_API_SERVER_INFO_PATH };
}

/** Fail closed before launching a child with a constructed environment. */
export function pinnedEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  const port = Number(env.PACER_PORT);
  if (!env.PACER_PORT || !Number.isInteger(port) || port < 1 || port > 65535 || port === 4317) {
    throw new Error("Invalid test service port");
  }
  return env;
}
