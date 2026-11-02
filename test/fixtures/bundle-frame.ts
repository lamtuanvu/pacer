/** Fixed, isolated bundle-stage exercise. Never executes SSH or invents a PID. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { Ctx } from "../../src/types";
import type { CallAuthority } from "../../src/plugins/authority";

const home = process.env.PACER_HOME;
assert(home && home === process.env.HOME && realpathSync(home) === home, "isolated fixture home required");
const entry = lstatSync(home);
assert(entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid?.() && !(entry.mode & 0o077));
const markerPath = join(home, ".bundle-frame-fixture");
const markerEntry = lstatSync(markerPath);
assert(markerEntry.isFile() && !markerEntry.isSymbolicLink() && markerEntry.nlink === 1 &&
  markerEntry.uid === entry.uid && !(markerEntry.mode & 0o077));
assert.equal(readFileSync(markerPath, "utf8"), "fixed bundle-stage fixture\n");
assert.equal(process.argv.length, 2, "fixture accepts no arguments");

interface Scheduled {
  executable: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  chunks: Buffer[];
  calls: number;
}
class OutputEvents extends EventEmitter {
  destroy(): void { this.emit("close"); }
}
let scheduled: Scheduled | undefined;
const originalChildProcess = { ...childProcess };
mock.module("node:child_process", () => ({
  ...originalChildProcess,
  spawn(executable: string, argv: string[], options: unknown) {
    assert(scheduled, "only the scheduled bundle child may be requested");
    const current = scheduled;
    assert.equal(++current.calls, 1);
    assert.equal(executable, current.executable);
    assert.deepEqual(argv, current.argv);
    assert.deepEqual(options, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: current.env });
    const stdout = new OutputEvents();
    const stderr = new OutputEvents();
    // An absent PID makes the production stop path incapable of signaling anything.
    const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: undefined, exitCode: null as number | null });
    queueMicrotask(() => {
      for (const chunk of current.chunks) stdout.emit("data", chunk);
      stdout.emit("end");
      stderr.emit("end");
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  },
}));

const { createCallAuthority } = await import("../../src/plugins/authority");
const { issueBundleStageResource, prepareBundleStageAuthority, stageBundle, resolveStagedBundle,
  transferStagedBundleOwnership, resolveTransferredBundle, discardTransferredBundle } = await import("../../src/plugins/bundle-stage");
const marker = Buffer.from("__PACER_BEGIN__\n");
const binary = Buffer.from([0xff, 0, 65]);
interface Case { name: string; chunks: Buffer[]; expected?: Buffer; error?: string; max?: number }
const cases: Case[] = [];
for (let split = 1; split < marker.length; split++) {
  cases.push({ name: `marker-split-${split}`, chunks: [marker.subarray(0, split), Buffer.concat([marker.subarray(split), binary])], expected: binary });
}
cases.push(
  { name: "bytewise", chunks: [...marker, ...binary].map(byte => Buffer.from([byte])), expected: binary },
  { name: "unsplit", chunks: [Buffer.concat([marker, binary])], expected: binary },
  { name: "banner-boundary", chunks: [Buffer.from("banner\n"), marker.subarray(0, 4), Buffer.concat([marker.subarray(4), binary])], expected: binary },
  { name: "midline-decoy", chunks: [Buffer.from("banner__PACER_BEGIN__\n"), marker, binary], expected: binary },
  { name: "false-prefix", chunks: [Buffer.from("__PAC"), Buffer.from("X__PACER_BEGIN__\n"), marker, binary], expected: binary },
  { name: "empty-chunks", chunks: [Buffer.alloc(0), marker.subarray(0, 2), Buffer.alloc(0), marker.subarray(2), binary], expected: binary },
  { name: "marker-in-payload", chunks: [marker, binary, marker], expected: Buffer.concat([binary, marker]) },
  { name: "empty-payload", chunks: [marker], expected: Buffer.alloc(0) },
  { name: "large-banner-small-bound", chunks: [Buffer.alloc(1024 * 1024, 120), Buffer.from("\n"), marker, Buffer.from("a")], expected: Buffer.from("a"), max: 1 },
  { name: "missing-marker", chunks: [Buffer.from("banner\n")], error: "plugin_refused" },
  { name: "partial-marker-eof", chunks: [marker.subarray(0, 6)], error: "plugin_refused" },
  { name: "crlf-marker", chunks: [Buffer.from("__PACER_BEGIN__\r\nabc")], error: "plugin_refused" },
  { name: "max-plus-one", chunks: [marker, Buffer.from("ab")], error: "too_large", max: 1 },
);
const results: Record<string, unknown>[] = [];
for (const [index, scenario] of cases.entries()) {
  const caseHome = join(home, `case-${index}`);
  mkdirSync(caseHome, { mode: 0o700 });
  const executable = join(caseHome, "ssh-fixture");
  writeFileSync(executable, "#!/bin/sh\nexit 99\n", { flag: "wx", mode: 0o700 });
  writeFileSync(join(caseHome, "strategy.yaml"), JSON.stringify({ planner: "claude-code", providers: { "claude-code": {} }, hosts: { box: { ssh: "never-contacted.invalid" } } }), { flag: "wx", mode: 0o600 });
  const ctx: Ctx = { home: caseHome, pacerHome: caseHome, now: 1, env: { HOME: caseHome, PACER_HOME: caseHome },
    which: name => name === "ssh" ? executable : null, run: async () => { throw Error("fixture cannot run commands"); } };
  // Real sshArgv may select its strict short directory. Require exclusive creation
  // and retain its identity; cleanup never recursively removes an external path.
  const normal = join(caseHome, "ssh");
  const control: string = Buffer.byteLength(join(normal, `cm-${"f".repeat(40)}`)) >= 104 && process.platform !== "win32"
    ? join("/tmp", `pacer-ssh-${process.getuid!()}-${createHash("sha256").update(caseHome).digest("hex").slice(0, 16)}`) : normal;
  assert(!existsSync(control), "fixture control directory must be new");
  let controlIdentity: Stats | undefined;
  const owners: CallAuthority[] = [];
  let result: Record<string, unknown> = { name: scenario.name, chunks: scenario.chunks.map(chunk => ({ bytes: chunk.length, sha256: createHash("sha256").update(chunk).digest("hex") })) };
  try {
    const issued = issueBundleStageResource(ctx, "box", ["~/fixture", "a".repeat(40), "pacer/fixture"], scenario.max ?? 64, 1000);
    controlIdentity = lstatSync(control);
    assert.equal(dirname(issued.argv.find(arg => arg.startsWith("ControlPath="))!.slice("ControlPath=".length)), control);
    const provider = createCallAuthority(ctx, { reads: [], commands: [], stores: [], bundleStages: [issued] }, { grants: ["process.spawn"], deadlineMs: Date.now() + 5000 });
    const caller = createCallAuthority(ctx, { reads: [], commands: [], stores: [] }, { grants: ["hosts"], deadlineMs: Date.now() + 5000 });
    owners.push(provider, caller);
    prepareBundleStageAuthority(provider);
    scheduled = { executable, argv: issued.argv.slice(1), env: ctx.env, chunks: scenario.chunks, calls: 0 };
    let staged: Awaited<ReturnType<typeof stageBundle>> | undefined, failure: unknown;
    try { staged = await stageBundle(provider, { argv: issued.argv, timeoutMs: issued.timeoutMs, maxBytes: issued.maxBytes }); }
    catch (error) { failure = error; }
    assert.equal(scheduled.calls, 1);
    if (scenario.error) {
      assert.equal((failure as { code?: string })?.code, scenario.error);
      assert.equal(staged, undefined);
      result = { ...result, rejection: scenario.error };
    } else {
      assert.ifError(failure);
      assert(staged && scenario.expected);
      assert.equal(staged.bytes, scenario.expected.length);
      assert.equal(staged.sha256, createHash("sha256").update(scenario.expected).digest("hex"));
      const path = resolveStagedBundle(provider, staged.handle).path;
      const ticket = transferStagedBundleOwnership(provider, staged.handle, caller);
      await provider.revoke();
      const claimed = resolveTransferredBundle(caller, ticket);
      assert.equal(claimed.path, path);
      assert.deepEqual(readFileSync(claimed.path), scenario.expected);
      assert.throws(() => resolveTransferredBundle(caller, ticket));
      discardTransferredBundle(caller, ticket);
      assert(!existsSync(path));
      result = { ...result, bytes: staged.bytes, sha256: staged.sha256 };
    }
    result = { ...result, passed: true };
  } catch (error) {
    result = { ...result, passed: false, failure: String(error) };
  } finally {
    scheduled = undefined;
    for (const owner of owners) await owner.revoke();
    assert.deepEqual(existsSync(join(caseHome, "transfers")) ? readdirSync(join(caseHome, "transfers")) : [], []);
    if (controlIdentity) {
      const current = lstatSync(control);
      assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === controlIdentity.dev && current.ino === controlIdentity.ino && current.uid === process.getuid?.() && !(current.mode & 0o077));
      rmdirSync(control);
    }
  }
  results.push({ ...result, cleanup: true });
}
console.log(JSON.stringify({ cases: results, failed: results.filter(row => !row.passed).length, childProcess: "simulated-no-pid", stageSourceSha256: createHash("sha256").update(readFileSync(new URL("../../src/plugins/bundle-stage.ts", import.meta.url))).digest("hex") }));
process.exitCode = results.some(row => !row.passed) ? 1 : 0;
