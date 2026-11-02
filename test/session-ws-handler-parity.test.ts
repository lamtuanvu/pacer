import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { sessionWebSocket } from "../src/serve/session-ws";
import { FrameType, WireDecoder, wire } from "../src/session/framing";
class Socket extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  paused = false;
  writes: Buffer[] = [];
  write(b: Buffer) {
    this.writes.push(b);
    return true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  destroy() {
    this.destroyed = true;
  }
}
function fixture() {
  const socket = new Socket(),
    messages: (string | Buffer)[] = [],
    closed: unknown[][] = [];
  let status = 1;
  const ws = {
    data: { socket, decoder: new WireDecoder() },
    sendText: (s: string) => {
      messages.push(s);
      return status;
    },
    sendBinary: (b: Buffer) => {
      messages.push(b);
      return status;
    },
    close: (...args: unknown[]) => closed.push(args),
  } as any;
  return {
    socket,
    messages,
    closed,
    ws,
    setStatus: (n: number) => (status = n),
  };
}
test("live WS handlers pause on backpressure, resume on drain, close on socket faults and zero sends", () => {
  const f = fixture();
  sessionWebSocket.open!(f.ws);
  f.setStatus(-1);
  f.socket.emit("data", wire(3, Buffer.from([0, 255])));
  expect(f.socket.paused).toBe(true);
  sessionWebSocket.drain!(f.ws);
  expect(f.socket.paused).toBe(false);
  f.setStatus(0);
  f.socket.emit("data", wire(5, { you: false }));
  expect(f.socket.destroyed).toBe(true);
  f.socket.emit("error", Error("fixture"));
  expect(f.closed.at(-1)).toEqual([1011, "Session socket closed"]);
  f.socket.emit("close");
  expect(f.closed.at(-1)).toEqual([]);
  sessionWebSocket.close!(f.ws, 1000, "fixture");
  expect(f.socket.destroyed).toBe(true);
});
test("live WS rejects incomplete frames and input overflow; complete hello carries trusted app and query offset", () => {
  const f = fixture();
  f.ws.data.from = 4;
  sessionWebSocket.message!(
    f.ws,
    JSON.stringify({ type: "hello", v: 1, client: "cli", from: 8 }),
  );
  const hello = new WireDecoder().push(f.socket.writes[0]!)[0]!;
  expect(JSON.parse(hello.data.toString())).toEqual({
    v: 1,
    client: "app",
    from: 4,
  });
  f.socket.writableLength = 1024 * 1024;
  sessionWebSocket.message!(f.ws, Buffer.from(wire(10, Buffer.from("x"))));
  expect(f.closed.at(-1)).toEqual([1009, "Session input queue exceeded"]);
  expect(f.socket.destroyed).toBe(true);
  const invalid = fixture();
  sessionWebSocket.message!(
    invalid.ws,
    Buffer.from(wire(10, Buffer.from("x")).subarray(0, 5)),
  );
  expect(invalid.closed).toEqual([[1002, "Invalid session frame"]]);
  expect(invalid.socket.destroyed).toBe(true);
  const badHost = fixture();
  sessionWebSocket.open!(badHost.ws);
  badHost.socket.emit("data", wire(5, Buffer.from("bad json")));
  expect(badHost.closed).toEqual([[1002, "Invalid session frame"]]);
  expect(badHost.socket.destroyed).toBe(true);
});
test("offline replay starts once on hello, resumes on drain and refuses every control action", () => {
  const messages: string[] = [],
    closed: unknown[][] = [];
  let sent = -1;
  const ws = {
    data: {
      decoder: new WireDecoder(),
      replay: {
        frames: [
          { type: FrameType.control, data: Buffer.from("{}") },
          { type: FrameType.exit, data: Buffer.from('{"code":0}') },
        ],
        next: 0,
        started: false,
      },
    },
    sendText: (s: string) => {
      messages.push(s);
      return sent;
    },
    close: (...args: unknown[]) => closed.push(args),
  } as any;
  sessionWebSocket.drain!(ws);
  expect(messages).toEqual([]);
  for (const type of ["take", "input", "size", "release"])
    sessionWebSocket.message!(ws, JSON.stringify({ type }));
  expect(messages.map((s) => JSON.parse(s))).toEqual(
    Array(4).fill({
      type: "control",
      controller: null,
      you: false,
      reason: "read-only",
    }),
  );
  messages.length = 0;
  sessionWebSocket.message!(ws, '{"type":"hello","v":1}');
  expect(messages).toHaveLength(1);
  expect(closed).toEqual([]);
  sent = 1;
  sessionWebSocket.drain!(ws);
  expect(messages.map((s) => JSON.parse(s))).toEqual([
    { type: "control" },
    { type: "exit", code: 0 },
  ]);
  expect(closed).toEqual([[]]);
  const failed = {
    ...ws,
    data: { ...ws.data, replay: { ...ws.data.replay, next: 0 } },
    sendText: () => 0,
  };
  sessionWebSocket.drain!(failed);
  expect(closed).toHaveLength(2);
});
