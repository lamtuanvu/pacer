import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../config/hosts";
import type { Ctx } from "../types";
import { socketPath } from "../session/host";
import { FrameType, WireDecoder, wire } from "../session/framing";
import { pluginRegistry } from "../plugins";
import { issueConfiguredHostReadFrom } from "../plugins/host-read-from-issuer";
import type { RemoteRecording } from "./recording";

/** Local protocol endpoint for a remote mirror; accepts hello only, never input/control. */
export class RemoteViewer {
  private server?: Server;
  private viewer?: Socket;
  private path?: string;
  private controller?: AbortController;
  private streaming?: Promise<void>;
  private joined = false;
  private resync = false;
  private closed = false;
  private onExit = () => { this.controller?.abort(); };
  constructor(private ctx: Ctx, private host: HostCfg, private remoteDir: string,
    private mirror: RemoteRecording, private serial: <T>(fn:()=>Promise<T>)=>Promise<T>) {}

  get active() { return !!this.controller; }
  async listen() {
    if (this.server?.listening) return;
    const path = socketPath(this.mirror.dir);
    rmSync(path, {force:true});
    const server = createServer(socket=>this.accept(socket));
    this.server=server;
    // Socket failure affects viewing only; SSH supervision and recording continue.
    server.on("error",()=>{});
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,()=>{server.off("error",reject);resolve();});});
    this.path=path;
    chmodSync(path,0o600);
    if(path!==join(this.mirror.dir,"session.sock")) writeFileSync(join(this.mirror.dir,"session.sock.path"),path,{mode:0o600});
    server.unref();
  }
  /** Protocol adapter also used by non-CLI viewers. */
  accept(socket: Socket) {
    if (this.viewer || this.closed) { socket.destroy(); return; }
    this.viewer = socket;
    const decoder = new WireDecoder();
    socket.on("error",()=>socket.destroy());
    socket.on("data",bytes=>{
      try {
        for (const frame of decoder.push(Buffer.from(bytes))) {
          if (frame.type !== FrameType.hello || this.joined) continue;
          const hello = JSON.parse(frame.data.toString());
          if (hello.v !== 1) {socket.destroy();return;}
          this.joined = true;
          void this.serial(async()=>{
            if (this.viewer !== socket || socket.destroyed) return;
            const missing = hello.from === undefined ? null : this.mirror.recording.since(hello.from);
            if (missing === null) socket.write(this.snapshot());
            else for (const bytes of missing) this.send(bytes);
            this.start();
          }).catch(()=>socket.destroy());
        }
      } catch { socket.destroy(); }
    });
    socket.on("drain",()=>{
      if (this.resync && this.viewer===socket) {
        this.resync=false;
        void this.serial(async()=>{if(this.viewer===socket) {socket.write(wire(FrameType.resync,{}));socket.write(this.snapshot());}}).catch(()=>socket.destroy());
      }
    });
    socket.on("close",()=>{
      if (this.viewer === socket) {
        this.viewer=undefined;this.joined=false;this.resync=false;
        void this.stopStream().then(()=>this.serial(async()=>{
            // A new viewer may arrive while the previous bounded read retires.
            if (this.viewer && this.joined) this.start();
          })).catch(()=>{});
      }
    });
  }
  private snapshot() {return wire(FrameType.snapshot,{...this.mirror.recording.snapshot(),controller:null,viewers:1});}
  send(bytes: Buffer) {
    if (!bytes.length || !this.viewer || !this.joined || this.resync) return;
    if(this.viewer.writableLength+bytes.length>1024*1024) {this.resync=true;return;}
    this.viewer.write(wire(FrameType.output,bytes));
  }
  resume() { this.start(); }
  private start() {
    if(this.controller || this.closed || !this.viewer) return;
    const controller = new AbortController();
    this.controller = controller;
    process.once("exit",this.onExit);
    this.streaming=(async()=>{
      try {
        while (!controller.signal.aborted) {
          const offset = await this.serial(async()=>this.mirror.offset);
          if (controller.signal.aborted) break;
          const grant = issueConfiguredHostReadFrom(this.ctx, this.host.alias, this.remoteDir,
            this.mirror.dir, "session.raw", offset, 262_144);
          const result = await pluginRegistry(this.ctx).readFromConfiguredHost(this.ctx, grant, controller.signal);
          if (controller.signal.aborted) break;
          if (result.timedOut || result.code !== 0) throw new Error(result.stderr || `remote read exited ${result.code}`);
          const bytes = Buffer.from(result.stdout, "hex");
          if (!bytes.length) {
            await new Promise<void>(resolve=>{
              const timer = setTimeout(()=>{controller.signal.removeEventListener("abort", cancel);resolve();}, 200);
              const cancel = () => {clearTimeout(timer);resolve();};
              controller.signal.addEventListener("abort", cancel, {once:true});
              if (controller.signal.aborted) cancel();
            });
            continue;
          }
          await this.serial(async()=>{
            if (controller.signal.aborted || this.mirror.offset !== offset) return;
            this.send(await this.mirror.output(bytes));
          });
        }
      } catch { /* polling resumes at the last successfully consumed byte */ }
      finally {
        process.off("exit",this.onExit);
        if(this.controller===controller) this.controller=undefined;
      }
    })();
  }
  async stopStream() {
    this.controller?.abort();
    await this.streaming;
  }
  async close(code: number) {
    this.closed=true;
    await this.stopStream();
    this.viewer?.end(wire(FrameType.exit,{code}));
    this.viewer?.destroy();
    this.server?.close();
    if(this.path) rmSync(this.path,{force:true});
    rmSync(join(this.mirror.dir,"session.sock.path"),{force:true});
  }
}
