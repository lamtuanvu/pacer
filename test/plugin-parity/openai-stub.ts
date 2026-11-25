/**
 * Loopback OpenAI-compatible chat stub for `pacer-assistant` parity and CT-11
 * (M3 C4). Records every `/chat/completions` request body (parsed JSON when
 * possible) and Authorization header so a test can compare the TypeScript and
 * Rust processes' request shapes byte-for-byte as JSON.
 *
 * Importable (start a server on an ephemeral port) or run directly on a fixed
 * port for CT-11: `bun test/plugin-parity/openai-stub.ts --port 8901`.
 */

export interface StubOptions {
  /** Response status; default 200. */
  status?: number;
  /** Raw response body; default a 200 `{choices:[{message:{content:"ok"}}]}`. */
  body?: string;
  /** Never reply (the client's deadline must fire); default false. */
  hang?: boolean;
}

export interface Stub {
  /** `baseUrl` for `p.context.backend`, pointing at `/v1/`. */
  url: string;
  /** Every request body, in order (parsed JSON or the raw string). */
  bodies: unknown[];
  /** Every Authorization header, in order (empty string when absent). */
  authHeaders: string[];
  stop: () => void;
}

export function start(opts: StubOptions = {}, port?: number): Stub {
  const bodies: unknown[] = [];
  const authHeaders: string[] = [];
  const server = Bun.serve({
    port: port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      // The plugin posts to `<baseUrl>/chat/completions` where baseUrl includes
      // the `/v1/` prefix, so accept any path ending in `/chat/completions`.
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const text = await req.text();
      try {
        bodies.push(JSON.parse(text));
      } catch {
        bodies.push(text);
      }
      authHeaders.push(req.headers.get("authorization") ?? "");
      if (opts.hang) return new Promise(() => {}) as unknown as Response;
      return new Response(opts.body ?? '{"choices":[{"message":{"content":"ok"}}]}', {
        status: opts.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1/`,
    bodies,
    authHeaders,
    stop: () => server.stop(true),
  };
}

// Direct run for CT-11: serve on the requested port and stay alive until killed.
const portFlag = Bun.argv.indexOf("--port");
const requested = portFlag !== -1 ? Number(Bun.argv[portFlag + 1]) : NaN;
if (Number.isInteger(requested)) {
  start({ status: 200 }, requested);
  console.log(`openai-stub listening on port ${requested}`);
  Bun.sleep(Number.MAX_SAFE_INTEGER).then(() => {});
}