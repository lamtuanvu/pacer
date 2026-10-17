import {createServer,createConnection,type Server,type Socket} from "node:net";
import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from "node:child_process";
import {Readable} from "node:stream";
import {killTree} from "../exec/process";
import {chmodSync,mkdirSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {Ctx} from "../types";
import type {HostCfg} from "../config/hosts";
import {socketPath} from "../session/host";
import {controlDir,payloadStream,sshArgv,runRemote} from "./ssh";
import {SCRIPTS} from "./scripts";

/** Byte-transparent protocol bridge. The remote host owns viewers and control. */
export class RemoteSession {
  private server?:Server;
  private path?:string;
  private forward?:string;
  private remoteSocket?:string;
  private peers=new Set<Socket>();
  private channels=new Set<ChildProcessWithoutNullStreams>();
  private closed=false;
  private preparing?:Promise<void>;
  private cancelling:Promise<unknown>=Promise.resolve();
  private prepared=false;
  private onExit=()=>{
    for(const channel of this.channels)this.kill(channel);
    if(this.forward){const [command,...args]=this.forwardArgv("cancel",this.forward);spawnSync(command!,args,{env:this.ctx.env,stdio:"ignore",timeout:15000});}
  };
  private kill(channel:ChildProcessWithoutNullStreams){if(channel.pid)killTree(channel.pid,"SIGKILL");}
  constructor(private ctx:Ctx,private host:HostCfg,private remoteDir:string,private localDir:string){}
  private forwardArgv(op:"forward"|"cancel",forward:string) {
    return ["ssh","-o","BatchMode=yes","-o",`ControlPath=${join(controlDir(this.ctx),"cm-%C")}`,"-O",op,"-L",forward,"--",this.host.ssh];
  }
  async prepare() {
    if(this.closed || this.prepared)return;
    if(this.preparing)return this.preparing;
    this.preparing=this.prepareForward().finally(()=>{this.preparing=undefined;});
    return this.preparing;
  }
  private async prepareForward() {
    await this.cancelling;
    if(this.closed)return;
    const result=await runRemote(this.ctx,this.host,SCRIPTS.SESSION_SOCKET,[this.remoteDir]);
    if(result.code || !result.stdout.startsWith("/") || /[\r\n\0:]/.test(result.stdout))throw Error("invalid remote session socket");
    if(this.closed)return;
    this.remoteSocket=result.stdout;
    const dir=join(this.localDir,"forward");
    mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
    const local=socketPath(dir);
    rmSync(local,{force:true});
    const forward=`${local}:${this.remoteSocket}`;
    const forwarded=await this.ctx.run(this.forwardArgv("forward",forward),15000);
    if(forwarded.code===0)this.forward=forward;
    this.prepared=true;
    if(this.closed){await this.cancelForward();return;}
    process.off("exit",this.onExit);process.on("exit",this.onExit);
  }
  private cancelForward() {
    const forward=this.forward;
    this.forward=undefined;this.remoteSocket=undefined;this.prepared=false;
    this.cancelling=this.cancelling.then(()=>forward?this.ctx.run(this.forwardArgv("cancel",forward),15000).catch(()=>{}):undefined);
    return this.cancelling;
  }
  async listen() {
    if(this.server?.listening || this.closed)return;
    await this.prepare();
    const path=socketPath(this.localDir);
    rmSync(path,{force:true});
    const server=createServer(socket=>this.accept(socket));this.server=server;
    server.on("error",()=>{});
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,()=>{server.off("error",reject);resolve();});});
    this.path=path;chmodSync(path,0o600);
    if(path!==join(this.localDir,"session.sock"))writeFileSync(join(this.localDir,"session.sock.path"),path,{mode:0o600});
    writeFileSync(join(this.localDir,"session.bridge.pid"),String(process.pid),{mode:0o600});
    server.unref();
  }
  accept(socket:Socket) {
    if(this.closed){socket.destroy();return;}
    this.peers.add(socket);
    socket.on("error",()=>socket.destroy());
    socket.once("close",()=>{
      this.peers.delete(socket);
      void (async()=>{await this.preparing?.catch(()=>{});if(!this.peers.size)await this.cancelForward();})();
    });
    socket.pause();
    void this.connect(socket);
  }
  private async connect(socket:Socket) {
    try {await this.prepare();} catch { /* exec transport may still be available */ }
    if(socket.destroyed||this.closed)return;
    socket.resume();
    if(!this.forward){this.exec(socket);return;}
    const upstream=createConnection(this.forward.slice(0,this.forward.indexOf(":")));
    let received=false,handedOff=false;
    let pending:Buffer[]=[];let count=0;
    const capture=(bytes:Buffer)=>{if(received)return;count+=bytes.length;if(count>1024*1024){socket.destroy();return;}pending.push(Buffer.from(bytes));};
    socket.on("data",capture);
    const timer=setTimeout(()=>{if(!received)upstream.destroy();},10000);
    const cleanup=()=>{clearTimeout(timer);socket.off("data",capture);};
    upstream.on("data",()=>{received=true;pending=[];cleanup();});
    upstream.on("error",()=>upstream.destroy());
    socket.once("close",()=>{cleanup();upstream.destroy();});
    upstream.once("close",()=>{
      cleanup();socket.unpipe(upstream);upstream.unpipe(socket);
      if(received || socket.destroyed || this.closed){socket.destroy();return;}
      if(!handedOff){handedOff=true;void this.cancelForward();this.exec(socket,Buffer.concat(pending));}
    });
    socket.pipe(upstream);upstream.pipe(socket,{end:false});
  }
  private exec(socket:Socket,pending?:Buffer) {
    if(socket.destroyed||this.closed)return;
    const [command,...args]=sshArgv(this.ctx,this.host,SCRIPTS.SESSION_PIPE,[this.remoteDir]);
    const channel=spawn(command,args,{env:this.ctx.env,detached:true,stdio:["pipe","pipe","pipe"]});
    this.channels.add(channel);
    channel.stderr.resume();channel.stdin.on("error",()=>socket.destroy());
    const stop=()=>{socket.unpipe(channel.stdin);this.kill(channel);};
    socket.once("close",stop);
    channel.on("error",()=>socket.destroy());
    channel.once("close",()=>{this.channels.delete(channel);socket.off("close",stop);socket.destroy();});
    if(pending?.length)channel.stdin.write(pending);
    socket.pipe(channel.stdin);
    void (async()=>{
      try{
        for await(const bytes of payloadStream(Readable.toWeb(channel.stdout) as unknown as ReadableStream<Uint8Array>)) {
          if(socket.destroyed)break;
          if(!socket.write(bytes))await new Promise<void>(resolve=>{
            const done=()=>{socket.off("drain",done);socket.off("close",done);resolve();};
            socket.once("drain",done);socket.once("close",done);
          });
        }
      }catch{socket.destroy();}
      finally{socket.end();}
    })();
  }
  async close() {
    this.closed=true;process.off("exit",this.onExit);
    for(const socket of this.peers)socket.destroy();
    for(const channel of this.channels)this.kill(channel);
    this.channels.clear();this.server?.close();
    await this.preparing?.catch(()=>{});
    await this.cancelForward();
    if(this.path)rmSync(this.path,{force:true});
    for(const name of ["session.sock.path","session.bridge.pid"])rmSync(join(this.localDir,name),{force:true});
  }
}
