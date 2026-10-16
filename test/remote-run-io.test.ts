import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RemoteRunIO } from "../src/remote/run-io";
import { Unreachable, type RunIO } from "../src/supervisor/io";
import { readRun, type RunState } from "../src/supervisor/run";
import { supervise } from "../src/supervisor/supervise";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };
function setup() {
  const home = tmpDir(), local = tmpDir(), log = join(tmpDir(), "ssh.log");
  writeFileSync(join(home, ".bash_profile"), "echo hello from profile\n");
  const env = fakeSshEnv(home, log);
  // macOS has no setsid utility; provide the same session semantics on the fake host.
  if (!Bun.which("setsid")) {
    const bin = join(home, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
  }
  const ctx = fakeCtx({ env: { ...process.env, ...env }, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env } }) });
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
  expect(readFileSync(join(local, "stdout")).length).toBe(262144);
  expect(first.exit).toBeNull();
  expect((await io.read()).exit).toBe(0);
  expect(readFileSync(join(local, "stdout"), "utf8")).toBe(output);
}, 10000);

test("a failed SSH poll is unreachable and does not erase the local record", async () => {
  const local = tmpDir(); writeFileSync(join(local, "stdout"), "kept\n");
  const env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "box-ssh");
  const ctx = fakeCtx({ run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...env } }) });
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
  expect((await io.read()).exit).toBeNull();
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
