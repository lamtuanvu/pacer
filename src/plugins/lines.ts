import type { Readable } from "node:stream";

export const MAX_LINE_BYTES = 1024 * 1024;

/** Split a child's stream into lines, dropping any line over 1 MiB so a plugin cannot grow the buffer. */
export function readLines(stream: Readable, receive: (line: string) => void, log: (m: string) => void, isOver: () => boolean): void {
  let buffer = "", dropping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (isOver()) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(offset, end);
      if (!dropping) {
        if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > MAX_LINE_BYTES) { buffer = ""; dropping = true; log("dropped a line over 1 MiB"); }
        else buffer += part;
      }
      if (newline < 0) break;
      if (!dropping) receive(buffer.replace(/\r$/, ""));
      buffer = ""; dropping = false; offset = newline + 1;
    }
  });
  stream.on("end", () => { if (!isOver() && !dropping && buffer) receive(buffer); buffer = ""; });
}
