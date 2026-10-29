import { readFixtureBundleMetadata } from "./ota-bundle-metadata";
/** Fixed live attached-service scenarios. Every update/adoption write crosses the guarded public API. */
import { constants, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HttpClient } from "../../src/api/http-client";
import type { SnapshotV3 } from "../../src/api/read-model/types";
import type { UpdateStatus } from "../../src/update/desktop/types";
import { enumerateNativeProcesses } from "../../src/update/desktop/native-os";
import { ownProcessIdentity, processIdentity, sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { readinessProofSchema } from "../../src/update/desktop/native-record";
import { readAdoption } from "../../src/update/desktop/adoption-store";
import { makeCtx } from "../../src/ctx";
import { healthy, loadSession, record, sourceServiceMatchesExecutable } from "./core";
import { recordOtaEvent } from "./ota-evidence";
import { assertFixtureLayoutScenario, exactFixtureExternal, initialFixtureVersion, readOtaRecord, updateOtaDriverRecord, type OtaOptions } from "./ota";
import { ATTACHED_SCENARIOS, newExercise } from "./ota-exercise-record";
import { incarnationExited, privateFixtureBytes } from "./ota-exercise";
import { verifyPairedAdoptionProcesses } from "./ota-paired-proof";
import { verifyAdoptionOutcome, verifyAdoptionSurvivors } from "./ota-outcome";
import { fixtureRequest, retryFixtureRevision } from "./ota-request";
import { attachFixtureService, fixtureEnvironment, seedFixtureConsent, fixtureExternalCli, fixtureInstallation, inspectFixtureJobs, verifyFixtureBundle, verifyPairedFixtureCode } from "./ota-native";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** adopt: attached → bundled service. adopt-failure: bundled readiness fails once, original restored.
 *  attached: app-only update that must never stop, replace or re-register the external service. */
export async function runAttachedExercise(id: string, scenario: string, options: OtaOptions = {}): Promise<void> {
  if (!(ATTACHED_SCENARIOS as readonly string[]).includes(scenario)) throw Error("UNVERIFIED: this fixed scenario has no attached exercise driver");
  const session = loadSession(id, options.base), driver = ownProcessIdentity();
  let state = readOtaRecord(id, options);
  assertFixtureLayoutScenario(state, scenario);
  if (process.platform !== "darwin" || !driver || !state.nativeFixture || state.phase !== "prepared" || state.runtime || state.exercise || !exactFixtureExternal(state) || session.stopped || !session.serviceIdentity || !sameProcess(session.serviceIdentity, processIdentity(session.pid))) throw Error("UNVERIFIED: fresh attached fixture and exact source service ownership required");
  const baseline = state.nativeFixture.baselineVersion, appVersion = initialFixtureVersion(state), external = fixtureExternalCli(state), bundled = join(state.currentApp, "Contents/Resources/pacer");
  await verifyFixtureBundle(state, appVersion);
  const before = await inspectFixtureJobs(state);
  if (before.desktops.length || before.jobs.some(job => job.loaded || job.state !== "reserved")) throw Error("Fixture registration is already active or uncertain");
  const source = enumerateNativeProcesses().find(item => sameProcess(item.process, session.serviceIdentity!));
  if (!source || !sourceServiceMatchesExecutable(source.executable, session) || !await healthy(session)) throw Error("Source service identity or guarded ports changed");
  state = updateOtaDriverRecord(id, state, { exercise: null, runtime: { schema: 1, driver, sourceService: session.serviceIdentity, desktop: null, state: "starting", request: null } }, options);
  if (!sameProcess(processIdentity(session.pid), session.serviceIdentity)) throw Error("Source service changed before handoff");
  process.kill(session.pid, "SIGTERM");
  const stopDeadline = Date.now() + 10000;
  while (!incarnationExited(session.serviceIdentity) && Date.now() < stopDeadline) await Bun.sleep(100);
  if (!incarnationExited(session.serviceIdentity)) throw Error("Source service exit unproven; fixture retained");

  // The compiled helper installs the lease's one external registration through the native ledger.
  const attached = await attachFixtureService(readOtaRecord(id, options));
  const attachedInstallation = fixtureInstallation(state, attached, appVersion, "attached");
  const externalService = attached.jobs[0].process!, externalRegistration = attached.jobs[0].registrationSha256!;
  // Desktop starts only after the exact attached incarnation serves its own health endpoint.
  const healthDeadline = Date.now() + 30000;
  let serving = false;
  while (Date.now() < healthDeadline && !serving) {
    try {
      const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000) });
      serving = response.ok && response.headers.get("x-pacer") === "1" && (await response.json()).pid === externalService.pid && sameProcess(processIdentity(externalService.pid), externalService);
    } catch { /* not yet serving */ }
    if (!serving) await Bun.sleep(250);
  }
  if (!serving) throw Error("External fixture service did not become healthy; Desktop was not started");
  record(session, { kind: "note", behavior: `OTA ${scenario} attach`, surface: "native fixture", verdict: "PASS", text: `External service registered, loaded and healthy from the lease's standalone CLI (pid ${externalService.pid}); Desktop has not started.` });

  const log = openSync(join(session.root, "evidence/native-desktop.log"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let launched: ProcessIdentity | null;
  try {
    seedFixtureConsent(state);
    const desktop = Bun.spawn([join(state.currentApp, "Contents/MacOS/pacer")], { env: fixtureEnvironment(state), stdin: "ignore", stdout: log, stderr: log });
    desktop.unref(); // A failed driver must exit; the Desktop is retired through the lease, not by the driver.
    launched = processIdentity(desktop.pid);
  } finally { closeSync(log); }
  if (!launched) throw Error("Launched desktop incarnation unavailable; fixture retained");
  state = updateOtaDriverRecord(id, readOtaRecord(id, options), { exercise: null, runtime: { ...state.runtime!, desktop: launched } }, options);
  const token = privateFixtureBytes(join(state.pacerHome, "token"), 4096).toString("utf8").trim();
  const client = new HttpClient(`http://127.0.0.1:${session.port}`, token, { protocol: 3, timeoutMs: 30000 });
  const installationId = attachedInstallation.id;
  let unsubscribe = () => {};
  try {
    async function status(target = installationId): Promise<UpdateStatus> { return client.call("desktop.update.status", { installationId: target }); }
    // Default automatic check/download runs first; adoption is offered once that settles.
    const readyDeadline = Date.now() + (scenario === "attached" ? 60000 : 240000);
    let ready = false;
    while (Date.now() < readyDeadline) {
      try {
        const snapshot = await client.snapshot();
        const value = (snapshot.snapshot as unknown as SnapshotV3).desktopUpdates?.find(item => item.installationId === installationId);
        if (value?.ownership === "attached" && value.current === appVersion && (scenario === "attached" ? value.actions.length > 0 : value.actions.includes("adopt"))) { ready = true; break; }
      } catch { /* Bounded native startup observation; no failed observation authorizes work. */ }
      await Bun.sleep(250);
    }
    if (!ready) throw Error(scenario === "attached" ? "Attached Desktop did not become provable" : "Attached Desktop did not offer service adoption");
    const preserved = ["strategy.yaml", "token"].map(name => ({ name, sha256: sha256(privateFixtureBytes(join(state.pacerHome, name), 1048576)) }));
    state = readOtaRecord(id, options);
    state = updateOtaDriverRecord(id, state, { runtime: { ...state.runtime!, state: "managed" }, exercise: { ...newExercise(scenario, driver, installationId), state: "running" } }, options);
    const initial = await client.snapshot();
    unsubscribe = client.subscribe(initial.seq, event => {
      recordOtaEvent(session, scenario, event);
    });
    async function mutate(action: "check" | "download" | "restart" | "adopt", extra: Record<string, unknown> = {}): Promise<void> {
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
      }, clearRequest, action === "restart" ? async () => { await waitStatus(value => value.actions.includes("restart"), 60000); } : undefined, action === "adopt" ? waitAdoptionOffer : undefined);
    }
    // The update phase (for example a cancelled automatic check) is independent of adoption.
    async function waitAdoptionOffer(): Promise<void> {
      const end = Date.now() + 240000;
      while (Date.now() < end) {
        try { if ((await status()).actions.includes("adopt")) return; } catch { /* service handoff may temporarily interrupt loopback */ }
        await Bun.sleep(250);
      }
      throw Error("Attached Desktop did not offer service adoption");
    }
    async function waitStatus(predicate: (status: UpdateStatus) => boolean, timeout: number): Promise<UpdateStatus> {
      const end = Date.now() + timeout; let last: UpdateStatus | undefined;
      while (Date.now() < end) {
        try { last = await status(); } catch { /* service handoff may temporarily interrupt loopback */ }
        if (last && predicate(last)) return last;
        if (last?.phase === "error" || last?.adoption?.phase === "recovery-failed") throw Error(`Fixture operation failed: ${last.adoption?.error?.message ?? last.error?.message ?? last.phase}`);
        await Bun.sleep(250);
      }
      throw Error(`Fixture outcome not established (${last?.adoption?.phase ?? last?.phase ?? "unavailable"})`);
    }
    const ctx = makeCtx({ home: state.pacerHome, pacerHome: state.pacerHome, env: fixtureEnvironment(state) });

    if (scenario === "attached") {
      if ((await status()).autoDownload) await waitStatus(value => value.phase === "ready" && value.target === "0.2.4", 120000);
      else {
        await waitStatus(value => value.actions.includes("check"), 60000);
        await mutate("check");
        const checked = await waitStatus(value => value.target === "0.2.4" && (value.phase === "ready" || value.actions.includes("download")), 60000);
        if (checked.phase !== "ready") { await mutate("download"); await waitStatus(value => value.phase === "ready", 90000); }
      }
      await mutate("restart", { version: "0.2.4" });
      const outcome = await waitStatus(value => value.phase === "complete", 360000);
      state = readOtaRecord(id, options);
      const tx = state.exercise?.transactionId;
      if (!tx || outcome.current !== "0.2.4") throw Error("Attached update transaction evidence is incomplete");
      const directory = join(state.pacerHome, "desktop-updates/native", installationId, tx);
      const prepared = privateFixtureBytes(join(directory, "prepared.json"), 1048576);
      let verified = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !verified) {
        try {
          const journal = JSON.parse(privateFixtureBytes(join(directory, "journal.json"), 1048576).toString("utf8"));
          if (journal.state !== "committed" || journal.manifestSha256 !== sha256(prepared)) throw Error("Attached journal is not committed for its manifest");
          if (!journal.steps.some((step: any) => step.action.kind === "retire-recovery" && step.evidence?.kind === "complete")) { await Bun.sleep(250); continue; }
          const proof = readinessProofSchema.parse(journal.verificationProof);
          if (proof.installationId !== installationId || proof.transactionId !== tx || proof.desktopVersion !== "0.2.4" || !sameProcess(proof.service, externalService)) throw Error("Attached readiness proof does not bind the untouched external service");
          await verifyFixtureBundle(readOtaRecord(id, options), "0.2.4");
          const jobs = await inspectFixtureJobs(readOtaRecord(id, options)), service = jobs.jobs[0];
          if (!service.loaded || service.executable !== external || !sameProcess(service.process, externalService) || service.registrationSha256 !== externalRegistration || jobs.jobs[1].loaded ||
              !jobs.desktops.some(desktop => sameProcess(desktop, proof.desktop)) || fixtureInstallation(state, jobs, "0.2.4", "attached").id !== installationId) throw Error("External service was stopped, replaced or re-registered");
          if (readOtaRecord(id, options).registrations[0].generations) throw Error("Attached update switched the service registration");
          verified = true;
        } catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
      }
      if (!verified) throw Error("Attached update survival was not established");
    } else {
      const expected = scenario === "adopt" ? "committed" : "restored";
      await waitAdoptionOffer();
      await mutate("adopt");
      // The update phase (for example a failed automatic check) is independent of adoption.
      const adoptionDeadline = Date.now() + 360000;
      let outcome: UpdateStatus | undefined;
      while (Date.now() < adoptionDeadline) {
        try { outcome = await status(); } catch { /* the service is replaced during adoption */ }
        const phase = outcome?.adoption?.phase;
        if (phase === expected) break;
        if (phase === "cancelled" || phase === "recovery-failed" || (phase === "committed" || phase === "restored") && phase !== expected) throw Error(`Adoption ended ${phase}: ${outcome?.adoption?.error?.message ?? "no error"}`);
        await Bun.sleep(250);
      }
      if (outcome?.adoption?.phase !== expected) throw Error(`Adoption outcome not established (${outcome?.adoption?.phase ?? "unavailable"})`);
      const adopted = readAdoption(ctx, installationId);
      state = readOtaRecord(id, options);
      const tx = adopted?.transactionId;
      if (!tx || state.exercise?.transactionId !== tx || !state.exercise.faults.every(fault => fault.consumed !== null)) throw Error("Adoption checkpoint evidence is incomplete");
      const directory = join(state.pacerHome, "desktop-updates/native", installationId, tx);
      const prepared = privateFixtureBytes(join(directory, "adoption-prepared.json"), 1048576);
      let pairedEvidence: ReturnType<typeof verifyPairedAdoptionProcesses> | undefined;
      let verified = false;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !verified) {
        try {
          const journal = JSON.parse(privateFixtureBytes(join(directory, "adoption-journal.json"), 1048576).toString("utf8"));
          const proven = verifyAdoptionOutcome(scenario, installationId, tx, outcome.adoption?.phase, prepared, journal, state.initialLayout);
          if (scenario === "adopt" && outcome.adoption?.resultingInstallationId !== proven.resultingInstallationId) throw Error("Public resulting installation differs from native proof");
          if (!journal.steps.some((step: any) => step.action.kind === "retire-recovery" && step.evidence?.kind === "complete")) { await Bun.sleep(250); continue; }
          const beforeProcesses = state.initialLayout === "paired" ? enumerateNativeProcesses() : [];
          await verifyFixtureBundle(readOtaRecord(id, options), appVersion);
          const jobs = await inspectFixtureJobs(readOtaRecord(id, options));
          if (state.initialLayout === "paired") {
            // The fixed verifier proved signatures/source hashes before these observations.
            const response = await fetch(`http://127.0.0.1:${state.innerPort}/health`, { signal: AbortSignal.timeout(1000), redirect: "error" });
            if (!response.ok || response.headers.get("x-pacer") !== "1" || (await response.json()).pid !== proven.service.pid) throw Error("Adoption health differs from proven service");
            const input = { appPath: state.currentApp, ownerUid: state.ownerUid, arch: state.nativeFixture!.arch,
              branch: proven.branch, service: proven.service, metadata: JSON.parse(readFixtureBundleMetadata(state.currentApp)) };
            pairedEvidence = verifyPairedAdoptionProcesses(input, beforeProcesses, enumerateNativeProcesses());
            if (pairedEvidence) {
              verifyPairedFixtureCode(state, pairedEvidence);
              pairedEvidence = verifyPairedAdoptionProcesses(input, beforeProcesses, enumerateNativeProcesses());
            }
          }
          const program = scenario === "adopt" ? bundled : external;
          verifyAdoptionSurvivors(journal, proven, jobs, state.serviceLabel, state.recoveryLabel, program);
          if (fixtureInstallation(state, jobs, appVersion, scenario === "adopt" ? "managed" : "attached").id !== proven.resultingInstallationId) throw Error("Live installation differs from the adoption proof");
          const row = readOtaRecord(id, options).registrations[0];
          if (row.generations?.length !== 2 || row.generations[0] !== externalRegistration || !row.history?.some(entry => entry.sha256 === externalRegistration && entry.processes.some(p => sameProcess(p, externalService)))) throw Error("Native ledger lacks the cataloged registration switch");
          if (scenario === "adopt-failure" && row.sha256 !== externalRegistration) throw Error("Failed adoption did not restore the original registration");
          verified = true;
        } catch (error) { if (Date.now() >= deadline) throw error; await Bun.sleep(250); }
      }
      if (!verified) throw Error("Adoption survival after native retirement was not established");
      if (state.initialLayout === "paired") record(session, { kind: "note", behavior: "OTA paired adoption participants", surface: "native inventory / journal / health", verdict: "PASS", text: JSON.stringify({ initialLayout: state.initialLayout, desktopVersion: appVersion, branch: scenario === "adopt" ? "managed" : "original", serviceVersion: scenario === "adopt" ? appVersion : baseline, codeProof: pairedEvidence ? "fresh-system-Security-framework-fixture-certificate" : "candidate-Root-and-Core-absent", participants: pairedEvidence }) });
    }
    for (const file of preserved) if (sha256(privateFixtureBytes(join(state.pacerHome, file.name), 1048576)) !== file.sha256) throw Error(`Fixture user data changed: ${file.name}`);
    state = readOtaRecord(id, options);
    updateOtaDriverRecord(id, state, { runtime: { ...state.runtime!, request: null }, exercise: { ...state.exercise!, state: "complete" } }, options);
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop / public API / native journal", verdict: "PASS", text: scenario === "attached"
      ? "App-only update committed to 0.2.4 with matching public status; the exact external service incarnation and registration bytes were never stopped or replaced. Configuration and token unchanged."
      : `Adoption ${scenario === "adopt" ? "committed to the bundled service" : "failed readiness once and restored the external service"}; journal, manifest, branch proof, ledger switch history and surviving participants verified. Configuration and token unchanged.` });
  } catch (error) {
    record(session, { kind: "note", behavior: `OTA ${scenario}`, surface: "desktop / public API / native journal", verdict: "FAIL", text: error instanceof Error ? error.message : "Attached exercise failed; resources and evidence retained." });
    throw error;
  } finally { unsubscribe(); client.close(); }
}
