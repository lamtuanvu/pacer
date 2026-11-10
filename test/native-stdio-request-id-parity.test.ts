import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "task.get,dispatch.tree";
const HELLO = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}';

/** Writes `lines` to the stdio front door verbatim, so ids reach it exactly as typed. */
async function exchange(home: string, lines: string[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write(lines.join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const markers = stderr.split("\n").filter(line => /^native (task\.get|dispatch\.tree) /.test(line));
    return { replies: stdout.trim().split("\n"), markers };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

const raw = (id: string, method: string, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"${method}","params":${params}}`;

test.skipIf(!front)("native replies echo request ids exactly as forced forwarding through JavaScript does", async () => {
  const ctx = fakeCtx();
  const exact = ["2", "-1", "9007199254740991", "-9007199254740991", '"s\\u0001\\u2028"', "null"];
  const inexact = [
    "9007199254740993", "9007199254740992", "-9007199254740993", "12345678901234567890", "18446744073709551616",
    "100000000000000000000000", "1.5", "1.0", "0.1", "1e3", "1E+2", "1e21", "1e-7", "-0", "-0.0",
  ];
  const lines = [HELLO, ...[...exact, ...inexact].flatMap(id => [
    raw(id, "task.get", '{"id":"missing"}'),
    raw(id, "dispatch.tree", "{}"),
  ])];
  const native = await exchange(ctx.home, lines, false);
  const forwarded = await exchange(ctx.home, lines, true);
  expect(native.replies.toSorted()).toEqual(forwarded.replies.toSorted());
  expect(native.replies.filter(line => line.includes('"id":9007199254740992,')).length).toBe(4);
  expect(native.replies.some(line => line.includes('"id":9007199254740993'))).toBe(false);
  expect(native.markers.length).toBe(exact.length * 2);
  expect(forwarded.markers).toEqual([]);
}, 60000);

test.skipIf(!front)("a hello JavaScript cannot echo is answered by Core and later requests stay native", async () => {
  const ctx = fakeCtx();
  const lines = [
    '{"jsonrpc":"2.0","id":9007199254740993,"method":"hello","params":{"protocol":3}}',
    raw("2", "dispatch.tree", "{}"),
  ];
  const { replies, markers } = await exchange(ctx.home, lines, false);
  const hello = replies.find(line => line.startsWith('{"jsonrpc":"2.0","id":9007199254740992,"result":'));
  expect(JSON.parse(hello!).result.protocol).toBe("3.0.0");
  expect(replies.length).toBe(2);
  expect(JSON.parse(replies.find(line => line !== hello)!)).toMatchObject({ id: 2, error: { data: { code: "invalid_input" } } });
  expect(markers).toEqual(["native dispatch.tree 2"]);
}, 60000);
