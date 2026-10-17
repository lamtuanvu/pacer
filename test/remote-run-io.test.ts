import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteRunIO } from "../src/remote/run-io";
import { Unreachable, type RunIO } from "../src/supervisor/io";
import { readRun, type RunState } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
function setup() {
  const home = tmpDir(), local = tmpDir(), log = join(tmpDir(), "ssh.log");
  writeFileSync(join(home, ".bash_profile"), 'echo hello from profile\nexport PATH="$HOME/bin:$PATH"\n');
  const env = fakeSshEnv(home, log);
  // macOS has no setsid utility; provide the same session semantics on the fake host.
  if (!Bun.which("setsid")) {
    const bin = join(home, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  if (Bun.which("gtail")) {
    const bin=join(home,"bin");mkdirSync(bin,{recursive:true});
    symlinkSync(Bun.which("gtail")!,join(bin,"tail"));
    env.PATH=`${bin}:${env.PATH}`;
  }
  const ctx = fakeCtx({ env: { ...process.env, ...env }, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env, ...o?.env } }) });
  const remote = join(home, ".pacer-remote/runs/t/1");
  return { io: new RemoteRunIO(ctx, host, remote, local), home, remote, local, log, ctx };
}
async function exited(io: RemoteRunIO): Promise<RunState> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const s = await io.read();
    if (s.exit !== null) return s;
    await Bun.sleep(50);
  }
  throw new Error("remote run did not exit");
}

test("a remote run starts detached, mirrors output and records its exit", async () => {
  const { io, home, local } = setup();
  expect(await io.start(["sh", "-c", "echo one; sleep 1; echo two; exit 3"], home, {}, "")).toHaveProperty("pid");
  const s = await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("one\ntwo\n");
  expect(s.exit).toBe(3); expect(s.alive).toBe(false);
  expect(readRun(local).exit).toBe(3);
}, 10000);

test("the prompt reaches the host agent unchanged", async () => {
  const { io, home, local, log } = setup();
  const prompt = `hostile-brief '" $(touch "$HOME/pwned") \`id\`\nline two\n__PACER_STDIN__\nlast line`;
  expect(await io.start(["sh", "-c", "cat"], home, {}, prompt)).toHaveProperty("pid");
  await exited(io);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt);
  expect(readFileSync(log, "utf8")).not.toContain("hostile-brief");
  expect(existsSync(join(home, "pwned"))).toBe(false);
}, 10000);

test.skipIf(!canInspectProcesses())("stop terminates the remote process group", async () => {
  const { io, home, remote } = setup();
  expect(await io.start(["sh", "-c", 'trap "" TERM; echo ready; sleep 30'], home, {}, "")).toHaveProperty("pid");
  while (!(await io.read()).stdoutBytes) await Bun.sleep(50);
  const started = Date.now();
  expect(await io.stop({ graceMs: 1000, sleep: Bun.sleep })).toEqual({ code: 137, killed: true });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(readFileSync(join(remote, "exit"), "utf8").trim()).toBe("137");
}, 10000);

test("unreachable polls keep the run until the grace ends", async () => {
  let calls = 0, now = 0;
  const state: RunState = { pid: 1, startedAt: 1, exit: 3, alive: false, stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  const io: RunIO = { read: async () => { if (++calls <= 3) throw new Unreachable("box"); return state; }, stop: async () => { throw new Error("must not stop unreachable run"); } };
  const options = { io, deadlineMs: 10000, isStopped: () => false, pollMs: 10, now: () => now, sleep: async (ms: number) => { now += ms; }, unreachableGraceMs: 50 };
  expect(await supervise(options)).toEqual({ kind: "exited", code: 3 });
  io.read = async () => { throw new Unreachable("box"); };
  expect(await supervise(options)).toEqual({ kind: "lost", code: 137 });
});

test("mirrors capped byte chunks without losing a split UTF-8 character", async () => {
  const { io, home, remote, local } = setup();
  expect(await io.start(["sh", "-c", "exit 0"], home, {}, "")).toHaveProperty("pid");
  await exited(io);
  const output = "a".repeat(262143) + "🦊" + "z";
  writeFileSync(join(remote, "stdout"), output);
  const first = await io.read();
  expect(readFileSync(join(local, "stdout")).length).toBe(Buffer.byteLength(output));
  expect(first.exit).toBe(0);
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(output);
}, 10000);

test("a failed SSH poll is unreachable and does not erase the local record", async () => {
  const local = tmpDir(); writeFileSync(join(local, "stdout"), "kept\n");
  const env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "box-ssh");
  const ctx = fakeCtx({ run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env, ...o?.env } }) });
  const io = new RemoteRunIO(ctx, host, "~/.pacer-remote/runs/t/1", local);
  await expect(io.read()).rejects.toBeInstanceOf(Unreachable);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe("kept\n");
});

test("read reports remote command failures as unreachable, and stop on an unreachable host ends quietly", async () => {
  const { RemoteRunIO } = await import("../src/remote/run-io");
  const { Unreachable } = await import("../src/supervisor/io");
  const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
  const failing = (code: number) => ({ ...fakeCtx(), run: async () => ({ code, stdout: "", stderr: "boom" }) });
  expect(await new RemoteRunIO(failing(1), host, "~/r", tmpDir()).read().catch((e) => e)).toBeInstanceOf(Unreachable);
  expect(await new RemoteRunIO(failing(255), host, "~/r", tmpDir()).stop({ graceMs: 1000, sleep: async () => {} })).toEqual({ code: 137, killed: false });
});

const utilScript = Bun.spawnSync(["script", "--version"]).stdout.toString().includes("util-linux");
test.skipIf(!utilScript)("PTY remote launch preserves argv/stdin and child exit under util-linux script", async () => {
  const { io, home, remote, local } = setup();
  const prompt = `quoted ' \" $(touch \"$HOME/pwned\")\n🦊`;
  expect(await io.start(["sh", "-c", 'test -t 1 || exit 91; cat; printf "\\033[31mred\\033[0m\\n"; exit 7'], home, {}, prompt, { session: "pty" })).toHaveProperty("pid");
  expect((await exited(io)).exit).toBe(7);
  expect(existsSync(join(remote, "session.raw"))).toBe(true);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(prompt + "red\n");
  expect(existsSync(join(home, "pwned"))).toBe(false);
  expect(existsSync(join(local, "session.ckpt"))).toBe(true);
}, 10000);

test("PTY selection wraps safely with script while pipe mode retains the wrapper", async () => {
  const { io, home, remote } = setup();
  const bin = join(home, "bin"); mkdirSync(bin, {recursive:true});
  writeFileSync(join(bin,"script"), '#!/bin/sh\n[ "$1" = "-qfec" ] || exit 92\nprintf "wrapped\\n" > "$3"\nexec sh -c "$2"\n', {mode:0o755});
  writeFileSync(join(home,".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
  const arg = `a 'quoted' \"value\" $(touch \"$HOME/pwned\")`;
  expect(await io.start(["sh","-c",'printf "%s" "$1" > argument; cat > prompt; exit 7',"agent",arg], home, {}, "input", {session:"pty"})).toHaveProperty("pid");
  // Observe remote exit directly; recording derivation is tested separately.
  for(let n=0; n<100 && !existsSync(join(remote,"exit")); n++) await Bun.sleep(20);
  expect(readFileSync(join(remote,"exit"),"utf8").trim()).toBe("7");
  expect(readFileSync(join(remote,"session.raw"),"utf8")).toBe("wrapped\n");
  expect(readFileSync(join(home,"argument"),"utf8")).toBe(arg);
  expect(readFileSync(join(home,"prompt"),"utf8")).toBe("input");
  expect(existsSync(join(home,"pwned"))).toBe(false);
});

test("raw mirror derives phase-1 files, masks secrets, drains chunks, rotates and resumes", async () => {
  const { io, home, remote, local, ctx } = setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"script");
  writeFileSync(join(remote,"started"),"1");
  writeFileSync(join(local,"session.json"),JSON.stringify({capBytes:1024}));
  ctx.env.PACER_KEY_TEST = "private-secret";
  const text = "x".repeat(262140) + "🦊\u001b[31mred\u001b[0m\r\nprivate-secret\ntail";
  writeFileSync(join(remote,"session.raw"), `Script started on date [COMMAND=\"agent\"]\n${text}\nScript done on date [COMMAND_EXIT_CODE=\"3\"]\n`);
  writeFileSync(join(remote,"exit"),"3");
  expect((await io.read()).exit).toBe(3);
  const expected = "x".repeat(262140)+"🦊red\n****\ntail";
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
  expect(existsSync(join(local,"session.log.1"))).toBe(true);
  expect(existsSync(join(local,"session.raw"))).toBe(false);
  const { replayRecording } = await import("../src/session/recording");
  const screen = await replayRecording(local);
  expect(screen.plain()).toContain("****"); screen.dispose();
  const resumed = new RemoteRunIO(ctx,host,remote,local);
  await exited(resumed);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
  expect((await resumed.read()).exit).toBe(3);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(expected);
},10000);

test.skipIf(!await canListen())("a read-only viewer streams over the ControlMaster and detaching returns to polling", async () => {
  const { io, remote, local, log, ctx } = setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),'Script started on date [COMMAND="agent"]\nfirst\r\n');
  writeFileSync(join(remote,"pid"),String(process.pid));
  await io.read();
  const { createConnection } = await import("node:net");
  const { socketPath } = await import("../src/session/host");
  const { wire, FrameType, WireDecoder } = await import("../src/session/framing");
  const socket = createConnection(socketPath(local));
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const frames: {type:number;data:Buffer}[] = [], decoder = new WireDecoder();
  socket.on("data", bytes=>frames.push(...decoder.push(Buffer.from(bytes))));
  socket.write(wire(FrameType.hello,{v:1,label:"test"}));
  const wait = async (predicate:()=>boolean) => {
    for(let n=0;n<200 && !predicate();n++) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  };
  await wait(()=>readFileSync(log,"utf8").includes('tail -c +'));
  socket.write(wire(FrameType.input,Buffer.from("never remote input")));
  socket.write(wire(FrameType.size,{cols:30,rows:10}));
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(remote,"session.raw"),"second\r\n");
  await wait(()=>frames.some(f=>f.type===FrameType.output && f.data.includes(Buffer.from("second"))));
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\n");
  expect((await import("../src/remote/ssh")).sshArgv(ctx,host,(await import("../src/remote/scripts")).SCRIPTS.FOLLOW,[remote,"0"])).toContain("ControlMaster=auto");
  socket.destroy();
  await Bun.sleep(150);
  appendFileSync(join(remote,"session.raw"),"third\r\n");
  await io.read();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\nthird\n");
  expect(readFileSync(log,"utf8")).not.toContain("never remote input");
  writeFileSync(join(remote,"exit"),"0");
  expect((await io.read()).exit).toBe(0);
},10000);

async function canListen(): Promise<boolean> {
  const {createServer} = await import("node:net");
  const {rmSync} = await import("node:fs");
  const path=join(tmpDir(),"probe.sock"), server=createServer();
  try {
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(path,resolve);});
    return true;
  } catch {return false;}
  finally {server.close();rmSync(path,{force:true});}
}

test("viewer protocol streams raw bytes with fake SSH and kills tail on detach", async()=>{
  const {ctx,remote,local,log}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  const {RemoteViewer}=await import("../src/remote/viewer");
  const {EventEmitter}=await import("node:events");
  const {appendFileSync}=await import("node:fs");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  const {SCRIPTS}=await import("../src/remote/scripts");
  const {runRemote}=await import("../src/remote/ssh");
  mkdirSync(remote,{recursive:true});
  const raw='Script started on date [COMMAND="agent"]\nfirst\r\n';
  writeFileSync(join(remote,"session.raw"),raw);
  writeFileSync(join(remote,"pid"),String(process.pid));
  const recording=new RemoteRecording(ctx,local);
  await recording.output(Buffer.from(raw));
  let queue:Promise<unknown>=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
  const viewer=new RemoteViewer(ctx,host,remote,recording,serial);
  const decoder=new WireDecoder(), frames:{type:number;data:Buffer}[]=[];
  class SocketFixture extends EventEmitter {
    destroyed=false;writableLength=0;
    write(bytes:Buffer) {frames.push(...decoder.push(bytes));return true;}
    end(bytes:Buffer) {this.write(bytes);}
    destroy() {this.destroyed=true;this.emit("close");}
  }
  const socket=new SocketFixture();
  viewer.accept(socket as unknown as import("node:net").Socket);
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await Bun.sleep(20);expect(fn()).toBe(true);};
  try {
    socket.emit("data",wire(FrameType.hello,{v:1,label:"test"}));
    await wait(()=>viewer.active);
    socket.emit("data",wire(FrameType.input,Buffer.from("do not forward")));
    socket.emit("data",wire(FrameType.size,{cols:10,rows:10}));
    appendFileSync(join(remote,"session.raw"),"second\r\n");
    await wait(()=>frames.some(f=>f.type===FrameType.output&&f.data.includes(Buffer.from("second"))));
    expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\n");
    expect(recording.recording.term.cols).toBe(120);
    expect((await import("../src/remote/ssh")).sshArgv(ctx,host,(await import("../src/remote/scripts")).SCRIPTS.FOLLOW,[remote,"0"])).toContain("ControlMaster=auto");
    expect(readFileSync(log,"utf8")).not.toContain("do not forward");
    socket.destroy();
    await wait(()=>!viewer.active);
    appendFileSync(join(remote,"session.raw"),"third\r\n");
    const r=await runRemote(ctx,host,SCRIPTS.READ_FROM,[remote,"session.raw",String(recording.offset),"262144","hex"]);
    await serial(()=>recording.output(Buffer.from(r.stdout,"hex")));
    expect(readFileSync(join(local,"stdout"),"utf8")).toBe("first\nsecond\nthird\n");
  } finally {await viewer.close(0);await recording.close();}
},10000);

test("script framing survives byte splits and preserves ordinary Script done output", async()=>{
  const {ctx,local}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  const recording=new RemoteRecording(ctx,local);
  const body="🦊\r\nScript done on is agent output\r\nlast";
  const raw=Buffer.from(`Script started on date [COMMAND="agent"]\n${body}\nScript done on date [COMMAND_EXIT_CODE="0"]\n`);
  for(const byte of raw) await recording.output(Buffer.from([byte]));
  await recording.close();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("🦊\nScript done on is agent output\nlast");
});

function canInspectProcesses(): boolean {
  try {return Bun.spawnSync(["ps","-p",String(process.pid),"-o","args="]).exitCode === 0;}
  catch {return false;}
}


test("mirror drains up to 4 MiB each poll and resumes the persisted raw cursor", async () => {
  const {io,ctx,remote,local}=setup();
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),'Script started on date [COMMAND="agent"]\n'+"line\n".repeat(900000));
  writeFileSync(join(remote,"exit"),"0");
  expect((await io.read()).exit).toBeNull();
  const first=readFileSync(join(local,"stdout"));
  expect(first.length).toBeGreaterThan(4*1024*1024-100);
  expect(first.length).toBeLessThanOrEqual(4*1024*1024);
  const run=ctx.run; const offsets:number[]=[];
  ctx.run=async(argv,ms,o)=>{if(argv.at(-1)?.includes("# Hex mode")) offsets.push(Number(argv.at(-1)!.match(/session.raw[\' ]+(\d+)/)?.[1]));return run(argv,ms,o);};
  const resumed=new RemoteRunIO(ctx,host,remote,local);
  expect((await resumed.read()).exit).toBe(0);
  expect(offsets[0]).toBeGreaterThan(4*1024*1024-100);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("line\n".repeat(900000));
},20000);

test.skipIf(!await canListen())("viewer removes stale sockets and retries a failed listen next poll", async()=>{
  const {io,remote,local}=setup();
  const {socketPath}=await import("../src/session/host");
  const {rmSync}=await import("node:fs");
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.host"),"pty");
  writeFileSync(join(remote,"session.raw"),"header\nfirst\n");
  const path=socketPath(local);
  mkdirSync(path); // unlink must fail on a directory, without preventing recording.
  await io.read();
  rmSync(path,{recursive:true});
  writeFileSync(path,"stale socket");
  await io.read();
  const {createConnection}=await import("node:net");const socket=createConnection(path);
  try {await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});}
  finally {socket.destroy();writeFileSync(join(remote,"exit"),"0");await io.read();}
});

test("FOLLOW ends when the recorded run pid exits", async()=>{
  const {ctx,remote}=setup();const {SCRIPTS}=await import("../src/remote/scripts");
  const {runRemote}=await import("../src/remote/ssh");
  const tail=Bun.spawnSync([Bun.which("gtail") ?? "tail","--version"]);
  if(!tail.stdout.toString().includes("GNU coreutils")) return;
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.raw"),"first\n");
  const child=Bun.spawn(["sleep","1"],{stdout:"ignore",stderr:"ignore"});
  writeFileSync(join(remote,"pid"),String(child.pid));
  const result=await runRemote(ctx,host,SCRIPTS.FOLLOW,[remote,"0"],{timeoutMs:4000});
  expect([0,143]).toContain(result.code);expect(result.stdout).toBe("first\n");
},6000);

test("restart preserves a partial line and rereads withheld secret bytes",async()=>{
  const {ctx,local}=setup();
  const {RemoteRecording}=await import("../src/remote/recording");
  ctx.env.PACER_KEY_TEST="restart-private-value";
  const raw=Buffer.from('Script started on date [COMMAND="agent"]\nprefix \x1b[31mrestart-private-value\x1b[0m after\r\n\nScript done on date [COMMAND_EXIT_CODE="0"]\n');
  const first=new RemoteRecording(ctx,local);
  await first.output(raw.subarray(0,raw.indexOf(Buffer.from("value"))));
  const state=readFileSync(join(local,"session.remote.json"),"utf8");
  expect(state).not.toContain("restart-private");
  const resumed=new RemoteRecording(ctx,local);await resumed.ready;
  expect(resumed.offset).toBeGreaterThan(0);
  await resumed.output(raw.subarray(resumed.offset));await resumed.close();
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe("prefix **** after\n");
  const {replayRecording}=await import("../src/session/recording");
  const replay=await replayRecording(local);expect(replay.plain()).toContain("prefix **** after");replay.dispose();
  first.recording.dispose();
});

test("PTY wrapper conversion rejects an unrecognized wrapper",async()=>{
  const {ptyWrapper}=await import("../src/remote/run-io");
  expect(()=>ptyWrapper("#!/bin/sh\necho changed\n")).toThrow("replacement failed");
});

test("PTY script uses the bash resolved on the remote PATH",async()=>{
  const {io,home,remote}=setup();const bin=join(home,"bin");mkdirSync(bin,{recursive:true});
  symlinkSync(Bun.which("bash")!,join(bin,"bash"));
  writeFileSync(join(bin,"script"),'#!/bin/sh\nprintf "%s" "$SHELL" > "$HOME/selected-shell"\nexec "$SHELL" -c "$2"\n',{mode:0o755});
  expect(await io.start(["true"],home,{},"",{session:"pty"})).toHaveProperty("pid");
  for(let n=0;n<100&&!existsSync(join(remote,"exit"));n++) await Bun.sleep(20);
  expect(readFileSync(join(home,"selected-shell"),"utf8")).toBe(join(bin,"bash"));
});

test("service exit kills its live stream SSH child",async()=>{
  const {ctx,home,local}=setup();const bin=join(home,"stream-bin");mkdirSync(bin);
  const pidFile=join(home,"stream-pid");
  writeFileSync(join(bin,"ssh"),'#!/bin/sh\necho $$ > "$STREAM_PID"\nprintf "__PACER_BEGIN__\\n"\nexec sleep 30\n',{mode:0o755});
  const file=join(home,"service.ts");
  writeFileSync(file,`
    import {EventEmitter} from "node:events";
    import {existsSync} from "node:fs";
    import {RemoteViewer} from ${JSON.stringify(new URL("../src/remote/viewer.ts",import.meta.url).pathname)};
    import {RemoteRecording} from ${JSON.stringify(new URL("../src/remote/recording.ts",import.meta.url).pathname)};
    import {wire,FrameType} from ${JSON.stringify(new URL("../src/session/framing.ts",import.meta.url).pathname)};
    const ctx={pacerHome:process.env.PACER_HOME,env:process.env} as any;
    const recording=new RemoteRecording(ctx,process.env.LOCAL!);await recording.ready;
    const viewer=new RemoteViewer(ctx,{ssh:"unused"} as any,"unused",recording,fn=>fn());
    class Socket extends EventEmitter {writableLength=0;write(){return true;}destroy(){this.emit("close");}}
    const socket=new Socket();viewer.accept(socket as any);
    socket.emit("data",wire(FrameType.hello,{v:1}));
    for(let n=0;n<100&&!existsSync(process.env.STREAM_PID!);n++)await Bun.sleep(10);
    process.exit(existsSync(process.env.STREAM_PID!)?0:2);
  `);
  const proc=Bun.spawn([process.execPath,file],{env:{...ctx.env,PATH:`${bin}:${ctx.env.PATH}`,STREAM_PID:pidFile,PACER_HOME:ctx.pacerHome,LOCAL:local},stdout:"ignore",stderr:"pipe"});
  expect(await proc.exited).toBe(0);
  const pid=Number(readFileSync(pidFile,"utf8"));
  const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
  try {
    for(let n=0;n<100&&alive();n++)await Bun.sleep(10);
    expect(alive()).toBe(false);
  }finally{try{process.kill(pid,"SIGKILL");}catch{}}
},5000);

test("release upload is content addressed, host verified, reused and repaired",async()=>{
  const {ctx,home}=setup();
  const {ensureRemoteBinary,remotePlatform}=await import("../src/remote/runtime");
  const binary=join(tmpDir(),"pacer");writeFileSync(binary,"release fixture\u0000\u00ff");
  expect(remotePlatform("Linux","aarch64")).toEqual({os:"linux",arch:"arm64"});
  expect(()=>remotePlatform("Linux","mips")).toThrow("unsupported");
  const installed=await ensureRemoteBinary(ctx,host,{binary});
  const bytes=readFileSync(binary);
  const hash=new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(installed).toBe(join(home,".pacer-remote/bin",hash,"pacer"));
  expect(readFileSync(installed)).toEqual(bytes);
  const first=statSync(installed).mtimeMs;
  await ensureRemoteBinary(ctx,host,{binary});
  expect(statSync(installed).mtimeMs).toBe(first);
  const {chmodSync}=await import("node:fs");
  const dirs=[join(home,".pacer-remote"),join(home,".pacer-remote/bin"),join(home,".pacer-remote/bin",hash)];
  for(const dir of dirs)chmodSync(dir,0o755);
  writeFileSync(installed,"corrupt");
  await ensureRemoteBinary(ctx,host,{binary});
  expect(readFileSync(installed)).toEqual(bytes);
  for(const dir of dirs)expect(statSync(dir).mode&0o777).toBe(0o700);
  const run=ctx.run;
  ctx.run=(argv,ms,o)=>run(argv,ms,o?.stdin?{...o,stdin:Buffer.from("bad upload").toString("base64")}:o);
  writeFileSync(installed,"corrupt again");
  await expect(ensureRemoteBinary(ctx,host,{binary})).rejects.toThrow("hash");
});

test("opted-in hosts launch _session and mirror native recordings without script",async()=>{
  const {ctx,home,remote,local}=setup();
  const binary=join(tmpDir(),"pacer");
  // A local executable stands in for the release and enters the real session host.
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${new URL("../src/cli.ts",import.meta.url).pathname}' "$@"\n`,{mode:0o755});
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local,{binary});
  const prompt="quoted ' 🦊\n";
  expect(await io.start(["sh","-c",'cat; printf "\\033[31mred\\033[0m\\n"; exit 7'],home,{},prompt)).toHaveProperty("pid");
  expect((await exited(io)).exit).toBe(7);
  expect(readFileSync(join(local,"stdout"),"utf8")).toBe(prompt+"red\n");
  expect(readFileSync(join(remote,"session.host"),"utf8")).toBe("builtin");
  expect(existsSync(join(remote,"session.raw"))).toBe(false);
  expect(readFileSync(join(local,"session.log"))).toEqual(readFileSync(join(remote,"session.log")));
  const {replayRecording}=await import("../src/session/recording");
  const a=await replayRecording(local),b=await replayRecording(remote);
  expect(a.snapshot()).toEqual(b.snapshot());a.dispose();b.dispose();
},15000);

for(const refused of [false,true]) test.skipIf(!await canListen())(`full remote protocol supports exact snapshots and control (forward refused=${refused})`,async()=>{
  const {ctx,home,local,remote,log}=setup();
  if(refused) ctx.env.PACER_FAKE_FORWARD_REFUSED="1";
  const run=ctx.run;
  // The fixture runner must also receive transport environment overrides.
  ctx.run=(argv,ms,o)=>run(argv,ms,{...o,env:{...ctx.env,...o?.env}});
  const {Recording}=await import("../src/session/recording");
  const {ViewerHub}=await import("../src/session/viewers");
  const {createServer,createConnection}=await import("node:net");
  const {socketPath}=await import("../src/session/host");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  mkdirSync(remote,{recursive:true});
  const binary=join(home,"fixture-pacer");
  writeFileSync(binary,`#!/bin/sh\nexec '${process.execPath}' '${new URL("../src/cli.ts",import.meta.url).pathname}' "$@"\n`,{mode:0o755});
  writeFileSync(join(remote,"session.binary"),binary);
  const record=new Recording(remote);await record.output(Buffer.from("\x1b[31mexact\x1b[0m\r\n"));
  let typed="",cols=120;
  const hub=new ViewerHub(()=>wire(FrameType.snapshot,{...record.snapshot(),controller:hub.controller,viewers:hub.size}),()=>null,fn=>{void fn();},()=>{},()=>{},
    {input:bytes=>{typed+=bytes.toString();},resize:(c)=>{cols=c;}});
  const path=socketPath(remote),server=createServer(socket=>hub.add(socket));
  await new Promise<void>(resolve=>server.listen(path,resolve));
  writeFileSync(join(remote,"session.sock.path"),path);
  writeFileSync(join(remote,"session.host"),"builtin");writeFileSync(join(remote,"pid"),String(process.pid));
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local);
  const frames:{type:number;data:Buffer}[]=[];
  let socket:ReturnType<typeof createConnection>|undefined;
  const wait=async(fn:()=>boolean)=>{for(let i=0;i<200&&!fn();i++)await Bun.sleep(20);expect(fn()).toBe(true);};
  try{
    await io.read();
    socket=createConnection(socketPath(local));const decoder=new WireDecoder();
    await new Promise<void>((resolve,reject)=>{socket!.once("connect",resolve);socket!.once("error",reject);});
    socket.on("data",bytes=>frames.push(...decoder.push(Buffer.from(bytes))));
    socket.write(wire(FrameType.hello,{v:1,client:"cli",label:"remote viewer"}));
    await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
    expect(JSON.parse(frames.find(f=>f.type===FrameType.snapshot)!.data.toString()).screenAnsi).toBe(record.snapshot().screenAnsi);
    socket.write(wire(FrameType.take,{}));
    await wait(()=>frames.some(f=>f.type===FrameType.control&&JSON.parse(f.data.toString()).you===true));
    socket.write(wire(FrameType.input,Buffer.from("input 🦊")));socket.write(wire(FrameType.size,{cols:80,rows:24}));
    await wait(()=>typed==="input 🦊"&&cols===80);
    socket.write(wire(FrameType.release,{}));await wait(()=>hub.controller===null);
    expect(readFileSync(log,"utf8")).toContain("-O forward");
    if(refused)expect(readFileSync(log,"utf8")).toContain("socket exec pipe");
    if(!refused){
      socket.destroy();await wait(()=>readFileSync(log,"utf8").includes("-O cancel"));
      const count=readFileSync(log,"utf8").split("-O forward").length;
      await io.read();expect(readFileSync(log,"utf8").split("-O forward").length).toBe(count);
      frames.length=0;
      socket=createConnection(socketPath(local));const nextDecoder=new WireDecoder();
      socket.on("data",bytes=>frames.push(...nextDecoder.push(Buffer.from(bytes))));
      await new Promise<void>((resolve,reject)=>{socket!.once("connect",resolve);socket!.once("error",reject);});
      socket.write(wire(FrameType.hello,{v:1}));await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
      expect(readFileSync(log,"utf8").split("-O forward").length).toBe(count+1);
    }
  }finally{
    socket?.destroy();writeFileSync(join(remote,"exit"),"0");await io.read();
    hub.destroy();server.close();await record.close();
  }
},15000);

for(const lateRefusal of [false,true]) test(`exec fallback relays session frames over fake SSH (late refusal=${lateRefusal})`,async()=>{
  const {ctx,home,local,remote,log}=setup();
  const {RemoteSession}=await import("../src/remote/session");
  const {Duplex}=await import("node:stream");
  const {wire,FrameType,WireDecoder}=await import("../src/session/framing");
  mkdirSync(remote,{recursive:true});
  writeFileSync(join(remote,"session.sock.path"),"/tmp/fixture.sock");
  // This executable stands in for a session socket endpoint in socket-restricted sandboxes.
  const pipe=join(home,"protocol.ts"),pidFile=join(home,"pipe.pid");
  writeFileSync(pipe,`
    import {writeFileSync} from "node:fs";
    writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    setInterval(()=>{},1000);
    import {wire,FrameType,WireDecoder} from ${JSON.stringify(new URL("../src/session/framing.ts",import.meta.url).pathname)};
    const decoder=new WireDecoder();
    process.stdin.on("data",bytes=>{for(const frame of decoder.push(bytes)) {
      if(frame.type===FrameType.hello)process.stdout.write(wire(FrameType.snapshot,{screenAnsi:"exact",cols:120,rows:40}));
      if(frame.type===FrameType.take)process.stdout.write(wire(FrameType.control,{you:true}));
      if(frame.type===FrameType.input)process.stdout.write(wire(FrameType.output,frame.data));
    }});
  `);
  writeFileSync(join(remote,"session.binary"),join(home,"fixture-pacer"));
  writeFileSync(join(home,"fixture-pacer"),`#!/bin/sh\nexec '${process.execPath}' '${pipe}'\n`,{mode:0o755});
  ctx.env.PACER_FAKE_FORWARD_REFUSED="1";
  const original=ctx.run;
  const commands:string[][]=[];
  ctx.run=(argv,ms,o)=>{
    commands.push(argv);
    if(argv.at(-1)?.includes('[ -S "$path" ]'))return Promise.resolve({code:0,stdout:"__PACER_BEGIN__\n/tmp/fixture.sock",stderr:""});
    if(lateRefusal && argv.includes("-O") && argv.includes("forward"))return Promise.resolve({code:0,stdout:"",stderr:""});
    return original(argv,ms,{...o,env:{...ctx.env,...o?.env}});
  };
  const bridge=new RemoteSession(ctx,host,remote,local);
  const frames:{type:number;data:Buffer}[]=[],decoder=new WireDecoder();
  const socket=new Duplex({read(){},write(data,_encoding,done){frames.push(...decoder.push(Buffer.from(data)));done();}});
  const wait=async(fn:()=>boolean)=>{for(let n=0;n<200&&!fn();n++)await Bun.sleep(10);expect(fn()).toBe(true);};
  try{
    await bridge.prepare();bridge.accept(socket as unknown as import("node:net").Socket);
    socket.push(wire(FrameType.hello,{v:1}));
    await wait(()=>frames.some(f=>f.type===FrameType.snapshot));
    socket.push(wire(FrameType.take,{}));
    await wait(()=>frames.some(f=>f.type===FrameType.control));
    socket.push(wire(FrameType.input,Buffer.from("control 🦊")));
    await wait(()=>frames.some(f=>f.type===FrameType.output&&f.data.toString()==="control 🦊"));
    expect(readFileSync(log,"utf8")).toContain("socket exec pipe");
    if(lateRefusal){
      await bridge.prepare();
      expect(commands.filter(a=>a.at(-1)?.includes('[ -S "$path" ]')).length).toBe(2);
      expect(commands.filter(a=>a.includes("forward")).length).toBe(2);
    }
    expect(commands.find(a=>a.includes("-O")&&a.includes("forward"))).toEqual(expect.arrayContaining(["-L",expect.stringContaining("ControlPath=")]));
  }finally{
    socket.destroy();await bridge.close();
    const pid=Number(readFileSync(pidFile,"utf8"));
    const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
    try{await wait(()=>!alive());}finally{if(alive())process.kill(pid,"SIGKILL");}
  }
  if(lateRefusal)expect(commands.some(a=>a.includes("cancel"))).toBe(true);
});

test("native recording observation failures are retried as unreachable",async()=>{
  const ctx=fakeCtx({run:async argv=>argv.at(-1)?.includes("for stream in stdout stderr session.raw")
    ? {code:0,stdout:"__PACER_BEGIN__\nsession=builtin\npid=1\nalive=1\n",stderr:""}
    : {code:1,stdout:"",stderr:"rotation changed"}});
  await expect(new RemoteRunIO(ctx,host,"~/run",tmpDir()).read()).rejects.toBeInstanceOf(Unreachable);
});

test("forward preparation creates a private directory and removes stale socket paths",async()=>{
  const {RemoteSession}=await import("../src/remote/session");
  const {socketPath}=await import("../src/session/host");
  const local=join(tmpDir(),"missing");
  let forwards=0;
  const ctx=fakeCtx({run:async argv=>{
    if(argv.includes("forward")){
      expect(statSync(join(local,"forward")).mode&0o777).toBe(0o700);
      expect(existsSync(socketPath(join(local,"forward")))).toBe(false);
      forwards++;
      return {code:0,stdout:"",stderr:""};
    }
    return {code:0,stdout:"__PACER_BEGIN__\n/tmp/remote.sock",stderr:""};
  }});
  const first=new RemoteSession(ctx,host,"~/run",local);
  try{await first.prepare();}finally{await first.close();}
  expect(forwards).toBe(1);
  const {chmodSync}=await import("node:fs");
  chmodSync(join(local,"forward"),0o755);
  writeFileSync(socketPath(join(local,"forward")),"stale");
  const second=new RemoteSession(ctx,host,"~/run",local);
  try{await second.prepare();}finally{await second.close();}
  expect(forwards).toBe(2);
});

test("socket discovery waits for an actual remote socket",async()=>{
  const {ctx,remote}=setup();const {runRemote}=await import("../src/remote/ssh");
  const {SCRIPTS}=await import("../src/remote/scripts");
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.sock.path"),join(remote,"missing.sock"));
  expect((await runRemote(ctx,host,SCRIPTS.SESSION_SOCKET,[remote])).code).not.toBe(0);
});

test("native mirrors transfer only appended log bytes and changed retained files",async()=>{
  const {ctx,remote,local}=setup();const {rmSync,appendFileSync,renameSync}=await import("node:fs");
  mkdirSync(remote,{recursive:true});writeFileSync(join(remote,"session.host"),"builtin");writeFileSync(join(remote,"exit"),"0");
  for(const name of ["session.log","session.log.1","session.ckpt","session.state"])writeFileSync(join(remote,name),name==="session.state"?"state":"first");
  const run=ctx.run;const payloads:string[]=[];
  ctx.run=async(argv,ms,o)=>{const result=await run(argv,ms,o);if(argv.at(-1)?.includes("for attempt in 1 2 3"))payloads.push(result.stdout);return result;};
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local);
  await io.read();const retained=statSync(join(local,"session.ckpt")).mtimeMs;
  await io.read();
  expect(payloads[1]).not.toContain(Buffer.from("first").toString("hex"));
  expect(statSync(join(local,"session.ckpt")).mtimeMs).toBe(retained);
  appendFileSync(join(remote,"session.log"),"second");await io.read();
  expect(payloads[2]).toContain(Buffer.from("second").toString("hex"));
  expect(payloads[2]).not.toContain(Buffer.from("first").toString("hex"));
  expect(readFileSync(join(local,"session.log"),"utf8")).toBe("firstsecond");
  renameSync(join(remote,"session.log"),join(remote,"session.log.1"));writeFileSync(join(remote,"session.log"),"new");
  writeFileSync(join(remote,"session.ckpt"),"next");await io.read();
  expect(readFileSync(join(local,"session.log"),"utf8")).toBe("new");
  expect(readFileSync(join(local,"session.log.1"),"utf8")).toBe("firstsecond");
  expect(readFileSync(join(local,"session.ckpt"),"utf8")).toBe("next");
  rmSync(join(remote,"session.log.1"));await io.read();expect(existsSync(join(local,"session.log.1"))).toBe(false);
});

test("START rejects a binary tampered with after upload",async()=>{
  const {ctx,home,remote,local}=setup();
  const binary=join(tmpDir(),"pacer"),marker=join(home,"tampered-executed");
  writeFileSync(binary,"#!/bin/sh\nexit 0\n",{mode:0o755});
  const run=ctx.run;
  ctx.run=async(argv,ms,o)=>{
    if(argv.at(-1)?.includes('mode="$3"; shift 3')){
      const hash=new Bun.CryptoHasher("sha256").update(readFileSync(binary)).digest("hex");
      writeFileSync(join(home,".pacer-remote/bin",hash,"pacer"),`#!/bin/sh\ntouch '${marker}'\n`);
    }
    return run(argv,ms,o);
  };
  const io=new RemoteRunIO(ctx,{...host,session:"full"},remote,local,{binary});
  const began=Date.now(),result=await io.start(["true"],home,{},"");
  expect(result).toEqual({error:"remote start refused: runtime binary failed its hash check"});
  // The refusal is reported at once, not after START's 5 s wait for a pid.
  expect(Date.now()-began).toBeLessThan(4000);
  expect(existsSync(marker)).toBe(false);
},10000);

test("service exit cancels its full-session SSH forward",async()=>{
  const {ctx,home,local,log}=setup();const file=join(home,"exit-forward.ts");
  writeFileSync(file,`
    import {RemoteSession} from ${JSON.stringify(new URL("../src/remote/session.ts",import.meta.url).pathname)};
    const ctx={env:process.env,pacerHome:process.env.PACER_HOME,run:async argv=>({code:0,stdout:argv.includes("forward")?"":"__PACER_BEGIN__\\n/tmp/fixture.sock",stderr:""})} as any;
    const bridge=new RemoteSession(ctx,{ssh:"box"} as any,"~/run",process.env.LOCAL!);
    await bridge.prepare();process.exit(0);
  `);
  const proc=Bun.spawn([process.execPath,file],{env:{...ctx.env,PACER_HOME:ctx.pacerHome,LOCAL:local},stdout:"ignore",stderr:"pipe"});
  expect(await proc.exited).toBe(0);
  expect(readFileSync(log,"utf8")).toContain("-O cancel");
});
