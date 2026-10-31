import { expect, test } from "bun:test";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { admitRemoteViewer } from "../src/remote/viewer-admission";

test("viewer admission keeps the first frame when it shares the acknowledgment packet", async () => {
  const server = createServer(peer => {
    peer.once("data", () => peer.write(Buffer.concat([
      Buffer.from("PACER-READY\n"), Buffer.from([0, 1, 2, 3]),
    ])));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("expected TCP listener");
  const client = createConnection(address.port, "127.0.0.1");
  try {
    await once(client, "connect");
    expect(await admitRemoteViewer(client)).toBeNull();
    const frame = once(client, "data");
    client.resume();
    expect((await frame)[0]).toEqual(Buffer.from([0, 1, 2, 3]));
  } finally {
    client.destroy();
    server.close();
  }
});
