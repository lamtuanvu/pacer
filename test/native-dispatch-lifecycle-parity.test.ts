import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closedPort, fakeCtx, pinnedPort } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.submit,dispatch.child,dispatch.wait,dispatch.review,dispatch.retry,dispatch.answer,dispatch.stop";

const rawLines = new WeakMap<object, string[]>();
/** `native` lists the request indexes the front door must answer itself; `null` means all of them. */
async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, native: number[] | null = null) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: pinnedPort({ HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }),
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    const replies = lines.map(line => JSON.parse(line));
    expect(replies[0]?.result?.protocol).toBe("3.0.0");
    const ops = new Set(requests.map(request => JSON.parse(request).method as string));
    const markers = stderr.split("\n").filter(line => {
      const match = /^native (\S+) \d+$/.exec(line);
      return match != null && ops.has(match[1]!);
    });
    const expected = forward ? [] : requests.map((request, index) => ({ request, index }))
      .filter(({ index }) => native === null || native.includes(index))
      .map(({ request, index }) => `native ${JSON.parse(request).method} ${index + 2}`);
    expect(markers).toEqual(expected);
    const result = replies.slice(1).sort((a, b) => a.id - b.id);
    rawLines.set(result, lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id));
    return result;
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const wire = (replies: object) => rawLines.get(replies)!;
const request = (id: number, method: string, params: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test.skipIf(!front)("lifecycle params errors match forced forwarding byte for byte", async () => {
  const ctx = fakeCtx();
  const cases: [string, unknown][] = [
    ["dispatch.submit", {}], ["dispatch.submit", undefined], ["dispatch.submit", null], ["dispatch.submit", [1]], ["dispatch.submit", "text"],
    ["dispatch.submit", { goal: "", repo: "r", title: "t".repeat(501), acceptance_timeout_min: 121, requestId: null, executor: 5 }],
    ["dispatch.submit", { goal: "g", repo: "x".repeat(4097), acceptance: "é".repeat(20001), acceptance_timeout_min: 0 }],
    ["dispatch.child", { goal: "g" }], ["dispatch.child", { requestId: "", kind: "k".repeat(129), context: 1, constraints: [] }],
    ["dispatch.wait", {}], ["dispatch.wait", { id: "t", timeout_s: -2 }], ["dispatch.wait", { id: "t", timeout_s: 3001 }],
    ["dispatch.wait", { id: "t", timeout_s: 12345678901234567890 }],
    ["dispatch.review", { id: "t" }], ["dispatch.review", { id: "t", accepted: "yes", expect_rev: 0, note: "n".repeat(2001) }],
    ["dispatch.retry", { id: "x".repeat(129), expect_rev: -1, requestId: "r", feedback: 7 }],
    ["dispatch.answer", { id: "t", expect_rev: 1, requestId: "r", text: "" }], ["dispatch.answer", { id: "t", expect_rev: 1, requestId: "r", text: "😀".repeat(2001) }],
    ["dispatch.stop", { id: "t", expect_rev: "1" }], ["dispatch.stop", { id: null }],
  ];
  const requests = cases.map(([op, params], index) => request(index + 2, op, params));
  const native = await exchange(ctx.home, requests, false);
  const forwarded = await exchange(ctx.home, requests, true);
  expect(native).toEqual(forwarded);
  expect(wire(native)).toEqual(wire(forwarded));
  expect(native.every(reply => reply.error?.data?.code === "invalid_input")).toBe(true);
}, 60000);

test.skipIf(!front)("callers without a work grant are refused natively as TypeScript refuses them", async () => {
  const ctx = fakeCtx();
  const requests = [
    request(2, "dispatch.submit", { goal: "g", repo: "/r" }), request(3, "dispatch.child", "bad"), request(4, "dispatch.wait", { id: "t" }),
    request(5, "dispatch.review", {}), request(6, "dispatch.retry", { id: "t" }), request(7, "dispatch.answer", null), request(8, "dispatch.stop", { id: "t" }),
  ];
  for (const env of [{ PACER_ROLE: "executor" }, { PACER_ENFORCEMENT_TOKEN: "pet_x" }] as Record<string, string>[]) {
    const native = await exchange(ctx.home, requests, false, env);
    expect(wire(native)).toEqual(wire(await exchange(ctx.home, requests, true, env)));
    expect(native.every(reply => reply.error?.data?.code === "not_allowed")).toBe(true);
  }
}, 60000);

test.skipIf(!front)("requests Core must run and work options stay with TypeScript", async () => {
  const ctx = fakeCtx();
  const requests = [
    request(2, "dispatch.wait", { id: "missing", timeout_s: 1 }),
    request(3, "dispatch.review", { id: "missing", accepted: true, expect_rev: 1 }),
    request(4, "dispatch.retry", { id: "missing", expect_rev: 1, requestId: "r" }),
    request(5, "dispatch.answer", { id: "missing", expect_rev: 1, requestId: "r", text: "yes" }),
    request(6, "dispatch.stop", { id: "missing" }),
    request(7, "dispatch.child", { goal: "g", requestId: "r" }),
    // workOptionsSchema issues interleave with the field issues, so any `options` forwards.
    request(8, "dispatch.submit", { goal: "", options: { bogus: true } }),
    request(9, "dispatch.child", { options: null }),
    request(10, "dispatch.stop", { expect_rev: 0 }),
    // serde_json may round fractional and exponent literals differently from JSON.parse.
    request(11, "dispatch.wait", { id: "", timeout_s: 1.5 }),
    request(12, "dispatch.review", { id: "t", accepted: true, expect_rev: 1.0000000000000002 }),
    request(13, "dispatch.submit", { goal: "g", repo: "r", acceptance_timeout_min: 1e300 }),
    // New child fields must be validated together with the original fields by Core.
    request(14, "dispatch.child", { difficulty: "invalid", model: 42 }),
  ];
  const routed = await exchange(ctx.home, requests, false, {}, [8]);
  expect(wire(routed)).toEqual(wire(await exchange(ctx.home, requests, true)));
  expect(routed.every(reply => reply.error != null)).toBe(true);
  expect(routed[6].error.message).toContain("options");
}, 60000);

async function serve(home: string, forward: boolean) {
  const port = closedPort();
  const env = pinnedPort({ HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
    ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) }, port);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let n = 0; n < 500 && !token; n++) {
    try {
      const candidate = readFileSync(join(env.PACER_HOME, "token"), "utf8").trim();
      const response = await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${candidate}` }, signal: AbortSignal.timeout(500) });
      if (response.ok) token = candidate;
    } catch {}
    if (!token) await Bun.sleep(20);
  }
  expect(token).not.toBe("");
  const post = async (op: string, body: string | Uint8Array<ArrayBuffer>) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(20000) });
    return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
  };
  const stop = async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
    return stderr;
  };
  return { post, stop };
}

test.skipIf(!front)("HTTP bodies serde_json cannot represent reach Core exactly as forced forwarding does", async () => {
  const bytes = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap(part => typeof part === "string" ? [...new TextEncoder().encode(part)] : part));
  // `native` marks the requests Rust answers itself; every other body must reach Core unchanged.
  const cases: { op: string; body: string | Uint8Array<ArrayBuffer>; native?: true }[] = [
    { op: "dispatch.answer", body: String.raw`{"id":"missing","expect_rev":1,"requestId":"r","text":"\ud800"}` },
    { op: "dispatch.answer", body: String.raw`{"id":"","expect_rev":0,"requestId":"r","text":"a\udfffb"}` },
    { op: "dispatch.submit", body: String.raw`{"goal":"\ud83d","repo":""}` },
    { op: "dispatch.stop", body: bytes('{"id":"', [0xff, 0xfe], '","expect_rev":0}') },
    { op: "dispatch.wait", body: bytes([0xef, 0xbb, 0xbf], '{"timeout_s":5000}') },
    { op: "dispatch.wait", body: '{"id":"missing","timeout_s":1e400}' },
    { op: "dispatch.stop", body: '{"id":"t","expect_rev":123456789012345678901234567890}' },
    { op: "dispatch.review", body: '{"id":"t","accepted":true,"expect_rev":1.0000000000000002}' },
    { op: "dispatch.retry", body: '{"id":"","expect_rev":0.1e1,"requestId":"r"}' },
    { op: "dispatch.child", body: '{"goal":"g","requestId":"r","acceptance_timeout_min":-1e-400}' },
    { op: "dispatch.wait", body: "{" },
    { op: "dispatch.stop", body: '{"id":"t","expect_rev":12345678901234567890}', native: true },
    { op: "dispatch.wait", body: '{"id":"","timeout_s":-9223372036854775808}', native: true },
    { op: "dispatch.answer", body: String.raw`{"id":"t","expect_rev":1,"requestId":"r","text":"\ud83d\ude00","note":"\u00e9"}` },
    { op: "dispatch.review", body: '{"id":"t","accepted":"no","expect_rev":9007199254740993}', native: true },
    { op: "dispatch.submit", body: "null", native: true },
    { op: "dispatch.stop", body: "x".repeat(256 * 1024 + 1) },
  ];
  const run = async (forward: boolean) => {
    const home = mkdtempSync("/tmp/pdl-");
    mkdirSync(join(home, ".pacer"), { mode: 0o700 });
    const service = await serve(home, forward);
    try {
      const replies = [];
      for (const { op, body } of cases) replies.push(await service.post(op, body));
      return { replies, stderr: await service.stop() };
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.replies).toEqual(forwarded.replies);
  const markers = (stderr: string) => stderr.split("\n").filter(line => /^native dispatch\.\w+$/.test(line));
  expect(markers(native.stderr)).toEqual(cases.filter(c => c.native).map(c => `native ${c.op}`));
  expect(markers(forwarded.stderr)).toEqual([]);
  expect(native.replies.every(reply => reply.type?.startsWith("application/json"))).toBe(true);
  expect(native.replies.at(-1)!.status).toBe(413);
  expect(JSON.parse(native.replies[10]!.body).error.message).toBe("body is not JSON");
}, 120000);
