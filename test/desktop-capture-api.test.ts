import { expect, test } from "bun:test";
import { CaptureBroker } from "../src/desktop/capture-broker";
function rejects(code: string, fn: () => unknown) { try { fn(); throw Error("expected rejection"); } catch (error) { expect(error).toMatchObject({ code }); } }
const png = Buffer.from(await Bun.file(`${import.meta.dir}/fixtures/live-control/one-pixel.png`).arrayBuffer());
const metadata = (method: "window" | "content" = "window") => ({ method, scale: 1, window_id: "1", pid: process.pid, app_version: "test", app_sha256: "0".repeat(64), captured_at_ms: Date.now(), viewport_width: 1, viewport_height: 1 });
test("capture requests require per-instance credential and completion is single use", () => {
  const broker = new CaptureBroker(); const worker = broker.register("desktop-a"); const other = broker.register("desktop-b");
  const request = broker.request("desktop-a", "main", "window");
  rejects("not_allowed", () => broker.claim("desktop-a", other));
  expect(broker.claim("desktop-a", worker)?.request_id).toBe(request.request_id);
  rejects("not_allowed", () => broker.complete(request.request_id, other, png, metadata()));
  broker.complete(request.request_id, worker, png, metadata());
  expect(broker.result(request.request_id).status).toBe("complete");
  expect(broker.image(request.request_id).byteLength).toBe(png.byteLength);
  rejects("conflict", () => broker.complete(request.request_id, worker, png, metadata()));
});
test("requests expire and malformed image cannot be accepted", () => {
  let now = 0; const broker = new CaptureBroker(() => now); const worker = broker.register("a");
  const request = broker.request("a", "main", "content"); broker.claim("a", worker);
  rejects("invalid_input", () => broker.complete(request.request_id, worker, new Uint8Array([1]), metadata("content")));
  now = 60001; rejects("not_found", () => broker.result(request.request_id));
});
test("worker restart invalidates old credentials and owned windows only", () => {
  const broker = new CaptureBroker(); const old = broker.register("a"); broker.register("a");
  rejects("not_allowed", () => broker.claim("a", old));
  rejects("invalid_input", () => broker.request("a", "../../other", "window"));
});

test("image route retains service authentication and rejects foreign worker", async () => {
  const { startServer } = await import("../src/serve/http");
  const { fakeCtx } = await import("./helpers");
  const { callOp } = await import("../src/api/ops");
  const ctx = fakeCtx();
  const server = startServer(() => ctx, { port: 0, listener: false });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const client = await callOp(ctx, "client.register", { kind: "desktop", version: "test", capture: true }) as {client_id: string; capture_worker: string};
    const request = await callOp(ctx, "desktop.capture.request", { client_id: client.client_id, window: "main", mode: "window" }) as {request_id: string};
    await callOp(ctx, "desktop.capture.claim", { client_id: client.client_id, worker_token: client.capture_worker });
    const url = `${origin}/v3/desktop/capture/${request.request_id}/image`;
    expect((await fetch(url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${server.token}`, "X-Pacer-Capture-Worker": "wrong", "X-Pacer-Capture-Method": "window", "X-Pacer-Capture-Scale": "1", "X-Pacer-Capture-Metadata": JSON.stringify(metadata()) };
    expect((await fetch(url, { method: "POST", headers, body: png })).status).toBe(403);
    headers["X-Pacer-Capture-Worker"] = client.capture_worker;
    expect((await fetch(url, { method: "POST", headers, body: png })).status).toBe(200);
    const image = await fetch(url, { headers });
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  } finally { server.stop(); }
});

test("non-ASCII worker tokens fail authorization without an internal error", () => {
  const broker = new CaptureBroker(); broker.register("a");
  rejects("not_allowed", () => broker.claim("a", "é".repeat(64)));
});

test("a truncated PNG header cannot complete a capture", () => {
  const broker = new CaptureBroker(); const worker = broker.register("a");
  const request = broker.request("a", "main", "window"); broker.claim("a", worker);
  rejects("invalid_input", () => broker.complete(request.request_id, worker, png.slice(0, 24), metadata()));
});

test("parallel upload conflicts and a stalled stream is cancelled at deadline", async () => {
  const { desktopCaptureRoute } = await import("../src/serve/desktop-capture");
  const { captureBroker } = await import("../src/desktop/capture-broker");
  const { fakeCtx } = await import("./helpers");
  const ctx = fakeCtx(); const broker = captureBroker(ctx.pacerHome); const token = broker.register("upload");
  const request = broker.request("upload", "main", "window"); broker.claim("upload", token);
  const url = `http://localhost/v3/desktop/capture/${request.request_id}/image`;
  const headers = { "X-Pacer-Capture-Worker": token, "X-Pacer-Capture-Method": "window", "X-Pacer-Capture-Scale": "1", "X-Pacer-Capture-Metadata": JSON.stringify(metadata()) };
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png.slice(0, 8)); }, cancel() { cancelled = true; } });
  const first = desktopCaptureRoute(new Request(url, { method: "POST", headers, body: stream }), ctx, { uploadTimeoutMs: 30 });
  await Bun.sleep(1);
  const duplicate = await desktopCaptureRoute(new Request(url, { method: "POST", headers, body: png }), ctx);
  expect(duplicate?.status).toBe(409);
  expect((await first)?.status).toBe(409); expect(cancelled).toBe(true);
});

test("capture-time window identity must match the requested target", () => {
  const broker = new CaptureBroker(); const token = broker.register("identity");
  const request = broker.request("identity", "main", "window", "99"); broker.claim("identity", token);
  rejects("conflict", () => broker.complete(request.request_id, token, png, metadata()));
});
