import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

// Synthetic collectors exercise the real resolver's ordering and refusal logic.
// They do not certify codesigning, the native job inspector, flock or live capture.
test.skipIf(process.platform !== "darwin")("fixed OTA collector rechecks authority without persisting lifecycle ownership", async () => {
  const root = realpathSync(tmpDir()), script = join(root, "resolver-probe.ts");
  const source = join(import.meta.dir, "../scripts/live");
  const native = join(import.meta.dir, "../src/update/desktop");
  await Bun.write(script, `
    import { mock } from "bun:test";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { realpathSync } from "node:fs";
import { join } from "node:path";
    import { fixture, hash } from ${JSON.stringify(join(import.meta.dir, "fixtures/live/ota-control-evidence.ts"))};
    const { readinessProofSchema } = await import(${JSON.stringify(join(native, "native-record.ts"))});
    let e, reads, locked, changed;
    const calls = [];
    const root = ${JSON.stringify(root)};
    const session = Object.freeze({ id: "fixture", root, port: 10101, innerPort: 10102, proxyPid: 999 });
    const setup = () => {
      e = fixture(); reads = 0; locked = false; changed = false; calls.length = 0;
      e.state.root = join(root, "ota"); e.state.currentApp = join(e.state.root, "current.app"); e.state.pacerHome = join(root, "home");
      e.state.sources = [{sha256: hash}, {sha256: hash}];
      e.transaction.command.target.appPath = e.state.currentApp; e.transaction.command.target.pacerHome = e.state.pacerHome;
      e.jobs.jobs[0].executable = join(e.state.currentApp, "Contents/Resources/pacer");
      e.processes[0].executable = join(e.state.currentApp, "Contents/MacOS/pacer");
      e.processes[1].executable = e.jobs.jobs[0].executable;
      mkdirSync(join(e.state.currentApp, "Contents/MacOS"), {recursive:true, mode:0o700});
      mkdirSync(e.state.pacerHome, {recursive:true, mode:0o700});
      writeFileSync(e.processes[0].executable, "synthetic nonsecret executable fixture", {mode:0o700});
      writeFileSync(join(e.state.pacerHome, "token"), "a".repeat(64), {mode:0o600});
    };
    mock.module(${JSON.stringify(join(source, "core.ts"))}, () => ({loadSession: () => session}));
    mock.module(${JSON.stringify(join(source, "ota.ts"))}, () => ({appDigest: () => hash, readOtaRecord: () => {
      if (!locked) throw Error("snapshot outside shared lock"); reads++;
      const state = structuredClone(e.state); if (changed && reads > 1) state.nonce = "changed"; return state;
    }}));
    mock.module(${JSON.stringify(join(source, "ota-lock.ts"))}, () => ({withOtaLedgerLock: (_root, callback) => {
      if (locked) throw Error("nested lock"); locked = true; try { return callback(); } finally { locked = false; }
    }}));
    mock.module(${JSON.stringify(join(native, "native-record.ts"))}, () => ({readinessProofSchema, readNativeTransaction: () => structuredClone(e.transaction)}));
    mock.module(${JSON.stringify(join(source, "ota-native.ts"))}, () => ({
      fixtureEnvironment: () => ({}), fixtureInstallation: () => ({id: hash}),
      verifyFixtureBundle: async (_state, version) => { if (locked) throw Error("inspector lock conflict"); calls.push("bundle:"+version); },
      inspectFixtureJobs: async (_state, retire) => { if (locked || retire !== false) throw Error("mutating or locked inspector"); calls.push("inspect:false"); return e.jobs; },
    }));
    mock.module(${JSON.stringify(join(native, "native-os.ts"))}, () => ({enumerateNativeProcesses: () => e.processes}));
    mock.module(${JSON.stringify(join(source, "control/lease.ts"))}, () => ({processIdentity: async () => e.identity, sameProcess: async () => true}));
    globalThis.fetch = async (input) => {
      calls.push("fetch"); const url = new URL(String(input));
      const body = url.pathname === "/__live/health" ? {pid:999} : url.pathname === "/health" ? {pid:4322} :
        {result:url.pathname.endsWith("client.list") ? e.clients : e.captures};
      return new Response(JSON.stringify(body), {headers:{"x-pacer":"1","x-pacer-live-proxy":"1"}});
    };
    const { resolveDesktopControlBinding } = await import(${JSON.stringify(join(source, "control/ota-binding.ts"))});
    const results = [];
    setup(); const before = JSON.stringify(session);
    const binding = await resolveDesktopControlBinding(session);
    results.push(binding.source === "ota" && binding.identity.pid === 4321 && reads === 2 && calls[0] === "bundle:0.2.4" && calls[1] === "inspect:false" && JSON.stringify(session) === before && !Object.hasOwn(session,"desktopPid"));
    for (const mutate of [
      () => e.state.exercise.state = "running", () => e.state.exercise.state = "failed", () => e.state.runtime.request = {},
      () => e.transaction.record.phase = "installing", () => e.transaction.journal.state = "restored",
    ]) {
      setup(); mutate(); let refused = false;
      try { await resolveDesktopControlBinding(session); } catch { refused = true; }
      results.push(refused && calls.length === 0);
    }
    setup(); changed = true; let refused = false;
    try { await resolveDesktopControlBinding(session); } catch { refused = true; }
    results.push(refused && reads === 2);
    console.log(JSON.stringify(results));
  `);
  const child = Bun.spawn([process.execPath, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual(Array(7).fill(true));
});
