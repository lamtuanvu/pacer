import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { tmpDir } from "./helpers";
import { atomicWrite, readEvidence, saveSession, type Session } from "../scripts/live/core";
import { appDigest, cleanupOta, exerciseOta, prepareOta, readOtaRecord } from "../scripts/live/ota";
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
