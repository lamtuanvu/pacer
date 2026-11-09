import {afterAll, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {defaultRun} from "../src/ctx";
import {fakeCtx} from "./helpers";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const NOW = 1_700_000_000.5;
const mac = process.platform === "darwin";
const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, {recursive: true, force: true}); });

type Step = {op: string; params: unknown; env?: Record<string, string>};

/** The driver runs asynchronously so a loopback release feed served by this process can answer it. */
async function native(steps: Step[], home: string, path: string) {
  const input = steps.map(step => JSON.stringify({op: step.op, params: step.params, home, now: NOW, env: {PATH: path, ...step.env}})).join("\n") + "\n";
  const proc = Bun.spawn([driver()], {stdin: new Blob([input]), stdout: "pipe", env: {...process.env, PATH: path}});
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim().split("\n").map(line => JSON.parse(line));
}

/** TypeScript runs on one copy of the fixture home, the native driver on another; replies and the files they leave must match. */
async function compare(steps: Step[], setup: (home: string) => void, files: string[] = []) {
  const ts = realpathSync(mkdtempSync(join(tmpdir(), "native-svc-ts-"))), rs = realpathSync(mkdtempSync(join(tmpdir(), "native-svc-rs-")));
  homes.push(ts, rs);
  setup(ts);
  cpSync(ts, rs, {recursive: true});
  const path = (home: string) => `${home}/bin:/usr/bin:/bin`;
  const expected: unknown[] = [];
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = path(ts);
    for (const step of steps) {
      const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env: {PATH: path(ts), ...step.env}, run: defaultRun});
      try { expected.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { expected.push({error: toApiError(error)}); }
    }
  } finally { process.env.PATH = savedPath; }
  const actual = await native(steps, rs, path(rs));
  const label = JSON.stringify(steps).slice(0, 300);
  const normalize = (value: unknown, home: string) => JSON.stringify(value).replaceAll(home, "$HOME");
  expect(normalize(actual, rs), label).toBe(normalize(expected, ts));
  for (const file of [...files, "service.log"]) {
    const read = (home: string) => existsSync(join(home, file)) ? readFileSync(join(home, file), "utf8").replaceAll(home, "$HOME") : null;
    expect(read(rs), `${label}: ${file}`).toBe(read(ts));
  }
}

function fakeServiceManager(home: string, script: string) {
  mkdirSync(join(home, "bin"), {recursive: true});
  for (const name of ["launchctl", "systemctl"]) {
    writeFileSync(join(home, "bin", name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$(dirname "$0")/../service.log"\n${script}`);
    chmodSync(join(home, "bin", name), 0o755);
  }
}
const registration = (home: string) => mac ? join(home, "Library/LaunchAgents/com.pacer.serve.plist") : join(home, ".config/systemd/user/pacer-serve.service");
const installed = (home: string) => { mkdirSync(join(registration(home), ".."), {recursive: true}); writeFileSync(registration(home), "<plist/>"); };
const status = (env?: Record<string, string>): Step => ({op: "service.status", params: {}, env});

test("native service.status matches TypeScript service-manager probes", async () => {
  const running = mac ? "printf 'gui/1/com.pacer.serve = {\\n\\tstate = running\\n\\tpid = 4242\\n\\tlast exit code = 0\\n}\\n'"
    : "printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=4242\\nExecMainStatus=0\\n'";
  await compare([status()], home => { installed(home); fakeServiceManager(home, running); });
  await compare([status()], home => fakeServiceManager(home, "echo 'Could not find service' >&2; exit 113"));
  await compare([status()], home => { installed(home); fakeServiceManager(home, mac ? "printf '\\tpid = 0\\n'" : "printf 'ActiveState=active\\nSubState=running\\nMainPID=0x10\\n'"); });
  await compare([status()], home => { installed(home); fakeServiceManager(home, `${running}; exit 3`); });
  await compare([status()], home => { mkdirSync(registration(home), {recursive: true}); fakeServiceManager(home, mac ? "printf ' pid = -7 \\n'" : "printf 'garbage\\n'"); });
  await compare([
    {op: "service.status", params: null}, {op: "service.status", params: []}, {op: "service.status", params: "x"},
    {op: "service.status", params: {extra: 1}}, status({PACER_ENFORCEMENT_TOKEN: "t"}),
  ], home => fakeServiceManager(home, "exit 1"));
  await compare([status()], () => {});
}, 600_000);

const check = (params: unknown = {}, env?: Record<string, string>): Step => ({op: "update.check", params, env});
const feed = (home: string, body: string) => { mkdirSync(join(home, "feed"), {recursive: true}); writeFileSync(join(home, "feed/latest.json"), body); };
const fileBase = (step: Step, base: string): Step => ({...step, env: {PACER_RELEASE_BASE: base, ...step.env}});

test("native update.check matches TypeScript release-feed reads and the cache", async () => {
  // The feed directory is the same relative path in both homes, so each run's base points into its own copy.
  for (const body of ['{"version":"v999.0.0"}', '{"version":"0.0.1"}', "<html>", "", '{"version":2}', "[1]", '\uFEFF{"version":"999.1.0-rc.1"}']) {
    const ts: Step[] = [], setup = (home: string) => feed(home, body);
    ts.push(check(), check(), check({force: true}));
    await compareWithBase(ts, setup);
  }
  await compareWithBase([check(), check({force: true})], () => {});
  await compareWithBase([check(), check({force: true}, {PACER_NO_UPDATE_CHECK: "1"}), check({force: 1}), check([]), check(null), check({force: true}, {PACER_ENFORCEMENT_TOKEN: "t"})], home => feed(home, '{"version":"999.0.0"}'));
  await compareWithBase([check({force: true})], home => { feed(home, '{"version":"999.0.0"}'); writeFileSync(join(home, "strategy.yaml"), "planner: claude-code\nupdate_check: false # off\n"); });
  await compareWithBase([check({force: true})], home => { feed(home, '{"version":"999.0.0"}'); writeFileSync(join(home, "active"), " work \n"); mkdirSync(join(home, "strategies")); writeFileSync(join(home, "strategies/work.yaml"), "update_check:\n  false\n"); });
  for (const cache of [
    {checkedAt: NOW - 10, latest: "1.0.0", current: "x", error: "old"}, {checkedAt: NOW - 10, latest: null, current: "x", error: 0},
    {checkedAt: NOW - 90_000, latest: "998.0.0", current: "x"}, {checkedAt: NOW + 10, latest: "998.0.0", current: "x"},
    {checkedAt: "1", latest: "1.0.0"}, {checkedAt: NOW, latest: "nope"}, [1],
  ]) {
    await compareWithBase([check()], home => { feed(home, '{"version":"999.0.0"}'); writeFileSync(join(home, "update-check.json"), JSON.stringify(cache)); });
  }
}, 600_000);

/** Runs the steps with `PACER_RELEASE_BASE` pointing at each home's own feed directory. */
async function compareWithBase(steps: Step[], setup: (home: string) => void) {
  const ts = realpathSync(mkdtempSync(join(tmpdir(), "native-upd-ts-"))), rs = realpathSync(mkdtempSync(join(tmpdir(), "native-upd-rs-")));
  homes.push(ts, rs);
  setup(ts);
  cpSync(ts, rs, {recursive: true});
  const expected: unknown[] = [];
  for (const step of steps) {
    const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env: fileBase(step, `file://${ts}/feed`).env, run: defaultRun});
    try { expected.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { expected.push({error: toApiError(error)}); }
  }
  const actual = await native(steps.map(step => fileBase(step, `file://${rs}/feed`)), rs, "/usr/bin:/bin");
  const label = JSON.stringify(steps).slice(0, 300);
  expect(JSON.stringify(actual).replaceAll(rs, "$HOME"), label).toBe(JSON.stringify(expected).replaceAll(ts, "$HOME"));
  const cache = (home: string) => existsSync(join(home, "update-check.json")) ? readFileSync(join(home, "update-check.json"), "utf8").replaceAll(home, "$HOME") : null;
  expect(cache(rs), `${label}: cache`).toBe(cache(ts));
}

test("native update.check matches TypeScript loopback HTTP feeds", async () => {
  const big = "x".repeat(1024 * 1024 + 1);
  const server = Bun.serve({port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/ok/latest.json") return new Response('{"version":"999.0.0"}');
    if (path === "/missing/latest.json") return new Response("no", {status: 404});
    if (path === "/http-redirect/latest.json") return new Response(null, {status: 302, headers: {location: "/ok/latest.json"}});
    if (path === "/bare-redirect/latest.json") return new Response(null, {status: 302});
    if (path === "/big/latest.json") return new Response(big);
    return new Response("?", {status: 500});
  }});
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const steps = ["ok", "missing", "http-redirect", "bare-redirect", "big", "other"].map(dir => check({force: true}, {PACER_RELEASE_BASE: `${base}/${dir}`}));
    steps.push(check({force: true}, {PACER_RELEASE_BASE: "http://example.test"}), check({force: true}, {PACER_RELEASE_BASE: "https://u@example.test"}));
    const ts = realpathSync(mkdtempSync(join(tmpdir(), "native-upd-ts-"))), rs = realpathSync(mkdtempSync(join(tmpdir(), "native-upd-rs-")));
    homes.push(ts, rs);
    const expected: unknown[] = [];
    for (const step of steps) {
      const ctx = fakeCtx({pacerHome: ts, home: ts, now: NOW, env: step.env, run: defaultRun});
      try { expected.push({result: await callOp(ctx, step.op, step.params)}); } catch (error) { expected.push({error: toApiError(error)}); }
    }
    const actual = await native(steps, rs, "/usr/bin:/bin");
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
    expect(readFileSync(join(rs, "update-check.json"), "utf8")).toBe(readFileSync(join(ts, "update-check.json"), "utf8"));
  } finally { server.stop(true); }
}, 600_000);

test("an array cached latest keeps update.check forwarded", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "native-upd-")));
  homes.push(home);
  writeFileSync(join(home, "update-check.json"), JSON.stringify({checkedAt: NOW, latest: ["1.0.0"]}));
  expect(await native([check(), check({}, {PACER_NO_UPDATE_CHECK: "1"})], home, "/usr/bin:/bin")).toEqual([{forwarded: true}, {result: expect.objectContaining({disabled: true})}]);
}, 600_000);
