import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { companionFile, hostTarget } from "../src/update/manifest";
import { fakeCtx } from "./helpers";
import { keychainStubPath } from "./keychain-stub";
import { createTask } from "../src/tasks/store";
import { socketPath } from "../src/session/host";
import { FrameType, WireDecoder, wire } from "../src/session/framing";

const supplied = process.env.PACER_TEST_FRONT_DOOR;

test.skipIf(!supplied)("released Rust and Bun transports preserve stdio, HTTP auth, cookie, SSE and WebSocket behavior", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pacer-transport-parity-"));
  const front = join(temporary, "pacer"), core = join(temporary, "pacer-core");
  const target = hostTarget();
  if (!target || !supplied) throw Error("A compiled host release front door is required");
  copyFileSync(supplied, front);
  const sibling = join(dirname(supplied), "pacer-core");
  copyFileSync(existsSync(sibling) ? sibling : join(dirname(supplied), companionFile(target)), core);
  chmodSync(front, 0o755); chmodSync(core, 0o755);
  const children: Bun.Subprocess[] = [];
  const environment = (name: string) => {
    const home = join(temporary, name); mkdirSync(home, { mode: 0o700 });
    return { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: keychainStubPath(home), LANG: "C", TZ: "Asia/Ho_Chi_Minh", PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1" };
  };
  const exchange = async (binary: string, name: string) => {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
      { jsonrpc: "2.0", id: 2, method: "task.list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "nonexistent.operation", params: {} },
    ].map(value => JSON.stringify(value)).join("\n") + "\n{\n";
    const child = Bun.spawn([binary, "api", "--stdio"], { env: environment(name), stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 15000 });
    children.push(child);
    await child.stdin.write(input); await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    return stdout.trim().split("\n").map(line => JSON.parse(line)).sort((a, b) => (a.id ?? -1) - (b.id ?? -1));
  };
  const serve = async (binary: string, name: string) => {
    const env = environment(name);
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!; reservation.stop(true);
    if (port === 4317) throw Error("Refusing the default service port");
    const child = Bun.spawn([binary, "serve", "--port", String(port)], { env: { ...env, PACER_PORT: String(port) }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    children.push(child);
    const stderr = new Response(child.stderr).text();
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const token = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
        const ready = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
        if (ready.ok) { await ready.arrayBuffer(); return { base, port, token, child, env }; }
        await ready.arrayBuffer();
      } catch {}
      if (child.exitCode !== null) throw Error(`Service exited: ${await stderr}`);
      await Bun.sleep(30);
    }
    throw Error("Compiled transport did not become ready");
  };
  try {
    expect(await exchange(front, "rust-stdio")).toEqual(await exchange(core, "bun-stdio"));
    const rust = await serve(front, "rust-http"), bun = await serve(core, "bun-http");
    const exercise = async (service: typeof rust) => {
      const { base, token, port } = service;
      const auth = { Authorization: `Bearer ${token}` };
      const results: unknown[] = [];
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await fetch(base + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(10000) });
        const body = (await response.text()).replaceAll(String(port), "<port>").replaceAll(service.env.HOME, "<home>");
        results.push({ path, status: response.status, type: response.headers.get("content-type"), body });
        return response;
      };
      const health = await fetch(base + "/health");
      const healthBody = await health.json() as { ok: boolean; pid: number };
      expect(health.status).toBe(200); expect(healthBody.ok).toBe(true); expect(healthBody.pid).toBe(service.child.pid);
      await request("/v3/hello");
      await request("/v3/hello", { headers: { ...auth, Host: "foreign.invalid" } });
      await request("/v3/hello", { headers: { ...auth, "Sec-Fetch-Site": "cross-site" } });
      await request("/v3/hello", { headers: auth });
      await request("/v2/hello", { headers: auth });
      await request("/v3/ops/task.list", { method: "POST", headers: auth, body: "{}" });
      await request("/v3/ops/nonexistent.operation", { method: "POST", headers: auth, body: "{}" });
      await request("/v3/ops/task.list", { method: "POST", headers: auth, body: "{" });
      const exchange = await fetch(base + "/v3/session/exchange", { method: "POST", headers: auth, signal: AbortSignal.timeout(10000) });
      expect(exchange.status).toBe(204);
      const cookie = exchange.headers.get("set-cookie")!.split(";")[0];
      await exchange.arrayBuffer();
      await request("/v3/hello", { headers: { Cookie: cookie } });
      await request("/v3/ops/task.list", { method: "POST", headers: { Cookie: cookie, Origin: base }, body: "{}" });
      await request("/v3/ops/task.list", { method: "POST", headers: { Cookie: cookie, Origin: base, "X-Pacer-Client": "app" }, body: "{}" });
      await request("/v3/ops/task.list", { method: "POST", headers: { Cookie: cookie, Origin: "https://foreign.invalid", "X-Pacer-Client": "app" }, body: "{}" });
      await request("/app/");
      const controller = new AbortController();
      const sse = await fetch(base + "/v3/events?since=0", { headers: auth, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const reader = sse.body!.getReader();
      try {
        const first = await reader.read();
        results.push({ sse: sse.status, type: sse.headers.get("content-type"), frame: new TextDecoder().decode(first.value) });
      } finally { controller.abort(); await reader.cancel().catch(() => {}); }
      const ctx = fakeCtx({ home: service.env.HOME, pacerHome: service.env.PACER_HOME, env: service.env });
      const task = createTask(ctx, { brief: { goal: "transport parity", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 300 });
      const dir = join(ctx.pacerHome, "runs", task.id, "1"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.log"), "");
      const received: unknown[] = [], messages: unknown[] = [];
      let peer: Socket | undefined, ws: WebSocket | undefined;
      const socket = socketPath(dir);
      writeFileSync(join(dir, "session.sock.path"), socket);
      const unix = createServer(connection => {
        peer = connection;
        const decoder = new WireDecoder();
        connection.on("data", bytes => {
          for (const frame of decoder.push(Buffer.from(bytes))) {
            received.push({ type: frame.type, data: JSON.parse(frame.data.toString()) });
            if (frame.type === FrameType.hello) {
              connection.write(wire(FrameType.snapshot, { outputOffset: 10, cols: 120, rows: 40 }));
              connection.write(wire(FrameType.output, Buffer.from([0, 255, 27])));
            }
          }
        });
      });
      try {
        await new Promise<void>((resolve, reject) => { unix.once("error", reject); unix.listen(socket, resolve); });
        ws = new WebSocket(`${base.replace("http:", "ws:")}/v3/tasks/${task.id}/session?from=7`, { headers: { Cookie: cookie, Origin: base, "Sec-Fetch-Site": "same-origin" } } as any);
        ws.binaryType = "arraybuffer";
        ws.onmessage = event => messages.push(typeof event.data === "string" ? JSON.parse(event.data) : { binary: Buffer.from(event.data).toString("hex") });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("WebSocket handshake timed out")), 5000);
          ws!.onopen = () => { clearTimeout(timer); resolve(); };
          ws!.onerror = () => { clearTimeout(timer); reject(Error("WebSocket handshake failed")); };
        });
        ws.send(JSON.stringify({ type: "hello", v: 1, client: "cli", label: "parity", cols: 80, rows: 24 }));
        for (let n = 0; n < 500 && messages.length < 2; n++) await Bun.sleep(10);
        expect(messages).toHaveLength(2);
        expect(received).toHaveLength(1);
        results.push({ websocket: { received, messages } });
      } finally {
        ws?.close(); peer?.destroy();
        await new Promise<void>(resolve => unix.close(() => resolve()));
      }
      return results;
    };
    expect(await exercise(rust)).toEqual(await exercise(bun));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    for (const child of children) {
      await Promise.race([child.exited, Bun.sleep(6000)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}, 90000);
