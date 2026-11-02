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

test("CLI attach sends hello then forced control, renders bytes and restores listeners on socket exit", async () => {
  const dir = tmpDir(),
    path = join(dir, "session.sock"),
    received: { type: number; body: any }[] = [],
    output: Buffer[] = [];
  const server = createServer((socket) => {
    const decoder = new WireDecoder();
    let ended = false;
    socket.on("data", (bytes) => {
      for (const frame of decoder.push(Buffer.from(bytes)))
        received.push({
          type: frame.type,
          body: JSON.parse(frame.data.toString()),
        });
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
