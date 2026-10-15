import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRun } from "../src/ctx";
import { SCRIPTS } from "../src/remote/scripts";
import { controlDir, payload, payloadStream, runRemote, sshArgv } from "../src/remote/ssh";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const host = { alias: "box", ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} };

test("sshArgv is fixed: options, alias, bash -lc and quoted args", () => {
  const ctx = fakeCtx();
  const argv = sshArgv(ctx, host, SCRIPTS.PROBE, ["it's"]);
  expect(argv.slice(0, 2)).toEqual(["ssh", "-o"]);
  expect(argv).toContain("BatchMode=yes");
  for (const option of ["ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=2", "ControlMaster=auto", "ControlPersist=60"]) {
    expect(argv).toContain(option);
  }
  expect(argv).toContain(`ControlPath=${join(ctx.pacerHome, "ssh", "cm-%C")}`);
  const i = argv.indexOf("--");
  expect(argv[i + 1]).toBe("box-ssh");
  expect(argv[i + 2]).toMatch(/^bash -lc '.*' pacer 'it'\\''s'$/s);
  expect(() => sshArgv(ctx, host, "rm -rf ~", [])).toThrow();
});

test("hostile text only travels on stdin", async () => {
  const ctx = { ...fakeCtx({ run: realRun }) }, hostHome = tmpDir(), log = join(tmpDir(), "ssh.log");
  ctx.env = fakeSshEnv(hostHome, log);
  const evil = `x'; touch "$HOME/pwned"; echo $(id) \`id\`\nline2`;
  const r = await runRemote({ ...ctx, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...ctx.env } }) }, host, SCRIPTS.ECHO_STDIN, [], { stdin: evil });
  expect(r.code).toBe(0);
  expect(r.stdout).toBe(evil);
  expect(readFileSync(log, "utf8")).not.toContain("pwned");
  expect(existsSync(join(hostHome, "pwned"))).toBe(false);
});

test("PROBE reports tools from the host's login shell", async () => {
  const hostHome = tmpDir(), log = join(tmpDir(), "ssh.log"), ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(hostHome, log);
  const r = await runRemote({ ...ctx, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...ctx.env } }) }, host, SCRIPTS.PROBE, []);
  expect(r.stdout).toMatch(/^git=git version /m);
  expect(r.stdout).toContain(`home=${hostHome}`);
  for (const tool of ["codex", "claude", "setsid"]) expect(r.stdout).toMatch(new RegExp(`^${tool}=.*$`, "m"));
});

test("controlDir creates a private SSH socket directory", () => {
  const ctx = fakeCtx();
  expect(controlDir(ctx)).toBe(join(ctx.pacerHome, "ssh"));
  expect(statSync(controlDir(ctx)).mode & 0o777).toBe(0o700);
});

test("defaultRun carries stdin and env to a real process", async () => {
  const stdin = "quotes '\" $(id) `id`\nline2\n";
  const result = await defaultRun(["sh", "-c", 'printf "%s\\n" "$PACER_STDIN_TEST"; cat'], 5000, {
    stdin, env: { ...process.env, PACER_STDIN_TEST: "present" },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`present\n${stdin}`);
});

test("quoted arguments cannot execute shell substitutions", async () => {
  const hostHome = tmpDir(), log = join(tmpDir(), "ssh.log"), ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(hostHome, log);
  const result = await runRemote({ ...ctx, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...ctx.env } }) }, host, SCRIPTS.PROBE,
    ["it's", '$(touch "$HOME/pwned")', '`touch "$HOME/pwned"`', "line1\nline2"]);
  expect(result.code).toBe(0);
  expect(existsSync(join(hostHome, "pwned"))).toBe(false);
});

test("an unreachable fake host returns SSH's connection refusal", async () => {
  const ctx = fakeCtx({ run: realRun });
  ctx.env = fakeSshEnv(tmpDir(), join(tmpDir(), "ssh.log"), "other box-ssh");
  const result = await runRemote({ ...ctx, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...process.env, ...ctx.env } }) }, host, SCRIPTS.PROBE, []);
  expect(result.code).toBe(255);
  expect(result.stderr).toContain("ssh: connect to host box-ssh port 22: Connection refused");
});

test("runRemote defaults to 60 seconds and forwards an explicit timeout", async () => {
  const timeouts: number[] = [];
  const ctx = fakeCtx({ run: async (_argv, ms) => { timeouts.push(ms); return { code: 0, stdout: "", stderr: "" }; } });
  await runRemote(ctx, host, SCRIPTS.PROBE, []);
  await runRemote(ctx, host, SCRIPTS.PROBE, [], { timeoutMs: 1234 });
  expect(timeouts).toEqual([60_000, 1234]);
});

test("payload framing ignores partial and inline markers and preserves binary bytes", async () => {
  const chatter = "inline __PACER_BEGIN__\nhello from profile\n";
  expect(payload(`${chatter}__PACER_BEGIN__\nresult`)).toBe("result");
  const bytes = Buffer.from([0, 255, 128, 10]);
  const framed = Buffer.concat([Buffer.from(`${chatter}__PACER_BEGIN__\n`), bytes]);
  for (let split = 0; split <= framed.length; split++) {
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(framed.subarray(0, split)); c.enqueue(framed.subarray(split)); c.close();
    } });
    const chunks = [];
    for await (const chunk of payloadStream(stream)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);
  }
});
