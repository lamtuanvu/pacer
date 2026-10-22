import { prepareManualCandidate } from "./ota-candidate";
/** Fixed live managed-update scenarios. Every update write crosses the guarded public API. */
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HttpClient } from "../../src/api/http-client";
import type { SnapshotV3 } from "../../src/api/read-model/types";
import type { UpdateStatus } from "../../src/update/desktop/types";
import { enumerateNativeProcesses } from "../../src/update/desktop/native-os";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { healthy, loadSession, record } from "./core";
import { recordOtaEvent } from "./ota-evidence";
import { readOtaRecord, resumeOtaStartup, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { MANAGED_SCENARIOS, newExercise, resumableStartup } from "./ota-exercise-record";
import { verifyExerciseOutcome, verifyExerciseSurvivors } from "./ota-outcome";
import { fixtureRequest, retryFixtureRevision } from "./ota-request";
import { fixtureEnvironment, fixtureInstallation, inspectFixtureJobs, seedFixtureConsent, verifyFixtureBundle } from "./ota-native";
import { makeCtx } from "../../src/ctx";
import { hasReservation } from "../../src/update/desktop/admission";
import { readNativeTransaction } from "../../src/update/desktop/native-record";

export function incarnationExited(expected: ProcessIdentity): boolean {
  const current = processIdentity(expected.pid);
  if (current) return !sameProcess(current, expected);
  try { process.kill(expected.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export function privateFixtureBytes(path: string, limit: number): Buffer {
  if (realpathSync(path) !== path) throw Error("Fixture evidence path is not canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > limit) throw Error("Fixture evidence is not private and bounded");
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw Error("Fixture evidence exceeds limit");
    return bytes;
  } finally { closeSync(fd); }
}
export async function runManagedExercise(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(MANAGED_SCENARIOS as readonly string[]).includes(scenario)) throw Error("UNVERIFIED: this fixed scenario has no native exercise driver");
  const session = loadSession(id, options.base), driver = ownProcessIdentity();
  let state = readOtaRecord(id, options);
  const resuming = resumableStartup(state.runtime, state.exercise, incarnationExited);
  if (process.platform !== "darwin" || !driver || !state.nativeFixture || state.phase !== "prepared" || (state.runtime && !resuming) || state.exercise || session.stopped || !session.serviceIdentity || (!resuming && !sameProcess(session.serviceIdentity, processIdentity(session.pid)))) throw Error("UNVERIFIED: fresh native fixture and exact source service ownership required");
  await verifyFixtureBundle(state, state.nativeFixture.baselineVersion);
  const before = await inspectFixtureJobs(state);
  if (resuming) {
    if (before.desktops.length || before.jobs[1].loaded || before.jobs[1].state !== "reserved") throw Error("Startup has unexpected native participants");
    fixtureInstallation(state, before, state.nativeFixture.baselineVersion, "managed");
    state = await resumeOtaStartup(id, state, options);
  } else {
    if (before.jobs.some(job => job.loaded || job.state !== "reserved")) throw Error("Fixture registration is already active or uncertain");
    const source = enumerateNativeProcesses().find(item => sameProcess(item.process, session.serviceIdentity!));
    if (!source || source.executable !== realpathSync(process.execPath) || !await healthy(session)) throw Error("Source service identity or guarded ports changed");
    state = updateOtaDriverRecord(id, state, { exercise: null, runtime: { schema: 1, driver, sourceService: session.serviceIdentity, desktop: null, state: "starting", request: null } }, options);
    // Exact recorded incarnation is rechecked immediately before this one signal.
    if (!sameProcess(processIdentity(session.pid), session.serviceIdentity)) throw Error("Source service changed before handoff");
    process.kill(session.pid, "SIGTERM");
    const stopDeadline = Date.now() + 10000;
    while (!incarnationExited(session.serviceIdentity) && Date.now() < stopDeadline) await Bun.sleep(100);
    if (!incarnationExited(session.serviceIdentity)) throw Error("Source service exit unproven; fixture retained");
  }
  const log = openSync(join(session.root, resuming ? `evidence/native-desktop-retry-${driver.pid}.log` : "evidence/native-desktop.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let launched: ProcessIdentity | null;
  try {
    seedFixtureConsent(state);
    const desktop = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer")], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
    launched = processIdentity(desktop.pid);
  } finally { closeSync(log); }
  if (!launched) throw Error("Launched desktop incarnation unavailable; fixture retained");
  state = updateOtaDriverRecord(id, state, { exercise: null, runtime: { ...state.runtime!, desktop: launched } }, options);
  const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
  const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 30000 });
  let unsubscribe = () => {};
  let journalTrace: ReturnType<typeof setInterval> | undefined;
  let journalTraceFd: number | undefined;
  try {
    let installationId: string | undefined;
    let lastBaselineObservation = "No native baseline observed";
    const readyDeadline = Date.now() + 60000;
    while (Date.now() < readyDeadline) {
      try {
        const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
        const installation = fixtureInstallation(state, jobs, state.nativeFixture!.baselineVersion, "managed");
        const snapshot = await client.snapshot();
        const status = (snapshot.snapshot as unknown as SnapshotV3).desktopUpdates?.find(item => item.installationId === installation.id);
        lastBaselineObservation = status
          ? `phase=${status.phase}, ownership=${status.ownership}, version=${status.current}, actions=${status.actions.join(",")}`
          : "Verified native installation is missing from the service snapshot";
        if (status?.ownership === "managed" && status.current === state.nativeFixture!.baselineVersion && status.actions.includes("check")) { installationId = installation.id; break; }
      } catch (error) {
        // Retain bounded diagnostic evidence; observation failure grants no work.
        lastBaselineObservation = error instanceof Error ? error.message.slice(0, 1024) : "Native baseline observation failed";
      }
      await Bun.sleep(250);
    }
    if (!installationId) throw Error(`Native managed baseline did not become provable: ${lastBaselineObservation}`);
    const preserved = ["strategy.yaml", "token"].map(name => ({ name, sha256: createHash("sha256").update(privateFixtureBytes(join(state.pacerHome, name), 1048576)).digest("hex") }));
    state = readOtaRecord(id, options);
    state = updateOtaDriverRecord(id, state, { runtime: { ...state.runtime!, state: "managed" }, exercise: { ...newExercise(scenario, driver, installationId), state: "running" } }, options);
    const initial = await client.snapshot();
    unsubscribe = client.subscribe(initial.seq, event => {
      recordOtaEvent(session, scenario, event);
    });
    async function status(): Promise<UpdateStatus> { return client.call("desktop.update.status", { installationId }); }
    async function mutate(action: "check" | "download" | "restart" | "configure", extra: Record<string, unknown> = {}): Promise<void> {
      const clearRequest = () => {
        const latest = readOtaRecord(id, options);
        updateOtaDriverRecord(id, latest, { exercise: latest.exercise, runtime: { ...latest.runtime!, request: null } }, options);
      };
      await retryFixtureRevision(async () => {
        const current = await status(), params = { installationId, requestId: `fixture-${randomUUID()}`, expectRevision: current.revision, ...extra }, op = `desktop.update.${action}`;
        let latest = readOtaRecord(id, options);
        latest = updateOtaDriverRecord(id, latest, { exercise: latest.exercise, runtime: { ...latest.runtime!, request: fixtureRequest(op, params) } }, options);
        await client.call(op, params); // A lost response leaves exact request evidence intact.
        clearRequest();
      }, clearRequest, action === "restart" ? async () => { await waitStatus(value => value.actions.includes("restart"), 60000); } : undefined);
    }
    async function waitStatus(predicate: (status: UpdateStatus) => boolean, timeout: number): Promise<UpdateStatus> {
      const end = Date.now() + timeout; let last: UpdateStatus | undefined;
      while (Date.now() < end) {
        try { last = await status(); } catch { /* service handoff may temporarily interrupt loopback */ }
        if (last && predicate(last)) return last;
        if (last?.phase === "error") throw Error(`Fixture operation failed: ${last.error?.message ?? last.phase}`);
        await Bun.sleep(250);
      }
      throw Error(`Fixture outcome not established (${last?.phase ?? "unavailable"})`);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        // This scenario proves the explicit check/download/restart path from
        // the immutable bridge. Default automatic behavior is reported separately.
        await prepareManualCandidate({ mutate, waitStatus });
        break;
      } catch (error) {
        // A check or download can fail before any transaction exists, for example when the
        // desktop reconnects mid-operation; the error hint tells a person to retry. Anything
        // else, or a third failure, fails the scenario.
        const current = await status().catch(() => undefined);
        if (attempt >= 2 || !current || current.phase !== "error" || current.transactionId !== null) throw error;
        record(session, { kind: "note", behavior: `OTA ${scenario} candidate retry`, surface: "public API", verdict: "UNVERIFIED", text: `Retrying the pre-transaction check after: ${current.error?.message ?? "error"}` });
      }
    }
    journalTraceFd = openSync(join(session.root, "evidence/native-journal-trace.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let lastJournalRevision = -1, traceBytes = 0;
    journalTrace = setInterval(() => {
      try {
        const current = readOtaRecord(id, options), tx = current.exercise?.transactionId;
        if (!tx || journalTraceFd === undefined || traceBytes >= 1048576) return;
        const value = JSON.parse(privateFixtureBytes(join(current.pacerHome, "desktop-updates/native", installationId!, tx, "journal.json"), 1048576).toString("utf8"));
        if (value.revision === lastJournalRevision) return;
        const last = value.steps.at(-1);
        const line = JSON.stringify({ at: new Date().toISOString(), revision: value.revision, state: value.state, error: value.error, lastAction: last?.action, completed: last?.evidence !== null }) + "\n";
        writeSync(journalTraceFd, line); traceBytes += Buffer.byteLength(line); lastJournalRevision = value.revision;
      } catch { /* Observation never authorizes a native effect or changes its result. */ }
    }, 100);
    await mutate("restart", { version: "0.2.4" });
    const expected = scenario === "upgrade" ? "complete" : scenario === "restore-failure" ? "recovery-failed" : "restored";
    let outcome: UpdateStatus | undefined;
    if (scenario === "restore-failure") {
      // This fault deliberately prevents the service from being relaunched.
      // Require the authorized offline journal, both consumed faults, retained
      // admission and native participant absence; never invent an API response.
      const ctx = makeCtx({ home: state.pacerHome, pacerHome: state.pacerHome, env: fixtureEnvironment(state) });
      const deadline = Date.now() + 360000;
      let observed = false;
      while (Date.now() < deadline) {
        try {
          const latest = readOtaRecord(id, options), tx = latest.exercise?.transactionId;
          if (tx && latest.exercise!.faults.every(fault => fault.consumed !== null)) {
            const native = readNativeTransaction(ctx, installationId!, tx);
            if (native.authorization && native.journal.state === "recovery-failed" && hasReservation(ctx, tx)) {
              const jobs = await inspectFixtureJobs(latest);
              if (!jobs.desktops.length && !jobs.jobs[0].loaded && !jobs.jobs[0].process) { observed = true; break; }
            }
          }
        } catch { /* Incomplete or busy native observations grant no success. */ }
        await Bun.sleep(250);
      }
      if (!observed) throw Error("Expected offline restoration failure was not established");
    } else outcome = await waitStatus(value => value.phase === expected, 360000);
    state = readOtaRecord(id, options);
    const tx = state.exercise?.transactionId;
    if (!tx || !state.exercise!.faults.every(fault => fault.consumed !== null)) throw Error("Native checkpoint evidence is incomplete");
    const directory = join(state.pacerHome, "desktop-updates/native", installationId, tx);
    const journal = JSON.parse(privateFixtureBytes(join(directory, "journal.json"), 1048576).toString("utf8"));
    const prepared = privateFixtureBytes(join(directory, "prepared.json"), 1048576);
    const expectedJournal = expected === "complete" ? "committed" : expected;
    verifyExerciseOutcome(scenario, installationId, tx, outcome?.phase, prepared, journal);
    for (const file of preserved) {
      const actual = createHash("sha256").update(privateFixtureBytes(join(state.pacerHome, file.name), 1048576)).digest("hex");
      if (actual !== file.sha256) throw Error(`Fixture user data changed during update: ${file.name}`);
    }
    if (expected !== "recovery-failed") {
      const version = expected === "complete" ? "0.2.4" : "0.2.3";
      await verifyFixtureBundle(state, version);
      const retirementDeadline = Date.now() + 30000;
      let survived = false;
      while (Date.now() < retirementDeadline) {
        try {
          const terminal = JSON.parse(privateFixtureBytes(join(directory, "journal.json"), 1048576).toString("utf8"));
          if (!terminal.steps.some((step: any) => step.action.kind === "retire-recovery" && step.evidence?.kind === "complete")) { await Bun.sleep(250); continue; }
          verifyExerciseOutcome(scenario, installationId, tx, outcome?.phase, prepared, terminal);
          const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
          verifyExerciseSurvivors(terminal, jobs, state.serviceLabel, state.recoveryLabel);
          if (outcome?.current !== version || fixtureInstallation(state, jobs, version, "managed").id !== installationId) throw Error("Final managed installation differs from verified outcome");
          survived = true; break;
        } catch { /* Cleanup may still hold the native lock; never turn missing participants into success. */ }
        await Bun.sleep(250);
      }
      if (!survived) throw Error("Final desktop/service survival after native retirement was not established");
    }
    state = readOtaRecord(id, options);
    updateOtaDriverRecord(id, state, { runtime: { ...state.runtime!, request: null }, exercise: { ...state.exercise!, state: expected === "recovery-failed" ? "failed" : "complete" } }, options);
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop / public API / native journal", verdict: "PASS", text: `Observed ${expectedJournal}${outcome ? " with matching public status" : " offline, with both faults consumed, admission retained and desktop/service absent"}; exact native checkpoint and journal evidence verified. Configuration and authentication token remained byte-identical. Owned native processes and registrations retained until verified retirement.` });
  } catch (error) {
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop / public API / native journal", verdict: "FAIL", text: error instanceof Error ? error.message : "Native exercise failed; resources and evidence retained." });
    throw error;
  } finally { clearInterval(journalTrace); if (journalTraceFd !== undefined) closeSync(journalTraceFd); unsubscribe(); client.close(); }
}
