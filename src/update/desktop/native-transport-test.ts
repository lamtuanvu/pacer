/** Release smoke: an authenticated self-connection, with no service or manager. */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, rmdirSync } from "node:fs";
import { connect } from "node:net";
import { currentVersion } from "../version";
import { encodeFrame, FrameDecoder } from "./adapter";
import { DarwinAuthority, nativeSocketPath } from "./native-os";
import { LocalNativeServer } from "./native-socket";
import { ownProcessIdentity, processIdentity, sameProcess } from "./process-identity";

export async function nativeTransportSelfTest() {
  const authority = DarwinAuthority.configured();
  if (!Bun.isStandaloneExecutable || !authority)
    throw Error("Native transport smoke requires a compiled signed baseline");
  const own = ownProcessIdentity();
  if (!own) throw Error("Native process identity unavailable");
  authority.verifyProcess(own, "cli");
  const directory = mkdtempSync("/private/tmp/pacer-native-smoke-");
  const identity = lstatSync(directory);
  let server: LocalNativeServer | undefined;
  let client: ReturnType<typeof connect> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!identity.isDirectory() || identity.uid !== process.getuid?.() || identity.mode & 0o077)
      throw Error("Native smoke directory unavailable");
    const path = nativeSocketPath(directory, 7433, process.getuid!());
    const nonce = randomBytes(32).toString("hex");
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(Error("Native transport smoke timed out")), 5_000);
      server = new LocalNativeServer(path, (peer) => {
        try {
          authority.verifyPeer(peer.auditToken, "cli", own);
          peer.onFrame = (frame) => {
            if (JSON.stringify(frame) !== JSON.stringify({ nonce })) {
              reject(Error("Native smoke frame mismatch"));
              peer.close();
              return;
            }
            void peer.send({ nonce }).catch(reject);
          };
        } catch (error) {
          peer.close();
          reject(error);
        }
      });
      client = connect(path);
      const decoder = new FrameDecoder();
      client.on("data", (bytes) => {
        try {
          const frames = decoder.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
          if (!frames.length) return;
          if (frames.length !== 1 || JSON.stringify(frames[0]) !== JSON.stringify({ nonce }))
            throw Error("Native smoke response mismatch");
          if (!sameProcess(own, processIdentity(process.pid)))
            throw Error("Native smoke incarnation changed");
          resolve();
        } catch (error) { reject(error); }
      });
      client.once("error", reject);
      client.once("connect", () => client!.write(encodeFrame({ nonce })));
    });
    return {
      schema: 1 as const, role: "cli" as const, version: currentVersion(),
      arch: process.arch === "arm64" ? "aarch64" : "x86_64",
      nativeTransportAbi: 1 as const, transport: "unix-audit-token" as const,
      verified: true as const,
    };
  } finally {
    clearTimeout(timeout);
    client?.destroy();
    server?.close();
    const after = lstatSync(directory);
    if (!after.isSymbolicLink() && after.dev === identity.dev && after.ino === identity.ino)
      rmdirSync(directory);
  }
}
