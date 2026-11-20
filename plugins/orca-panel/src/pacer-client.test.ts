// Tests for the pure pacer HTTP/SSE client. Runner-agnostic: `bun test` and `orca plugin
// test` (Node's runner) both execute it, so it sticks to node:test/node:http — fixture
// servers are plain node:http servers on ephemeral loopback ports.
/// <reference types="@types/bun" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { callOp, getSnapshot, readPacerEndpoint, subscribeEvents } from "./pacer-client";

type FixtureServer = { port: number; close(): Promise<void> };

/** Starts a loopback server on an ephemeral port; `close()` ends every open connection. */
function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("readPacerEndpoint reads the token and builds the loopback URL", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "pacer-home-"));
  writeFileSync(join(tmpHome, "token"), "the-token-contents");
  try {
    const ep = readPacerEndpoint({ PACER_HOME: tmpHome, PACER_PORT: "4321" });
    assert.deepEqual(ep, { baseUrl: "http://127.0.0.1:4321", token: "the-token-contents" });
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("readPacerEndpoint returns null when the token file is missing", () => {
  assert.equal(readPacerEndpoint({ PACER_HOME: "/nonexistent" }), null);
});

test("getSnapshot sends the bearer token and parses the snapshot", async () => {
  let auth: string | null = null;
  let path = "";
  const server = await startServer((req, res) => {
    path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    auth = req.headers.authorization ?? null;
    jsonResponse(res, 200, {
      seq: 5,
      planner: { pace: 50 },
      counts: { attention: 1 },
      attention: [
        {
          id: "a1",
          kind: "review",
          severity: "decide",
          title: "Review the change",
          detail: "d",
          raisedAt: 100,
          since: 100,
          actions: [],
          notify: false,
        },
      ],
      repos: [{ key: "k1", label: "jawfish", path: "/repo" }],
    });
  });
  try {
    const result = await getSnapshot({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });
    assert.equal(path, "/v3/snapshot");
    assert.equal(auth, "Bearer t");
    assert.equal("error" in result, false);
    const snapshot = result as { seq: number; attention: { id: string }[] };
    assert.equal(snapshot.seq, 5);
    assert.deepEqual(snapshot.attention.map((a) => a.id), ["a1"]);
  } finally {
    await server.close();
  }
});

test("getSnapshot returns { error } on a non-2xx response", async () => {
  const server = await startServer((_req, res) => {
    jsonResponse(res, 401, { error: { code: "unauthorized", message: "bad token" } });
  });
  try {
    const result = await getSnapshot({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });
    assert.deepEqual(result, { error: "bad token" });
  } finally {
    await server.close();
  }
});

test("callOp posts params and returns the op result", async () => {
  let method = "";
  let path = "";
  let auth: string | null = null;
  let body = "";
  const server = await startServer(async (req, res) => {
    method = req.method ?? "";
    path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    auth = req.headers.authorization ?? null;
    body = await readBody(req);
    jsonResponse(res, 200, { result: { dismissed: true } });
  });
  try {
    const result = await callOp({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }, "attention.dismiss", { id: "a1" });
    assert.equal(method, "POST");
    assert.equal(path, "/v3/ops/attention.dismiss");
    assert.equal(auth, "Bearer t");
    assert.deepEqual(JSON.parse(body), { id: "a1" });
    assert.deepEqual(result, { ok: true, result: { dismissed: true } });
  } finally {
    await server.close();
  }
});

test("callOp maps an error response to { ok: false, error }", async () => {
  const server = await startServer((_req, res) => {
    jsonResponse(res, 404, { error: { code: "unknown_task", message: "unknown attention id" } });
  });
  try {
    const result = await callOp({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }, "attention.dismiss", {
      id: "nope",
    });
    assert.deepEqual(result, { ok: false, error: "unknown attention id" });
  } finally {
    await server.close();
  }
});

test("subscribeEvents parses SSE frames and calls onEvent per event", async () => {
  const frames = [
    ": connected\n\n",
    'id: 1\nevent: attention\ndata: {"x":1}\n\n',
    ": keepalive\n\n",
    'id: 2\nevent: counts\ndata: {"y":2}\n\n',
  ];
  let requestedSince = "";
  const server = await startServer((req, res) => {
    requestedSince = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("since") ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames) res.write(frame);
    res.end();
  });
  const events: Array<{ seq: number; type: string; data: unknown }> = [];
  let drops = 0;
  let resolveDrop: () => void;
  const dropped = new Promise<void>((r) => {
    resolveDrop = r;
  });
  try {
    subscribeEvents(
      { baseUrl: `http://127.0.0.1:${server.port}`, token: "t" },
      7,
      (seq, type, data) => events.push({ seq, type, data }),
      () => {
        drops++;
        resolveDrop();
      },
    );
    await dropped;
    assert.equal(requestedSince, "7");
    assert.deepEqual(events, [
      { seq: 1, type: "attention", data: { x: 1 } },
      { seq: 2, type: "counts", data: { y: 2 } },
    ]);
    assert.equal(drops, 1);
  } finally {
    await server.close();
  }
});

test("subscribeEvents calls onDrop when the stream ends without events", async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end();
  });
  let drops = 0;
  let resolveDrop: () => void;
  const dropped = new Promise<void>((r) => {
    resolveDrop = r;
  });
  try {
    const abort = subscribeEvents(
      { baseUrl: `http://127.0.0.1:${server.port}`, token: "t" },
      0,
      () => {
        throw Error("no events expected");
      },
      () => {
        drops++;
        resolveDrop();
      },
    );
    await dropped;
    assert.equal(drops, 1);
    assert.equal(typeof abort, "function");
    abort();
  } finally {
    await server.close();
  }
});
