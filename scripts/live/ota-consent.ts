/** Fixed first-run consent / UseApp scenarios over an attached CLI service. */
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpClient } from "../../src/api/http-client";
import { enumerateNativeProcesses } from "../../src/update/desktop/native-os";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { healthy, loadSession, record } from "./core";
import { createTask, updateTask } from "../../src/tasks/store";
import { exactFixtureExternal, initialFixtureVersion, readOtaRecord, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { CONSENT_SCENARIOS, newExercise } from "./ota-exercise-record";
import { incarnationExited, privateFixtureBytes } from "./ota-exercise";
import { attachFixtureTakeover, fixtureEnvironment, fixtureInstallation, fixtureTakeoverCli, inspectFixtureJobs, verifyFixtureBundle } from "./ota-native";
import { FIXTURE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
import { assertRealAppUnchanged, realAppNote, snapshotRealApp } from "./ota-real-app";
import { desktopControls, hasAccessibilityText, settingsReady, takeoverJournal, waitFor } from "./ota-takeover";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms: number) => Bun.sleep(ms);

async function shell(state: ReturnType<typeof readOtaRecord>, args: string[]): Promise<string> {
  const child = Bun.spawn(args, { env: fixtureEnvironment(state), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw Error(`${args[0]} failed (${status}): ${stderr.slice(0, 500)}`);
  return stdout + stderr;
}

type Controls = Awaited<ReturnType<typeof desktopControls>>;

function seedQueuedHold(home: string): string {
  const ctx = { home, pacerHome: home, now: Date.now() / 1000, env: {} as Record<string, string>, which: () => null };
  const { id } = createTask(ctx as any, { brief: { goal: "consent-takeover busy hold", repo: home }, kind: "feature", requestedExecutor: null, timeoutS: 3600 });
  updateTask(ctx as any, id, record => {
    Object.assign(record, { state: "queued", title: "consent-takeover busy hold" });
  });
  return id;
}

function clearQueuedHold(home: string, id: string): void {
  const ctx = { home, pacerHome: home, now: Date.now() / 1000, env: {} as Record<string, string>, which: () => null };
  updateTask(ctx as any, id, record => {
    record.state = "done";
    record.settledAt = ctx.now;
    delete record.runnerPid;
  });
}

export async function runConsentExercise(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(CONSENT_SCENARIOS as readonly string[]).includes(scenario)) throw Error("Unknown fixed consent scenario");
  const session = loadSession(id, options.base), driver = ownProcessIdentity();
  let state = readOtaRecord(id, options);
  if (process.platform !== "darwin" || !driver || state.phase !== "prepared" || !state.nativeFixture?.signingCertSha1 || state.runtime || state.exercise || !exactFixtureExternal(state) || session.stopped || !session.serviceIdentity || !sameProcess(session.serviceIdentity, processIdentity(session.pid))) throw Error("UNVERIFIED: fresh certificate-pinned consent fixture required");
  const realApp = snapshotRealApp(enumerateNativeProcesses());
  const baseline = initialFixtureVersion(state);
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
  if (service.executable !== file || !service.loaded || !service.process || lstatSync(file).isSymbolicLink()) throw Error("Consent binary was not registered as a regular file");
  const code = await shell(state, ["/usr/bin/codesign", "-dv", "--verbose=4", file]);
  if (!code.includes("Signature=adhoc")) throw Error("Consent preflight did not prove an ad hoc signature");
  const originalHash = digest(readFileSync(file));
  const installationId = fixtureInstallation(state, attached, state.nativeFixture!.candidateVersion, "attached").id;
  const originalRegistration = service.registrationSha256!;
  const originalProcess = service.process;
  const config = join(state.pacerHome, "Library/Application Support", FIXTURE_IDENTIFIERS.desktop);
  mkdirSync(config, { recursive: true, mode: 0o700 });
  // Consent scenarios start with no consent.json and no owner.json.
  if (existsSync(join(config, "consent.json"))) throw Error("Consent must not be seeded for first-run scenarios");
  if (existsSync(join(state.pacerHome, "owner.json"))) throw Error("owner.json must not be seeded for first-run scenarios");
  const preserved = ["strategy.yaml", "token"].map(name => ({ name, hash: digest(privateFixtureBytes(join(state.pacerHome, name), 1048576)) }));
  const theme = scenario === "consent-plain-existing" ? "light" : "dark";
  const evidence = (name: string) => join(session.root, "evidence", name);
  writeFileSync(evidence("real-app-before.json"), JSON.stringify(realApp, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  let holdId: string | null = null;
  try {
  const observed: Record<string, unknown> = { scenario, theme, originalPid: originalProcess.pid, originalRegistration };
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
      const child = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer")], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
      child.unref();
      const identity = processIdentity(child.pid);
      if (!identity) throw Error("Desktop process identity unavailable");
      return identity;
    } finally { closeSync(log); }
  }
  async function pageShown(ui: Controls, button: string, label: string) {
    await ui.activate();
    let last: { role: string; name: string }[] = [];
    return waitFor(async () => {
      const seen = await ui.controls();
      last = seen.elements.map(e => ({ role: e.role, name: e.name }));
      return seen.elements.some(e => e.name === button && e.role === "button") ? seen : null;
    }, 60000, `${label} page did not appear`).catch(error => { throw Error(`${String(error)}: ${JSON.stringify(last.slice(0, 50))}`); });
  }
  async function settings(ui: Controls, name: string, takeover: boolean) {
    if (!takeover) {
      await ui.click("Settings");
      await ui.click("App preferences");
    }
    let last: string[] = [];
    let scrolls = 0;
    const texts = await waitFor(async () => {
      const seen = await ui.texts();
      last = seen;
      const ready = settingsReady(seen, takeover);
      if (!ready && !takeover && hasAccessibilityText(seen, "App preferences") && scrolls++ < 12) await ui.scroll(400);
      return ready ? seen : null;
    }, 60000, `Settings did not show the ${takeover ? "service replacement" : "committed"} state`).catch(async error => {
      try { writeFileSync(evidence("settings-timeout.png"), await ui.frame(), { flag: "wx", mode: 0o600 }); } catch {}
      throw Error(`${String(error)} (${last.length} accessibility strings): ${JSON.stringify(last.slice(-80))}`);
    });
    await ui.capture(evidence(name), themeOf(name), 30000).catch(error => { throw Error(`Settings capture ${name}: ${String(error)}`); });
    record(session, { kind: "capture", behavior: `OTA ${scenario} Settings → Updates`, surface: "native desktop", path: evidence(name), text: `rendered ${themeOf(name)} page` });
    return texts;
  }
  if (scenario === "consent-use-app-busy" || scenario === "consent-use-app-dismiss" || scenario === "consent-use-app-restart") {
    holdId = seedQueuedHold(state.pacerHome);
  }
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: { ...newExercise(scenario, driver, installationId), state: "running" }, runtime: { ...state.runtime!, state: "managed" } }, options);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).pid === originalProcess.pid ? true : null;
  }, 30000, "Consent service did not become healthy");
  let desktop: ProcessIdentity | null = launch("native-desktop.log", theme);
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop } }, options);
  const ui = await desktopControls(desktop.pid);
  await pageShown(ui, "Set up pacer", "Welcome");
  await capture(ui, `consent-welcome-${theme}.png`, `Welcome (${theme})`);
  await ui.click("Set up pacer");
  await pageShown(ui, "Agree and continue", "Consent");
  await capture(ui, `consent-consent-${theme}.png`, `Consent (${theme})`);
  await ui.click("Agree and continue");
  await pageShown(ui, "Use this app's pacer", "Existing");
  await capture(ui, `consent-existing-${theme}.png`, `Existing (${theme})`);
  record(session, { kind: "note", behavior: `OTA ${scenario} Existing page`, surface: "native desktop", verdict: "PASS", text: "Welcome → Consent → Existing reached with no consent seeded and the CLI still registered." });

  if (scenario === "consent-plain-existing") {
    await ui.click("Keep mine");
    await waitFor(async () => existsSync(join(config, "consent.json")) ? true : null, 10000, "Keep mine did not write consent");
    const consent = JSON.parse(readFileSync(join(config, "consent.json"), "utf8"));
    if (consent.keep !== true) throw Error("Keep mine did not record keep:true");
    if (!existsSync(join(config, "cli-choice.json"))) throw Error("Keep mine did not write cli-choice.json");
    if (takeoverJournal(state.pacerHome)) throw Error("Keep mine wrote a takeover journal");
    if (!lstatSync(file).isFile() || digest(readFileSync(file)) !== originalHash) throw Error("Keep mine changed the terminal command");
    const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
    if (!sameProcess(jobs.jobs[0].process, originalProcess) || jobs.jobs[0].registrationSha256 !== originalRegistration) throw Error("Keep mine changed the service");
    observed.kept = true;
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service", verdict: "PASS", text: "Plain Consent kept the Existing page; Keep mine wrote keep:true and left the CLI service untouched." });
  } else {
    // Snapshot command bytes before UseApp; keep sampling until commit.
    if (digest(readFileSync(file)) !== originalHash || lstatSync(file).isSymbolicLink()) {
      throw Error("Terminal command changed before UseApp");
    }
    await ui.click("Use this app's pacer");
    function linkStillOriginal(): boolean {
      return !lstatSync(file).isSymbolicLink() && digest(readFileSync(file)) === originalHash;
    }
    function assertNoEarlyRelink(when: string) {
      if (!linkStillOriginal()) throw Error(`UseApp relinked before the takeover committed (${when})`);
    }
    assertNoEarlyRelink("immediately after click");
    observed.noEarlyRelink = true;

    if (scenario === "consent-use-app-busy" || scenario === "consent-use-app-dismiss" || scenario === "consent-use-app-restart") {
      // App must stay usable while work is outstanding; no journal yet.
      const waited = await waitFor(async () => {
        if (!linkStillOriginal()) return "early-relink" as const;
        const log = readFileSync(evidence("native-desktop.log"), "utf8");
        return /consent takeover waiting for \d+ tasks \/ \d+ terminals/.test(log) ? true : null;
      }, 90000, "Consent takeover did not log a wait for busy work");
      if (waited === "early-relink") throw Error("UseApp relinked before the takeover committed (busy wait)");
      if (takeoverJournal(state.pacerHome)) throw Error("Takeover journal appeared while work was busy");
      assertNoEarlyRelink("after busy wait log");
      // Prove the web UI is reachable (Settings path) while waiting.
      await settings(ui, `settings-waiting-${theme}.png`, true).catch(async () => {
        // Settings → Updates may already be open after connect; fall through.
        const texts = await ui.texts();
        if (!hasAccessibilityText(texts, "Updates") && !hasAccessibilityText(texts, "Review service replacement")) {
          throw Error("App was not usable while consent takeover waited");
        }
      });
      observed.waitedWhileBusy = true;

      if (scenario === "consent-use-app-dismiss") {
        await settings(ui, `settings-before-dismiss-${theme}.png`, true);
        await ui.click("Review service replacement");
        await pageShown(ui, "Not now", "Takeover offer");
        await ui.click("Not now");
        await waitFor(async () => existsSync(join(config, "takeover-dismissed.json")) ? true : null, 10000, "Dismissal was not persisted");
        clearQueuedHold(state.pacerHome, holdId!);
        holdId = null;
        await sleep(25000); // watcher interval is 20 s
        assertNoEarlyRelink("dismiss idle settle");
        if (takeoverJournal(state.pacerHome)) throw Error("Dismissed UseApp still wrote a takeover journal after idle");
        const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
        if (!sameProcess(jobs.jobs[0].process, originalProcess) || jobs.jobs[0].registrationSha256 !== originalRegistration) throw Error("Dismissed UseApp changed the CLI service");
        observed.dismissed = true;
        record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service", verdict: "PASS", text: "Not now while a UseApp move was pending cancelled the automatic takeover; the CLI service remained." });
      } else if (scenario === "consent-use-app-restart") {
        process.kill(desktop.pid, "SIGTERM");
        await waitFor(async () => incarnationExited(desktop!) ? true : null, 10000, "Pending desktop did not exit");
        clearQueuedHold(state.pacerHome, holdId!);
        holdId = null;
        assertNoEarlyRelink("before relaunch");
        const relaunched = launch("native-desktop-relaunch.log", theme);
        state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: state.exercise, runtime: { ...state.runtime!, desktop: relaunched } }, options);
        desktop = relaunched;
        const next = await desktopControls(relaunched.pid);
        await pageShown(next, "Use the app's service", "Takeover offer after restart");
        await capture(next, `consent-offer-after-restart-${theme}.png`, "ADR 0011 offer after restart");
        assertNoEarlyRelink("after relaunch offer");
        if (takeoverJournal(state.pacerHome)) throw Error("Restart auto-committed a UseApp takeover");
        observed.reofferAfterRestart = true;
        record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop", verdict: "PASS", text: "Relaunch while a UseApp move was pending showed the normal ADR 0011 offer; no automatic move." });
      } else {
        clearQueuedHold(state.pacerHome, holdId!);
        holdId = null;
        const result = await waitFor(async () => {
          const tx = takeoverJournal(state.pacerHome);
          if (tx?.journal.state === "committed") return tx;
          if (!linkStillOriginal()) return "early-relink" as const;
          return null;
        }, 180000, "Consent takeover did not commit after idle");
        if (result === "early-relink") throw Error("UseApp relinked before the takeover committed (polling for commit after idle)");
        writeFileSync(evidence("takeover-journal.json"), JSON.stringify(result.journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        state = readOtaRecord(id, options);
        await assertCommitted(state, session, ui, file, originalHash, originalRegistration, observed, theme, evidence, settings);
        assertNoManagedInstallLoop(evidence("native-desktop.log"));
        record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service / journal", verdict: "PASS", text: `Busy UseApp deferred then committed. Observed: ${JSON.stringify(observed)}` });
      }
    } else {
      // consent-use-app: idle immediately → commit with relink
      const result = await waitFor(async () => {
        const tx = takeoverJournal(state.pacerHome);
        if (tx?.journal.state === "committed") return tx;
        if (!linkStillOriginal()) return "early-relink" as const;
        return null;
      }, 180000, "Consent UseApp takeover did not commit");
      if (result === "early-relink") throw Error("UseApp relinked before the takeover committed (polling for commit)");
      writeFileSync(evidence("takeover-journal.json"), JSON.stringify(result.journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      state = readOtaRecord(id, options);
      await assertCommitted(state, session, ui, file, originalHash, originalRegistration, observed, theme, evidence, settings);
      assertNoManagedInstallLoop(evidence("native-desktop.log"));
      record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "native desktop / service / journal", verdict: "PASS", text: `UseApp committed with relink-after-commit. Observed: ${JSON.stringify(observed)}` });
    }
  }

  if (scenario !== "consent-use-app" && scenario !== "consent-use-app-busy") {
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
  writeFileSync(evidence("consent-observed.json"), JSON.stringify(observed, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } finally {
    if (holdId) try { clearQueuedHold(state.pacerHome, holdId); } catch {}
    if (!existsSync(evidence("real-app-after.json"))) {
      writeFileSync(evidence("real-app-after.json"), JSON.stringify(snapshotRealApp(enumerateNativeProcesses()), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    }
  }
}

function assertNoManagedInstallLoop(logPath: string): void {
  const log = readFileSync(logPath, "utf8");
  if (
    /automatic install/.test(log)
    || /could not finish signing in/.test(log)
    || /managed service (install|start) refused/.test(log)
  ) {
    throw Error("UseApp still looped through managed install");
  }
}

async function assertCommitted(
  state: ReturnType<typeof readOtaRecord>,
  session: ReturnType<typeof loadSession>,
  ui: Controls,
  file: string,
  originalHash: string,
  originalRegistration: string,
  observed: Record<string, unknown>,
  theme: string,
  evidence: (name: string) => string,
  settings: (ui: Controls, name: string, takeover: boolean) => Promise<string[]>,
): Promise<void> {
  const jobs = await inspectFixtureJobs(state);
  const bundled = join(state.currentApp, "Contents/Resources/pacer");
  if (jobs.jobs[0].executable !== bundled || !jobs.jobs[0].loaded || jobs.jobs[0].registrationSha256 === originalRegistration) throw Error("Bundled service did not survive consent takeover");
  const owner = JSON.parse(readFileSync(join(state.pacerHome, "owner.json"), "utf8"));
  if (owner.owner !== "desktop") throw Error("owner.json was not desktop after UseApp");
  const backups = readdirSync(join(state.pacerHome, ".local/bin")).filter(name => /^pacer\.pre-app-\d{8}T\d{6}Z$/.test(name));
  if (backups.length !== 1 || digest(readFileSync(join(state.pacerHome, ".local/bin", backups[0]))) !== originalHash || readlinkSync(file) !== bundled) throw Error("Terminal command was not safely relinked after commit");
  const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
  const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 10000 });
  try {
    await waitFor(async () => {
      try {
        const snapshot = await client.snapshot();
        return (snapshot.snapshot as any).desktopUpdates?.some((item: any) => item.ownership === "managed") ? true : null;
      } catch { return null; }
    }, 60000, "Managed OTA status unavailable");
  } finally { client.close(); }
  await settings(ui, `settings-after-${theme}.png`, false);
  observed.relinked = true;
  observed.owner = "desktop";
  observed.service = { executable: jobs.jobs[0].executable, registrationSha256: jobs.jobs[0].registrationSha256, ownership: "managed" };
}
