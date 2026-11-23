import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readDuplexChunk } from "../src/plugins/duplex-read";

test("a close event drains buffered SSH stdout before reporting EOF", async () => {
  const stream = new Readable({ read() {} });
  const bytes = Buffer.from("__PACER_BEGIN__\nviewer output");
  const first = readDuplexChunk(stream, 65_536, new AbortController().signal);
  stream.push(bytes);
  stream.push(null);
  stream.emit("close"); // A short-lived child can close before its queued readable event.
  expect(await first).toEqual({ base64: bytes.toString("base64"), eof: false });
  expect(await readDuplexChunk(stream, 65_536, new AbortController().signal))
    .toEqual({ base64: "", eof: true });
});
