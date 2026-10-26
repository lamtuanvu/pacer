import { createInterface } from "node:readline";
let request: any, mode: string;
const send = (m: any) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "planner.install" || m.method === "planner.uninstall") {
    request = m;
    mode = m.params.mode;
    send({
      id: "chunk",
      method: "$/resultChunk",
      params: {
        request: m.id,
        offset: 0,
        base64: mode === "incomplete" ? "ew==" : "e30=",
      },
      _meta: m._meta,
    });
    if (mode === "overlap")
      send({
        id: "overlap",
        method: "$/resultChunk",
        params: { request: m.id, offset: 0, base64: "e30=" },
        _meta: m._meta,
      });
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
