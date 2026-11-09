import { expect, test, spyOn } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tmpDir } from "./helpers";
import { attachSession } from "../src/session/attach";
import {
  wire,
  WireDecoder,
  FrameType,
  encodeHeader,
} from "../src/session/framing";

test("CLI attach on a 1.1 host sends hello then forced control, no 1.2 frames, renders bytes and restores listeners on socket exit", async () => {
  const dir = tmpDir(),
    path = join(dir, "session.sock"),
    received: { type: number; body: any }[] = [],
    output: Buffer[] = [];
  const server = createServer((socket) => {
    const decoder = new WireDecoder();
    let ended = false;
    socket.on("data", (bytes) => {
      for (const frame of decoder.push(Buffer.from(bytes))) {
        received.push({
          type: frame.type,
          body: JSON.parse(frame.data.toString()),
        });
        // A 1.1 host answers hello without a version range.
        if (frame.type === FrameType.hello)
          socket.write(wire(FrameType.control, { controller: "cli:fixture", you: false }));
      }
      if (!ended && received.some((f) => f.type === FrameType.take))
        ((ended = true),
          socket.end(
            Buffer.concat([
              wire(FrameType.control, { you: true, controller: "cli:fixture" }),
              wire(FrameType.output, Buffer.from([0, 255, 65])),
              wire(FrameType.exit, { code: 0 }),
            ]),
          ));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const before = [
    process.listenerCount("SIGINT"),
    process.listenerCount("SIGTERM"),
    process.stdout.listenerCount("resize"),
  ];
  const stdout = spyOn(process.stdout, "write").mockImplementation(((
    data: string | Uint8Array,
  ) => {
    output.push(Buffer.from(data));
    return true;
  }) as any);
  try {
    await attachSession(dir, { control: true, force: true }, "Fixture");
    expect(received.slice(0, 2)).toEqual([
      {
        type: 1,
        body: expect.objectContaining({
          v: 1,
          client: "cli",
          cols: expect.any(Number),
          rows: expect.any(Number),
        }),
      },
      { type: 8, body: { force: true } },
    ]);
    expect(received.some((f) => f.type === FrameType.focus || f.type === FrameType.deliver)).toBe(false);
    expect(received[0].body.readOnly).toBeUndefined();
    expect(Buffer.concat(output).includes(Buffer.from([0, 255, 65]))).toBe(
      true,
    );
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
      process.stdout.listenerCount("resize"),
    ]).toEqual(before);
  } finally {
    stdout.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("dead local socket falls back to recording and explicit replay avoids the socket", async () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, "session.log"),
    encodeHeader({ cols: 80, rows: 24, startedAt: 0, generation: 0 }),
  );
  writeFileSync(join(dir, "session.sock.path"), join(dir, "missing.sock"));
  const before = process.listenerCount("SIGINT");
  await attachSession(dir);
  await attachSession(dir, { replay: true });
  expect(process.listenerCount("SIGINT")).toBe(before);
});

async function fakeHost(versions: [number, number] | null, finish: (received: { type: number; body: any }[]) => boolean) {
  const dir = tmpDir(), received: { type: number; body: any }[] = [];
  const server = createServer((socket) => {
    const decoder = new WireDecoder();
    let ended = false;
    socket.on("data", (bytes) => {
      for (const frame of decoder.push(Buffer.from(bytes))) {
        received.push({ type: frame.type, body: frame.type === FrameType.input ? frame.data.toString() : JSON.parse(frame.data.toString()) });
        if (frame.type === FrameType.hello) socket.write(wire(FrameType.control, { controller: null, you: !frame.data.toString().includes("readOnly"), ...(versions ? { versions, pacer: "0.0.0" } : {}) }));
      }
      if (!ended && finish(received)) { ended = true; socket.end(wire(FrameType.exit, { code: 0 })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "session.sock"), resolve));
  return { dir, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const quietly = async (fn: () => Promise<void>) => {
  const stdout = spyOn(process.stdout, "write").mockImplementation((() => true) as any);
  try { await fn(); } finally { stdout.mockRestore(); }
};

test("CLI attach on a 1.2 host focuses and sends its size, and ignores --control and --force", async () => {
  const host = await fakeHost([1, 2], (r) => r.some((f) => f.type === FrameType.size));
  try {
    await quietly(() => attachSession(host.dir, { control: true, force: true }, "Fixture"));
    expect(host.received.map((f) => f.type)).toEqual([FrameType.hello, FrameType.focus, FrameType.size]);
    expect(host.received[0].body.versions).toEqual([1, 2]);
    expect(host.received[2].body).toEqual({ cols: expect.any(Number), rows: expect.any(Number) });
  } finally { await host.close(); }
});

test("read-only attach says so in hello and sends no take, focus, size or input to either host", async () => {
  for (const versions of [[1, 2], null] as const) {
    let seen = 0;
    const host = await fakeHost(versions as [number, number] | null, () => ++seen > 0);
    try {
      await quietly(() => attachSession(host.dir, { control: true, force: true, readOnly: true }, "Fixture"));
      await Bun.sleep(20);
      expect(host.received.map((f) => f.type)).toEqual([FrameType.hello]);
      expect(host.received[0].body.readOnly).toBe(true);
    } finally { await host.close(); }
  }
});

test("pacer attach from an executor session is always read-only; --read-only sets it explicitly", async () => {
  const { recordDispatch } = await import("../scripts/golden/session-dispatch");
  const rows: { scenario: string; calls: unknown[][] }[] = await recordDispatch();
  const options = (scenario: string) => rows.find((r) => r.scenario === scenario)!.calls.find((c) => c[0] === "attach")?.[2];
  expect(options("attach-executor")).toMatchObject({ readOnly: true });
  expect(options("attach-control")).toMatchObject({ readOnly: false, control: true, force: true });
  expect(options("attach-read-only")).toMatchObject({ readOnly: true });
});

async function bridgeHost(versions: [number, number] | null) {
  const dir = tmpDir();
  // A session reached through an SSH bridge lives on a paired or remote machine (ADR 0023, decision 2).
  writeFileSync(join(dir, "session.bridge.pid"), String(process.pid));
  const received: { type: number; body: any }[] = [];
  const ADMISSION = Buffer.from("PACER-VIEWER/1\n");
  const server = createServer((socket) => {
    const decoder = new WireDecoder();
    let admitted = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (bytes) => {
      buffer = Buffer.concat([buffer, Buffer.from(bytes)]);
      if (!admitted) {
        const at = buffer.indexOf(ADMISSION);
        if (at < 0) return;
        socket.write("PACER-READY\n");
        admitted = true;
        buffer = buffer.subarray(at + ADMISSION.length);
      }
      for (const frame of decoder.push(buffer)) {
        received.push({ type: frame.type, body: frame.type === FrameType.input ? frame.data.toString() : JSON.parse(frame.data.toString()) });
        if (frame.type === FrameType.hello) {
          socket.write(wire(FrameType.control, { controller: null, you: false, ...(versions ? { versions, pacer: "0.0.0" } : {}) }));
          socket.end(wire(FrameType.exit, { code: 0 }));
        }
      }
      buffer = Buffer.alloc(0);
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "session.sock"), resolve));
  return { dir, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a CLI attach through an SSH bridge to a remote session is read-only: readOnly hello and no input, size, focus or take", async () => {
  for (const versions of [[1, 2], null] as const) {
    const host = await bridgeHost(versions as [number, number] | null);
    try {
      await quietly(() => attachSession(host.dir, { control: true, force: true }, "Fixture"));
      await Bun.sleep(20);
      expect(host.received.map((f) => f.type)).toEqual([FrameType.hello]);
      expect(host.received[0].body.readOnly).toBe(true);
    } finally { await host.close(); }
  }
});
