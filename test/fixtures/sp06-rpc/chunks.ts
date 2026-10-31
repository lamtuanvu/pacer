import { createInterface } from "node:readline";
let request: any, mode: string;
const encode = (m: any) => JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n";
const send = (m: any) => process.stdout.write(encode(m));
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "planner.install" || m.method === "planner.uninstall") {
    request = m;
    mode = m.params.mode;
    const first = encode({
      id: "chunk",
      method: "$/resultChunk",
      params: {
        request: m.id,
        offset: 0,
        base64: mode === "incomplete" ? "ew==" : "e30=",
      },
      _meta: m._meta,
    });
    // One write delivers the overlap while the first chunk is still staging; separate
    // writes can arrive after it finished and fail contiguity instead of conflict.
    process.stdout.write(mode === "overlap" ? first + encode({
      id: "overlap",
      method: "$/resultChunk",
      params: { request: m.id, offset: 0, base64: "e30=" },
      _meta: m._meta,
    }) : first);
  } else if (m.id === "chunk" && m.error)
    send({ id: request.id, error: m.error });
  else if (m.id === "chunk" && !m.error && mode !== "overlap")
    send({
      id: request.id,
      result: {
        _chunkedResult: {
          bytes: mode === "wrong-receipt" ? 3 : mode === "incomplete" ? 1 : 2,
        },
      },
    });
});
