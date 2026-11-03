import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";
import { answerSpawn, prepareSpawnAuthority, readSpawnOutput } from "../src/plugins/capability-spawn";

const argv = ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"];
function fixture(source = 'process.stdout.write("fixture-ok");') {
  const ctx = fakeCtx(), executable = join(ctx.home, "fixture-provider");
  writeFileSync(executable, `#!${process.execPath}\n${source}\n`); chmodSync(executable, 0o700);
  ctx.which = bin => bin === "opencode" ? executable : null;
  const authority = createCallAuthority(ctx, { reads: [], commands: [{ argv, timeoutMs: 5000 }], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  return { ctx, executable, authority };
}
test("exact pinned synthetic provider command returns captured output", async () => {
  const f = fixture();
  try {
    const result = await answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 1000 });
    expect(result).toMatchObject({ code: 0, stdout: "fixture-ok", stderr: "" });
  } finally { await f.authority.revoke(); }
});

test("host-issued Codex live mode sends only the fixed read-only app-server exchange", async () => {
  const ctx = fakeCtx(), executable = join(ctx.home, "codex-fixture"), home = join(ctx.home, "work-codex");
  writeFileSync(executable, `#!${process.execPath}\nlet text = "";\nprocess.stdin.on("data", part => { text += part; if (text.includes("account/rateLimits/read")) process.stdout.write(JSON.stringify({id:2,result:{home:process.env.CODEX_HOME,methods:text.split("\\n").filter(Boolean).map(line=>JSON.parse(line).method)}})+"\\n"); });\nprocess.stdin.on("end", () => process.exit(0));\n`);
  chmodSync(executable, 0o700);
  ctx.which = name => name === "codex" ? executable : null;
  const liveArgv = ["codex", "-s", "read-only", "-a", "never", "app-server"];
  const authority = createCallAuthority(ctx, { reads: [], stores: [], commands: [{ argv: liveArgv,
    timeoutMs: 5000, mode: "codex-live", env: { PATH: process.env.PATH ?? "", CODEX_HOME: home } }] } as never,
    { deadlineMs: Date.now() + 8000, grants: ["process.spawn"], accountHome: home });
  prepareSpawnAuthority(authority);
  try {
    await expect(answerSpawn(authority, ["codex"], { argv: ["codex", "login"], timeoutMs: 3000 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(answerSpawn(authority, ["codex"], { argv: liveArgv, timeoutMs: 3000, env: { CODEX_HOME: "/tmp/other" } })).rejects.toMatchObject({ code: "capability_denied" });
    const result = await answerSpawn(authority, ["codex"], { argv: liveArgv, timeoutMs: 3000 }) as { code: number; stdout: string };
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim()).result).toMatchObject({ home,
      methods: ["initialize", "initialized", "account/rateLimits/read"] });
    await expect(answerSpawn(authority, ["codex"], { argv: liveArgv, timeoutMs: 3000 })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
  const foreign = createCallAuthority(ctx, { reads: [], stores: [], commands: [{ argv: liveArgv,
    timeoutMs: 5000, mode: "codex-live", env: { CODEX_HOME: join(ctx.home, "other") } }] } as never,
    { deadlineMs: Date.now() + 8000, grants: ["process.spawn"], accountHome: home });
  try { expect(() => prepareSpawnAuthority(foreign)).toThrow(); }
  finally { await foreign.revoke(); }
});

test("command, scope, grant, overrides and issuance identity are independent gates", async () => {
  const f = fixture();
  try {
    for (const params of [{ argv: ["opencode", "auth", "login"], timeoutMs: 1000 }, { argv, timeoutMs: 5001 },
      { argv, timeoutMs: 1000, env: {} }, { argv, timeoutMs: 1000, cwd: f.ctx.home }, { argv, timeoutMs: 1000, stdin: "x" }]) {
      await expect(answerSpawn(f.authority, ["opencode"], params)).rejects.toBeInstanceOf(Error);
    }
    await expect(answerSpawn(f.authority, ["*"], { argv, timeoutMs: 1000 })).rejects.toMatchObject({ code: "capability_denied" });
    const unprepared = createCallAuthority(f.ctx, f.authority.resources as never, { deadlineMs: Date.now() + 10000, grants: ["process.spawn"] });
    const ungranted = createCallAuthority(f.ctx, f.authority.resources as never, { deadlineMs: Date.now() + 10000 });
    try {
      await expect(answerSpawn(unprepared, ["opencode"], { argv, timeoutMs: 1000 })).rejects.toMatchObject({ code: "capability_denied" });
      prepareSpawnAuthority(ungranted);
      await expect(answerSpawn(ungranted, ["opencode"], { argv, timeoutMs: 1000 })).rejects.toMatchObject({ code: "capability_denied" });
    } finally { await unprepared.revoke(); await ungranted.revoke(); }
    renameSync(f.executable, f.executable + ".old");
    writeFileSync(f.executable, `#!${process.execPath}\nprocess.stdout.write("replacement");`); chmodSync(f.executable, 0o700);
    prepareSpawnAuthority(f.authority); // must not repin an existing authority
    await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 1000 })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.authority.revoke(); }
});

test("missing executable is snapshotted as readable 127, never late-discovered", async () => {
  const f = fixture(); f.ctx.which = () => null;
  const authority = createCallAuthority(f.ctx, f.authority.resources as never, { deadlineMs: Date.now() + 10000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority); f.ctx.which = () => f.executable;
  try { expect(await answerSpawn(authority, ["opencode"], { argv, timeoutMs: 1000 })).toMatchObject({ code: 127 }); }
  finally { await authority.revoke(); await f.authority.revoke(); }
});

test("large encoded output uses bounded call-owned chunks with no cross-call or expired access", async () => {
  const f = fixture('process.stdout.write("x".repeat(800000));'), other = fixture();
  try {
    const result = await answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 2000 }) as { output: { stdout: string } };
    expect(result.output.stdout).toBeString();
    const chunk = await readSpawnOutput(f.authority, { handle: result.output.stdout, offset: 0, length: 262144 });
    expect(Buffer.from(chunk.base64, "base64")).toHaveLength(262144);
    await expect(readSpawnOutput(other.authority, { handle: result.output.stdout, offset: 0, length: 1 })).rejects.toMatchObject({ code: "capability_denied" });
    await expect(readSpawnOutput(f.authority, { handle: result.output.stdout, offset: 0, length: 262145 })).rejects.toMatchObject({ code: "invalid_input" });
    await f.authority.revoke();
    await expect(readSpawnOutput(f.authority, { handle: result.output.stdout, offset: 0, length: 1 })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.authority.revoke(); await other.authority.revoke(); }
});

test("stdout and stderr enforce separate incremental 1MiB limits", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const f = fixture(`process.${stream}.write("x".repeat(1048577));`);
    try { await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 2000 })).rejects.toMatchObject({ code: "too_large" }); }
    finally { await f.authority.revoke(); }
  }
});

test("timeout reaps a TERM-ignoring child and concurrent calls cannot start another", async () => {
  const f = fixture(`
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => {});
    process.stdout.write(String(process.pid));
    writeFileSync(process.argv[1] + ".ready", String(process.pid));
    setInterval(() => {}, 10);
  `);
  const originalSpawn = childProcess.spawn;
  let child: childProcess.ChildProcess | undefined;
  const spawning = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof originalSpawn>) => {
    child = originalSpawn(...args);
    return child;
  }) as typeof originalSpawn);
  // Drive only the command deadline after readiness, not Bun/OS startup latency.
  // The real TERM/KILL escalation, streams and child settlement remain untouched.
  const originalTimer = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    if (delay === 700) {
      expire = callback;
      return originalTimer(() => {}, 10000);
    }
    return originalTimer(callback, delay);
  }) as typeof setTimeout);
  try {
    const running = answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 700 });
    const observed = running.then(value => ({ value, error: null }), error => ({ value: null, error }));
    spawning.mockRestore();
    clock.mockRestore(); // No global mock remains installed across an await.
    await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 700 })).rejects.toMatchObject({ code: "capability_denied" });
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(f.executable + ".ready") && Date.now() < readyDeadline) await Bun.sleep(10);
    expect(existsSync(f.executable + ".ready")).toBe(true);
    const pid = Number(readFileSync(f.executable + ".ready", "utf8"));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(expire).toBeDefined();
    expire!();
    // Admission stays closed during escalation, not just while the child runs.
    await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 700 })).rejects.toMatchObject({ code: "capability_denied" });
    const settled = await observed;
    expect(settled.error).toBeNull();
    const result = settled.value as { timedOut: boolean; stdout: string };
    expect(result.timedOut).toBe(true);
    expect(Number(result.stdout)).toBe(pid);
    expect(child?.signalCode).toBe("SIGKILL");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { spawning.mockRestore(); clock.mockRestore(); await f.authority.revoke(); }
});

test("startup timeout reaps a child even before it emits readiness output", async () => {
  const f = fixture('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); process.stdout.write("unreachable");');
  // Observe the OS-owned PID without depending on application startup or stdout.
  const originalSpawn = childProcess.spawn;
  let pid: number | undefined;
  const spawning = spyOn(childProcess, "spawn").mockImplementation(((...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args);
    pid = child.pid;
    return child;
  }) as typeof originalSpawn);
  try {
    const running = answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 700 });
    spawning.mockRestore();
    await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 700 })).rejects.toMatchObject({ code: "capability_denied" });
    const result = await running as { timedOut: boolean; stdout: string };
    expect(result).toMatchObject({ timedOut: true, stdout: "" });
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally { spawning.mockRestore(); await f.authority.revoke(); }
});

test("revocation waits child settlement and never returns cancelled output", async () => {
  const f = fixture('process.on("SIGTERM",()=>{}); setInterval(()=>{},10);');
  const running = answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 5000 });
  const observed = running.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await f.authority.revoke();
  expect((await observed).error).toMatchObject({ code: "capability_denied" });
  await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 1000 })).rejects.toMatchObject({ code: "capability_denied" });
});

test("a descendant holding inherited pipes cannot be certified as cleaned up", async () => {
  const source = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setTimeout(()=>{},700)"],{stdio:["ignore",1,2]}); process.exit(0);';
  const f = fixture(source);
  await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 2000 })).rejects.toMatchObject({ code: "plugin_unavailable" });
  await expect(answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 2000 })).rejects.toMatchObject({ code: "plugin_unavailable" });
  await expect(f.authority.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
});

test("a suppressed cap error cannot erase separate descendant cleanup uncertainty", async () => {
  const source = 'const {spawn}=require("node:child_process"); spawn(process.execPath,["-e","setTimeout(()=>{},700)"],{detached:true,stdio:["ignore",1,2]}); process.stdout.write("x".repeat(1048577));';
  const f = fixture(source);
  const pluginResult = await answerSpawn(f.authority, ["opencode"], { argv, timeoutMs: 2000 })
    .then(() => "unexpected", error => { expect(error).toMatchObject({ code: "too_large" }); return "plugin-caught-error-and-returned-success"; });
  expect(pluginResult).toBe("plugin-caught-error-and-returned-success");
  await expect(f.authority.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
});
