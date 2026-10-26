import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { prepareSpawnAuthority } from "../src/plugins/capability-spawn";
import { answerCapability } from "../src/plugins/host";
import { armDuplexInput, consumeDuplexInputReceipt } from "../src/plugins/capability-duplex";
import { fakeCtx, tmpDir } from "./helpers";

test("a stream-owned duplex SSH child uses exact argv and bounded simultaneous bytes", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), pidFile = join(dir, "pid");
  writeFileSync(ssh, "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nexec cat\n", { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", pidFile];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 5000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 20_000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  const call = (method: string, params: unknown) => answerCapability(ctx, plugin, method, params, authority);
  try {
    await expect(call("capability.process.duplex.open", { argv: ["ssh", "other"], timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    const opened = await call("capability.process.duplex.open", { argv, timeoutMs: 5000 }) as { handle: string };
    expect(opened.handle).toMatch(/^[0-9a-f-]{36}$/);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    const read = call("capability.process.duplex.read", { handle: opened.handle, length: 65_536, timeoutMs: 5000 });
    await expect(call("capability.process.duplex.read", { handle: opened.handle, length: 1, timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "conflict" });
    const bytes = Buffer.from("duplex fox 🦊");
    await expect(call("capability.process.duplex.write", { handle: opened.handle,
      base64: bytes.toString("base64"), timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    armDuplexInput(authority, 0, bytes);
    await expect(call("capability.process.duplex.write", { handle: opened.handle,
      base64: Buffer.from("wrong").toString("base64"), timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await expect(call("capability.process.duplex.write", { handle: opened.handle,
      base64: bytes.toString("base64"), timeoutMs: 5000 })).resolves.toEqual({ bytes: bytes.length });
    await expect(call("capability.process.duplex.write", { handle: opened.handle,
      base64: bytes.toString("base64"), timeoutMs: 5000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    consumeDuplexInputReceipt(authority, 0);
    expect(() => consumeDuplexInputReceipt(authority, 0)).toThrow();
    const received = await read as { base64: string; eof: boolean };
    expect(Buffer.from(received.base64, "base64")).toEqual(bytes);
    expect(received.eof).toBe(false);
    await expect(call("capability.process.duplex.write", { handle: opened.handle,
      base64: Buffer.alloc(65_537).toString("base64"), timeoutMs: 5000 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(call("capability.process.duplex.close", { handle: opened.handle })).resolves.toEqual({ ok: true });
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { break; }
      await Bun.sleep(10);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await authority.revoke(); }
});

test("duplex spawn is unavailable without a host-issued command mode", async () => {
  const ctx = fakeCtx();
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  try {
    await expect(answerCapability(ctx, plugin, "capability.process.duplex.open",
      { argv: ["ssh", "anything"], timeoutMs: 1000 }, authority))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
});

test("a failed SSH launch cannot certify cleanup before process close", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh");
  writeFileSync(ssh, "#!/no-such-interpreter\n", { mode: 0o755 });
  const ctx = fakeCtx({ which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", "unused"];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 1000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  try {
    const { handle } = await answerCapability(ctx, plugin, "capability.process.duplex.open",
      { argv, timeoutMs: 1000 }, authority) as { handle: string };
    await expect(answerCapability(ctx, plugin, "capability.process.duplex.close", { handle }, authority))
      .resolves.toEqual({ ok: true });
  } finally { await authority.revoke(); }
});

test("a timed-out duplex read reaps its SSH child and retires the handle", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), pidFile = join(dir, "pid");
  writeFileSync(ssh, "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nexec sleep 30\n", { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", pidFile];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 1000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  const call = (method: string, params: unknown) => answerCapability(ctx, plugin, method, params, authority);
  try {
    const { handle } = await call("capability.process.duplex.open", { argv, timeoutMs: 1000 }) as { handle: string };
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    await expect(call("capability.process.duplex.read", { handle, length: 1, timeoutMs: 30 }))
      .rejects.toMatchObject({ code: "plugin_timeout" });
    await expect(call("capability.process.duplex.write", { handle, base64: "YQ==", timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await authority.revoke(); }
});

test("a failed SSH stdin write retires its handle without a receipt", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), readyFile = join(dir, "ready");
  writeFileSync(ssh, "#!/bin/sh\nexec 0<&-\nprintf ready > \"$1\"\nexec sleep 30\n", { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", readyFile];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 1000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  const call = (method: string, params: unknown) => answerCapability(ctx, plugin, method, params, authority);
  try {
    const { handle } = await call("capability.process.duplex.open", { argv, timeoutMs: 1000 }) as { handle: string };
    for (let i = 0; i < 100 && !existsSync(readyFile); i++) await Bun.sleep(10);
    expect(existsSync(readyFile)).toBe(true);
    const bytes = Buffer.alloc(65_536, 1);
    let failed = false;
    for (let seq = 0; seq < 4; seq++) {
      armDuplexInput(authority, seq, bytes);
      try {
        await call("capability.process.duplex.write", { handle,
          base64: bytes.toString("base64"), timeoutMs: 1000 });
        consumeDuplexInputReceipt(authority, seq);
      } catch (error) {
        expect(error).toMatchObject({ code: "plugin_unavailable" });
        expect(() => consumeDuplexInputReceipt(authority, seq)).toThrow();
        failed = true;
        break;
      }
    }
    expect(failed).toBe(true);
    await expect(call("capability.process.duplex.write", { handle,
      base64: bytes.toString("base64"), timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
});

test("a blocked SSH stdin write times out and has no receipt", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh");
  writeFileSync(ssh, `#!${Bun.which("python3")}\nimport time\ntime.sleep(30)\n`, { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", "unused"];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 1000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  const call = (method: string, params: unknown) => answerCapability(ctx, plugin, method, params, authority);
  let timedOut = false;
  try {
    const { handle } = await call("capability.process.duplex.open", { argv, timeoutMs: 1000 }) as { handle: string };
    const bytes = Buffer.alloc(65_536, 1);
    for (let seq = 0; seq < 32; seq++) {
      armDuplexInput(authority, seq, bytes);
      try {
        await call("capability.process.duplex.write", { handle,
          base64: bytes.toString("base64"), timeoutMs: 100 });
        consumeDuplexInputReceipt(authority, seq);
      } catch (error) {
        expect(error).toMatchObject({ code: "plugin_timeout" });
        expect(() => consumeDuplexInputReceipt(authority, seq)).toThrow();
        timedOut = true;
        break;
      }
    }
    expect(timedOut).toBe(true);
  } finally { await authority.revoke(); }
});

test("service exit terminates the owned duplex SSH process group", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), pidFile = join(dir, "pid"), service = join(dir, "service.ts");
  writeFileSync(ssh, "#!/bin/sh\nprintf '%s' \"$$\" > \"$1\"\nexec sleep 30\n", { mode: 0o755 });
  writeFileSync(service, `
    import {existsSync} from 'node:fs';
    import {createCallAuthority} from ${JSON.stringify(new URL("../src/plugins/authority.ts", import.meta.url).pathname)};
    import {prepareSpawnAuthority} from ${JSON.stringify(new URL("../src/plugins/capability-spawn.ts", import.meta.url).pathname)};
    import {answerDuplex} from ${JSON.stringify(new URL("../src/plugins/capability-duplex.ts", import.meta.url).pathname)};
    const ctx={pacerHome:${JSON.stringify(dir)},env:{...process.env,HOME:${JSON.stringify(dir)}},which:(name:string)=>name==='ssh'?${JSON.stringify(ssh)}:null} as any;
    const argv=['ssh',${JSON.stringify(pidFile)}];
    const authority=createCallAuthority(ctx,{reads:[],commands:[{argv,timeoutMs:1000,mode:'session-duplex'}],stores:[]},
      {deadlineMs:Date.now()+5000,grants:['process.spawn']});
    prepareSpawnAuthority(authority);
    await answerDuplex(authority,['ssh'],'capability.process.duplex.open',{argv,timeoutMs:1000});
    for(let i=0;i<100&&!existsSync(${JSON.stringify(pidFile)});i++) await Bun.sleep(10);
    if(!existsSync(${JSON.stringify(pidFile)})) process.exit(2);
    process.exit(0);
  `);
  const processResult = Bun.spawn([process.execPath, service], { stdout: "ignore", stderr: "pipe" });
  expect(await processResult.exited).toBe(0);
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await Bun.sleep(10);
  }
  expect(() => process.kill(pid, 0)).toThrow();
}, 5000);

test("an exited leader does not strand a pipe-holding process-group descendant", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), childFile = join(dir, "descendant"), terminatedFile = join(dir, "terminated");
  writeFileSync(ssh, `#!${Bun.which("python3")}\nimport os, signal, sys, time\npid = os.fork()\nif pid == 0:\n    def stop(_signum, _frame):\n        open(sys.argv[2], 'w').write('terminated')\n        os._exit(0)\n    signal.signal(signal.SIGTERM, stop)\n    open(sys.argv[1], 'w').write(str(os.getpid()))\n    time.sleep(6)\n    os._exit(0)\nwhile not os.path.exists(sys.argv[1]):\n    time.sleep(0.01)\nos._exit(0)\n`, { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", childFile, terminatedFile];
  const authority = createCallAuthority(ctx,
    { reads: [], commands: [{ argv, timeoutMs: 5000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 10_000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  let descendant = 0;
  try {
    const { handle } = await answerCapability(ctx, plugin, "capability.process.duplex.open",
      { argv, timeoutMs: 5000 }, authority) as { handle: string };
    for (let i = 0; i < 100 && !existsSync(childFile); i++) await Bun.sleep(10);
    expect(existsSync(childFile)).toBe(true);
    descendant = Number(readFileSync(childFile, "utf8"));
    await expect(answerCapability(ctx, plugin, "capability.process.duplex.close", { handle }, authority))
      .resolves.toEqual({ ok: true });
    expect(readFileSync(terminatedFile, "utf8")).toBe("terminated");
  } finally {
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} }
    await authority.revoke().catch(() => {});
  }
}, 5000);
