/** Fixed own-link repair scenarios for a desktop-owned terminal-link registration. */
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpClient } from "../../src/api/http-client";
import { enumerateNativeProcesses } from "../../src/update/desktop/native-os";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { healthy, loadSession, record } from "./core";
import { exactFixtureExternal, initialFixtureVersion, readOtaRecord, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { OWN_LINK_SCENARIOS, newExercise } from "./ota-exercise-record";
import { incarnationExited, privateFixtureBytes } from "./ota-exercise";
import { attachFixtureOwnLink, fixtureEnvironment, fixtureInstallation, fixtureTakeoverCli, inspectFixtureJobs, verifyFixtureBundle } from "./ota-native";
import { FIXTURE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
import { assertRealAppUnchanged, realAppNote, snapshotRealApp } from "./ota-real-app";
import { desktopControls, waitFor } from "./ota-takeover";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export async function runOwnLinkExercise(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(OWN_LINK_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unknown fixed own-link scenario");
  const session = loadSession(id, options.base), driver = ownProcessIdentity();
  let state = readOtaRecord(id, options);
  if (process.platform !== "darwin" || !driver || state.phase !== "prepared" || !state.nativeFixture?.signingCertSha1 || state.runtime || state.exercise || !exactFixtureExternal(state) || session.stopped || !session.serviceIdentity || !sameProcess(session.serviceIdentity, processIdentity(session.pid))) throw Error("UNVERIFIED: fresh certificate-pinned own-link fixture required");
  const realApp = snapshotRealApp(enumerateNativeProcesses());
  const baseline = initialFixtureVersion(state);
  await verifyFixtureBundle(state, baseline);
  const before = await inspectFixtureJobs(state);
  if (before.desktops.length || before.jobs.some(job => job.loaded || job.state !== "reserved")) throw Error("Fixture job already active");
  if (!await healthy(session)) throw Error("Guarded source service is unhealthy");
  state = updateOtaDriverRecord(id, state, { exercise: null, runtime: { schema: 1, driver, sourceService: session.serviceIdentity, desktop: null, state: "starting", request: null } }, options);
  process.kill(session.pid, "SIGTERM");
  await waitFor(async () => incarnationExited(session.serviceIdentity!) ? true : null, 10000, "Source service did not exit");
  const attached = await attachFixtureOwnLink(readOtaRecord(id, options));
  const service = attached.jobs[0];
  const link = fixtureTakeoverCli(state);
  const bundled = join(state.currentApp, "Contents/Resources/pacer");
  if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== bundled) throw Error("Own-link seed did not create the app-owned symlink");
  if (!service.loaded || !service.process || service.executable !== link) throw Error("Own-link registration was not loaded naming the terminal link");
  const owner = JSON.parse(readFileSync(join(state.pacerHome, "owner.json"), "utf8"));
  if (owner.owner !== "desktop") throw Error("Own-link seed did not write owner=desktop");
  const originalRegistration = service.registrationSha256!;
  const originalProcess = service.process;
  const originalPlist = service.registrationText!;
  const installationId = fixtureInstallation(state, attached, state.nativeFixture!.candidateVersion, "attached").id;
  const config = join(state.pacerHome, "Library/Application Support", FIXTURE_IDENTIFIERS.desktop);
  mkdirSync(config, { recursive: true, mode: 0o700 });
  // Own-link repair does not ask; seed consent so the desktop connects without onboarding.
  writeFileSync(join(config, "consent.json"), JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), path: false, keep: false }), { flag: "wx", mode: 0o600 });
  const preserved = ["strategy.yaml", "token"].map(name => ({ name, hash: digest(privateFixtureBytes(join(state.pacerHome, name), 1048576)) }));
  const theme = "dark";
  const evidence = (name: string) => join(session.root, "evidence", name);
  writeFileSync(evidence("real-app-before.json"), JSON.stringify(realApp, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
  const observed: Record<string, unknown> = { scenario, theme, originalPid: originalProcess.pid, originalRegistration };
  function launch(logName: string): ProcessIdentity {
    writeFileSync(join(config, "theme.json"), JSON.stringify(theme), { mode: 0o600 });
    const log = openSync(evidence(logName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const child = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer"), "--pacer-relaunch-route=/settings/updates"], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
      child.unref();
      const identity = processIdentity(child.pid);
      if (!identity) throw Error("Desktop process identity unavailable");
      return identity;
    } finally { closeSync(log); }
  }
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: { ...newExercise(scenario, driver, installationId), state: "running" }, runtime: { ...state.runtime!, state: "managed" } }, options);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).pid === originalProcess.pid ? true : null;
  }, 30000, "Own-link service did not become healthy");
  const desktop = launch("native-desktop.log");
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop } }, options);
  const ui = await desktopControls(desktop.pid);
  await ui.activate();

  if (scenario === "own-link-repair") {
    await waitFor(async () => {
      const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
      return jobs.jobs[0].executable === bundled && jobs.jobs[0].loaded && jobs.jobs[0].registrationSha256 !== originalRegistration ? true : null;
    }, 180000, "Own-link registration was not rewritten to the bundled CLI");
    const log = readFileSync(evidence("native-desktop.log"), "utf8");
    const repairs = log.match(/own-link repair committed/g) ?? [];
    if (repairs.length !== 1) throw Error(`Expected one own-link repair commit, saw ${repairs.length}`);
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== bundled) throw Error("Own-link repair changed the terminal symlink");
    const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!jobs.jobs[0].process || jobs.jobs[0].executable !== bundled) throw Error("Repaired service is not the bundled CLI");
    const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
    const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 10000 });
    try {
      await waitFor(async () => {
        try { await client.snapshot(); return true; } catch { return null; }
      }, 60000, "Repaired service did not answer");
    } finally { client.close(); }
    // Settings should load after connect (not stuck on takeoverProgress).
    await waitFor(async () => {
      const texts = await ui.texts();
      return texts.some(value => value.toLowerCase() === "updates") ? true : null;
    }, 60000, "App did not reach Settings after own-link repair");
    observed.repaired = true;
    observed.registrationExecutable = bundled;
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service", verdict: "PASS", text: `Own-link registration rewritten once to the bundled CLI; link unchanged. Observed: ${JSON.stringify(observed)}` });
  } else {
    // own-link-repair-failure: compiled fault after bootout → restore
    await waitFor(async () => {
      const log = readFileSync(evidence("native-desktop.log"), "utf8");
      return /own-link repair failed after mutation/.test(log) ? true : null;
    }, 180000, "Own-link repair failure was not logged");
    state = readOtaRecord(id, options);
    if (state.exercise?.faults.some(f => !f.consumed)) throw Error("Compiled own-link-bootstrap checkpoint was not consumed");
    const jobs = await inspectFixtureJobs(state);
    if (!jobs.jobs[0].loaded || jobs.jobs[0].registrationSha256 !== originalRegistration || jobs.jobs[0].registrationText !== originalPlist) throw Error("Original own-link registration was not restored");
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== bundled) throw Error("Restore changed the terminal symlink");
    const log = readFileSync(evidence("native-desktop.log"), "utf8");
    if ((log.match(/own-link repair failed after mutation/g) ?? []).length !== 1) throw Error("Own-link repair retried after failure this launch");
    if (/holding takeover page takeoverProgress/.test(log) && !/holding takeover page (starting|connected)/.test(log)) {
      // Progress may flash; the window must leave it and connect.
    }
    await waitFor(async () => {
      const texts = await ui.texts();
      return texts.some(value => value.toLowerCase() === "updates") || texts.some(value => /starting|connected|home/i.test(value)) ? true : null;
    }, 60000, "App did not leave takeoverProgress after own-link restore");
    const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
    const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 10000 });
    try {
      await waitFor(async () => {
        try { await client.snapshot(); return true; } catch { return null; }
      }, 60000, "Restored own-link service did not answer");
    } finally { client.close(); }
    observed.restored = true;
    observed.forwardLogged = true;
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service", verdict: "PASS", text: `Own-link repair fault restored the original registration once. Observed: ${JSON.stringify(observed)}` });
  }

  if (scenario === "own-link-repair-failure") {
    const current = readOtaRecord(id, options).runtime!.desktop!;
    if (sameProcess(processIdentity(current.pid), current)) process.kill(current.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(current) ? true : null, 10000, "Fixture desktop did not exit");
  }
  for (const item of preserved) if (digest(privateFixtureBytes(join(state.pacerHome, item.name), 1048576)) !== item.hash) throw Error(`User data changed: ${item.name}`);
  const realAppAfter = snapshotRealApp(enumerateNativeProcesses());
  writeFileSync(evidence("real-app-after.json"), JSON.stringify(realAppAfter, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  assertRealAppUnchanged(realApp, realAppAfter);
  observed.realApp = realAppNote(realApp, realAppAfter);
  observed.preserved = preserved.map(item => item.name);
  state = readOtaRecord(id, options);
  updateOtaDriverRecord(id, state, { exercise: { ...state.exercise!, state: "complete" }, runtime: { ...state.runtime!, request: null } }, options);
  writeFileSync(evidence("own-link-observed.json"), JSON.stringify(observed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } finally {
    if (!existsSync(evidence("real-app-after.json"))) {
      writeFileSync(evidence("real-app-after.json"), JSON.stringify(snapshotRealApp(enumerateNativeProcesses()), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
}
