import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closedPort, fakeCtx, pinnedPort } from "./helpers";

// Parity for `dispatch.enforcement`, `dispatch.enforcement.probe` and
// `dispatch.enforcement.denied`. Rust owns the params validation, the caller
// refusals and (for `denied`) the store effects, so the front door must
// answer the deterministically-native requests byte for byte exactly as forced
// forwarding to the TypeScript core would.
//
// `dispatch.enforcement` has no callable store effects it can run without the
// dispatch-parts bridge for a specific repository; in a fresh home no
// repository is registered, so every request has a repo the policy says Core
// must resolve and the front door forwards it just like `PACER_FORWARD_OPS`
// would. `dispatch.enforcement.probe` answers its params and repo refusals
// itself and defers a resolvable probe to Core. `denied` answers at its
// enforcement-identity gate (no `pet_` identity here), which fires before
// the params are validated.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "dispatch.enforcement,dispatch.enforcement.probe,dispatch.enforcement.denied";

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

test.skipIf(!front)("enforcement identity gate and repo refusals match forced forwarding byte for byte", async () => {
  const ctx = fakeCtx();
  // Skip the happy-path `dispatch.enforcement` row production (a registered
  // repository home) and `dispatch.enforcement.probe` canary run: those need a
  // provisioned, registered repository.
  const denied_bad_agent = [
    request(2, "dispatch.enforcement.denied", {}),
    request(3, "dispatch.enforcement.denied", { agent: "gemini" }),
    request(4, "dispatch.enforcement.denied", { agent: "" }),
    request(5, "dispatch.enforcement.denied", { agent: "claude-code", stray: true }),
    request(6, "dispatch.enforcement.denied", null),
    request(7, "dispatch.enforcement.denied", "text"),
  ];
  const denied_tokens = [
    request(8, "dispatch.enforcement.denied", { agent: "codex" }),
    request(9, "dispatch.enforcement.denied", { agent: "cursor" }),
  ];
  const probes_no_grant = [
    // No `pet_` identity or work grant is involved; each probe reaches its
    // params and repo validation and is refused `invalid_input` there.
    request(10, "dispatch.enforcement.probe", { repo: "anywhere", runner: "r" }),
    request(11, "dispatch.enforcement.probe", { repo: "" }),
    request(12, "dispatch.enforcement.probe", {}),
    request(13, "dispatch.enforcement.probe", null),
  ];
  const enforcement_forwarded = [
    // No repository is registered, so Core must resolve the repo; the front
    // door forwards the request exactly as forced forwarding would.
    request(14, "dispatch.enforcement", { repo: "anywhere" }),
    request(15, "dispatch.enforcement", {}),
    request(16, "dispatch.enforcement", { repo: "" }),
  ];

  // Refusals the front door answers itself: `denied` (0-7), each at its
  // enforcement-identity gate, and `probe` (8-11), each at its params and
  // repo validation. `dispatch.enforcement` (12-14) has no repo registered
  // in a fresh home, so the front door forwards it to Core in both
  // exchanges and it never carries a native marker here.
  const native_idxs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const native = await exchange(ctx.home, denied_bad_agent.concat(denied_tokens, probes_no_grant, enforcement_forwarded), false, {}, native_idxs);
  const forwarded = await exchange(ctx.home, denied_bad_agent.concat(denied_tokens, probes_no_grant, enforcement_forwarded), true);
  expect(native).toEqual(forwarded);
  expect(wire(native)).toEqual(wire(forwarded));
  // The 8 `denied` requests answer at the enforcement-identity gate, which
  // runs before the params are validated, so each is `not_allowed` regardless
  // of the agent value (matching `authorizeWorkOperation` in `src/core/work.ts`).
  expect(native.slice(0, 8).every(reply => reply.error?.data?.code === "not_allowed")).toBe(true);
  // The 4 `probe` requests need no work grant here, so they run their params
  // and repo validation: every one fails `invalid_input` before the repo can
  // resolve (matching the TypeScript handler's repo-first order).
  expect(native.slice(8, 12).every(reply => reply.error?.data?.code === "invalid_input")).toBe(true);
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
    return { status: response.status, body: await response.text() };
  };
  const markers = async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native dispatch\.enforcement(\.|$)/.test(line)); };
  const stop = async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5000)]); if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } } return stderr; };
  return { post, markers, stop };
}

test.skipIf(!front)("HTTP enforcement refusals match forced forwarding byte for byte", async () => {
  // Over HTTP the `denied` identity gate and the `probe` params/repo validation
  // fire before any store access, and `dispatch.enforcement` with no registered
  // repository is forwarded; each reply must be byte-identical to forced
  // forwarding to TypeScript.
  const cases: { op: string; body: string; native?: true }[] = [
    { op: "dispatch.enforcement.denied", body: JSON.stringify({}), native: true },
    { op: "dispatch.enforcement.denied", body: JSON.stringify({ agent: "gemini" }), native: true },
    { op: "dispatch.enforcement.denied", body: JSON.stringify({ agent: "claude-code", stray: true }), native: true },
    // No repository is registered, so `dispatch.enforcement` is forwarded in both runs.
    { op: "dispatch.enforcement", body: JSON.stringify({ repo: "anywhere" }) },
    { op: "dispatch.enforcement", body: JSON.stringify({}) },
    { op: "dispatch.enforcement", body: JSON.stringify({ repo: "" }) },
    // A valid-enough probe runs its params and repo validation natively.
    { op: "dispatch.enforcement.probe", body: JSON.stringify({ repo: "anywhere", runner: "r" }), native: true },
    { op: "dispatch.enforcement.probe", body: JSON.stringify({ repo: "" }), native: true },
    { op: "dispatch.enforcement.probe", body: JSON.stringify({}), native: true },
    { op: "dispatch.enforcement.probe", body: JSON.stringify(null), native: true },
  ];
  const run = async (forward: boolean) => {
    const home = mkdtempSync("/tmp/pen-");
    mkdirSync(join(home, ".pacer"), { mode: 0o700 });
    const service = await serve(home, forward);
    try {
      const replies = [];
      for (const { op, body } of cases) replies.push(await service.post(op, body));
      return { replies, materialized: await service.markers(), stderr: await service.stop() };
    } finally { await service.stop(); rmSync(home, { recursive: true, force: true }); }
  };
  const native = await run(false), forwarded = await run(true);
  expect(native.replies).toEqual(forwarded.replies);
  expect(native.materialized).toEqual(cases.filter(c => c.native).map(c => `native ${c.op}`));
  expect(forwarded.materialized).toEqual([]);
  // `denied` answers at the enforcement-identity gate and `probe` at params/repo
  // validation; both refuse with the TS-identical `not_allowed` / `invalid_input`.
  expect(native.replies[0]!.body).toContain('"not_allowed"');
  expect(native.replies[6]!.body).toContain('"invalid_input"');
}, 120000);