import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { tmpDir } from "./helpers";
import { atomicWrite, readEvidence, saveSession, type Session } from "../scripts/live/core";
import { appDigest, cleanupOta, exerciseOta, prepareOta, readOtaRecord, recordOtaRegistrationIntent, observeOtaRegistration } from "../scripts/live/ota";
import { refusedOp } from "../scripts/live/proxy";
import { refusal } from "../scripts/live/guard";

const restoreSpies: (() => void)[] = [];
afterEach(() => { for (const restore of restoreSpies.splice(0).reverse()) restore(); });

function fixture() {
  const sourceRoot = realpathSync(tmpDir()), base = join(sourceRoot, "live"), root = join(base, "sandbox");
  for (const dir of [base, root, ...["home", "evidence", "bin", "logs", "repo"].map(p => join(root, p))]) mkdirSync(dir, { mode: 0o700 });
  const session: Session = { id: "sandbox", root, port: 49190, innerPort: 49191, pid: 12345, proxyPid: 12346, createdAt: new Date().toISOString() };
  saveSession(session);
  const from = join(sourceRoot, "old.app"), to = join(sourceRoot, "new.app");
  for (const [app, version] of [[from, "1"], [to, "2"]]) {
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true, mode: 0o700 });
    writeFileSync(join(app, "Contents/Info.plist"), version);
    writeFileSync(join(app, "Contents/MacOS/pacer"), "fixture executable " + version);
  }
  const realHome = join(sourceRoot, "real-home");
  const registration = join(realHome, "Library/LaunchAgents/com.pacer.serve.plist");
  mkdirSync(join(realHome, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(registration, "existing user registration");
  let managerCalls = 0;
  // Observe real process APIs; a manager call is a guard failure, not a mocked success.
  for (const [object, method] of [[Bun, "spawn"], [Bun, "spawnSync"], [childProcess, "spawn"], [childProcess, "spawnSync"], [childProcess, "execFile"], [childProcess, "execFileSync"]] as const) {
    const original = object[method as keyof typeof object] as (...args: any[]) => any;
    const spy = spyOn(object as any, method).mockImplementation((...args: any[]) => {
      const executable = typeof args[0] === "string" ? args[0] : Array.isArray(args[0]) ? args[0][0] : args[0]?.cmd?.[0];
      if (typeof executable === "string" && /(?:^|\/)(launchctl|systemctl)$/.test(executable)) { managerCalls++; throw Error("unexpected service-manager call"); }
      return Reflect.apply(original, object, args);
    });
    restoreSpies.push(() => spy.mockRestore());
  }
  const options = { base, sourceRoot, realHome, platform: "darwin" as const };
  return { sourceRoot, base, session, from, to, registration, options, calls: () => managerCalls };
}

for (const op of ["check", "download", "restart", "cancel", "configure", "adopt", "future"]) {
  test(`desktop OTA ${op} stays refused without native fixture authority`, () => {
    expect(refusedOp("POST", `/v3/ops/desktop.update.${op}`)).toBe(`desktop.update.${op}`);
    expect(refusal(["desktop-update", op])).toContain("D3");
  });
}
test("desktop OTA status remains readable", () => {
  expect(refusedOp("POST", "/v3/ops/desktop.update.status")).toBeUndefined();
  expect(refusal(["desktop-update", "status"])).toBeUndefined();
});

test("prepare and cleanup copy disposable apps, preserve inputs and real registration", async () => {
  const f = fixture();
  await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options);
  expect(state.phase).toBe("prepared");
  expect(state.nativeFixture).toBe(null);
  expect(state.serviceLabel).not.toBe("com.pacer.serve");
  expect(state.serviceLabel).not.toBe(state.recoveryLabel);
  expect(readFileSync(join(state.currentApp, "Contents/Info.plist"), "utf8")).toBe("1");
  expect(readFileSync(join(state.candidateApp, "Contents/Info.plist"), "utf8")).toBe("2");
  await cleanupOta(f.session.id, f.options);
  expect(existsSync(state.currentApp)).toBe(false);
  expect(existsSync(state.candidateApp)).toBe(false);
  expect(readFileSync(join(f.from, "Contents/Info.plist"), "utf8")).toBe("1");
  expect(readFileSync(f.registration, "utf8")).toBe("existing user registration");
  expect(readEvidence(f.session).some(e => e.behavior === "OTA fixture cleanup" && e.verdict === "PASS")).toBe(true);
  expect(f.calls()).toBe(0);
});

for (const mutation of ["port", "home", "label", "source-destination", "symlink", "missing-record", "unowned-registration"]) {
  test(`OTA refuses ${mutation} before manager calls`, async () => {
    const f = fixture();
    if (mutation === "port") {
      saveSession({ ...f.session, port: 4317 });
      await expect(prepareOta(f.session.id, f.from, f.to, f.options)).rejects.toThrow();
    } else if (mutation === "home") {
      rmSync(join(f.session.root, "home"), { recursive: true });
      symlinkSync(join(f.sourceRoot, "real-home"), join(f.session.root, "home"));
      await expect(prepareOta(f.session.id, f.from, f.to, f.options)).rejects.toThrow();
    } else if (mutation === "symlink") {
      symlinkSync(f.registration, join(f.from, "Contents/escape"));
      await expect(prepareOta(f.session.id, f.from, f.to, f.options)).rejects.toThrow();
    } else if (mutation === "missing-record") {
      await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
    } else {
      await prepareOta(f.session.id, f.from, f.to, f.options);
      const path = join(f.session.root, "ota/record.json"), state = JSON.parse(readFileSync(path, "utf8"));
      if (mutation === "label") state.serviceLabel = "com.pacer.serve";
      if (mutation === "source-destination") state.currentApp = f.from;
      if (mutation === "unowned-registration") state.registrations[0].path = f.registration;
      atomicWrite(path, JSON.stringify(state));
      await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
    }
    expect(readFileSync(f.registration, "utf8")).toBe("existing user registration");
    expect(f.calls()).toBe(0);
  });
}

test("unsupported scenarios and missing native fixture support never execute an arbitrary command", async () => {
  const f = fixture();
  await prepareOta(f.session.id, f.from, f.to, f.options);
  await expect(exerciseOta(f.session.id, "touch /tmp/escape", f.options)).rejects.toThrow("Unsupported");
  await expect(exerciseOta(f.session.id, "upgrade", f.options)).rejects.toThrow("UNVERIFIED");
  expect(readEvidence(f.session).at(-1)?.verdict).toBe("UNVERIFIED");
  expect(f.calls()).toBe(0);
});

test("OTA refuses symlinked live roots and missing sandbox records", async () => {
  const f = fixture(), linked = join(f.sourceRoot, "linked-live");
  symlinkSync(f.base, linked);
  await expect(prepareOta("sandbox", f.from, f.to, { ...f.options, base: linked })).rejects.toThrow("symlink");
  rmSync(join(f.session.root, "session.json"));
  await expect(prepareOta("sandbox", f.from, f.to, f.options)).rejects.toThrow();
  expect(f.calls()).toBe(0);
});

test("cleanup refuses swapped copies and unrecorded registration resources", async () => {
  const f = fixture();
  await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options);
  rmSync(state.currentApp, { recursive: true });
  symlinkSync(f.from, state.currentApp);
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
  expect(readFileSync(join(f.from, "Contents/Info.plist"), "utf8")).toBe("1");
  rmSync(state.currentApp);
  writeFileSync(state.registrations[0].path, "unproven registration");
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow("owner");
  expect(f.calls()).toBe(0);
});

test("source and registration changes prevent cleanup from claiming preservation", async () => {
  for (const target of ["source", "registration"]) {
    const f = fixture();
    await prepareOta(f.session.id, f.from, f.to, f.options);
    writeFileSync(target === "source" ? join(f.from, "Contents/Info.plist") : f.registration, "changed externally");
    await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
    expect(existsSync(join(f.session.root, "ota/candidate.app"))).toBe(true);
    expect(readEvidence(f.session).some(e => e.behavior === "OTA fixture cleanup" && e.verdict === "PASS")).toBe(false);
  }
});

test("cleanup remains idempotent after the sandbox stops", async () => {
  const f = fixture();
  await prepareOta(f.session.id, f.from, f.to, f.options);
  await cleanupOta(f.session.id, f.options);
  saveSession({ ...f.session, stopped: true });
  await cleanupOta(f.session.id, f.options);
  expect(readOtaRecord(f.session.id, f.options).phase).toBe("cleaned");
});

test("relative app framework links are preserved without modifying source bundles", async () => {
  const f = fixture();
  symlinkSync("MacOS/pacer", join(f.from, "Contents/Current"));
  await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options);
  expect(readFileSync(join(state.currentApp, "Contents/Current"), "utf8")).toBe("fixture executable 1");
  await expect(prepareOta(f.session.id, f.from, f.to, f.options)).rejects.toThrow();
  await cleanupOta(f.session.id, f.options);
  expect(readFileSync(join(f.from, "Contents/Current"), "utf8")).toBe("fixture executable 1");
});

test("planned recovery and ownership scenarios remain unavailable until native fixture integration", async () => {
  const f = fixture();
  await prepareOta(f.session.id, f.from, f.to, f.options);
  for (const scenario of ["upgrade", "startup-failure", "helper-crash", "interrupted-install", "restore-failure", "adopt", "adopt-failure", "attached", "wrong-service", "watcher-race"]) {
    await expect(exerciseOta(f.session.id, scenario, f.options)).rejects.toThrow("UNVERIFIED");
  }
  expect(f.calls()).toBe(0);
});


test("app fingerprints frame file contents so a file cannot impersonate another entry", () => {
  const f = fixture();
  writeFileSync(join(f.from, "Contents/Info.plist"), "same");
  writeFileSync(join(f.to, "Contents/Info.plist"), "same");
  writeFileSync(join(f.from, "Contents/MacOS/pacer"), 'x["Contents/MacOS/z",420]file:y');
  writeFileSync(join(f.to, "Contents/MacOS/pacer"), "x");
  writeFileSync(join(f.to, "Contents/MacOS/z"), "y");
  expect(appDigest(f.from)).not.toBe(appDigest(f.to));
});

test("registration intent and loaded ownership survive uncertain inspection and block cleanup", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options), label = state.serviceLabel;
  const plist = `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${state.currentApp}/Contents/MacOS/pacer</string><string>30</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${state.pacerHome}</string><key>PACER_HOME</key><string>${state.pacerHome}</string></dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/></dict></plist>`;
  recordOtaRegistrationIntent(f.session.id, label, plist, f.options);
  let current = readOtaRecord(f.session.id, f.options);
  expect(current.registrations[0].state).toBe("intent");
  expect(readFileSync(current.registrations[0].path, "utf8")).toBe(plist);
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow("active or uncertain");
  const child = {pid: 123456, bootId: "boot", birth: "100:1"};
  await observeOtaRegistration(f.session.id, label, "loaded", async expected => ({...expected, loaded:true, coverage:"complete", processes:[child], exited:[]}), f.options);
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow("active or uncertain");
  await expect(observeOtaRegistration(f.session.id, label, "retired", async expected => ({...expected, loaded:false, coverage:"unknown", processes:[], exited:[child]}), f.options)).rejects.toThrow();
  await expect(observeOtaRegistration(f.session.id, label, "retired", async expected => ({...expected, loaded:false, coverage:"complete", processes:[], exited:[]}), f.options)).rejects.toThrow();
  expect(readOtaRecord(f.session.id, f.options).registrations[0].state).toBe("loaded");
  await observeOtaRegistration(f.session.id, label, "retired", async expected => ({...expected, loaded:false, coverage:"complete", processes:[], exited:[child]}), f.options);
  await cleanupOta(f.session.id, f.options);
  expect(readOtaRecord(f.session.id, f.options).phase).toBe("cleaned");
  expect(f.calls()).toBe(0);
});

test("registration ledger rejects changed plist, real labels and paths outside fixture", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options), label = state.serviceLabel;
  const make = (name:string, program:string) => `<plist><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array><string>${program}</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>${state.pacerHome}</string></dict><key>KeepAlive</key><false/><key>RunAtLoad</key><true/></dict></plist>`;
  expect(() => recordOtaRegistrationIntent(f.session.id, "com.pacer.serve", make("com.pacer.serve", `${state.currentApp}/Contents/MacOS/pacer`), f.options)).toThrow();
  expect(() => recordOtaRegistrationIntent(f.session.id, label, make(label, "/bin/sleep"), f.options)).toThrow();
  recordOtaRegistrationIntent(f.session.id, label, make(label, `${state.currentApp}/Contents/MacOS/pacer`), f.options);
  expect(() => recordOtaRegistrationIntent(f.session.id, label, make(label, `${state.candidateApp}/Contents/MacOS/pacer`), f.options)).toThrow();
  writeFileSync(state.registrations[0].path, "changed");
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
  expect(existsSync(state.currentApp)).toBe(true);
  expect(f.calls()).toBe(0);
});

import { reserveOtaBuild, finishOtaBuild, otaFixturePolicy } from "../scripts/live/ota";

test("native build reserves exact immutable intent before compilation and finalizes once", async () => {
  const f = fixture(), state = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options);
  expect(state.phase).toBe("building");
  expect(state.sources.map(s => s.sha256)).toEqual([null, null]);
  expect(otaFixturePolicy(state).currentApp).toBe(state.currentApp);
  expect(state.nativeFixture?.buildRoot).toBe(join(state.root, "build"));
  expect(() => reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options)).toThrow();
  await expect(exerciseOta(f.session.id, "upgrade", f.options)).rejects.toThrow();
  for (const source of state.sources) {
    for (const dir of ["MacOS", "Resources", "Frameworks"]) mkdirSync(join(source.path, "Contents", dir), { recursive: true });
    writeFileSync(join(source.path, "Contents/Info.plist"), "fixture");
    writeFileSync(join(source.path, "Contents/Resources/pacer"), "fixture cli");
    writeFileSync(join(source.path, "Contents/Frameworks/libpacer-native.dylib"), "fixture shim");
  }
  const archive = Buffer.from("fixture archive"), feed = Buffer.from("fixture feed");
  finishOtaBuild(f.session.id, { archive, feed }, f.options);
  const staged = readOtaRecord(f.session.id, f.options);
  expect(staged.external.map(file => file.path)).toEqual([join(staged.root, "external/pacer"), join(staged.root, "external/libpacer-native.dylib")]);
  writeFileSync(join(staged.root, "external/extra"), "unrecorded");
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow();
  rmSync(join(staged.root, "external/extra"));
  readOtaRecord(f.session.id, f.options);
  const ready = readOtaRecord(f.session.id, f.options);
  expect(ready.phase).toBe("prepared");
  expect(ready.sources.every(source => source.sha256?.length === 64)).toBe(true);
  expect(ready.artifacts).toHaveLength(2);
  const feedPath = join(state.root, "feed/stable.json"), artifactPath = ready.artifacts.find(item => item.path.includes("/artifacts/"))!.path;
  writeFileSync(feedPath, "changed");
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow("changed");
  writeFileSync(feedPath, feed);
  rmSync(artifactPath);
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow("missing");
  writeFileSync(artifactPath, archive, { mode: 0o600 });
  expect(() => finishOtaBuild(f.session.id, { archive, feed }, f.options)).toThrow();
  expect(f.calls()).toBe(0);
  await cleanupOta(f.session.id, f.options);
  expect(existsSync(state.sources[0].path)).toBe(true);
  expect(existsSync(join(state.root, "feed"))).toBe(false);
});

for (const mutation of ["source", "build-root", "hash-phase", "artifact", "symlink"]) test(`native build refuses changed ${mutation}`, async () => {
  const f = fixture(), state = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options);
  if (mutation === "source") state.sources[0].path = f.from;
  if (mutation === "build-root") state.nativeFixture!.buildRoot = f.sourceRoot;
  if (mutation === "hash-phase") state.phase = "prepared";
  if (mutation === "artifact") writeFileSync(join(state.root, "unrecorded"), "foreign");
  if (mutation === "symlink") { rmSync(state.nativeFixture!.buildRoot, { recursive: true }); symlinkSync(f.sourceRoot, state.nativeFixture!.buildRoot); }
  atomicWrite(join(state.root, "record.json"), JSON.stringify(state));
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow();
  expect(f.calls()).toBe(0);
});

test("native fixture accepts only stable private known lock files", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options), locks = join(state.root, "locks");
  mkdirSync(locks, { mode: 0o700 });
  writeFileSync(join(locks, "ledger-lock"), "", { mode: 0o600 });
  expect(readOtaRecord(f.session.id, f.options).phase).toBe("prepared");
  writeFileSync(join(locks, "foreign"), "", { mode: 0o600 });
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow();
});

test("exercise markers cannot be attached to ordinary unsigned preparation", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const path = join(f.session.root, "ota/record.json"), state = JSON.parse(readFileSync(path, "utf8"));
  state.exercise = { schema: 1, scenario: "upgrade", state: "armed", driver: { pid: 42, bootId: "boot", birth: "birth" }, installationId: "a".repeat(64), transactionId: null, faults: [] };
  atomicWrite(path, JSON.stringify(state));
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow();
  expect(f.calls()).toBe(0);
});
test("prepared records default to no runtime or exercise authority", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options);
  expect((state as any).exercise).toBeNull(); expect((state as any).runtime).toBeNull();
});

test("native runtime ownership retains cleanup even when registration rows are empty", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const path = join(f.session.root, "ota/record.json"), state = JSON.parse(readFileSync(path, "utf8"));
  state.runtime = { schema: 1, driver: { pid: 42, bootId: "boot", birth: "birth" }, sourceService: { pid: 43, bootId: "boot", birth: "birth" }, desktop: null, state: "starting", request: null };
  atomicWrite(path, JSON.stringify(state));
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow();
  expect(existsSync(state.currentApp)).toBe(true); expect(f.calls()).toBe(0);
});

test.skipIf(process.platform !== "darwin")("changed fixture bundle refuses before executing a diagnostic", async () => {
  const f = fixture(); await prepareOta(f.session.id, f.from, f.to, f.options);
  const state = readOtaRecord(f.session.id, f.options);
  state.nativeFixture = { schema: 1, kind: "native-build", buildRoot: join(state.root, "build"), baselineVersion: "0.2.3", candidateVersion: "0.2.4", arch: "aarch64", updaterKeySha256: "b".repeat(64) };
  writeFileSync(join(state.currentApp, "Contents/MacOS/pacer"), "changed diagnostic");
  let calls = 0;
  const spy = spyOn(Bun, "spawn").mockImplementation(() => { calls++; throw Error("unexpected diagnostic execution"); });
  restoreSpies.push(() => spy.mockRestore());
  const { verifyFixtureBundle } = await import("../scripts/live/ota-native");
  await expect(verifyFixtureBundle(state, "0.2.3")).rejects.toThrow();
  expect(calls).toBe(0);
});

test("driver ledger CAS preserves native transaction consumption and rejects another incarnation", async () => {
  const { updateOtaDriverRecord } = await import("../scripts/live/ota");
  const { ownProcessIdentity } = await import("../src/update/desktop/process-identity");
  const { newExercise } = await import("../scripts/live/ota-exercise-record");
  const f = fixture(), build = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options);
  for (const source of build.sources) {
    for (const dir of ["MacOS", "Resources", "Frameworks"]) mkdirSync(join(source.path, "Contents", dir), { recursive: true });
    writeFileSync(join(source.path, "Contents/Info.plist"), "fixture");
    writeFileSync(join(source.path, "Contents/Resources/pacer"), "fixture cli");
    writeFileSync(join(source.path, "Contents/Frameworks/libpacer-native.dylib"), "fixture shim");
  }
  finishOtaBuild(f.session.id, { archive: Buffer.from("archive"), feed: Buffer.from("feed") }, f.options);
  const initial = readOtaRecord(f.session.id, f.options), driver = ownProcessIdentity()!;
  const runtime = { schema: 1 as const, driver, sourceService: driver, desktop: null, state: "starting" as const, request: null };
  expect(() => updateOtaDriverRecord(f.session.id, initial, { runtime: { ...runtime, driver: { ...driver, birth: "reused" } }, exercise: null }, f.options)).toThrow();
  const started = updateOtaDriverRecord(f.session.id, initial, { runtime, exercise: null }, f.options);
  expect(() => updateOtaDriverRecord(f.session.id, initial, { runtime, exercise: null }, f.options)).toThrow("changed");
  const bound = updateOtaDriverRecord(f.session.id, started, { runtime, exercise: { ...newExercise("upgrade", driver, "b".repeat(64)), state: "running" } }, f.options);
  expect(() => updateOtaDriverRecord(f.session.id, bound, { runtime, exercise: { ...bound.exercise!, transactionId: "invented" } }, f.options)).toThrow("immutable");
  await expect(cleanupOta(f.session.id, f.options)).rejects.toThrow("Unresolved");
  expect(f.calls()).toBe(0);
});

test("fixed cleanup diagnostic ledger binds files once without launching processes", async () => {
  const { recordOtaDiagnostics, replaceOtaDiagnostics } = await import("../scripts/live/ota");
  const { createHash } = await import("node:crypto");
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const f = fixture(), build = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options);
  for (const source of build.sources) {
    for (const dir of ["MacOS", "Resources", "Frameworks"]) mkdirSync(join(source.path, "Contents", dir), { recursive: true });
    writeFileSync(join(source.path, "Contents/Info.plist"), "fixture");
    writeFileSync(join(source.path, "Contents/Resources/pacer"), "fixture cli");
    writeFileSync(join(source.path, "Contents/Frameworks/libpacer-native.dylib"), "fixture shim");
  }
  finishOtaBuild(f.session.id, { archive: Buffer.from("archive"), feed: Buffer.from("feed") }, f.options);
  const initial = readOtaRecord(f.session.id, f.options), path = join(initial.root, "record.json");
  initial.runtime = { schema: 1, driver: { pid: 42, bootId: "boot", birth: "birth" }, sourceService: { pid: 43, bootId: "boot", birth: "birth" }, desktop: { pid: 44, bootId: "boot", birth: "birth" }, state: "starting", request: null };
  atomicWrite(path, JSON.stringify(initial));
  const stage = join(build.nativeFixture!.buildRoot, "diagnostics/stage");
  mkdirSync(stage, { mode: 0o700, recursive: true });
  const descriptor = { schema: 1 as const, policySha256: digest(JSON.stringify(otaFixturePolicy(initial))), cliSha256: digest("cli"), helperSha256: digest("helper") };
  writeFileSync(join(stage, "build.json"), JSON.stringify(descriptor), { mode: 0o600 });
  writeFileSync(join(stage, "pacer-startup-cleanup"), "cli", { mode: 0o700 });
  writeFileSync(join(stage, "pacer-update-helper"), "helper", { mode: 0o700 });
  recordOtaDiagnostics(f.session.id, descriptor, f.options);
  expect(readOtaRecord(f.session.id, f.options).diagnostics).toEqual(descriptor);
  expect(() => recordOtaDiagnostics(f.session.id, descriptor, f.options)).toThrow();
  if (process.platform === "darwin") {
    writeFileSync(join(build.nativeFixture!.buildRoot, "diagnostics/source-captured.json"), JSON.stringify({ sourceSha256: "f".repeat(64) }), { mode: 0o600 });
    mkdirSync(stage, { mode: 0o700 });
    const next = { ...descriptor, helperSha256: digest("new helper") };
    writeFileSync(join(stage, "build.json"), JSON.stringify(next), { mode: 0o600 });
    writeFileSync(join(stage, "pacer-startup-cleanup"), "cli", { mode: 0o700 });
    writeFileSync(join(stage, "pacer-update-helper"), "new helper", { mode: 0o700 });
    const recorded = readOtaRecord(f.session.id, f.options);
    recorded.diagnosticProcesses = [(await import("../src/update/desktop/process-identity")).ownProcessIdentity()!];
    atomicWrite(path, JSON.stringify(recorded));
    await expect(replaceOtaDiagnostics(f.session.id, next, f.options)).rejects.toThrow("Diagnostic process exit");
    expect(existsSync(join(initial.root, "diagnostics/pacer-update-helper"))).toBe(true);
    recorded.diagnosticProcesses = []; atomicWrite(path, JSON.stringify(recorded));
    await replaceOtaDiagnostics(f.session.id, next, f.options);
    const replaced = readOtaRecord(f.session.id, f.options);
    expect(replaced.diagnostics).toEqual(next);
    expect(replaced.diagnosticsHistory[0]).toEqual({ ...descriptor, path: join(build.nativeFixture!.buildRoot, "diagnostics/attempt-1"), sourceSha256: "f".repeat(64) });
    expect(readFileSync(join(build.nativeFixture!.buildRoot, "diagnostics/attempt-1/pacer-update-helper"), "utf8")).toBe("helper");
  }
  writeFileSync(join(initial.root, "diagnostics/pacer-startup-cleanup"), "changed");
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow("changed");
  expect(f.calls()).toBe(0);
});

test("paired initial layout fixes current to candidate and external to immutable bridge", async () => {
  const f = fixture();
  const state = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options, undefined, "paired");
  expect(state.initialLayout).toBe("paired");
  for (const [index, source] of state.sources.entries()) {
    for (const dir of ["MacOS", "Resources", "Frameworks"]) mkdirSync(join(source.path, "Contents", dir), { recursive: true });
    writeFileSync(join(source.path, "Contents/Info.plist"), "fixture " + index);
    writeFileSync(join(source.path, "Contents/Resources/pacer"), "cli " + index);
    writeFileSync(join(source.path, "Contents/Frameworks/libpacer-native.dylib"), "shim " + index);
  }
  finishOtaBuild(f.session.id, { archive: Buffer.from("archive"), feed: Buffer.from("feed") }, f.options);
  const ready = readOtaRecord(f.session.id, f.options);
  expect(appDigest(ready.currentApp)).toBe(ready.sources[1].sha256!);
  expect(appDigest(ready.candidateApp)).toBe(ready.sources[1].sha256!);
  expect(readFileSync(join(ready.root, "external/pacer"), "utf8")).toBe("cli 0");
  expect(readFileSync(join(ready.root, "external/libpacer-native.dylib"), "utf8")).toBe("shim 0");
  expect(otaFixturePolicy(ready)).not.toHaveProperty("initialLayout");
  expect(ready.nativeFixture).not.toHaveProperty("initialLayout");
  expect(() => reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options, undefined, "bridge")).toThrow();
  for (const scenario of ["upgrade", "attached", "startup-failure", "restore-failure"]) await expect(exerciseOta(f.session.id, scenario, f.options)).rejects.toThrow("Paired initial layout is only for adoption");
  const { runManagedExercise } = await import("../scripts/live/ota-exercise");
  const { runAttachedExercise } = await import("../scripts/live/ota-adoption");
  await expect(runManagedExercise(f.session.id, "upgrade", f.options)).rejects.toThrow("Paired initial layout is only for adoption");
  await expect(runAttachedExercise(f.session.id, "attached", f.options)).rejects.toThrow("Paired initial layout is only for adoption");
  expect(f.calls()).toBe(0);
});

test("initial layout defaults to bridge and unknown layout refuses before reserve", () => {
  const f = fixture();
  expect(() => reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options, undefined, "arbitrary" as any)).toThrow();
  expect(existsSync(join(f.session.root, "ota"))).toBe(false);
  expect(reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options).initialLayout).toBe("bridge");
});

test("fixture old-service choice is paired-only and bound to a compiled nonce", async () => {
  const { reserveOtaBuild, otaFixturePolicy } = await import("../scripts/live/ota");
  const f = fixture();
  expect(() => reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options, undefined, "bridge", true)).toThrow("paired layout");
  expect(existsSync(join(f.session.root, "ota"))).toBe(false);
  const state = reserveOtaBuild(f.session.id, "aarch64", "a".repeat(64), f.options, undefined, "paired", true);
  expect(state.oldServiceChoice).toBe("continue");
  expect(state.nonce.startsWith("f0a3c29e5c0d")).toBe(true);
  expect(Object.keys(state.nativeFixture!).sort()).toEqual(["arch", "baselineVersion", "buildRoot", "candidateVersion", "kind", "schema", "updaterKeySha256"].sort());
  expect(Object.keys(otaFixturePolicy(state)).sort()).toEqual(["currentApp", "home", "nonce", "port", "recoveryLabel", "root", "schema", "serviceLabel", "uid"].sort());
  const path = join(f.session.root, "ota/record.json"), changed = JSON.parse(readFileSync(path, "utf8"));
  delete changed.oldServiceChoice;
  atomicWrite(path, JSON.stringify(changed));
  expect(() => readOtaRecord(f.session.id, f.options)).toThrow("Fixture old-service choice differs from compiled nonce");
  expect(f.calls()).toBe(0);
});


test("runtime driver cannot request an initial layout change before any ownership query", async () => {
  const { updateOtaDriverRecord } = await import("../scripts/live/ota");
  expect(() => updateOtaDriverRecord("nonexistent", {} as any, { initialLayout: "paired" } as any)).toThrow("Initial layout is immutable");
});
