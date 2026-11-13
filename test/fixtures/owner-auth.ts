import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { HOST_SOCKET_KEY_ENV, takeOwnerKey } from "../../src/plugins/host-bridge";

/**
 * The owner's side of the bridge credential (#918) for stand-in owners: Core in this test
 * process holds `key`, and `authed` answers its challenge before the stand-in sees a frame.
 */
let key: Buffer | undefined;

/** Give in-process Core a fresh owner credential, as the owner does for its Core child. */
export function useOwnerKey(): Buffer {
  key = randomBytes(32);
  takeOwnerKey({ [HOST_SOCKET_KEY_ENV]: key.toString("hex") });
  return key;
}

/** The credential in-process Core holds, installing one first if needed. */
export function ownerKey(): Buffer {
  return key ?? useOwnerKey();
}

const proof = (secret: Buffer, label: string, caller: string, owner: string) =>
  createHmac("sha256", secret).update(`${label}\0${caller}\0${owner}`).digest();

/** Wrap a stand-in owner's connection handler: it runs only after the caller proves the key. */
export function authed(handler: (socket: Socket) => void): (socket: Socket) => void {
  return socket => {
    const secret = ownerKey();
    socket.on("error", () => {});
    let text = "", caller: string | undefined;
    const owner = randomBytes(32).toString("hex");
    const refuse = (id: unknown) => { socket.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "unauthorized" } }) + "\n"); };
    const onData = (data: Buffer) => {
      text += data.toString("utf8");
      for (let cut = text.indexOf("\n"); cut >= 0; cut = text.indexOf("\n")) {
        const frame = JSON.parse(text.slice(0, cut));
        text = text.slice(cut + 1);
        if (frame.method !== "_host.auth") return refuse(frame.id ?? null);
        if (caller === undefined) {
          caller = frame.params.nonce as string;
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { nonce: owner, proof: proof(secret, "pacer-host-owner/v1", caller, owner).toString("hex") } }) + "\n");
          continue;
        }
        const sent = Buffer.from(String(frame.params?.proof ?? ""), "hex");
        const expected = proof(secret, "pacer-host-core/v1", caller, owner);
        if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return refuse(null);
        socket.off("data", onData);
        handler(socket);
        if (text) socket.emit("data", Buffer.from(text));
        return;
      }
    };
    socket.on("data", onData);
  };
}
