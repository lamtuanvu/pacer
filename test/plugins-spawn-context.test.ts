import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { answerSpawn, prepareSpawnAuthority } from "../src/plugins/capability-spawn";
import { SCOPED_CAPABILITY_METHODS } from "../src/plugins/capability-protocol";
import { prepareCredentialBindings } from "../src/plugins/credential-bindings";
import { fakeCtx } from "./helpers";
const owners: CallAuthority[] = [], homes: string[] = [];
afterEach(async () => { try { await Promise.all(owners.splice(0).map(owner => owner.revoke())); } finally { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); } });
function fixture(mode = "safe", options: { grants?: string[]; ref?: string; delayed?: () => Promise<string | null> } = {}) {
  const ctx = fakeCtx(), cwd = join(ctx.home, "work"), script = join(ctx.home, "owned-child.js"), receipt = join(ctx.home, "receipt.json");
  homes.push(ctx.home); mkdirSync(cwd);
  writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({pid:process.pid,cwd:process.cwd(),plain:process.env.PLAIN,keyPresent:!!process.env.CREDENTIAL,ambient:process.env.SPAWN_CONTEXT_AMBIENT}));\nif(${JSON.stringify(mode)}==='stdout')process.stdout.write('x'.repeat(800000)+process.env.CREDENTIAL);\nelse if(${JSON.stringify(mode)}==='stderr')process.stderr.write(process.env.CREDENTIAL);\nelse if(${JSON.stringify(mode)}==='hold')setTimeout(()=>{},10000);\nelse process.stdout.write('safe output');\n`);
  ctx.which = name => name === "owned-child" ? process.execPath : null;
  const ref = options.ref ?? "endpoint:owned";
  const command = { argv: ["owned-child", script], timeoutMs: 5000, cwd, env: { PLAIN: "captured" }, secretEnv: { CREDENTIAL: ref } };
  const authority = createCallAuthority(ctx, { reads: [], commands: [command], stores: [] }, { deadlineMs: Date.now() + 10000, grants: options.grants ?? ["process.spawn", "secrets.resolve"] });
  owners.push(authority); let lookups = 0;
  prepareCredentialBindings(authority, [{ ref: "endpoint:owned", resolve: async () => { lookups++; return options.delayed ? await options.delayed() : "owned-injected-credential"; } }]);
  prepareSpawnAuthority(authority);
  const params = { argv: command.argv, timeoutMs: 5000, cwd, env: { PLAIN: "captured", CREDENTIAL: { secretRef: ref } } };
  return { authority, command, params, cwd, receipt, get lookups() { return lookups; }, run: (input: Record<string, unknown> = params) => answerSpawn(authority, ["owned-child"], input) };
}
test("owned context injects only exact captured environment and cwd into actual child", async () => {
  process.env.SPAWN_CONTEXT_AMBIENT = "must-not-inherit";
  try {
    const f = fixture();
    expect(await f.run()).toMatchObject({ code: 0, stdout: "safe output", stderr: "", timedOut: false });
    expect(JSON.parse(readFileSync(f.receipt, "utf8"))).toMatchObject({ cwd: realpathSync(f.cwd), plain: "captured", keyPresent: true });
    expect(readFileSync(f.receipt, "utf8")).not.toContain("must-not-inherit");
    expect(f.lookups).toBe(1);
    expect(JSON.stringify(f.authority.resources)).not.toContain("owned-injected-credential");
  } finally { delete process.env.SPAWN_CONTEXT_AMBIENT; }
});
test("legacy pinned commands receive only the host's minimal environment", async () => {
  const ctx=fakeCtx({env:{HOME:process.env.HOME,PATH:process.env.PATH,SPAWN_CONTEXT_AMBIENT:"private"}});
  homes.push(ctx.home);
  const script=join(ctx.home,"legacy-env.js");
  writeFileSync(script,"console.log(JSON.stringify({home:process.env.HOME,ambient:process.env.SPAWN_CONTEXT_AMBIENT}))");
  ctx.which=name=>name==="legacy-tool"?process.execPath:null;
  const authority=createCallAuthority(ctx,{reads:[],commands:[{argv:["legacy-tool",script],timeoutMs:5000}],stores:[]},{deadlineMs:Date.now()+10000,grants:["process.spawn"]});
  owners.push(authority);prepareSpawnAuthority(authority);
  const result=await answerSpawn(authority,["legacy-tool"],{argv:["legacy-tool",script],timeoutMs:5000}) as {stdout:string};
  expect(JSON.parse(result.stdout)).toEqual({home:process.env.HOME});
});
test("legacy consumers receive only their required ambient variables",async()=>{
  const ambient={HOME:"/tmp/home",PATH:process.env.PATH,DBUS_SESSION_BUS_ADDRESS:"unix:path=/bus",DISPLAY:":1",WAYLAND_DISPLAY:"wayland-0",XDG_RUNTIME_DIR:"/run/user/1",HTTPS_PROXY:"http://proxy",http_proxy:"http://lower",NO_PROXY:"localhost",SSL_CERT_FILE:"/tmp/ca",NODE_EXTRA_CA_CERTS:"/tmp/node-ca",ARK_PROFILE:"work",ARK_REGION:"region",ARK_API_KEY:"fixture-key",PRIVATE_TOKEN:"hidden"};
  const ctx=fakeCtx({env:ambient});homes.push(ctx.home);
  const script=join(ctx.home,"env-consumer.js");writeFileSync(script,"console.log(JSON.stringify(process.env))");
  ctx.which=()=>process.execPath;
  for(const name of ["notify-send","arkcli","opencode","generic-tool"]){
    const authority=createCallAuthority(ctx,{reads:[],commands:[{argv:[name,script],timeoutMs:5000}],stores:[]},{deadlineMs:Date.now()+10000,grants:["process.spawn"]});
    owners.push(authority);prepareSpawnAuthority(authority);
    const result=await answerSpawn(authority,[name],{argv:[name,script],timeoutMs:5000}) as {stdout:string};
    const env=JSON.parse(result.stdout);
    expect(env.PRIVATE_TOKEN).toBeUndefined();
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(name==="notify-send"?ambient.DBUS_SESSION_BUS_ADDRESS:undefined);
    expect(env.DISPLAY).toBe(name==="notify-send"?ambient.DISPLAY:undefined);
    expect(env.WAYLAND_DISPLAY).toBe(name==="notify-send"?ambient.WAYLAND_DISPLAY:undefined);
    expect(env.XDG_RUNTIME_DIR).toBe(name==="notify-send"?ambient.XDG_RUNTIME_DIR:undefined);
    expect(env.HTTPS_PROXY).toBe(["arkcli","opencode"].includes(name)?ambient.HTTPS_PROXY:undefined);
    expect(env.http_proxy).toBe(["arkcli","opencode"].includes(name)?ambient.http_proxy:undefined);
    expect(env.SSL_CERT_FILE).toBe(["arkcli","opencode"].includes(name)?ambient.SSL_CERT_FILE:undefined);
    expect(env.ARK_PROFILE).toBe(name==="arkcli"?ambient.ARK_PROFILE:undefined);
    expect(env.ARK_REGION).toBe(name==="arkcli"?ambient.ARK_REGION:undefined);
    expect(env.ARK_API_KEY).toBe(name==="arkcli"?ambient.ARK_API_KEY:undefined);
  }
});
test("altered vector/context and undeclared scopes deny before credential lookup or child effects", async () => {
  const f = fixture();
  for (const params of [
    { ...f.params, argv: [...f.params.argv, "extra"] }, { ...f.params, cwd: f.cwd + "/other" },
    { ...f.params, env: { PLAIN: "changed", CREDENTIAL: { secretRef: "endpoint:owned" } } },
    { ...f.params, env: { ...f.params.env, EXTRA: "x" } }, { ...f.params, env: {} },
    { ...f.params, stdin: "unissued" },
  ]) await expect(f.run(params)).rejects.toMatchObject({ code: "capability_denied" });
  await expect(answerSpawn(f.authority, ["other-tool"], f.params)).rejects.toMatchObject({ code: "capability_denied" });
  expect(f.lookups).toBe(0); expect(existsSync(f.receipt)).toBe(false);
});
test("host-issued stdin is exact and reaches the pinned child", async () => {
  expect(SCOPED_CAPABILITY_METHODS["capability.process.spawn"]!.deadlineMs).toBe(0);
  const f = fixture();
  const script = join(f.authority.ctx.home, "stdin-child.js");
  writeFileSync(script, `process.stdin.setEncoding("utf8");let input="";for await(const chunk of process.stdin)input+=chunk;require("node:fs").writeFileSync(${JSON.stringify(f.receipt)}, input);`);
  const command = { argv: ["owned-child", script], cwd: f.cwd, env: {}, timeoutMs: 5000,
    stdin: "host prompt\n" };
  const authority = createCallAuthority(f.authority.ctx, { reads: [], commands: [command], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["process.spawn"] });
  owners.push(authority); prepareSpawnAuthority(authority);
  const params = { argv: command.argv, cwd: f.cwd, env: {}, timeoutMs: 5000 };
  await expect(answerSpawn(authority, ["owned-child"], { ...params, stdin: "plugin override" }))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(f.receipt)).toBe(false);
  expect(await answerSpawn(authority, ["owned-child"], { ...params, stdin: command.stdin }))
    .toMatchObject({ code: 0, timedOut: false });
  expect(readFileSync(f.receipt, "utf8")).toBe(command.stdin);
});
test("timed-out stdin child is reaped before returning", async () => {
  const f = fixture();
  const script = join(f.authority.ctx.home, "stdin-hold.js");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(f.receipt)},String(process.pid));process.stdin.resume();setTimeout(()=>{},10000);`);
  const command = { argv: ["owned-child", script], cwd: f.cwd, env: {}, timeoutMs: 1000,
    stdin: "host prompt" };
  const authority = createCallAuthority(f.authority.ctx, { reads: [], commands: [command], stores: [] },
    { deadlineMs: Date.now() + 3000, grants: ["process.spawn"] });
  owners.push(authority); prepareSpawnAuthority(authority);
  const result = await answerSpawn(authority, ["owned-child"], {
    argv: command.argv, cwd: f.cwd, env: {}, timeoutMs: 1000, stdin: command.stdin,
  });
  expect(result).toMatchObject({ timedOut: true });
  expect(existsSync(f.receipt)).toBe(true);
  expect(() => process.kill(Number(readFileSync(f.receipt, "utf8")), 0)).toThrow();
});
for (const mode of ["stdout", "stderr"]) test(`exact injected credential reflection in ${mode} is refused before output handles`, async () => {
  const f = fixture(mode);
  const error = await f.run().catch(error => error);
  expect(error).toMatchObject({ code: "capability_denied", data: { reason: "credential_reflection" } });
  expect(JSON.stringify(error)).not.toContain("owned-injected-credential");
  expect((error as { output?: unknown }).output).toBeUndefined();
});
test("foreign bound ref and missing secret grant deny without child launch", async () => {
  const foreign = fixture("safe", { ref: "endpoint:foreign" });
  await expect(foreign.run()).rejects.toMatchObject({ code: "capability_denied" });
  expect(foreign.lookups).toBe(0); expect(existsSync(foreign.receipt)).toBe(false);
  const noGrant = fixture("safe", { grants: ["process.spawn"] });
  await expect(noGrant.run()).rejects.toMatchObject({ code: "capability_denied" });
  expect(noGrant.lookups).toBe(0); expect(existsSync(noGrant.receipt)).toBe(false);
});
test("cwd replacement during secret lookup denies before spawn", async () => {
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture("safe", { delayed: async () => { entered(); await gate; return "owned-injected-credential"; } });
  const pending = f.run().catch(error => error);
  await started; renameSync(f.cwd, f.cwd + ".original"); mkdirSync(f.cwd); finish();
  expect(await pending).toMatchObject({ code: "capability_denied" });
  expect(existsSync(f.receipt)).toBe(false);
});
test("owner revoke terminates admitted contextual child and denies later calls", async () => {
  const f = fixture("hold"), pending = f.run().catch(error => error);
  const until = Date.now() + 3000;
  while (!existsSync(f.receipt) && Date.now() < until) await Bun.sleep(5);
  expect(existsSync(f.receipt)).toBe(true);
  const pid = JSON.parse(readFileSync(f.receipt, "utf8")).pid;
  await f.authority.revoke();
  expect(await pending).toMatchObject({ code: "capability_denied" });
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(f.run()).rejects.toMatchObject({ code: "capability_denied" });
});


test("issued environment maps are immutable snapshots, with no raw values in resources", async () => {
  const f = fixture();
  expect(Object.isFrozen(f.authority.resources.commands[0]!.env)).toBe(true);
  expect(Object.isFrozen(f.authority.resources.commands[0]!.secretEnv)).toBe(true);
  f.command.env.PLAIN = "mutated";
  f.command.secretEnv.CREDENTIAL = "endpoint:foreign";
  expect(await f.run()).toMatchObject({ code: 0, stdout: "safe output" });
  expect(JSON.parse(readFileSync(f.receipt, "utf8")).plain).toBe("captured");
});
test("revocation during bound lookup waits but never launches a late child", async () => {
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture("safe", { delayed: async () => { entered(); await gate; return "owned-injected-credential"; } });
  const pending = f.run().catch(error => error);
  await started;
  let settled = false;
  const revoked = f.authority.revoke().then(() => { settled = true; });
  await Bun.sleep(0); expect(settled).toBe(false);
  finish(); await revoked;
  expect(await pending).toMatchObject({ code: "capability_denied" });
  expect(existsSync(f.receipt)).toBe(false);
});

test("same issued vector can select its exact separately admitted context", async () => {
  const f = fixture();
  const authority = createCallAuthority(f.authority.ctx, { reads: [], commands: [{ ...f.command, env: { PLAIN: "other" } }, f.command], stores: [] }, { deadlineMs: Date.now() + 5000, grants: ["process.spawn", "secrets.resolve"] });
  owners.push(authority);
  prepareCredentialBindings(authority, [{ ref: "endpoint:owned", resolve: async () => "owned-injected-credential" }]);
  prepareSpawnAuthority(authority);
  expect(await answerSpawn(authority, ["owned-child"], f.params)).toMatchObject({ code: 0, stdout: "safe output" });
  expect(JSON.parse(readFileSync(f.receipt, "utf8")).plain).toBe("captured");
});
