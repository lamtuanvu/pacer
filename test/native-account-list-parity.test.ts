import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import { accountListParts } from "../src/api/account-list-bridge";
import { tmpDir, withLoginIndicators } from "./helpers";
import { cleanupUsageFixtures, fakeCtx } from "./usage-plugin-fixtures";

afterEach(cleanupUsageFixtures);

// Native account.list (rows composed in Rust over the account-list Core bridge),
// the account.signin refusals and the admitted sign-ins the front door forwards,
// against the same requests forced through PACER_FORWARD_OPS to the TypeScript
// core, over stdio and HTTP.

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const OPS = "account.list,account.signin";
const UUID = "123e4567-e89b-42d3-a456-426614174000";

const model = (id: string) => `{id: ${id}, context: 1000, output: 100, tools: true}`;
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
  work: {kind: codex, home: ~/.codex-work}
  out: {kind: codex, home: "~/team's out"}
  mail: {kind: claude, home: ~/me@mail.test}
  linked: {kind: codex, orca_account: acct1}
  gone: {kind: claude, orca_account: missing1}
  "7": {kind: codex, home: ~/.codex-7}
  ep: {kind: endpoint, usage: metered, budget: {weekly_tokens: 1000}, connection: {api: openai-compatible, base_url: "https://ep.test/v1", key: "env:EP_KEY", models: [${model("m1")}]}}
  fk: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "https://fk.test:8443/v1", key: file, models: [${model("f1")}]}}
  ext: {kind: endpoint, usage: unmetered, model: acme/m1}
runners:
  claude-code: {}
  codex: {}
  codex#work: {}
  opencode#ext: {}
routing:
  - default: [claude-code, codex]
`;

// Recreates `work` as a Claude account without runners.
const EDITED = STRATEGY.replace("  work: {kind: codex, home: ~/.codex-work}", "  work: {kind: claude, home: ~/.claude-work}").replace("  codex#work: {}\n", "");

const ORCA = JSON.stringify({ claude: { accounts: [] }, codex: { activeAccountId: "acct1", accounts: [{ id: "acct1", label: "Team Codex" }] }, rateLimits: {} });

function bin(dir: string, name: string, body: string) {
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
}

function home(): string {
  const dir = tmpDir(), pacer = join(dir, ".pacer");
  mkdirSync(join(pacer, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pacer, "strategy.yaml"), STRATEGY);
  writeFileSync(join(pacer, "secrets", "fk.key"), "file-key-value", { mode: 0o600 });
  for (const folder of [".codex-work", ".codex-7"]) { mkdirSync(join(dir, folder)); writeFileSync(join(dir, folder, "auth.json"), "{}"); }
  mkdirSync(join(dir, "team's out"));
  mkdirSync(join(dir, "me@mail.test"));
  mkdirSync(join(dir, "orca", "codex-accounts", "acct1", "home"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  for (const name of ["claude", "codex", "opencode"]) bin(dir, name, "exit 1");
  bin(dir, "fake-orca", `echo '${ORCA}'`);
  withLoginIndicators({ home: dir } as Ctx);
  return dir;
}

// Unmetered readings are captured at the reading process's clock.
const clocks = (text: string, dir: string) => text.replaceAll(dir, "<home>").replace(/"capturedAt":[\d.]+/g, '"capturedAt":"<now>"');

// Executor callers reach a service over HTTP; give them a closed port, never the default one.
const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const CLOSED_PORT = String(reservation.port);
reservation.stop(true);

const env = (dir: string, forward: boolean, extra: Record<string, string> = {}) => ({
  HOME: dir, PACER_HOME: join(dir, ".pacer"), PATH: `${join(dir, "bin")}:/usr/bin:/bin`, PACER_CORE_ARGV: core, PACER_PORT: CLOSED_PORT,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  PACER_ORCA_USER_DATA: join(dir, "orca"), ORCA_CLI_COMMAND: "fake-orca", EP_KEY: "sk-ep-secret-value",
  ...extra, ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
});

async function exchange(dir: string, requests: string[], forward: boolean, extra: Record<string, string> = {}, expectNative: boolean | string[] = !forward) {
  const child = Bun.spawn([front!, "api", "--stdio"], { cwd: dir, env: env(dir, forward, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(stdout + stderr).not.toContain("sk-ep-secret-value");
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result?.protocol).toBe("3.0.0");
    const markers = stderr.split("\n").filter(line => /^native account\.(list|signin) \d+$/.test(line));
    expect(markers).toEqual(Array.isArray(expectNative) ? expectNative : expectNative ? requests.map((r, i) => `native ${JSON.parse(r).method} ${i + 2}`) : []);
    return lines.slice(1).sort((a, b) => JSON.parse(a).id - JSON.parse(b).id).map(line => clocks(line, dir));
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}
const requests = (cases: [string, unknown][]) => cases.map(([method, params], i) =>
  JSON.stringify({ jsonrpc: "2.0", id: i + 2, method, ...(params === undefined ? {} : { params }) }));

test.skipIf(!front)("account.list rows and account.signin refusals match forced forwarding", async () => {
  const cases: [string, unknown][] = [
    ["account.list", {}],
    ["account.list", undefined],
    ["account.list", { extra: true }],
    ["account.signin", { name: "nope" }],
    ["account.signin", { name: "ep" }],
    ["account.signin", { name: "gone" }],
    ["account.signin", { name: "ext", target: "tmux", request_id: UUID }],
  ];
  const homes = [home(), home()];
  const native = await exchange(homes[0]!, requests(cases), false);
  const forwarded = await exchange(homes[1]!, requests(cases), true);
  expect(native).toEqual(forwarded);
  const rows = JSON.parse(native[0]!).result as Record<string, unknown>[];
  expect(rows.map(row => row.name)).toEqual(["7", "claude", "codex", "work", "out", "mail", "linked", "gone", "ep", "fk", "ext"]);
  const byName = Object.fromEntries(rows.map(row => [row.name, row]));
  expect(byName.linked).toMatchObject({ label: "Team Codex", runnable: true });
  expect(byName.gone).toMatchObject({ runnable: false, folder: null });
  expect(byName.mail).toMatchObject({ home: "[redacted]", folder: "[redacted]" });
  expect(byName.work).toMatchObject({ runners: ["codex#work"], locked: "In use by 1 executor(s)", signedIn: true });
  expect(byName.claude).toMatchObject({ locked: "Planner — can't remove" });
  expect(byName.out).toMatchObject({ signedIn: false, signin_command: "CODEX_HOME='<home>/team'\\''s out' codex login" });
  expect(byName.ep).toMatchObject({ state: "not_tested", connection: { base_url_host: "ep.test", key: "present" } });
  expect(byName.ext).toMatchObject({ state: "external" });
  expect(native.slice(3).map(line => JSON.parse(line).error.data.code)).toEqual(["invalid_input", "not_allowed", "not_allowed", "not_allowed"]);
}, 120000);

test.skipIf(!front)("a strategy edit during the bridge reads cannot mix snapshots", async () => {
  // The Orca read runs after the strategy load.
  const homes = [home(), home()];
  for (const dir of homes) {
    writeFileSync(join(dir, "edited.yaml"), EDITED);
    bin(dir, "fake-orca", `cp '${join(dir, "edited.yaml")}' '${join(dir, ".pacer", "next.yaml")}' && mv '${join(dir, ".pacer", "next.yaml")}' '${join(dir, ".pacer", "strategy.yaml")}'\necho '${ORCA}'`);
  }
  const list = requests([["account.list", {}]]);
  const native = await exchange(homes[0]!, list, false);
  expect(native).toEqual(await exchange(homes[1]!, list, true));
  expect(readFileSync(join(homes[0]!, ".pacer", "strategy.yaml"), "utf8")).toBe(EDITED);
  const work = (JSON.parse(native[0]!).result as Record<string, unknown>[]).find(row => row.name === "work");
  expect(work).toMatchObject({ kind: "codex", home: "~/.codex-work", runners: ["codex#work"], signedIn: true });
}, 120000);

test.skipIf(!front)("a strategy edit between the native read and the bridge load cannot mix snapshots", async () => {
  // The wrapper core swaps in the edited strategy after the native forward check has read
  // the original and before the core loads it for the bridge (or for the forwarded op).
  const wrapped = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/core-stdin-proxy.ts"), ...JSON.parse(core)]);
  const homes = [home(), home()];
  for (const dir of homes) writeFileSync(join(dir, "edited.yaml"), EDITED);
  const list = requests([["account.list", {}]]);
  const extra = (dir: string) => ({ PACER_CORE_ARGV: wrapped, PACER_TEST_STRATEGY_EDIT: join(dir, "edited.yaml") });
  const native = await exchange(homes[0]!, list, false, extra(homes[0]!));
  expect(native).toEqual(await exchange(homes[1]!, list, true, extra(homes[1]!)));
  for (const dir of homes) expect(readFileSync(join(dir, ".pacer", "strategy.yaml"), "utf8")).toBe(EDITED);
  const work = (JSON.parse(native[0]!).result as Record<string, unknown>[]).find(row => row.name === "work");
  expect(work).toMatchObject({ kind: "claude", home: "~/.claude-work", folder: "<home>/.claude-work", runners: [], signedIn: false });
  expect(work).not.toHaveProperty("locked");
}, 120000);

test("the account-list bridge reports the strategy text its parts were read against", async () => {
  const ctx = fakeCtx();
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  other: {kind: codex}\n");
  const text = "planner: claude-code\naccounts:\n  personal: {kind: claude}\n  api: {kind: endpoint, usage: unmetered}\n";
  writeFileSync(join(ctx.pacerHome, "strategies", "named.yaml"), text);
  writeFileSync(join(ctx.pacerHome, "active"), "named\n");
  const parts = await accountListParts(ctx);
  expect(parts.strategy).toEqual({ path: join(ctx.pacerHome, "strategies", "named.yaml"), name: "named", text });
  expect(parts.accounts.map(a => a.name)).toEqual(["personal", "api"]);
});

test.skipIf(!front)("account inputs only TypeScript owns stay forwarded", async () => {
  const cases: [string, unknown][] = [
    ["account.list", []],
    ["account.signin", { name: 5 }],
    ["account.signin", { name: "ep", target: "bad" }],
    ["account.signin", { name: "ep", request_id: "nope" }],
    ["account.signin", { interactive: "bogus" }],
    ["account.signin", { name: "constructor" }],
  ];
  const homes = [home(), home()];
  expect(await exchange(homes[0]!, requests(cases), false, {}, false)).toEqual(await exchange(homes[1]!, requests(cases), true));
  const broken = home();
  writeFileSync(join(broken, ".pacer", "strategy.yaml"), "accounts: [unclosed\n");
  const loads = requests([["account.list", {}], ["account.signin", { name: "nope" }]]);
  expect(await exchange(broken, loads, false, {}, false)).toEqual(await exchange(broken, loads, true));
}, 120000);

test.skipIf(!front)("an enforcement identity is refused natively", async () => {
  const dir = home();
  const enforced = requests([["account.list", {}], ["account.signin", { name: "nope" }]]);
  const extra = { PACER_ENFORCEMENT_TOKEN: "pet_x" };
  expect(await exchange(dir, enforced, false, extra)).toEqual(await exchange(dir, enforced, true, extra));
}, 60000);

async function serve(dir: string, forward: boolean, extra: Record<string, string> = {}) {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe", env: env(dir, forward, { ...extra, PACER_PORT: String(port) }) });
  const stderr = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "", ready = false;
  for (let n = 0; n < 1000 && !ready; n++) {
    try {
      token = readFileSync(join(dir, ".pacer/token"), "utf8").trim();
      ready = (await fetch(base + "/v3/hello", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (!ready) await Bun.sleep(20);
  }
  if (!ready) { child.kill("SIGTERM"); await child.exited; throw new Error(`serve did not start: ${await stderr}`); }
  return {
    origin: base,
    post: async (op: string, body: unknown, caller: Record<string, string> = { Authorization: `Bearer ${token}` }) => {
      const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { "Content-Type": "application/json", ...caller },
        body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      return `${response.status} ${clocks(await response.text(), dir)}`;
    },
    stop: async () => { child.kill("SIGTERM"); await child.exited; return (await stderr).split("\n").filter(line => /^native account\./.test(line)); },
  };
}

test.skipIf(!front)("HTTP callers reach the account-list bridge like the TypeScript core", async () => {
  const results: { bodies: string[]; markers: string[] }[] = [];
  for (const forward of [false, true]) {
    const server = await serve(home(), forward);
    const bodies = [await server.post("account.list", {}), await server.post("account.signin", { name: "ep" })];
    results.push({ bodies, markers: await server.stop() });
  }
  expect(results[0]!.bodies).toEqual(results[1]!.bodies);
  expect(results[0]!.bodies[0]).toStartWith("200 ");
  expect(results[0]!.markers).toEqual(["native account.list", "native account.signin"]);
  expect(results[1]!.markers).toEqual([]);
}, 120000);

// Recording stand-ins for every launcher a sign-in can reach. The test PATH puts them ahead of
// /usr/bin, so no real terminal, Orca or login starts, and none of them runs the login script.
function launchers(dir: string) {
  const log = join(dir, "launch.log");
  bin(dir, "tmux", `echo "tmux $*" >> '${log}'`);
  bin(dir, "open", `echo "open $*" >> '${log}'`);
  bin(dir, "orca", `echo "orca $*" >> '${log}'
case "$1" in
  status) echo '{"ok":true,"result":{"runtime":{"state":"ready","reachable":true}}}' ;;
  worktree) echo '{"ok":true,"result":{"worktree":{"id":"wt1"}}}' ;;
  terminal) echo '{"ok":true,"result":{"terminal":{"handle":"term1"}}}' ;;
  *) exit 1 ;;
esac`);
}
// Launch scripts, admission leases and built-in terminals get fresh UUIDs per call.
const ids = (text: string, dir: string) => clocks(text, dir).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
const launches = (dir: string) => { try { return ids(readFileSync(join(dir, "launch.log"), "utf8"), dir); } catch { return ""; } };
const TMUX = { TMUX: "/tmp/pacer-test-tmux,1,0" };
const GRANT = `pwg_${"0".repeat(64)}`;
const ADMITTED: [string, unknown][] = [
  ["account.signin", { name: "out", target: "tmux", request_id: UUID }],
  ["account.signin", { name: "work", target: "orca" }],
  ["account.signin", { name: "mail", target: "terminal" }],
  ["account.signin", { name: "claude" }],
  ["account.signin", { name: "linked", target: "auto" }],
];

test.skipIf(!front)("admitted account.signin requests reach the TypeScript core unchanged over stdio", async () => {
  const proxy = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/core-stdin-proxy.ts"), ...JSON.parse(core)]);
  const sent = requests(ADMITTED);
  const runs = [];
  for (const forward of [false, true]) {
    const dir = home();
    launchers(dir);
    const extra = { ...TMUX, PACER_CORE_ARGV: proxy, PACER_TEST_CORE_LOG: join(dir, "core-stdin.log") };
    const out = (await exchange(dir, sent, forward, extra, false)).map(line => ids(line, dir));
    const received = readFileSync(join(dir, "core-stdin.log"), "utf8").split("\n").filter(line => line.includes('"account.signin"'));
    runs.push({ out, received, launches: launches(dir).split("\n").filter(Boolean).sort() });
  }
  expect(runs[0]).toEqual(runs[1]);
  expect(runs[0]!.received).toEqual(sent);
  const results = runs[0]!.out.map(line => JSON.parse(line).result);
  expect(results.map(r => `${r.opened} ${r.target}`)).toEqual(["true tmux", "true orca", "true terminal", "true orca", "true orca"]);
  expect(results[0].command).toBe("CODEX_HOME='<home>/team'\\''s out' codex login");
  // The core runs the sign-ins concurrently; the terminal app is whatever this machine prefers.
  const opened = (title: string) => `orca terminal create --worktree id:wt1 --title Sign in to ${title} --command <home>/.pacer/terminal/<uuid>.sh --json`;
  expect(runs[0]!.launches.map(line => line.replace(/^open -a \S+ /, "open -a <app> "))).toEqual([
    "open -a <app> <home>/.pacer/terminal/<uuid>.sh", opened("claude"), opened("linked"), opened("work"),
    ...Array(3).fill("orca status --json"), ...Array(3).fill("orca worktree show --worktree active --json"),
    "tmux new-window <home>/.pacer/terminal/<uuid>.sh",
  ].sort());
}, 120000);

test.skipIf(!front)("admitted account.signin failures and executor callers match forced forwarding over stdio", async () => {
  const cases = requests([["account.signin", { name: "out", target: "tmux" }], ["account.signin", { name: "nope" }], ["account.signin", { name: "claude", target: "orca" }]]);
  // Executor callers keep every account op on the TypeScript core, which relays them to the
  // service over HTTP (a closed port here), refusals included.
  const callers: { caller: Record<string, string>; refused: string[]; codes: string[] }[] = [
    { caller: {}, refused: ["native account.signin 3"], codes: ["internal", "invalid_input", "internal"] },
    { caller: { PACER_ROLE: "executor", PACER_WORK_GRANT: GRANT }, refused: [], codes: ["internal", "internal", "internal"] },
  ];
  for (const { caller, refused, codes } of callers) {
    const runs = [];
    for (const forward of [false, true]) {
      const dir = home();
      launchers(dir);
      // The launcher folder is a file, so the core's admitted sign-in fails before any launch.
      writeFileSync(join(dir, ".pacer", "terminal"), "");
      runs.push({ out: await exchange(dir, cases, forward, { ...TMUX, ...caller }, forward ? false : refused), launches: launches(dir) });
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.launches).toBe("");
    expect(runs[0]!.out.map(line => JSON.parse(line).error?.data?.code)).toEqual(codes);
  }
}, 120000);

test.skipIf(!front)("admitted account.signin over HTTP keeps the caller's identity and matches forced forwarding", async () => {
  const session = "ab".repeat(32);
  const results = [];
  for (const forward of [false, true]) {
    const dir = home(), blocked = home();
    launchers(dir);
    launchers(blocked);
    writeFileSync(join(blocked, ".pacer", "terminal"), "");
    mkdirSync(join(dir, ".pacer", "app"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, ".pacer", "app", "sessions.json"), JSON.stringify([{ hash: createHash("sha256").update(session).digest("hex"), expiresAt: Date.now() / 1000 + 3600 }]) + "\n", { mode: 0o600 });
    const server = await serve(dir, forward, TMUX);
    const app = { Cookie: `pacer_session=${session}`, Origin: server.origin, "X-Pacer-Client": "app" };
    const task = { Authorization: `Bearer ${GRANT}` };
    const bodies = [
      await server.post("account.signin", { name: "out", target: "tmux", request_id: UUID }),
      await server.post("account.signin", { name: "work", target: "orca" }),
      await server.post("account.signin", { name: "work", target: "tmux", request_id: UUID }, app),
      await server.post("account.signin", { name: "nope" }, app),
      await server.post("account.signin", { name: "out", target: "tmux" }, task),
      await server.post("account.signin", { name: "nope" }, task),
    ].map(body => ids(body, dir));
    const markers = await server.stop();
    const failing = await serve(blocked, forward, TMUX);
    bodies.push(ids(await failing.post("account.signin", { name: "out", target: "tmux" }), blocked));
    results.push({ bodies, markers: [...markers, ...await failing.stop()], launches: [launches(dir), launches(blocked)] });
  }
  expect(results[0]!.bodies).toEqual(results[1]!.bodies);
  expect(results[0]!.launches).toEqual(results[1]!.launches);
  expect(results[1]!.markers).toEqual([]);
  // Only the app caller's unknown account is refused natively; the unregistered task grant is refused before any op runs.
  expect(results[0]!.markers).toEqual(["native account.signin"]);
  expect(results[0]!.bodies).toEqual([
    `200 {"result":{"opened":true,"target":"tmux","command":"CODEX_HOME='<home>/team'\\\\''s out' codex login"}}`,
    `200 {"result":{"opened":true,"target":"orca","command":"CODEX_HOME=<home>/.codex-work codex login"}}`,
    `200 {"result":{"opened":true,"target":"builtin","command":"codex login","terminalId":"<uuid>"}}`,
    `400 {"error":{"code":"invalid_input","message":"unknown account: nope"}}`,
    "403 forbidden\n",
    "403 forbidden\n",
    `500 {"error":{"code":"internal","message":"EEXIST: file already exists, mkdir '<home>/.pacer/terminal'"}}`,
  ]);
  expect(results[0]!.launches).toEqual([
    "tmux new-window <home>/.pacer/terminal/<uuid>.sh\norca status --json\norca worktree show --worktree active --json\n" +
      "orca terminal create --worktree id:wt1 --title Sign in to work --command <home>/.pacer/terminal/<uuid>.sh --json\n",
    "",
  ]);
}, 180000);
