import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx } from "./helpers";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.submit,dispatch.child,dispatch.wait,dispatch.review,dispatch.retry,dispatch.answer,dispatch.stop";

const rawLines = new WeakMap<object, string[]>();
/** `native` lists the request indexes the front door must answer itself; `null` means all of them. */
async function exchange(home: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, native: number[] | null = null) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home,
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}) },
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
    ["dispatch.submit", { goal: "g", repo: "x".repeat(4097), acceptance: "é".repeat(20001), acceptance_timeout_min: 0.5 }],
    ["dispatch.child", { goal: "g" }], ["dispatch.child", { requestId: "", kind: "k".repeat(129), context: 1, constraints: [] }],
    ["dispatch.wait", {}], ["dispatch.wait", { id: "t", timeout_s: 1.5 }], ["dispatch.wait", { id: "t", timeout_s: 3001 }],
    ["dispatch.wait", { id: "t", timeout_s: 1e300 }],
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
  ];
  const routed = await exchange(ctx.home, requests, false, {}, [8]);
  expect(wire(routed)).toEqual(wire(await exchange(ctx.home, requests, true)));
  expect(routed.every(reply => reply.error != null)).toBe(true);
  expect(routed[6].error.message).toContain("options");
}, 60000);
