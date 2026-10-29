/** Independent disposable peer: observes bytes, deliberately denies; no helper spawn. */
import { readSync, writeSync } from "node:fs";
function exact(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(0, bytes, offset, size - offset, null);
    if (!count) throw Error("request ended early");
    offset += count;
  }
  return bytes;
}
const size = exact(4).readUInt32BE();
if (size < 1 || size > 8192) throw Error("request bound");
const value = JSON.parse(exact(size).toString("utf8"));
writeSync(0, Buffer.from([69, 0, 0, 0, 0]));
console.log(JSON.stringify({ keys: Object.keys(value).sort(), authority: {schema:value.schema,path:value.path,sha256:value.sha256,version:value.version}, startedAtMs: value.startedAtMs, receivedAtMs: Date.now() }));
