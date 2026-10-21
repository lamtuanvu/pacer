import NodeWebSocket from "ws";
import type { ServerWebSocket } from "bun";
import { readFileSync } from "node:fs";
import { record, type Session } from "./core";
import { authorizeFixtureRequest } from "./ota-request";

/** D8 policy source of truth; the procedure table is checked against these rows. */
export const BLOCKED_OPS: Readonly<Record<string, string>> = {
  "agent.connect": "setup.agentConnect installs integrations in real agent homes",
  "service.install": "setup.serviceInstall registers a real launchd/systemd login service",
  "agent.disconnect": "setup.agentDisconnect reverts integrations in real agent homes",
  "account.signin": "accounts.signin / interactiveTerminal opens real terminals and login flows",
  "account.add": "accounts.add creates account homes; endpoints.addEndpoint may write Keychain keys",
  "account.remove": "accounts.remove may delete account homes and endpoint keys",
  "account.adopt": "endpoints.adoptEndpoint stores keys and regenerates provider config",
  "account.edit": "endpoints.editEndpoint stores keys and regenerates provider config",
  "host.add": "hosts.add enables remote execution outside the sandbox",
  "host.account.add": "hosts.addAccount maps real remote account homes",
  "host.repo.map": "hosts.mapRepo maps checkouts outside the sandbox",
  "host.repo.setup": "hosts.setupJob clones and changes remote repository identity",
  "host.terminal": "hosts.terminal opens a real SSH terminal",
  "update.apply": "applyUpdate may replace the installed binary and refresh integrations",
  "strategy.build": "buildStrategy opens a planning terminal in Orca, tmux or the OS",
  "config.set": "config.set can install and uninstall planner integrations (whole op refused conservatively)",
  "runner.add": "interactiveTerminal opens a real terminal (whole op refused conservatively)",
  "task.attach": "openSession can switch/create Orca terminals or split real tmux (whole op refused conservatively)",
  "host.clean": "hosts.cleanJob removes worktrees on remote hosts (whole op refused conservatively)",
  "desktop.update.*": "all desktop update operations except status require a verified OTA fixture",
  "plugin.remove": "plugins.remove deletes a plugin folder under the home (whole op refused conservatively)",
  "service.*": "all service operations except service.status can change the real login service",
};

export function refusedOp(method: string, pathname: string): string | undefined {
  if (method !== "POST") return;
  const match = pathname.match(/^\/v[23]\/ops\/(.*)$/);
  if (!match) return;
  const op = match[1];
  if (Object.hasOwn(BLOCKED_OPS, op) || (op.startsWith("service.") && op !== "service.status") || (op.startsWith("desktop.update.") && op !== "desktop.update.status")) return op;
}

export function upstreamHeaders(input: Headers, publicPort: number, innerPort: number): Headers {
  const headers = new Headers(input);
  headers.set("host", `127.0.0.1:${innerPort}`);
  if ([`http://127.0.0.1:${publicPort}`, `http://localhost:${publicPort}`].includes(headers.get("origin") ?? "")) {
    headers.set("origin", `http://127.0.0.1:${innerPort}`);
  }
  return headers;
}

function transportHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (headers.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) headers.delete(name);
  return headers;
}

// lib.dom's constructor hides Bun's options overload when both type sets are loaded.
export const ClientWebSocket = globalThis.WebSocket as unknown as {
  new(url: string, options: Bun.WebSocketOptions): WebSocket;
};
interface Bridge { upstream: NodeWebSocket }
export function startProxy(session: Session) {
  if (!session.innerPort || session.innerPort === session.port) throw Error("Proxy requires a separate inner port");
  const upstreamOrigin = `http://127.0.0.1:${session.innerPort}`;
  return Bun.serve<Bridge>({
    hostname: "127.0.0.1", port: session.port, idleTimeout: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      // Keep the service's Host protection at the public boundary before rewriting.
      if (![`127.0.0.1:${session.port}`, `localhost:${session.port}`].includes(req.headers.get("host") ?? "")) {
        return new Response("misdirected request\n", { status: 421 });
      }
      if (req.method === "GET" && url.pathname === "/__live/health") {
        return Response.json({ pid: process.pid }, { headers: { "x-pacer-live-proxy": "1" } });
      }
      const op = refusedOp(req.method, url.pathname);
      if (op && !await authorizeFixtureRequest(session, req)) {
        const message = `Live validation D8: ${op} changes the real user environment`;
        record(session, { kind: "note", behavior: `D8 blocked ${op}`, surface: "API proxy", verdict: "UNVERIFIED", steps: `${req.method} ${url.pathname}`, text: message });
        return Response.json({ error: { code: "forbidden", message } }, { status: 403 });
      }
      const headers = upstreamHeaders(req.headers, session.port, session.innerPort!);
      const target = upstreamOrigin + url.pathname + url.search;
      try {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          // Let the upstream authenticate the handshake before accepting the client.
          const wsHeaders = new Headers(headers);
          for (const name of ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol"]) wsHeaders.delete(name);
          const upstream = new NodeWebSocket(target.replace(/^http:/, "ws:"), { headers: Object.fromEntries(wsHeaders) });
          upstream.binaryType = "arraybuffer";
          const pending: (string | ArrayBuffer)[] = [];
          let client: ServerWebSocket<Bridge> | undefined;
          let closed = false;
          let pendingBytes = 0;
          upstream.onmessage = event => {
            // binaryType is fixed to arraybuffer above, so binary messages have this shape.
            const frame = event.data as string | ArrayBuffer;
            if (client) client.send(frame);
            else {
              pendingBytes += typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
              if (pendingBytes > 1024 * 1024) upstream.close(1009, "Proxy queue exceeded");
              else pending.push(frame);
            }
          };
          upstream.onclose = () => { closed = true; client?.close(); };
          const refusal = await new Promise<Response | undefined>((ok, fail) => {
            const timer = setTimeout(() => { fail(Error("WebSocket upstream timeout")); upstream.terminate(); }, 3000);
            upstream.onopen = () => { clearTimeout(timer); ok(undefined); };
            upstream.onerror = () => { clearTimeout(timer); client?.close(1011, "Upstream error"); fail(Error("WebSocket upstream rejected")); };
            // The browser WebSocket API hides HTTP refusals. ws exposes the actual
            // response so the guarded validation path keeps the service's contract.
            upstream.once("unexpected-response", (_request, response) => {
              const chunks: Buffer[] = [];
              let bytes = 0;
              const declared = response.headers["content-length"];
              const length = declared === undefined ? null : Number(declared);
              // Bun exposes raw chunk framing on rejected upgrades. Fail closed
              // instead of relaying a corrupted body when framing is ambiguous.
              if (response.headers["transfer-encoding"] !== undefined || (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > 256 * 1024))) {
                clearTimeout(timer);
                fail(Error("WebSocket refusal has an invalid or oversized content length"));
                response.destroy();
                upstream.terminate();
                return;
              }
              response.on("data", (data: Buffer) => {
                const chunk = Buffer.from(data);
                bytes += chunk.length;
                if (bytes > 256 * 1024) {
                  const error = Error("WebSocket refusal exceeds 256 KiB");
                  clearTimeout(timer);
                  // Reject before closing: some runtimes emit end during destroy.
                  fail(error);
                  response.destroy(error);
                  upstream.terminate();
                  return;
                }
                chunks.push(chunk);
              });
              response.once("error", error => { clearTimeout(timer); fail(error); upstream.terminate(); });
              response.once("end", () => {
                clearTimeout(timer);
                try {
                  if (length !== null && bytes !== length) throw Error("WebSocket refusal body was truncated");
                  const headers = new Headers();
                  for (const [name, value] of Object.entries(response.headers)) {
                    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, item);
                  }
                  const status = response.statusCode ?? 502;
                  const body = Buffer.concat(chunks);
                  ok(new Response(body.length ? body : null, {
                    status: status >= 200 && status <= 599 ? status : 502,
                    headers: transportHeaders(headers),
                  }));
                } catch (error) { fail(error); }
                finally { upstream.terminate(); }
              });
            });
          });
          if (refusal) return refusal;
          // open fires after upgrade; stash the early upstream frames until then.
          const data: Bridge = { upstream };
          bridgeOpen.set(data, ws => {
            client = ws;
            for (const frame of pending) ws.send(frame);
            pending.length = 0;
            if (closed) ws.close();
          });
          if (server.upgrade(req, { data })) return;
          bridgeOpen.delete(data);
          upstream.close();
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        const response = await fetch(target, {
          method: req.method, headers: transportHeaders(headers), body: req.body,
          redirect: "manual", signal: req.signal, decompress: false,
        });
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: transportHeaders(response.headers) });
      } catch {
        return new Response("Live validation upstream unavailable\n", { status: 502 });
      }
    },
    websocket: {
      maxPayloadLength: 1024 * 1024, backpressureLimit: 1024 * 1024, closeOnBackpressureLimit: true,
      open(ws) { bridgeOpen.get(ws.data)?.(ws); bridgeOpen.delete(ws.data); },
      message(ws, message) { ws.data.upstream.send(message); },
      close(ws) { bridgeOpen.delete(ws.data); ws.data.upstream.close(); },
    },
  });
}
const bridgeOpen = new WeakMap<Bridge, (ws: ServerWebSocket<Bridge>) => void>();

if (import.meta.main) {
  const session = JSON.parse(readFileSync(process.argv[2], "utf8")) as Session;
  const proxy = startProxy(session);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { proxy.stop(true); process.exit(0); });
}
