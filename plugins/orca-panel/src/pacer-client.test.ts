// Tests for the pure pacer HTTP/SSE client. Plain `bun test` — no Orca virtual modules,
// no Orca plugin harness. Fixture servers use Bun.serve() on ephemeral ports.
/// <reference types="@types/bun" />
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { callOp, getSnapshot, readPacerEndpoint, subscribeEvents } from "./pacer-client";

test("readPacerEndpoint reads the token and builds the loopback URL", () => {
  const tmpHome = mkdtempSync(join(tmpdir(), "pacer-home-"));
  writeFileSync(join(tmpHome, "token"), "the-token-contents");
  try {
    const ep = readPacerEndpoint({ PACER_HOME: tmpHome, PACER_PORT: "4321" });
    expect(ep).toEqual({ baseUrl: "http://127.0.0.1:4321", token: "the-token-contents" });
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("readPacerEndpoint returns null when the token file is missing", () => {
  expect(readPacerEndpoint({ PACER_HOME: "/nonexistent" })).toBeNull();
});

test("getSnapshot sends the bearer token and parses the snapshot", async () => {
  let auth: string | null = null;
  let path = "";
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      path = url.pathname;
      auth = req.headers.get("authorization");
      return Response.json({
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
    },
  });
  try {
    const result = await getSnapshot({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });
    expect(path).toBe("/v3/snapshot");
    expect(auth as string | null).toBe("Bearer t");
    expect(result).toMatchObject({ seq: 5, attention: [{ id: "a1" }] });
    expect("error" in result).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("getSnapshot returns { error } on a non-2xx response", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 });
    },
  });
  try {
    const result = await getSnapshot({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" });
    expect(result).toEqual({ error: "bad token" });
  } finally {
    server.stop(true);
  }
});

test("callOp posts params and returns the op result", async () => {
  let method = "";
  let path = "";
  let auth: string | null = null;
  let body = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      method = req.method;
      path = url.pathname;
      auth = req.headers.get("authorization");
      body = await req.text();
      return Response.json({ result: { dismissed: true } });
    },
  });
  try {
    const result = await callOp(
      { baseUrl: `http://127.0.0.1:${server.port}`, token: "t" },
      "attention.dismiss",
      { id: "a1" },
    );
    expect(method).toBe("POST");
    expect(path).toBe("/v3/ops/attention.dismiss");
    expect(auth as string | null).toBe("Bearer t");
    expect(JSON.parse(body)).toEqual({ id: "a1" });
    expect(result).toEqual({ ok: true, result: { dismissed: true } });
  } finally {
    server.stop(true);
  }
});

test("callOp maps an error response to { ok: false, error }", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ error: { code: "unknown_task", message: "unknown attention id" } }, { status: 404 });
    },
  });
  try {
    const result = await callOp({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t" }, "attention.dismiss", {
      id: "nope",
    });
    expect(result).toEqual({ ok: false, error: "unknown attention id" });
  } finally {
    server.stop(true);
  }
});

test("subscribeEvents parses SSE frames and calls onEvent per event", async () => {
  const frames = [
    ": connected\n\n",
    "id: 1\nevent: attention\ndata: {\"x\":1}\n\n",
    ": keepalive\n\n",
    "id: 2\nevent: counts\ndata: {\"y\":2}\n\n",
  ];
  let requestedSince = "";
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requestedSince = new URL(req.url).searchParams.get("since") ?? "";
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
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
    expect(requestedSince).toBe("7");
    expect(events).toEqual([
      { seq: 1, type: "attention", data: { x: 1 } },
      { seq: 2, type: "counts", data: { y: 2 } },
    ]);
    expect(drops).toBe(1);
  } finally {
    server.stop(true);
  }
});

test("subscribeEvents calls onDrop when the stream ends without events", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      const stream = new ReadableStream({ start(controller) { controller.close(); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
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
    expect(drops).toBe(1);
    expect(typeof abort).toBe("function");
    abort();
  } finally {
    server.stop(true);
  }
});
