import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import type { HostCfg } from "../config/hosts";
import { socketPath } from "../session/host";
import { pluginRegistry } from "../plugins";
import { issueConfiguredHostSessionStream } from "../plugins/host-session-stream-issuer";
import { CoreError } from "../core/errors";

/** Concurrent local viewers per remote session; each one holds a bundled SSH stream. */
export const MAX_SESSION_VIEWERS = 2;

/** Byte-transparent local viewer socket over one host-issued bundled SSH stream. */
export class RemoteSession {
  private server?: Server;
  private listening?: Promise<void>;
  private path?: string;
  private peers = new Map<Socket, AbortController>();
  private bridges = new Set<Promise<void>>();
  private closed = false;
  private onExit = () => {
    for (const owner of this.peers.values()) owner.abort();
  };

  constructor(private ctx: Ctx, private host: HostCfg, private remoteDir: string, private localDir: string) {}

  async listen(): Promise<void> {
    if (this.server?.listening || this.closed) return;
    if (this.listening) return this.listening;
    this.listening = this.bind().finally(() => { this.listening = undefined; });
    return this.listening;
  }

  private async bind(): Promise<void> {
    const path = socketPath(this.localDir);
    rmSync(path, { force: true });
    const server = createServer(socket => this.accept(socket));
    this.server = server;
    server.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    if (this.closed) { server.close(); rmSync(path, { force: true }); return; }
    this.path = path;
    chmodSync(path, 0o600);
    if (path !== join(this.localDir, "session.sock"))
      writeFileSync(join(this.localDir, "session.sock.path"), path, { mode: 0o600 });
    writeFileSync(join(this.localDir, "session.bridge.pid"), String(process.pid), { mode: 0o600 });
    process.on("exit", this.onExit);
    server.unref();
  }

  accept(socket: Socket): void {
    if (this.closed) { socket.destroy(); return; }
    // The session socket protocol has no error frame, so the refusal is the socket error and an immediate close.
    if (this.peers.size >= MAX_SESSION_VIEWERS) {
      socket.on("error", () => {});
      socket.destroy(new CoreError("plugin_unavailable", `remote session already has ${MAX_SESSION_VIEWERS} viewers; close one and try again`));
      return;
    }
    const owner = new AbortController();
    this.peers.set(socket, owner);
    socket.pause();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { owner.abort(); this.peers.delete(socket); });
    const bridge = this.bridge(socket, owner).catch(() => { socket.destroy(); });
    this.bridges.add(bridge);
    void bridge.finally(() => this.bridges.delete(bridge));
  }

  private async bridge(socket: Socket, owner: AbortController): Promise<void> {
    const grant = issueConfiguredHostSessionStream(this.ctx, this.host.alias, this.remoteDir, this.localDir);
    const stream = await pluginRegistry(this.ctx).streamConfiguredHost(this.ctx, grant,
      bytes => this.output(socket, owner.signal, bytes), owner.signal);
    let sending: Promise<void> = Promise.resolve();
    socket.on("data", raw => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      socket.pause();
      sending = sending.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += 65_536) {
          if (owner.signal.aborted || socket.destroyed) throw Error("viewer ended");
          await stream.sendInput(bytes.subarray(offset, offset + 65_536));
        }
        if (!owner.signal.aborted && !socket.destroyed) socket.resume();
      }).catch(() => { owner.abort(); socket.destroy(); });
    });
    socket.resume();
    try {
      await stream.done;
      if (!socket.destroyed && !owner.signal.aborted) socket.end();
    } catch {
      socket.destroy();
    } finally {
      owner.abort();
    }
  }

  private async output(socket: Socket, signal: AbortSignal, bytes: Buffer): Promise<void> {
    if (signal.aborted || socket.destroyed) throw Error("viewer ended");
    if (socket.write(bytes)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off("drain", drained); socket.off("close", closed); signal.removeEventListener("abort", closed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(Error("viewer ended")); };
      const timer = setTimeout(closed, 4000);
      timer.unref();
      socket.once("drain", drained); socket.once("close", closed);
      signal.addEventListener("abort", closed, { once: true });
      if (signal.aborted || socket.destroyed) closed();
    });
    if (signal.aborted || socket.destroyed) throw Error("viewer ended");
  }

  async close(): Promise<void> {
    this.closed = true;
    process.off("exit", this.onExit);
    await this.listening?.catch(() => {});
    for (const [socket, owner] of this.peers) { owner.abort(); socket.destroy(); }
    this.peers.clear();
    await Promise.allSettled([...this.bridges]);
    this.server?.close();
    if (this.path) rmSync(this.path, { force: true });
    for (const name of ["session.sock.path", "session.bridge.pid"])
      rmSync(join(this.localDir, name), { force: true });
  }
}
