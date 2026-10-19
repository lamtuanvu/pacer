import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { startHealthListener } from "../src/serve/health-listener";

test("listener forwards backend auth failures and request/response headers without caching", async () => {
  let calls = 0;
  const backend = createServer((req, res) => {
    calls++;
    expect(req.headers.authorization).toBe("Bearer wrong");
    expect(req.headers.cookie).toBe("pacer_session=wrong");
    expect(req.headers.origin).toBe("http://example.test");
    expect(req.headers.host).toBe(`127.0.0.1:${listener.port}`);
    res.writeHead(401, { "x-backend": String(calls), "set-cookie": ["a=1", "b=2"] });
    res.end("backend unauthorized");
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const listener = startHealthListener((backend.address() as { port: number }).port, 0);
  try {
    for (const path of ["/v3/snapshot", "/v3/snapshot", "/v3/ops/routing.status"]) {
      const response = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
        headers: { Authorization: "Bearer wrong", Cookie: "pacer_session=wrong", Origin: "http://example.test" },
        ...(path.includes("/ops/") ? { method: "POST", body: "{}" } : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("x-backend")).toBe(String(calls));
      expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      expect(await response.text()).toBe("backend unauthorized");
    }
    expect(calls).toBe(3);
  } finally { listener.stop(); backend.closeAllConnections(); backend.close(); }
});

test("listener streams SSE before the backend finishes its response", async () => {
  let finish!: () => void;
  const backend = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-stream": "backend" });
    res.write("data: first\n\n");
    finish = () => res.end("data: last\n\n");
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const listener = startHealthListener((backend.address() as { port: number }).port, 0);
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/v3/events`, { signal: AbortSignal.timeout(1000) });
    expect(response.headers.get("x-stream")).toBe("backend");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    finish();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: last\n\n");
  } finally { finish?.(); listener.stop(); backend.closeAllConnections(); backend.close(); }
});

test("listener forwards WebSocket handshake headers and bidirectional bytes", async () => {
  const backend = createServer();
  backend.on("upgrade", (req, socket, head) => {
    expect(req.headers.cookie).toBe("pacer_session=backend");
    expect(req.headers.origin).toBe(`http://127.0.0.1:${listener.port}`);
    expect(req.headers.host).toBe(`127.0.0.1:${listener.port}`);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Backend: upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const listener = startHealthListener((backend.address() as { port: number }).port, 0);
  const socket = connect(listener.port, "127.0.0.1");
  try {
    const received = await new Promise<string>((resolve, reject) => {
      let data = "";
      socket.setTimeout(1000, () => reject(Error("upgrade timed out")));
      socket.on("error", reject);
      socket.on("data", chunk => {
        data += chunk.toString();
        if (data.includes("hello")) resolve(data);
      });
      socket.on("connect", () => socket.write(`GET /v3/tasks/task/session HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\nOrigin: http://127.0.0.1:${listener.port}\r\nCookie: pacer_session=backend\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nhello`));
    });
    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("X-Backend: upgrade");
    expect(received).toEndWith("hello");
  } finally { socket.destroy(); listener.stop(); backend.close(); }
});
