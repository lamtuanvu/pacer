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
import { initialFixtureVersion, readOtaRecord, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { TAKEOVER_SCENARIOS, newExercise } from "./ota-exercise-record";
import { incarnationExited, privateFixtureBytes } from "./ota-exercise";
import { captureProblem } from "./capture-content";
import { attachFixtureTakeover, fixtureEnvironment, fixtureInstallation, fixtureTakeoverCli, inspectFixtureJobs, verifyFixtureBundle } from "./ota-native";
import { FIXTURE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
import { assertRealAppUnchanged, realAppNote, snapshotRealApp } from "./ota-real-app";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => Bun.sleep(ms);

async function shell(state: ReturnType<typeof readOtaRecord>, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { env: fixtureEnvironment(state), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw Error(`${args[0]} failed (${status}): ${stderr.slice(0, 500)}`);
  return stdout + stderr;
}

type ControlElement = { ref: string; role: string; name: string; value?: string; actions: string[]; focused?: boolean; disabled?: boolean };

/** The named clickable control, once it is present and not disabled (including aria-disabled). */
export function readyControl(elements: ControlElement[], name: string): ControlElement | null {
  return elements.find(element => element.name === name && element.actions.includes("click") && !element.disabled && !["heading", "static text"].includes(element.role.toLowerCase())) ?? null;
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
    return { window_id, elements: result.elements as ControlElement[] };
  }
  async function activate() {
    const window_id = await window();
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "activate" } });
  }
  async function key(key: string) {
    const window_id = await window();
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "activate" } });
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "key", key } });
  }
  async function texts() {
    const { elements } = await controls();
    return elements.flatMap(element => [element.name, element.value ?? ""]).filter(Boolean);
  }
  async function frame() {
    const window_id = await window();
    const result = await nativeCommand({ command: "capture", pid, start_identity: identity!.start_identity, window_id });
    return Buffer.from(result.png, "base64");
  }
  /** Writes a frame once it shows a rendered page in the expected theme; fails rather than record a blank one. */
  async function capture(path: string, theme: "light" | "dark", timeout = 15000) {
    let problem = "";
    const bytes = await waitFor(async () => {
      const bytes = await frame();
      problem = captureProblem(bytes, theme) ?? "";
      return problem ? null : bytes;
    }, timeout, "Capture did not show a rendered page").catch(error => { throw Error(`${String(error)}: ${problem}`); });
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  }
  async function click(name: string) {
    const window_id = await window();
    // Activating the window can start the page's confirm hold, so wait until
    // the control is enabled again after activation before clicking it.
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "activate" } });
    await sleep(300);
    let last: ControlElement[] = [];
    const item = await waitFor(async () => {
      last = (await controls()).elements;
      return readyControl(last, name);
    }, 5000, `Desktop control ${name} absent or disabled`).catch(() => {
      throw Error(`Desktop control ${name} absent or disabled: ${last.map(e => `${e.name}${e.disabled ? " (disabled)" : ""}`).filter(Boolean).slice(0, 30).join(", ")}`);
    });
    await nativeCommand({ command: "act", pid, start_identity: identity!.start_identity, window_id, action: { kind: "click", ref: item.ref } });
  }
  return { activate, controls, click, key, texts, frame, capture };
}

type Controls = Awaited<ReturnType<typeof desktopControls>>;
// Internal states and reason codes must never reach the page text.
const INTERNAL = /\b(prepared|stopping|switched|verifying|committed|recovery-failed)\b|[a-z-]+:(identity|unavailable|invalid|io|timeout|busy)\b|redetect|interrupted:/;

function hasText(texts: string[], text: string) { return texts.some(value => value.includes(text)); }

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
  // Fixture apps have their own identifier, so the installed app may keep running; prove it is untouched.
  const realApp = snapshotRealApp(enumerateNativeProcesses());
  await verifyFixtureBundle(state, initialFixtureVersion(state));
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
  const config = join(state.pacerHome, "Library/Application Support", FIXTURE_IDENTIFIERS.desktop);
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, "consent.json"), JSON.stringify({ at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), path: false, keep: false }), { flag: "wx", mode: 0o600 });
  const preserved = ["strategy.yaml", "token"].map(name => ({ name, hash: digest(privateFixtureBytes(join(state.pacerHome, name), 1048576)) }));
  // Each scenario fixes its theme, so light and dark captures are both covered.
  const theme = (["takeover", "takeover-dismiss", "takeover-crash"] as string[]).includes(scenario) ? "light" : "dark";
  const evidence = (name: string) => join(session.root, "evidence", name);
  const observed: Record<string, unknown> = { scenario, theme, originalPid: null, originalRegistration: null };
  const themeOf = (name: string) => name.includes("dark") ? "dark" as const : "light" as const;
  async function capture(ui: Controls, name: string, text: string) {
    try {
      await ui.capture(evidence(name), themeOf(name));
      record(session, { kind: "capture", behavior: `OTA ${scenario} ${text}`, surface: "native desktop", path: evidence(name), text: `${text}; rendered ${themeOf(name)} page (not blank)` });
    } catch (error) {
      record(session, { kind: "note", behavior: `OTA ${scenario} capture ${name}`, surface: "native desktop", verdict: "UNVERIFIED", text: String(error) });
    }
  }
  function launch(logName: string, desktopTheme: string): ProcessIdentity {
    writeFileSync(join(config, "theme.json"), JSON.stringify(desktopTheme), { mode: 0o600 });
    const log = openSync(evidence(logName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      // Settings → Updates is the first service page, so it can be checked after the offer.
      const child = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer"), "--pacer-relaunch-route=/settings/updates"], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
      child.unref();
      const identity = processIdentity(child.pid);
      if (!identity) throw Error("Desktop process identity unavailable");
      return identity;
    } finally { closeSync(log); }
  }
  async function offerShown(ui: Controls) {
    await ui.activate();
    let last: ControlElement[] = [];
    return waitFor(async () => {
      const seen = await ui.controls();
      last = seen.elements;
      return seen.elements.some(e => e.name === "Use the app's service" && e.role === "button") && seen.elements.some(e => e.name === "Not now" && e.role === "button") ? seen : null;
    }, 60000, "Takeover page did not precede the version gate").catch(error => { throw Error(`${String(error)}: ${JSON.stringify(last.map(e => [e.role, e.name]).slice(0, 50))}`); });
  }
  async function tabOrder(ui: Controls, name: string) {
    // Default macOS keyboard settings: Full Keyboard Access is not required.
    const order: string[] = [];
    for (let step = 0; step < 6; step++) {
      await ui.key("Tab");
      await sleep(200);
      // WebKit also marks the focused control's scroll area and web area as focused; report the control.
      const focused = (await ui.controls()).elements.filter(element => element.focused && !["AXWebArea", "AXScrollArea"].includes(element.role)).at(-1);
      order.push(focused ? `${focused.role}: ${focused.name}` : "none");
    }
    writeFileSync(evidence(name), JSON.stringify({ keys: "Tab x6", order }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const position = (text: string) => order.findIndex(entry => entry.endsWith(`: ${text}`));
    const [choice, confirm, dismiss] = [position("Also point the terminal command at the app"), position("Use the app's service"), position("Not now")];
    const passed = choice >= 0 && confirm > choice && dismiss > confirm;
    record(session, { kind: "note", behavior: `OTA ${scenario} offer keyboard order`, surface: "native desktop", verdict: passed ? "PASS" : "FAIL", text: `Tab order without Full Keyboard Access: ${order.join(" → ")}. VoiceOver WAIVED (VO-TEMP-2026-10), not tested.` });
    if (!passed) throw Error(`Takeover offer controls are not reachable in order by Tab: ${order.join(", ")}`);
  }
  async function settings(ui: Controls, name: string, takeover: boolean) {
    const texts = await waitFor(async () => {
      const seen = await ui.texts();
      const ready = takeover
        ? hasText(seen, "The pacer service was replaced by another build. Automatic updates are paused.") && hasText(seen, "Review service replacement")
        : hasText(seen, "Updates") && !hasText(seen, "Use the app's service");
      return ready ? seen : null;
    }, 60000, `Settings did not show the ${takeover ? "service replacement" : "committed"} state`);
    // The service page can report its text before WebKit paints it; wait for a
    // rendered frame in the expected theme and fail rather than record a blank one.
    await ui.capture(evidence(name), themeOf(name), 30000).catch(error => { throw Error(`Settings capture ${name}: ${String(error)}`); });
    record(session, { kind: "capture", behavior: `OTA ${scenario} Settings → Updates ${takeover ? "before replacement" : "after replacement"} (${themeOf(name)})`, surface: "native desktop", path: evidence(name), text: `rendered ${themeOf(name)} page (not blank, page area below the title bar)` });
    if (!takeover && (hasText(texts, "replaced by another build") || hasText(texts, "Review service replacement"))) throw Error("Settings still reports a replaced service after commit");
    return texts;
  }
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: { ...newExercise(scenario, driver, installationId), state: "running" }, runtime: { ...state.runtime!, state: "managed" } }, options);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).pid === originalProcess.pid ? true : null;
  }, 30000, "Takeover service did not become healthy");
  let desktop: ProcessIdentity | null = launch("native-desktop.log", theme);
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop } }, options);
  const ui = await desktopControls(desktop.pid);
  await offerShown(ui);
  await sleep(500);
  const offerTexts = await ui.texts();
  if (offerTexts.some(text => INTERNAL.test(text)) || hasText(offerTexts, "Starting pacer")) throw Error("Takeover offer shows internal text or the starting heading");
  // Paths may break at <wbr>, which accessibility can expose as separate text runs.
  const offerText = offerTexts.join("");
  if (!offerText.includes(fixtureTakeoverCli(state)) || !offerText.includes(join(state.currentApp, "Contents/Resources/pacer"))) throw Error("Takeover offer does not show both full executable paths");
  await capture(ui, `takeover-offer-${theme}.png`, `offer before the version gate (${theme})`);
  if (scenario === "takeover" || scenario === "takeover-dismiss") await tabOrder(ui, "takeover-offer-tab-order.json");
  observed.originalPid = originalProcess.pid;
  observed.originalRegistration = originalRegistration;
  record(session, { kind: "note", behavior: `OTA ${scenario} offer`, surface: "native desktop", verdict: "PASS", text: `Takeover choice was visible before the version gate with both full executable paths and no internal text; original service PID ${originalProcess.pid}, registration ${originalRegistration}; certificate-pinned lease rejected the ad hoc CLI.` });
  if (scenario === "takeover-dismiss") {
    await ui.click("Not now");
    await waitFor(async () => existsSync(join(config, "takeover-dismissed.json")) ? true : null, 10000, "Dismissal was not persisted");
    await settings(ui, "settings-before-light.png", true);
    // The Settings button opens the bundled confirmation again, even after Not now.
    await ui.click("Review service replacement");
    await offerShown(ui);
    record(session, { kind: "note", behavior: "OTA takeover-dismiss Settings review button", surface: "native desktop / service web app", verdict: "PASS", text: "Settings → Updates showed the replaced-service reason and Review service replacement; the button opened the bundled confirmation page." });
    await ui.click("Not now");
    await settings(ui, "settings-after-not-now-light.png", true);
    const dismissal = JSON.parse(readFileSync(join(config, "takeover-dismissed.json"), "utf8"));
    if (!/^[a-f0-9]{64}$/.test(dismissal.sha256) || !/^[a-f0-9]{40}$/.test(dismissal.cdhash)) throw Error("Dismissal identity is malformed");
    const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!sameProcess(jobs.jobs[0].process, originalProcess) || jobs.jobs[0].registrationSha256 !== originalRegistration) throw Error("Dismissal changed the service");
    if (!sameProcess(processIdentity(desktop.pid), desktop)) throw Error("Dismissed desktop incarnation changed");
    process.kill(desktop.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(desktop!) ? true : null, 10000, "Dismissed desktop did not exit");
    // The same executable identity is not offered again after a relaunch.
    const same = launch("native-desktop-same.log", "dark");
    state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop: same } }, options);
    const sameUi = await desktopControls(same.pid);
    await settings(sameUi, "settings-before-dark.png", true);
    if ((await sameUi.controls()).elements.some(e => e.name === "Use the app's service")) throw Error("Dismissed identity was offered again");
    record(session, { kind: "note", behavior: "OTA takeover-dismiss same identity", surface: "native desktop", verdict: "PASS", text: "After Not now, a relaunch with the same executable identity opened the service app directly; Settings still explained the replaced service." });
    process.kill(same.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(same) ? true : null, 10000, "Same-identity desktop did not exit");
    const helper = join(state.currentApp, "Contents/Resources/pacer-update-helper");
    JSON.parse(await shell(state, [helper, "--ota-fixture-refresh-takeover"]));
    if (digest(readFileSync(file)) === originalHash) throw Error("Fixed dismissal probe did not change the executable");
    const changed = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!changed.jobs[0].loaded || changed.jobs[0].registrationSha256 !== originalRegistration || sameProcess(changed.jobs[0].process, originalProcess)) throw Error("Changed service did not reload under the same registration");
    const relaunched = launch("native-desktop-reoffer.log", "dark");
    state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop: relaunched } }, options);
    const secondUi = await desktopControls(relaunched.pid);
    await offerShown(secondUi);
    await sleep(500);
    await capture(secondUi, "takeover-offer-dark.png", "re-offer for a changed executable (dark)");
    observed.dismissal = { sha256: dismissal.sha256, cdhash: dismissal.cdhash, reofferedAfterChange: true };
  } else {
    if (scenario === "takeover-relink") await ui.click("Also point the terminal command at the app");
    await ui.click("Use the app's service");
    const expected = scenario === "takeover" || scenario === "takeover-relink" ? "committed" : "restored";
    // Best effort: the switch may finish before the first frame is captured.
    const progressTexts = await ui.texts().catch(() => [] as string[]);
    await capture(ui, `takeover-progress-${theme}.png`, `progress after confirming (${theme})`);
    observed.progressText = progressTexts.filter(text => /service|Checking|Stopping|Starting|Restoring/.test(text)).slice(0, 6);
    if (progressTexts.some(text => INTERNAL.test(text))) throw Error("Takeover progress shows internal text");
    if (scenario === "takeover-crash") {
      // The helper exits after the switch. Until the recovery job finishes, the
      // desktop holds an in-progress page and leaves the service alone.
      await waitFor(async () => hasText(await ui.texts(), "Replacing the pacer service") ? true : null, 60000, "In-progress page was not shown after the helper exited");
      await capture(ui, "takeover-in-progress-light.png", "transaction in progress after a helper crash (light)");
    }
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
      await settings(ui, `settings-after-${theme}.png`, false);
      observed.relinked = scenario === "takeover-relink";
      observed.service = { executable: jobs.jobs[0].executable, registrationSha256: jobs.jobs[0].registrationSha256, ownership: "managed" };
    } else {
      if (!jobs.jobs[0].loaded || jobs.jobs[0].executable !== file || jobs.jobs[0].registrationSha256 !== originalRegistration || digest(readFileSync(file)) !== originalHash) throw Error("Original service was not restored");
      const restored = await waitFor(async () => {
        const seen = await ui.controls();
        return seen.elements.some(e => e.name === "Continue current service" && e.role === "button") ? seen : null;
      }, 60000, "Restored page did not appear");
      await sleep(500);
      const texts = restored.elements.flatMap(e => [e.name, e.value ?? ""]);
      if (!hasText(texts, "Kept your current service") || texts.some(text => INTERNAL.test(text))) throw Error("Restored page shows internal text or the wrong heading");
      await capture(ui, `takeover-restored-${theme}.png`, `restored outcome (${theme})`);
      observed.restoredText = texts.filter(text => /service/.test(text)).slice(0, 4);
      if (scenario === "takeover-crash") {
        // From the helper's exit until the restored outcome, the desktop must not
        // install, start or sign in to the service the recovery job owns.
        const log = readFileSync(evidence("native-desktop.log"), "utf8");
        const start = log.indexOf("service takeover failed");
        const end = log.indexOf("holding takeover page takeoverRestored", start);
        const pending = start < 0 ? "" : log.slice(start, end < 0 ? undefined : end);
        if (!pending.includes("holding takeover page takeoverProgress") || /automatic (install|start|restart) succeeded|desktop sign-in complete/.test(pending)) throw Error("Desktop acted on the service while the takeover transaction was pending");
        observed.pendingGate = "no install, start or sign-in while the transaction was pending";
      }
      await ui.click("Continue current service");
      await waitFor(async () => existsSync(join(config, "takeover-acknowledged.json")) ? true : null, 10000, "Continuing did not record the outcome");
      observed.continued = true;
    }
    observed.journal = { tx: result.tx, state: result.journal.state, error: result.journal.error, steps: result.journal.steps.map((step: any) => `${step.action.kind}:${step.outcome ?? (step.uncertain ? "uncertain" : "open")}`) };
  }
  if (scenario !== "takeover" && scenario !== "takeover-relink") {
    // The kept or restored service is the source-built CLI, which cannot ask
    // fixture desktops to exit during cleanup; end this driver's desktop here.
    const current = readOtaRecord(id, options).runtime!.desktop!;
    if (sameProcess(processIdentity(current.pid), current)) process.kill(current.pid, "SIGTERM");
    await waitFor(async () => incarnationExited(current) ? true : null, 10000, "Fixture desktop did not exit");
  }
  for (const item of preserved) if (digest(privateFixtureBytes(join(state.pacerHome, item.name), 1048576)) !== item.hash) throw Error(`User data changed: ${item.name}`);
  assertRealAppUnchanged(realApp, snapshotRealApp(enumerateNativeProcesses()));
  observed.realApp = realAppNote(realApp);
  state = readOtaRecord(id, options);
  updateOtaDriverRecord(id, state, { exercise: { ...state.exercise!, state: "complete" }, runtime: { ...state.runtime!, request: null } }, options);
  observed.preserved = preserved.map(item => item.name);
  writeFileSync(evidence("takeover-observed.json"), JSON.stringify(observed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service / journal", verdict: "PASS", text: `Observed: ${JSON.stringify(observed)}. VoiceOver WAIVED (VO-TEMP-2026-10), not tested.` });
}
