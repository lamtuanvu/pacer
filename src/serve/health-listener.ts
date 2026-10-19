/** Keep the public listener on its own thread. A synchronous filesystem read in
 * any service operation must not delay health or look like a dead process.
 * All other HTTP and upgrade traffic streams to the backend, which owns auth
 * and response caching. Health reflects the backend heartbeat. */
async function listenerMain() {
  const { createServer, request } = await import("node:http");
  const { createConnection } = await import("node:net");
  self.onmessage = (event: MessageEvent) => {
    const { ready, backendPort, port, pid, heartbeatMaxAgeMs } = event.data;
    const state = new Int32Array(ready);
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer(async (req, res) => {
      const address = server.address();
      const publicPort = typeof address === "object" && address ? address.port : 0;
      if (![ `127.0.0.1:${publicPort}`, `localhost:${publicPort}` ].includes(req.headers.host ?? "")) {
        res.writeHead(421); res.end("misdirected request\n"); return;
      }
      if (req.method === "GET" && new URL(req.url ?? "/", "http://localhost").pathname === "/health") {
        // Unsigned subtraction tolerates the Int32 millisecond clock wrapping.
        const lagMs = (Math.floor(performance.timeOrigin + performance.now()) - Atomics.load(state, 1)) >>> 0;
        const ok = lagMs <= heartbeatMaxAgeMs;
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "X-Pacer": "1" });
        res.end(JSON.stringify({ ok, pid, backendLagS: lagMs / 1000 }));
        return;
      }
      const upstream = request({ hostname: "127.0.0.1", port: backendPort, method: req.method, path: req.url, headers: req.rawHeaders, agent: false }, response => {
        res.writeHead(response.statusCode ?? 502, response.rawHeaders);
        response.pipe(res);
        response.on("error", () => res.destroy());
      });
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    // Forward the original handshake and all subsequent bytes. The backend alone
    // authorizes the upgrade, preserving cookies, Origin and binary frames.
    server.on("upgrade", (req, socket, head) => {
      const address = server.address();
      const publicPort = typeof address === "object" && address ? address.port : 0;
      if (![`127.0.0.1:${publicPort}`, `localhost:${publicPort}`].includes(req.headers.host ?? "")) {
        socket.end("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: backendPort });
      sockets.add(upstream);
      upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
      socket.on("close", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("connect", () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
        upstream.write("\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", () => { Atomics.store(state, 0, -1); Atomics.notify(state, 0); });
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      Atomics.store(state, 0, typeof address === "object" && address ? address.port : -1);
      Atomics.notify(state, 0);
    });
    self.onmessage = (event: MessageEvent) => {
      if (event.data !== "stop") return;
      for (const socket of sockets) socket.destroy();
      server.close();
      self.close();
    };
  };
}

export function startHealthListener(backendPort: number, port: number, heartbeatMaxAgeMs = 45_000) {
  // Inline worker source also works in the compiled single-file CLI: no external
  // worker script or additional release asset is needed.
  const url = URL.createObjectURL(new Blob([`(${listenerMain.toString()})()`], { type: "application/javascript" }));
  const worker = new Worker(url);
  const ready = new SharedArrayBuffer(8);
  const state = new Int32Array(ready);
  const heartbeat = () => Atomics.store(state, 1, Math.floor(performance.timeOrigin + performance.now()) | 0);
  heartbeat();
  worker.postMessage({ ready, backendPort, port, pid: process.pid, heartbeatMaxAgeMs });
  const result = Atomics.wait(state, 0, 0, 5000);
  URL.revokeObjectURL(url);
  const boundPort = Atomics.load(state, 0);
  if (result === "timed-out" || boundPort <= 0) {
    worker.terminate();
    throw Error(`Could not listen on 127.0.0.1:${port}`);
  }
  const heartbeatTimer = setInterval(heartbeat, 1000);
  return { port: boundPort, stop: () => { clearInterval(heartbeatTimer); worker.postMessage("stop"); } };
}
