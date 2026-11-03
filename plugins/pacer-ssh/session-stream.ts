import { PluginError, type HostClient } from "@pacer/plugin";
import { sessionPipeArgv } from "./probe";

const marker = Buffer.from("__PACER_BEGIN__\n");
const fail = (code: string, message: string): never => { throw new PluginError(code, message); };

/** Drop login-shell chatter and the fixed marker without retaining opaque bytes. */
function payload() {
  let prefix = Buffer.alloc(0), framed = false, lineStart = true;
  return {
    get framed() { return framed; },
    take(chunk: Buffer): Buffer {
      if (framed) return chunk;
      const bytes = Buffer.concat([prefix, chunk]);
      prefix = Buffer.alloc(0);
      for (let i = 0; i < bytes.length; i++) {
        if (lineStart && bytes[i] === marker[0]) {
          const remaining = bytes.subarray(i);
          if (remaining.length < marker.length && marker.subarray(0, remaining.length).equals(remaining)) {
            prefix = Buffer.from(remaining); break;
          }
          if (remaining.subarray(0, marker.length).equals(marker)) {
            framed = true;
            return remaining.subarray(marker.length);
          }
        }
        lineStart = bytes[i] === 10;
      }
      return Buffer.alloc(0);
    },
  };
}

export async function streamSession(input: Record<string, unknown>, host: HostClient, signal: AbortSignal,
  session: { sshTarget: string; controlPath: string }): Promise<{ code: 0; bytes: number }> {
  const streamId = input.streamId;
  if (signal.aborted || input.script !== "SESSION_PIPE" ||
    !Array.isArray(input.args) || input.args.length !== 1 ||
    typeof streamId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(streamId) ||
    !Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 2000 || (input.timeoutMs as number) > 60_000 ||
    !Number.isSafeInteger(input.maxBytes) || (input.maxBytes as number) < 1 || (input.maxBytes as number) > 65_536 ||
    input.stdin !== undefined || !host.streamProgress || !host.streamInput)
    fail("capability_denied", "remote session stream was not issued for this provider");
  const argv = (() => {
    try { return sessionPipeArgv(session.sshTarget, session.controlPath, input.args as string[]); }
    catch { return fail("capability_denied", "invalid host-issued session pipe tuple"); }
  })();
  const opened = await host.call<{ handle: string }>("capability.process.duplex.open", { argv, timeoutMs: input.timeoutMs });
  if (!opened || typeof opened.handle !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(opened.handle))
    fail("plugin_refused", "SSH session broker returned an invalid handle");
  const handle = opened.handle;
  let closed = false;
  const close = async (graceful: boolean) => {
    if (closed) fail("plugin_unavailable", "SSH session stream already closed");
    closed = true;
    return host.call<{ ok: true; code: number | null; signal: string | null; terminated: boolean }>(
      "capability.process.duplex.close", { handle, graceful });
  };
  const incoming = (async () => {
    while (!signal.aborted) {
      const frame = await host.streamInput!.next();
      const bytes = Buffer.from(frame.bytes);
      if (!bytes.length || bytes.length > 65_536) fail("plugin_refused", "session input frame exceeds the bound");
      const receipt = await host.call<{ bytes: number }>("capability.process.duplex.write",
        { handle, base64: bytes.toString("base64"), timeoutMs: input.timeoutMs });
      if (receipt?.bytes !== bytes.length) fail("plugin_refused", "SSH session input receipt is incomplete");
      await frame.ack();
    }
  })();
  void incoming.catch(() => {});
  try {
    const decoded = payload();
    let sequence = 0, total = 0;
    const outgoing = (async () => {
      while (!signal.aborted) {
        const frame = await host.call<{ base64: string; eof: boolean }>("capability.process.duplex.read",
          { handle, length: 65_536, timeoutMs: input.timeoutMs, pollMs: 1000 });
        if (!frame || typeof frame.base64 !== "string" || typeof frame.eof !== "boolean" ||
          frame.base64.length > 87_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.base64))
          fail("plugin_refused", "SSH session output frame is invalid");
        const bytes = Buffer.from(frame.base64, "base64");
        if (bytes.length > 65_536 || bytes.toString("base64") !== frame.base64)
          fail("plugin_refused", "SSH session output frame exceeds the bound");
        const next = decoded.take(bytes);
        if (next.length) {
          total += next.length;
          if (!Number.isSafeInteger(total)) fail("too_large", "SSH session byte count overflow");
          await host.streamProgress!(streamId as string, sequence++, next);
        }
        if (frame.eof) break;
      }
      if (signal.aborted) fail("plugin_unavailable", "SSH session owner ended");
      if (!decoded.framed) fail("plugin_refused", "SSH session payload marker missing");
    })();
    await Promise.race([outgoing, incoming.then(() => fail("plugin_unavailable", "SSH session input ended early"))]);
    const receipt = await close(true);
    if (!receipt?.ok || receipt.code !== 0 || receipt.signal !== null || receipt.terminated)
      fail("plugin_unavailable", "SSH session ended without a clean remote exit");
    return { code: 0, bytes: total };
  } catch (error) {
    if (!closed) await close(false).catch(() => {});
    throw error;
  }
}
