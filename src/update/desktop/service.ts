import {createAdoptionRuntime,type AdoptionNative} from "./adoption-service";
import {readAdoption,listAdoptions} from "./adoption-store";
import {adoptionPending} from "./adoption-state";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import { publish } from "../../link/publish";
import { compareVersions } from "../version";
import * as admission from "./admission";
import { ownProcessIdentity, sameProcess, type ProcessIdentity } from "./process-identity";
import { AdapterError, runAdapterCommand, type AdapterRequest, type PreparedFrame, type VerifiedPipeFactory } from "./adapter";
import { cancelRestart, checkDue, checksEnabled, rememberRequest, replayRequest, requestRestart, updateStatus } from "./policy";
import { readUpdate, writeUpdate } from "./store";
import { assertIdentifier, type Installation, type UpdateRecord, type UpdateRequest, type RestartRequest, type UpdateStatus, type UpdateAction } from "./types";

/** Internal proof from local signature/process/service verification. Never construct from public client registration or environment paths. */
export interface VerifiedNativeSession {
  readonly installation: Installation;
  readonly desktopClientId: string;
  readonly sessionId: string;
  readonly bootId: string;
  readonly desktop: ProcessIdentity;
  readonly service: ProcessIdentity;
  alive(): boolean;
  readonly closed: Promise<void>;
}
export interface NativeAuthorityProvider extends AdoptionNative {
  sessions(): readonly VerifiedNativeSession[];
  subscribe(changed: () => void): () => void;
  /** Recheck static Installation plus signed native processes, service ownership/admission and attached compatibility. */
  reverify(session: VerifiedNativeSession): Promise<void>;
  /** Confirm durable journal and reservation, and persist authorization, before allowing the continuation. */
  authorizeInstall?(session: VerifiedNativeSession, prepared: PreparedFrame): Promise<boolean>;
  /** Positive authenticated readiness/rollback proof; a helper's outcome alone is insufficient. */
  verifyOutcome?(session: VerifiedNativeSession, record: UpdateRecord, outcome: "committed" | "restored" | "recovery-failed"): Promise<{ installation: Installation; attempted: boolean }>;
}
export interface DesktopUpdateDeps {
  native?: NativeAuthorityProvider;
  adapter?: VerifiedPipeFactory;
  clock?: { nowS(): number; monotonicMs(): number; bootId(): string };
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  admission?: Pick<typeof admission, "reserveIdle" | "releaseReservation" | "reconcileAdmission">;
  publish?: (status: UpdateStatus) => Promise<void>;
}
export interface DesktopUpdateRuntime {
  status(installationId: string): UpdateStatus;
  listStatuses(): UpdateStatus[];
  boundClientId(installationId: string): string;
  check(request: UpdateRequest): Promise<UpdateStatus>;
  download(request: UpdateRequest): Promise<UpdateStatus>;
  restart(request: RestartRequest): Promise<UpdateStatus>;
  cancel(request: UpdateRequest): Promise<UpdateStatus>;
  adopt(request: UpdateRequest): Promise<UpdateStatus>;
  adoptCancel(request: UpdateRequest): Promise<UpdateStatus>;
  configure(request: UpdateRequest & { autoDownload: boolean }): UpdateStatus;
  start(): Promise<void>;
  stop(): void;
  tick(): Promise<void>;
  /** Internal lifecycle/testing drain, never a public operation. */
  settled(): Promise<void>;
}
const unavailable = () => new CoreError("not_allowed", "Verified desktop update connection is unavailable", "Open a supported desktop connected to this service. Native update registration is required.");
const conflict = () => new CoreError("conflict", "Desktop update state changed", "Read the current status and retry with a new request ID.");
const superseded = (error: unknown) => error instanceof CoreError && (error.code === "conflict" || error.code === "not_allowed");
const unavailableNative: NativeAuthorityProvider = { sessions: () => [], subscribe: () => () => {}, reverify: async () => { throw unavailable(); } };
const runtimes = new Map<string, DesktopUpdateRuntime>();
/** Service composition-root hook only. Public operations cannot install a runtime or native provider. */
export function bindDesktopUpdateRuntime(ctx: Ctx, runtime: DesktopUpdateRuntime): () => void {
  const key = resolve(ctx.pacerHome);
  if (runtimes.has(key)) throw new CoreError("conflict", "Desktop update service is already registered");
  runtimes.set(key, runtime);
  return () => { if (runtimes.get(key) === runtime) runtimes.delete(key); };
}
export function desktopUpdateRuntime(ctx: Ctx): DesktopUpdateRuntime { const runtime = runtimes.get(resolve(ctx.pacerHome)); if (!runtime) throw unavailable(); return runtime; }
export function desktopUpdateStatuses(ctx: Ctx): UpdateStatus[] { return runtimes.get(resolve(ctx.pacerHome))?.listStatuses() ?? []; }
export const desktopUpdateStatus = (ctx: Ctx, id: string): UpdateStatus => desktopUpdateRuntime(ctx).status(id);
export const desktopUpdateCheck = (ctx: Ctx, request: UpdateRequest): Promise<UpdateStatus> => desktopUpdateRuntime(ctx).check(request);
export const desktopUpdateDownload = (ctx: Ctx, request: UpdateRequest): Promise<UpdateStatus> => desktopUpdateRuntime(ctx).download(request);
export const desktopUpdateRestart = (ctx: Ctx, request: RestartRequest): Promise<UpdateStatus> => desktopUpdateRuntime(ctx).restart(request);
export const desktopUpdateCancel = (ctx: Ctx, request: UpdateRequest): Promise<UpdateStatus> => desktopUpdateRuntime(ctx).cancel(request);
export const desktopUpdateConfigure = (ctx: Ctx, request: UpdateRequest & { autoDownload: boolean }): UpdateStatus => desktopUpdateRuntime(ctx).configure(request);

type Active = { controller: AbortController; previous: UpdateRecord; phase: "checking" | "downloading" | "reserved" | "recovering"; transactionId: string | null };
export function createDesktopUpdateRuntime(getCtx: () => Ctx, deps: DesktopUpdateDeps = {}): DesktopUpdateRuntime {
  const native = deps.native ?? unavailableNative, gate = deps.admission ?? admission;
  const clock = deps.clock ?? { nowS: () => Date.now() / 1000, monotonicMs: () => performance.now(), bootId: () => ownProcessIdentity()?.bootId ?? "" };
  const schedule = deps.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return () => clearTimeout(timer); });
  const jitter = () => Math.max(0, Math.min(1, (deps.random ?? Math.random)())) * 3_600_000;
  const known = new Map<string, Installation>(), watched = new Map<string, string>(), active = new Map<string, Active>();
  const waitingSessions = new Map<string, string>(), nextCheck = new Map<string, number>(), failures = new Map<string, number>();
  const jobs = new Set<Promise<void>>(), initialized = new Set<string>();
  let publications = Promise.resolve(), started = false, stopped = false, ticking = false;
  let unsubscribe: (() => void) | undefined, cancelTimer: (() => void) | undefined;
  let runtimeError = false;
  const ctx = () => ({ ...getCtx(), now: clock.nowS() });
  const record = (id: string) => readUpdate(ctx(), id);
  const liveSession = (id: string): VerifiedNativeSession | undefined => native.sessions().find(s => s.installation.id === id && s.alive() && s.bootId === clock.bootId());
  const isCurrent = (session: VerifiedNativeSession) => {
    const current = liveSession(session.installation.id);
    return !!current && current.sessionId === session.sessionId && sameProcess(current.desktop, session.desktop) && sameProcess(current.service, session.service);
  };
  const installation = (id: string) => { assertIdentifier(id); const value = known.get(id)??readAdoption(ctx(),id)?.authority.target; if (!value) throw unavailable(); return value; };
  const operational = () => { if (!started || stopped || runtimeError) throw unavailable(); };
  const requireSession = (id: string) => { operational(); installation(id); if (!initialized.has(id)) throw unavailable(); const session = liveSession(id); if (!session) throw unavailable(); return session; };
  const verified = async (id: string) => { const session = requireSession(id); try { await native.reverify(session); } catch { throw unavailable(); } if (stopped || !isCurrent(session)) throw unavailable(); return session; };
  const emit = (id: string) => {
    const status = runtime.status(id);
    publications = publications.then(async () => {
      if (deps.publish) await deps.publish(status);
      else { const report = await publish(ctx(), [{ type: "entity", data: { kind: "desktop.update", id, value: status } }]); if (report.errors.length) throw new Error("publication unavailable"); }
    }).catch(() => { runtimeError = true; });
  };
  const persist = (next: UpdateRecord) => { const saved = writeUpdate(ctx(), next, next.revision); emit(saved.installationId); return saved; };
  const track = (promise: Promise<void>) => { const job = promise.catch(() => { runtimeError = true; }).finally(() => jobs.delete(job)); jobs.add(job); };
  const replay = (current: UpdateRecord, request: UpdateRequest, action: UpdateAction, params: Record<string,string|boolean> = {}) => {
    const receipt = replayRequest(current, request, action, params);
    if (receipt && receipt.transactionId !== current.transactionId) throw conflict();
    return receipt;
  };
  const commitRequest = (request: UpdateRequest, action: UpdateAction, change: (value: UpdateRecord) => UpdateRecord, params: Record<string,string|boolean> = {}) => {
    const current = record(request.installationId);
    if (replay(current, request, action, params)) return { saved: current, repeated: true };
    try { return { saved: persist(rememberRequest(change(current), request, action, params)), repeated: false }; }
    catch (error) {
      if (error instanceof CoreError && error.code === "conflict") {
        const fresh = record(request.installationId);
        if (replay(fresh, request, action, params)) return { saved: fresh, repeated: true };
      }
      throw error;
    }
  };
  const pendingPhase = (value: UpdateRecord) => ["waiting", "reserved", "installing", "verifying", "rolling-back", "recovery-failed"].includes(value.phase);
  const release = async (id: string, tx: string | null) => { if (tx && installation(id).ownership === "managed") await gate.releaseReservation(ctx(), tx); };
  const revokeWaiting = (id: string) => {
    const value = record(id);
    if (value.phase === "waiting") { persist(cancelRestart(value)); if (value.transactionId) waitingSessions.delete(value.transactionId); }
    // Once native authorization is durable, the helper owns shutdown/recovery.
    // Its planned desktop exit must not cancel that transaction's observation.
    const operation = active.get(id);
    if (operation?.phase !== "recovering" && ["checking", "downloading", "reserved"].includes(value.phase)) operation?.controller.abort();
  };
  const observe = () => {
    for (const session of native.sessions()) {
      assertIdentifier(session.installation.id); assertIdentifier(session.desktopClientId); assertIdentifier(session.sessionId);
      if (resolve(session.installation.pacerHome) !== resolve(ctx().pacerHome)) throw unavailable();
      if (!known.has(session.installation.id)) known.set(session.installation.id, structuredClone(session.installation));
      if (watched.get(session.installation.id) !== session.sessionId) {
        watched.set(session.installation.id, session.sessionId);
        void session.closed.then(() => {
          if (!stopped && watched.get(session.installation.id) === session.sessionId) {
            try { revokeWaiting(session.installation.id); } catch { runtimeError = true; }
          }
        }, () => { runtimeError = true; });
      }
    }
  };
  const resetAfterNetwork = (value: UpdateRecord, previous: UpdateRecord): UpdateRecord => ({ ...value,
    phase: previous.phase === "ready" ? "ready" : "idle", candidate: previous.candidate,
    downloadedBytes: previous.phase === "ready" ? previous.downloadedBytes : 0,
    totalBytes: previous.phase === "ready" ? previous.totalBytes : null, error: null,
  });
  const network = async (id: string, operation: Active, request: AdapterRequest) => {
    try {
      const result = await runAdapterCommand(deps.adapter, request, { signal: operation.controller.signal, onProgress: progress => {
        if (active.get(id) !== operation || stopped) throw conflict();
        const value = record(id); if (value.phase !== "downloading") throw conflict();
        persist({ ...value, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes });
      } });
      if (active.get(id) !== operation || stopped) return;
      const value = record(id), installed = installation(id);
      if (value.phase !== operation.phase) throw conflict();
      if (result.kind === "checked") {
        const offered = result.candidate;
        if (offered && (offered.arch !== installed.arch || !offered.protocolMajors.includes(3) || !offered.rollbackCompatible)) throw new CoreError("not_allowed", "Desktop release is incompatible");
        const candidate = offered && compareVersions(offered.version, installed.version) > 0 ? offered : null;
        const previousReady = operation.previous.phase === "ready" && JSON.stringify(operation.previous.candidate) === JSON.stringify(candidate);
        persist({ ...value, candidate, phase: previousReady ? "ready" : "idle", checkedAt: clock.nowS(), error: null,
          downloadedBytes: previousReady ? operation.previous.downloadedBytes : 0, totalBytes: previousReady ? operation.previous.totalBytes : null });
        failures.delete(id); nextCheck.set(id, clock.monotonicMs() + 86_400_000 + jitter());
      } else if (result.kind === "downloaded") persist({ ...value, phase: "ready", candidate: result.candidate, downloadedBytes: result.downloadedBytes, totalBytes: result.totalBytes, error: null });
      else throw conflict();
    } catch (error) {
      if (active.get(id) === operation && !stopped) {
        const value = record(id);
        if (value.phase === operation.phase) {
          const restored = resetAfterNetwork(value, operation.previous);
          persist({ ...restored, phase: restored.phase === "ready" ? "ready" : "error", error: { code: "update_failed", message: error instanceof AdapterError ? error.message : "Desktop update could not be verified" } });
          const count = (failures.get(id) ?? 0) + 1; failures.set(id, count);
          nextCheck.set(id, clock.monotonicMs() + [60_000, 300_000, 900_000, 3_600_000, 21_600_000][Math.min(count - 1, 4)]! + jitter());
        }
      }
    } finally { if (active.get(id) === operation) active.delete(id); }
    if (!stopped && request.command === "check") {
      const value = record(id);
      if (value.phase === "idle" && value.candidate && value.autoDownload && value.failedVersion !== value.candidate.version && liveSession(id)) {
        try { await startNetwork({ installationId: id, requestId: randomUUID(), expectRevision: value.revision }, "download", true); }
        catch (error) { if (!superseded(error)) throw error; }
      }
    }
  };
  const startNetwork = async (request: UpdateRequest, command: "check" | "download", automatic = false) => {
    await verified(request.installationId);
    if (automatic && !record(request.installationId).autoDownload) return runtime.status(request.installationId);
    if (command === "check" && !checksEnabled(ctx())) throw new CoreError("not_allowed", "Update checking is disabled");
    if (!deps.adapter?.capabilities.has(command)) throw unavailable();
    let previous!: UpdateRecord;
    const committed = commitRequest(request, command, current => {
      if (pendingPhase(current) || ["checking", "downloading"].includes(current.phase)) throw conflict();
      if (command === "download" && !current.candidate) throw conflict();
      previous = current;
      return { ...current, phase: command === "check" ? "checking" : "downloading", error: null,
        ...(command === "download" ? { downloadedBytes: 0, totalBytes: null } : {}) };
    });
    if (!committed.repeated) {
      const value = committed.saved;
      const operation: Active = { controller: new AbortController(), previous, phase: command === "check" ? "checking" : "downloading", transactionId: null };
      active.set(request.installationId, operation);
      const input: AdapterRequest = command === "check"
        ? { command, installationId: request.installationId, revision: value.revision, transactionId: null }
        : { command, installationId: request.installationId, revision: value.revision, transactionId: null, candidate: value.candidate! };
      track(network(request.installationId, operation, input));
    }
    return runtime.status(request.installationId);
  };
  const install = async (id: string, session: VerifiedNativeSession, recovery = false) => {
    const previous = record(id), transactionId = previous.transactionId;
    if (!transactionId || active.has(id)) return;
    const operation: Active = { controller: new AbortController(), previous, phase: recovery ? "recovering" : "reserved", transactionId };
    active.set(id, operation);
    try {
      const result = await runAdapterCommand(deps.adapter, recovery
        ? { command: "recover", installationId: id, revision: previous.revision, transactionId }
        : { command: "install", installationId: id, revision: previous.revision, transactionId, candidate: previous.candidate!, target: installation(id) }, {
        signal: operation.controller.signal,
        authorizeInstall: async prepared => {
          if (stopped || !isCurrent(session)) return false;
          await native.reverify(session);
          if (stopped || !isCurrent(session) || record(id).phase !== "reserved" || record(id).transactionId !== transactionId) return false;
          const allowed = await native.authorizeInstall!(session, prepared);
          return allowed && !stopped && isCurrent(session) && record(id).phase === "reserved" && record(id).transactionId === transactionId;
        },
        onAuthorized: () => {
          const value = record(id); if (value.phase !== "reserved" || value.transactionId !== transactionId) throw conflict();
          persist({ ...value, phase: "installing" });
        },
      });
      if (result.kind !== "outcome") throw conflict();
      const value = record(id);
      if (value.transactionId !== transactionId) throw conflict();
      if (result.outcome === "recovery-failed") { persist({ ...value, phase: "recovery-failed", error: { code: "recovery_failed", message: "Desktop recovery requires repair" } }); return; }
      const outcomeProof = await native.verifyOutcome!(session, value, result.outcome);
      if (typeof outcomeProof.attempted !== "boolean" || (result.outcome === "committed" && !outcomeProof.attempted)) throw conflict();
      const confirmed = outcomeProof.installation;
      const expected = { ...installation(id), version: result.outcome === "committed" ? value.candidate?.version : installation(id).version };
      if ((Object.keys(expected) as (keyof Installation)[]).some(key => confirmed[key] !== expected[key])) throw conflict();
      known.set(id, structuredClone(confirmed));
      persist({ ...record(id), phase: result.outcome === "committed" ? "complete" : "restored", error: null,
        failedVersion: result.outcome === "restored" && outcomeProof.attempted ? value.candidate?.version ?? null : value.failedVersion,
        requestId: null, requestedBy: null, requesterBootId: null });
      await release(id, transactionId);
    } catch (error) {
      const value = record(id);
      if (value.transactionId !== transactionId) { runtimeError = true; return; }
      // Only a fresh install can prove no authorization was sent. A failed
      // recovery connection says nothing about the original durable handoff.
      if (!recovery && error instanceof AdapterError && error.handoff === "none") {
        persist({ ...value, phase: "error", requestId: null, requestedBy: null, requesterBootId: null,
          error: { code: "pre_handoff", message: error.message } });
        await release(id, transactionId);
      } else {
        persist({ ...value, phase: "recovery-failed", error: { code: "handoff_uncertain", message: "Desktop update requires transaction recovery" } });
      }
    } finally { if (active.get(id) === operation) active.delete(id); }
  };
  const advanceWaiting = async (id: string) => {
    let value = record(id);
    if (value.phase !== "waiting" || !value.transactionId) return;
    const tx = value.transactionId, session = liveSession(id);
    if (!session || value.requesterBootId !== clock.bootId() || value.requestedBy !== session.desktopClientId || waitingSessions.get(tx) !== session.sessionId) { revokeWaiting(id); return; }
    await native.reverify(session);
    if (!isCurrent(session) || stopped) { revokeWaiting(id); return; }
    const reservation = installation(id).ownership === "attached" ? { reserved: true, blockers: [] } : await gate.reserveIdle(ctx(), tx);
    value = record(id);
    if (value.phase !== "waiting" || value.transactionId !== tx || !isCurrent(session) || stopped) {
      if (reservation.reserved) await release(id, tx);
      if (value.phase === "waiting") revokeWaiting(id);
      return;
    }
    if (!reservation.reserved) {
      if (JSON.stringify(value.blockers) !== JSON.stringify(reservation.blockers)) persist({ ...value, blockers: reservation.blockers });
      return;
    }
    try { persist({ ...value, phase: "reserved", blockers: [] }); }
    catch (error) { await release(id, tx); throw error; }
    track(install(id, session));
  };
  // Discovery may happen after launchd starts the service. Reconcile each recorded
  // installation once before it becomes eligible for public mutation or scheduling.
  const reconcile = async (id: string) => {
    if (initialized.has(id)) return false;
    const session = liveSession(id);
    if (!session) return true;
    // Discovery can overlap the desktop's short-lived sign-in CLI or a native
    // reconnect. Keep this installation unavailable and retry with fresh proof;
    // an observation failure must not permanently poison the service runtime.
    try { await native.reverify(session); } catch { return true; }
    if (stopped || !isCurrent(session)) return true;
    const value = record(id);
    if (value.phase === "waiting") {
      persist(cancelRestart(value));
      await release(id, value.transactionId);
    } else if (["checking", "downloading"].includes(value.phase)) {
      persist({ ...value, phase: "error", error: { code: "interrupted", message: "Desktop update network operation was interrupted" } });
    } else if (["reserved", "installing", "verifying", "rolling-back", "recovery-failed"].includes(value.phase)) {
      if (!deps.adapter?.capabilities.has("recover") || !native.verifyOutcome) throw unavailable();
      track(install(id, session, true));
    } else if (value.transactionId && (value.phase === "ready" && !value.requestId || value.phase === "error" && value.error?.code === "pre_handoff" || value.phase === "complete" || value.phase === "restored")) {
      await release(id, value.transactionId);
    }
    initialized.add(id);
    return true;
  };
  const adoption=createAdoptionRuntime(ctx,{native,adapter:deps.adapter,admission:gate,bootId:clock.bootId,changed:value=>{if(known.has(value.installationId))emit(value.installationId);},completed:(_oldId,value)=>{known.set(value.id,structuredClone(value));}});
  const runtime: DesktopUpdateRuntime = {
    status(id) {
      const value = record(id), status = updateStatus(installation(id), value);
      const adopted=readAdoption(ctx(),id),session=liveSession(id);
      let currentAdoption: ReturnType<NonNullable<AdoptionNative["inspectAdoption"]>> | undefined;
      if ((!adopted || !adoptionPending(adopted)) && session && adoption.capable() && session.installation.ownership === "attached") {
        try { currentAdoption = native.inspectAdoption?.(session); } catch { /* Retain terminal audit data without granting a new action. */ }
      }
      const source = currentAdoption ?? adopted?.authority;
      if(source) status.adoption={phase:adopted?.phase??"available",revision:adopted?.revision??value.revision,previousInstallationId:id,resultingInstallationId:adopted?.resultingInstallationId??null,currentServiceExecutable:source.oldServiceExecutable,replacementServiceExecutable:source.newServiceExecutable,serviceLabel:source.target.serviceLabel,port:source.target.port,blockers:adopted?.blockers??[],error:adopted?.error??null};
      if(adopted&&adoptionPending(adopted))return{...status,actions:adopted.phase==="waiting"?["adoptCancel"]:[]};
      if (runtimeError) return { ...status, actions: [], error: { code: "coordination_failed", message: "Desktop update coordination requires reconnect or recovery" } };
      if (!initialized.has(id)) return { ...status, actions: [] };
      if (!liveSession(id)) return { ...status, actions: value.phase === "waiting" ? ["cancel"] : [] };
      return { ...status, actions: status.actions.filter(action => (action !== "adopt" || !!currentAdoption) && (action !== "check" || !!deps.adapter?.capabilities.has("check")) && (action !== "download" || !!deps.adapter?.capabilities.has("download")) && (action !== "restart" || !!native.authorizeInstall && !!native.verifyOutcome && !!deps.adapter?.capabilities.has("install"))) };
    },
    listStatuses: () => [...new Set([...known.keys(),...listAdoptions(ctx()).map(value=>value.installationId)])].map(id => runtime.status(id)),
    boundClientId: id => requireSession(id).desktopClientId,
    check: request => startNetwork(request, "check"), download: request => startNetwork(request, "download"),
    async restart(request) {
      const session = await verified(request.installationId);
      if (request.clientId !== session.desktopClientId || !native.authorizeInstall || !native.verifyOutcome || !deps.adapter?.capabilities.has("install")) throw unavailable();
      const current = record(request.installationId), next = requestRestart(current, request, clock.bootId());
      if (next !== current) {
        let saved: UpdateRecord;
        try { saved = persist(next); }
        catch (error) {
          if (!(error instanceof CoreError) || error.code !== "conflict") throw error;
          const fresh = record(request.installationId);
          if (requestRestart(fresh, request, clock.bootId()) !== fresh) throw error;
          saved = fresh;
        }
        waitingSessions.set(saved.transactionId!, session.sessionId);
      } else if (waitingSessions.get(next.transactionId!) !== session.sessionId) throw conflict();
      return runtime.status(request.installationId);
    },
    async adopt(request){operational();installation(request.installationId);await adoption.adopt(request);return runtime.status(request.installationId);},
    async adoptCancel(request){operational();installation(request.installationId);await adoption.cancel(request);return runtime.status(request.installationId);},
    async cancel(request) {
      operational(); installation(request.installationId);
      const current = record(request.installationId);
      if (replay(current, request, "cancel")) return runtime.status(request.installationId);
      if (current.phase === "waiting") persist(rememberRequest(cancelRestart(current), request, "cancel"));
      else if (["checking", "downloading"].includes(current.phase)) {
        const operation = active.get(request.installationId); if (!operation) throw conflict();
        persist(rememberRequest(resetAfterNetwork(current, operation.previous), request, "cancel"));
        active.delete(request.installationId); operation.controller.abort();
      } else throw conflict();
      return runtime.status(request.installationId);
    },
    configure(request) {
      requireSession(request.installationId);
      commitRequest(request, "configure", current => {
        if (["reserved", "installing", "verifying", "rolling-back", "recovery-failed"].includes(current.phase)) throw conflict();
        return { ...current, autoDownload: request.autoDownload };
      }, { autoDownload: request.autoDownload });
      return runtime.status(request.installationId);
    },
    async start() {
      if (started) return; if (stopped) throw unavailable();
      started = true;
      try {
        await adoption.start();
        observe();
        for (const id of known.keys()) await reconcile(id);
        unsubscribe = native.subscribe(() => { void runtime.tick().catch(() => { runtimeError = true; }); });
        cancelTimer = schedule(() => { void runtime.tick().catch(() => { runtimeError = true; }); }, 0);
      } catch { runtimeError = true; throw unavailable(); }
    },
    stop() {
      if (stopped) return;
      for (const id of known.keys()) { try { revokeWaiting(id); } catch { runtimeError = true; } }
      stopped = true; adoption.stop(); cancelTimer?.(); unsubscribe?.();
    },
    async tick() {
      if (!started || stopped || ticking || runtimeError) return;
      ticking = true; cancelTimer?.();
      try {
        observe();
        await adoption.tick();
        for (const id of known.keys()) {
          const adopted=readAdoption(ctx(),id);if(adopted&&adoptionPending(adopted))continue;
          if (await reconcile(id)) continue;
          const value = record(id);
          if (value.phase === "waiting") { await advanceWaiting(id); continue; }
          if (active.has(id) || pendingPhase(value) || !liveSession(id) || !checksEnabled(ctx())) continue;
          if (!nextCheck.has(id)) nextCheck.set(id, checkDue(value.checkedAt, clock.nowS()) ? clock.monotonicMs() : clock.monotonicMs() + Math.max(0, 86400 - (clock.nowS() - value.checkedAt!)) * 1000 + jitter());
          if (clock.monotonicMs() >= nextCheck.get(id)!) {
            try { await runtime.check({ installationId: id, requestId: randomUUID(), expectRevision: value.revision }); }
            catch (error) { if (!superseded(error)) throw error; }
          }
        }
      } finally { ticking = false; if (!stopped) cancelTimer = schedule(() => { void runtime.tick().catch(() => { runtimeError = true; }); }, 1000); }
    },
    async settled() { await adoption.settled(); while (jobs.size) await Promise.all([...jobs]); await publications; },
  };
  return runtime;
}
