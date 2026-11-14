import { expect, test } from "bun:test";
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_SECRET_ENV, CORE_SECRETS_ENV, readCoreSecrets, scrubCoreSecrets } from "../src/core-secrets";
import { fakeCtx, tmpDir } from "./helpers";
import { keychainStubPath } from "./keychain-stub";

// Core's secrets arrive in one frame on stdin (#918, ADR 0027): read exactly once, before
// anything else reads stdin, and a missing or malformed frame refuses the start.

const frame = (body: string) => `pacer-core-secrets/1 ${Buffer.byteLength(body)}\n${body}`;
const secrets = { internalToken: "a".repeat(64), ownerKey: "b".repeat(64), nativeConfigSyncKey: "c".repeat(64) };

function withInput<T>(bytes: string, read: (fd: number) => T): { value?: T; error?: Error; rest: string } {
  const path = join(tmpDir(), "stdin");
  writeFileSync(path, bytes);
  const fd = openSync(path, "r");
  try {
    let value: T | undefined, error: Error | undefined;
    try { value = read(fd); } catch (caught) { error = caught as Error; }
    const rest = Buffer.alloc(Buffer.byteLength(bytes));
    return { value, error, rest: rest.toString("utf8", 0, readSync(fd, rest, 0, rest.length, null)) };
  } finally { closeSync(fd); }
}

test("Core reads exactly its frame and leaves the lines that follow", () => {
  const line = '{"jsonrpc":"2.0","id":1,"method":"hello"}\n';
  const { value, rest } = withInput(frame(JSON.stringify(secrets)) + line, fd => readCoreSecrets(fd));
  expect(value).toEqual(secrets);
  expect(rest).toBe(line);
  expect(withInput(frame("{}"), fd => readCoreSecrets(fd)).value).toEqual({});
});

test("a missing frame fails closed", () => {
  expect(withInput("", fd => readCoreSecrets(fd)).error?.message).toContain("frame is missing; refusing to start");
});

test("a malformed frame fails closed without revealing its contents", () => {
  const body = JSON.stringify(secrets);
  const hex = (c: string) => JSON.stringify(c.repeat(64));
  for (const input of [
    '{"jsonrpc":"2.0","id":1,"method":"hello"}\n',
    "pacer-core-secrets/1 0\n",
    "pacer-core-secrets/1 02\n{}",
    "pacer-core-secrets/1 4097\n" + "x".repeat(4097),
    "pacer-core-secrets/1 99999\n{}",
    "pacer-core-secrets/1 2",
    `pacer-core-secrets/1 ${body.length + 5}\n${body}`,
    frame("not json"),
    frame("[]"),
    frame("null"),
    frame(JSON.stringify({ ...secrets, extra: "d".repeat(64) })),
    frame(JSON.stringify({ internalToken: "A".repeat(64) })),
    frame(JSON.stringify({ ownerKey: "b".repeat(63) })),
    frame(JSON.stringify({ nativeConfigSyncKey: 1 })),
    // One encoding only: a repeated key (last one wins in JSON.parse) or any other spelling.
    frame(`{"internalToken":${hex("a")},"internalToken":${hex("b")}}`),
    frame(`{"ownerKey":${hex("b")},"ownerKey":${hex("b")}}`),
    frame(`{"internalToken": ${hex("a")}}`),
    frame(`{"internal\\u0054oken":${hex("a")}}`),
  ]) {
    const { error } = withInput(input, fd => readCoreSecrets(fd));
    expect(error?.message, input).toBe("Core's secrets frame on stdin is malformed; refusing to start");
  }
  // A JSON-RPC line is refused at its first byte; nothing more is consumed.
  expect(withInput("{}\n", fd => readCoreSecrets(fd)).rest).toBe("}\n");
});

test("a frame from another build names the version mismatch", () => {
  for (const input of ["pacer-core-secrets/2 2\n{}", "pacer-core-secrets/10 2\n{}"]) {
    expect(withInput(input, fd => readCoreSecrets(fd)).error?.message, input)
      .toBe("Core's secrets frame on stdin has an unsupported version (the pacer front door and pacer-core must come from the same build); refusing to start");
  }
  expect(() => scrubCoreSecrets({ [CORE_SECRETS_ENV]: "stdin/2" })).toThrow("must come from the same build");
});

/** `readCoreSecrets` in a child whose stdin is `stdin`; the parent never writes unless told to. */
async function readInChild(stdin: "pipe" | "ignore" | "tty" | "closed", write = "", timeoutMs = 300) {
  const script = `const { readCoreSecrets } = require(${JSON.stringify(join(import.meta.dir, "../src/core-secrets.ts"))});
const started = Date.now();
try { readCoreSecrets(0, ${timeoutMs}); console.log(JSON.stringify({ ok: true })); }
catch (error) { console.log(JSON.stringify({ error: error.message, elapsed: Date.now() - started })); }`;
  const argv = [process.execPath, "-e", script];
  const tty = ["python3", "-c", "import os,pty,subprocess,sys; m,s=pty.openpty(); r=subprocess.run(sys.argv[1:],stdin=s,stdout=subprocess.PIPE); sys.stdout.buffer.write(r.stdout)"];
  const closed = ["/bin/sh", "-c", 'exec "$@" <&-', "sh"];
  const child = Bun.spawn(stdin === "tty" ? [...tty, ...argv] : stdin === "closed" ? [...closed, ...argv] : argv, {
    stdin: stdin === "pipe" ? "pipe" : "ignore", stdout: "pipe", stderr: "inherit",
  });
  if (write) child.stdin?.write(write);
  // The writer stays open and silent: a blocking read here would wait for ever.
  const exited = await Promise.race([child.exited, Bun.sleep(15000).then(() => "hung" as const)]);
  if (exited === "hung") child.kill("SIGKILL");
  await child.stdin?.end();
  const out = await new Response(child.stdout).text();
  return exited === "hung" ? { hung: true } : JSON.parse(out.trim().split("\n").at(-1) || "{}");
}

test("a silent, terminal, empty or closed stdin fails closed within the deadline", async () => {
  const [silent, partial, tty, empty, closed] = await Promise.all([
    readInChild("pipe"), readInChild("pipe", "pacer-core-secrets/1 10\n{"), readInChild("tty"), readInChild("ignore"), readInChild("closed"),
  ]);
  expect(silent).toMatchObject({ error: expect.stringContaining("frame is missing") });
  expect(silent.elapsed).toBeGreaterThanOrEqual(250);
  expect(silent.elapsed).toBeLessThan(5000);
  expect(partial).toMatchObject({ error: expect.stringContaining("malformed") });
  expect(partial.elapsed).toBeLessThan(5000);
  // A terminal never carries the frame, so Core does not wait for one.
  expect(tty).toMatchObject({ error: expect.stringContaining("frame is missing") });
  expect(tty.elapsed).toBeLessThan(250);
  expect(empty).toMatchObject({ error: expect.stringContaining("frame is missing") });
  expect(closed).toMatchObject({ error: expect.stringContaining("frame is missing") });
}, 30000);

test("startup removes every secret name and the announcement from both environments", () => {
  const names = [...CORE_SECRET_ENV, CORE_SECRETS_ENV];
  const env: Record<string, string | undefined> = { PATH: "/bin", [CORE_SECRETS_ENV]: "stdin/1" };
  for (const name of CORE_SECRET_ENV) env[name] = process.env[name] = "e".repeat(64);
  expect(scrubCoreSecrets(env)).toBe(true);
  for (const name of names) {
    expect(env).not.toHaveProperty(name);
    expect(process.env[name]).toBeUndefined();
  }
  expect(env.PATH).toBe("/bin");
  expect(scrubCoreSecrets({ PACER_INTERNAL_TOKEN: "e".repeat(64) })).toBe(false);
  expect(() => scrubCoreSecrets({ [CORE_SECRETS_ENV]: "env/1" })).toThrow("Unsupported PACER_CORE_SECRETS value");
});

/** Core as a front door starts it, with `stdin` as the only input. */
async function core(argv: string[], stdin: string, env: Record<string, string> = { [CORE_SECRETS_ENV]: "stdin/1" }) {
  const ctx = fakeCtx();
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...argv], {
    env: { HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: keychainStubPath(ctx.home), TZ: process.env.TZ ?? "UTC",
      PACER_NO_UPDATE_CHECK: "1", PACER_DISCOVERY: "off", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(stdin);
  await child.stdin.end();
  const exited = await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung" as const)]);
  if (exited === "hung") child.kill("SIGKILL");
  return { code: exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
}

test("internal Core refuses to start on a missing or malformed frame and announces no listener", async () => {
  for (const input of ["", "garbage\n", frame(JSON.stringify({ internalToken: "short" }))]) {
    const result = await core(["serve", "--internal"], input);
    expect(result.code, input).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toMatch(/refusing to start/);
  }
}, 60000);

test("internal Core never takes its credential from the environment, and names an older front door", async () => {
  const result = await core(["serve", "--internal"], "", { PACER_INTERNAL_TOKEN: "a".repeat(64), PACER_INTERNAL_PARENT_PIPE: "1" });
  expect(result.code).toBe(2);
  expect(result.out).toBe("");
  expect(result.err).toContain("secrets frame on stdin (PACER_CORE_SECRETS=stdin/1)");
  expect(result.err).toContain("the pacer front door and pacer-core must come from the same build");
  expect(result.err).not.toContain("a".repeat(16));
});

test("stdio Core warns that an older front door's environment secrets are ignored", async () => {
  const hello = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}\n';
  const served = await core(["api", "--stdio"], hello, { PACER_NATIVE_CONFIG_SYNC_KEY: "c".repeat(64) });
  expect(JSON.parse(served.out.split("\n")[0]!)).toMatchObject({ id: 1, result: { protocol: expect.any(String) } });
  expect(served.err).toContain("must come from the same build");
  expect(served.err).not.toContain("c".repeat(16));
}, 30000);

/** Core, or the front door, with a stdin pipe its parent holds open and never writes. */
async function silent(argv: string[], env: Record<string, string>) {
  const ctx = fakeCtx();
  const started = Date.now();
  const child = Bun.spawn(argv, {
    env: { HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: keychainStubPath(ctx.home), TZ: process.env.TZ ?? "UTC",
      PACER_NO_UPDATE_CHECK: "1", PACER_DISCOVERY: "off", ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const exited = await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung" as const)]);
  if (exited === "hung") child.kill("SIGKILL");
  await child.stdin.end();
  return { code: exited, elapsed: Date.now() - started, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
}

test("Core announced a frame on a silent stdin refuses within its 10 s budget", async () => {
  const result = await silent([process.execPath, "src/cli.ts", "api", "--stdio"], { [CORE_SECRETS_ENV]: "stdin/1" });
  expect(result.code).toBe(2);
  expect(result.err).toContain("frame is missing; refusing to start");
  expect(result.elapsed).toBeGreaterThanOrEqual(9000);
  expect(result.elapsed).toBeLessThan(15000);
}, 30000);

const front = process.env.PACER_TEST_FRONT_DOOR;
test.skipIf(!front)("the front door does not pass an inherited announcement to the Core it execs", async () => {
  const result = await silent([front!, "help"], {
    [CORE_SECRETS_ENV]: "stdin/1", PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
  });
  expect(result.err).not.toContain("refusing to start");
  expect(result.code).toBe(0);
  expect(result.elapsed).toBeLessThan(8000);
}, 30000);

test("stdio Core reads its frame before the first request, and refuses a request in its place", async () => {
  const hello = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}\n';
  const refused = await core(["api", "--stdio"], hello);
  expect(refused.code).toBe(2);
  expect(refused.out).toBe("");
  expect(refused.err).toContain("frame on stdin is malformed");
  const served = await core(["api", "--stdio"], frame(JSON.stringify({ nativeConfigSyncKey: "c".repeat(64) })) + hello);
  expect(JSON.parse(served.out.split("\n")[0]!)).toMatchObject({ id: 1, result: { protocol: expect.any(String) } });
}, 60000);
