/** Fixed native takeover scenarios. The lease owns every path and service label. */
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpClient } from "../../src/api/http-client";
import { enumerateNativeProcesses } from "../../src/update/desktop/native-os";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { processIdentitySync } from "./control/lease";
import { nativeCommand } from "./control/desktop";
import { healthy, loadSession, record } from "./core";
import { readOtaRecord, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { TAKEOVER_SCENARIOS, newExercise } from "./ota-exercise-record";
import { incarnationExited, privateFixtureBytes } from "./ota-exercise";
import { attachFixtureTakeover, fixtureEnvironment, fixtureInstallation, fixtureTakeoverCli, inspectFixtureJobs, verifyFixtureBundle } from "./ota-native";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => Bun.sleep(ms);

async function shell(state: ReturnType<typeof readOtaRecord>, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { env: fixtureEnvironment(state), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw Error(`${args[0]} failed (${status}): ${stderr.slice(0, 500)}`);
  return stdout + stderr;
}

async function desktopControls(pid: number) {
  const identity = processIdentitySync(pid);
  if (!identity) throw Error("Desktop native identity unavailable");
  async function window() {
    const result = await nativeCommand({ command: "targets", pid, start_identity: identity!.start_identity });
    const target = result.windows.find((entry: any) => entry.title === "pacer") ?? result.windows[0];
    if (!target) throw Error("Desktop window unavailable");
    return target.window_id as string;
  }
  async function controls() {
    const window_id = await window();
    const result = await nativeCommand({ command: "inspect", pid, start_identity: identity!.start_identity, window_id });
    return { window_id, elements: result.elements as Array<{ref: string; role: string; name: string; value?: string; actions: string[]}> };
  }
  async function click(name: string) {
    const { window_id, elements } = await controls();
    const item = elements.find(element => element.name === name && element.actions.includes("click") && !["heading", "static text"].includes(element.role.toLowerCase()));
    if (!item) throw Error(`Desktop control ${name} absent: ${elements.map(e => e.name).filter(Boolean).slice(0, 30).join(", ")}`);
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "activate" } });
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "click", ref: item.ref } });
  }
  return { controls, click };
}

async function waitFor<T>(read: () => Promise<T | null>, timeout: number, message: string): Promise<T> {
  const end = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < end) {
    try { const value = await read(); if (value !== null) return value; }
    catch (error) { lastError = error; }
    await sleep(250);
  }
  throw Error(`${message}${lastError ? `: ${String(lastError)}` : ""}`);
}

function takeoverJournal(home: string): { tx: string; journal: any; manifest: any } | null {
  const root = join(home, "desktop-updates/native/takeover");
  if (!existsSync(root)) return null;
  const txs = readdirSync(root).filter(name => /^[A-Za-z0-9_-]{1,128}$/.test(name));
  if (txs.length !== 1) throw Error("Expected one takeover transaction");
  const directory = join(root, txs[0]);
  const journal = JSON.parse(privateFixtureBytes(join(directory, "takeover-journal.json"), 1048576).toString("utf8"));
  const manifestBytes = privateFixtureBytes(join(directory, "takeover-manifest.json"), 1048576);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (journal.transactionKind !== "takeover" || manifest.transactionKind !== "takeover" || journal.manifestSha256 !== digest(manifestBytes)) throw Error("Takeover journal is not bound to its manifest");
  return { tx: txs[0], journal, manifest };
}

export async function runTakeoverExercise(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(TAKEOVER_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unknown fixed takeover scenario");
  const session = loadSession(id, options.base), driver = ownProcessIdentity();
  let state = readOtaRecord(id, options);
  if (process.platform !== "darwin" || !driver || state.phase !== "prepared" || !state.nativeFixture?.signingCertSha1 || state.runtime || state.exercise || state.external.length !== 4 || session.stopped || !session.serviceIdentity || !sameProcess(session.serviceIdentity, processIdentity(session.pid))) throw Error("UNVERIFIED: fresh certificate-pinned takeover fixture required");
  if (enumerateNativeProcesses().some(item => item.executable === "/Applications/pacer.app/Contents/MacOS/pacer")) throw Error("UNVERIFIED: real desktop is running; fixture launch refused");
  const baseline = state.nativeFixture!.baselineVersion;
  await verifyFixtureBundle(state, baseline);
  const before = await inspectFixtureJobs(state);
  if (before.desktops.length || before.jobs.some(job => job.loaded || job.state !== "reserved")) throw Error("Fixture job already active");
  if (!await healthy(session)) throw Error("Guarded source service is unhealthy");
  state = updateOtaDriverRecord(id, state, { exercise: null, runtime: { schema: 1, driver, sourceService: session.serviceIdentity, desktop: null, state: "starting", request: null } }, options);
  process.kill(session.pid, "SIGTERM");
  await waitFor(async () => incarnationExited(session.serviceIdentity!) ? true : null, 10000, "Source service did not exit");
  const attached = await attachFixtureTakeover(readOtaRecord(id, options));
  const service = attached.jobs[0];
  const file = fixtureTakeoverCli(state);
  if (service.executable !== file || !service.loaded || !service.process || lstatSync(file).isSymbolicLink()) throw Error("Takeover binary was not registered as a regular file");
  const code = await shell(state, ["/usr/bin/codesign", "-dv", "--verbose=4", file]);
  if (!code.includes("Signature=adhoc")) throw Error("Takeover preflight did not prove an ad hoc signature");
  // The compiled attach mode has also asserted ReleaseTrust::verify_static rejects this file.
  const originalHash = digest(readFileSync(file));
  const installationId = fixtureInstallation(state, attached, state.nativeFixture!.candidateVersion, "attached").id;
  const originalRegistration = service.registrationSha256!;
  const originalProcess = service.process;
  const config = join(state.pacerHome, "Library/Application Support/dev.pacer.desktop");
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, "consent.json"), JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), path: false, keep: false }), { flag: "wx", mode: 0o600 });
  const preserved = ["strategy.yaml", "token"].map(name => ({ name, hash: digest(privateFixtureBytes(join(state.pacerHome, name), 1048576)) }));
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: { ...newExercise(scenario, driver, installationId), state: "running" }, runtime: { ...state.runtime!, state: "managed" } }, options);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).pid === originalProcess.pid ? true : null;
  }, 30000, "Takeover service did not become healthy");
  const log = openSync(join(session.root, "evidence/native-desktop.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let desktop: ProcessIdentity | null;
  try {
    const child = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer")], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
    child.unref(); desktop = processIdentity(child.pid);
  } finally { closeSync(log); }
  if (!desktop) throw Error("Desktop process identity unavailable");
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop } }, options);
  const ui = await desktopControls(desktop.pid);
  const offer = await waitFor(async () => {
    const observed = await ui.controls();
    return observed.elements.some(e => e.name === "Use the app's service") && observed.elements.some(e => e.name === "Not now") ? observed : null;
  }, 60000, "Takeover page did not precede the version gate");
  const nativeId = processIdentitySync(desktop.pid);
  if (nativeId) {
    try {
      const capture = await nativeCommand({ command: "capture", pid: desktop.pid, start_identity: nativeId.start_identity, window_id: offer.window_id });
      const path = join(session.root, "evidence/takeover-offer.png");
      writeFileSync(path, Buffer.from(capture.png, "base64"), { flag: "wx", mode: 0o600 });
      record(session, { kind: "capture", behavior: `OTA ${scenario} offer`, surface: "native desktop", path, text: "Takeover confirmation before version gate" });
    } catch (error) {
      record(session, { kind: "note", behavior: `OTA ${scenario} native capture`, surface: "native desktop", verdict: "UNVERIFIED", text: String(error) });
    }
  }
  record(session, { kind: "note", behavior: `OTA ${scenario} offer`, surface: "native desktop", verdict: "PASS", text: `Takeover choice was visible before the version gate; original service PID ${originalProcess.pid}, registration ${originalRegistration}; certificate-pinned lease rejected the ad hoc CLI.` });
  if (scenario === "takeover-dismiss") {
    await ui.click("Not now");
    await waitFor(async () => existsSync(join(config, "takeover-dismissed.json")) ? true : null, 10000, "Dismissal was not persisted");
    const dismissal = JSON.parse(readFileSync(join(config, "takeover-dismissed.json"), "utf8"));
    if (!/^[a-f0-9]{64}$/.test(dismissal.sha256) || !/^[a-f0-9]{40}$/.test(dismissal.cdhash)) throw Error("Dismissal identity is malformed");
    const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!sameProcess(jobs.jobs[0].process, originalProcess) || jobs.jobs[0].registrationSha256 !== originalRegistration) throw Error("Dismissal changed the service");
    if (!sameProcess(processIdentity(desktop.pid), desktop)) throw Error("Dismissed desktop incarnation changed");
    process.kill(desktop.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(desktop!) ? true : null, 10000, "Dismissed desktop did not exit");
    const helper = join(state.currentApp, "Contents/Resources/pacer-update-helper");
    JSON.parse(await shell(state, [helper, "--ota-fixture-refresh-takeover"]));
    if (digest(readFileSync(file)) === originalHash) throw Error("Fixed dismissal probe did not change the executable");
    const changed = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!changed.jobs[0].loaded || changed.jobs[0].registrationSha256 !== originalRegistration || sameProcess(changed.jobs[0].process, originalProcess)) throw Error("Changed service did not reload under the same registration");
    const secondLog = openSync(join(session.root, "evidence/native-desktop-reoffer.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let relaunched: ProcessIdentity | null;
    try {
      const child = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer")], { env: fixtureEnvironment(state), stdin: "ignore", stdout: secondLog, stderr: secondLog });
      child.unref(); relaunched = processIdentity(child.pid);
    } finally { closeSync(secondLog); }
    if (!relaunched) throw Error("Relaunched desktop identity unavailable");
    state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop: relaunched } }, options);
    const secondUi = await desktopControls(relaunched.pid);
    await waitFor(async () => {
      const observed = await secondUi.controls();
      return observed.elements.some(e => e.name === "Use the app's service") && observed.elements.some(e => e.name === "Not now") ? true : null;
    }, 60000, "Changed executable did not re-offer takeover");
  } else {
    if (scenario === "takeover-relink") await ui.click("Also point the terminal command at the app");
    await ui.click("Use the app's service");
    const expected = scenario === "takeover" || scenario === "takeover-relink" ? "committed" : "restored";
    const result = await waitFor(async () => {
      const tx = takeoverJournal(state.pacerHome);
      return tx?.journal.state === expected ? tx : null;
    }, 180000, `Takeover did not reach ${expected}`);
    state = readOtaRecord(id, options);
    if (result.manifest.candidate.registrationSha256 !== originalRegistration || result.manifest.candidate.process.pid !== originalProcess.pid) throw Error("Takeover authorization differs from original service");
    if (state.exercise?.faults.some(f => !f.consumed)) throw Error("Compiled takeover checkpoint was not consumed");
    const jobs = await inspectFixtureJobs(state);
    const bundled = join(state.currentApp, "Contents/Resources/pacer");
    if (expected === "committed") {
      if (jobs.jobs[0].executable !== bundled || !jobs.jobs[0].loaded || jobs.jobs[0].registrationSha256 === originalRegistration) throw Error("Bundled service did not survive takeover");
      const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
      const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 10000 });
      try { await waitFor(async () => { try { const snapshot = await client.snapshot(); return (snapshot.snapshot as any).desktopUpdates?.some((item: any) => item.ownership === "managed") ? true : null; } catch { return null; } }, 60000, "Managed OTA status unavailable"); }
      finally { client.close(); }
      if (scenario === "takeover-relink") {
        const backups = readdirSync(join(state.pacerHome, ".local/bin")).filter(name => /^pacer\.pre-app-\d{8}T\d{6}Z$/.test(name));
        if (backups.length !== 1 || digest(readFileSync(join(state.pacerHome, ".local/bin", backups[0]))) !== originalHash || readlinkSync(file) !== bundled) throw Error("Terminal command was not safely relinked");
      } else if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== originalHash) throw Error("Original terminal command changed");
    } else {
      if (!jobs.jobs[0].loaded || jobs.jobs[0].executable !== file || jobs.jobs[0].registrationSha256 !== originalRegistration || digest(readFileSync(file)) !== originalHash) throw Error("Original service was not restored");
    }
  }
  if (scenario !== "takeover" && scenario !== "takeover-relink") {
    // The kept or restored service is the source-built CLI, which cannot ask
    // fixture desktops to exit during cleanup; end this driver's desktop here.
    const current = readOtaRecord(id, options).runtime!.desktop!;
    if (sameProcess(processIdentity(current.pid), current)) process.kill(current.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(current) ? true : null, 10000, "Fixture desktop did not exit");
  }
  for (const item of preserved) if (digest(privateFixtureBytes(join(state.pacerHome, item.name), 1048576)) !== item.hash) throw Error(`User data changed: ${item.name}`);
  state = readOtaRecord(id, options);
  updateOtaDriverRecord(id, state, { exercise: { ...state.exercise!, state: "complete" }, runtime: { ...state.runtime!, request: null } }, options);
  record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service / journal", verdict: "PASS", text: "Verified fixed takeover outcome, fixture registration, terminal command and preserved user data. Native and VoiceOver presentation not separately audited." });
}
