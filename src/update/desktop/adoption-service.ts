/** Service-owned adoption orchestration. No coordinator callback crosses a native await. */
import { CoreError } from "../../core/errors";
import type { Ctx } from "../../types";
import type { VerifiedNativeSession } from "./service";
import { sameProcess } from "./process-identity";
import {
  AdapterError,
  runAdapterCommand,
  type PreparedFrame,
  type VerifiedPipeFactory,
} from "./adapter";
import {
  beginAdoption,
  cancelAdoption,
  replayAdoptionRequest,
  listAdoptions,
  readAdoption,
  transitionAdoption,
  type AdoptionRecord,
  type AdoptionAuthority,
} from "./adoption-store";
import { adoptionPending } from "./adoption-state";
import * as admission from "./admission";
import type { Installation, UpdateRequest } from "./types";
export interface AdoptionNative {
  sessions(): readonly VerifiedNativeSession[];
  reverify(session: VerifiedNativeSession): Promise<void>;
  inspectAdoption?(session: VerifiedNativeSession): AdoptionAuthority;
  authorizeAdoption?(
    session: VerifiedNativeSession,
    record: AdoptionRecord,
    prepared: PreparedFrame,
  ): Promise<boolean>;
  verifyAdoptionOutcome?(
    record: AdoptionRecord,
    outcome: "committed" | "restored",
  ): Promise<{ installation: Installation; attempted: boolean }>;
}
interface Dependencies {
  native: AdoptionNative;
  adapter?: VerifiedPipeFactory;
  admission?: Pick<typeof admission, "reserveIdle" | "releaseReservation">;
  bootId: () => string;
  changed?: (record: AdoptionRecord) => void;
  completed?: (oldId: string, installation: Installation) => void;
}
const unavailable = () =>
  new CoreError(
    "not_allowed",
    "Verified desktop service adoption is unavailable",
    "Connect the supported signed desktop to the inspected service.",
  );
export function createAdoptionRuntime(getCtx: () => Ctx, deps: Dependencies) {
  const gate = deps.admission ?? admission,
    active = new Map<
      string,
      { controller: AbortController; promise: Promise<void> }
    >();
  let stopped = false,
    started = false;
  const record = (id: string) => readAdoption(getCtx(), id);
  const session = (value: AdoptionRecord) =>
    deps.native
      .sessions()
      .find(
        (s) =>
          s.alive() &&
          s.bootId === deps.bootId() &&
          s.installation.appPath === value.authority.target.appPath &&
          s.installation.pacerHome === value.authority.target.pacerHome,
      );
  const permitted = (s: VerifiedNativeSession, value: AdoptionRecord) =>
    s.sessionId === value.authority.nativeSessionId &&
    s.desktopClientId === value.authority.desktopClientId &&
    sameProcess(s.desktop, value.authority.desktop) &&
    sameProcess(s.service, value.authority.service) &&
    s.bootId === value.authority.bootId;
  const change = (
    value: AdoptionRecord,
    phase: AdoptionRecord["phase"],
    patch: Parameters<typeof transitionAdoption>[4] = {},
  ) => {
    const next = transitionAdoption(
      getCtx(),
      value.installationId,
      value.revision,
      phase,
      patch,
    );
    deps.changed?.(next);
    return next;
  };
  const cancelWaiting = async (value: AdoptionRecord) => {
    const current = record(value.installationId);
    if (
      current?.phase === "waiting" &&
      current.transactionId === value.transactionId
    ) {
      change(current, "cancelled");
      await gate.releaseReservation(getCtx(), value.transactionId);
    }
  };
  const capable = () =>
    !!deps.native.inspectAdoption &&
    !!deps.native.authorizeAdoption &&
    !!deps.native.verifyAdoptionOutcome &&
    !!deps.adapter?.capabilities.has("adopt") &&
    !!deps.adapter.capabilities.has("recover-adoption");
  async function run(
    value: AdoptionRecord,
    s: VerifiedNativeSession,
    recovery: boolean,
    controller: AbortController,
  ) {
    try {
      const result = await runAdapterCommand(
        deps.adapter,
        {
          command: recovery ? "recover-adoption" : "adopt",
          installationId: value.installationId,
          revision: value.revision,
          transactionId: value.transactionId,
          ...(!recovery ? { target: value.authority.target } : {}),
        } as Parameters<typeof runAdapterCommand>[1],
        {
          signal: controller.signal,
          authorizeInstall: async (prepared) => {
            const current = record(value.installationId);
            if (
              stopped ||
              !current ||
              current.phase !== "reserved" ||
              current.transactionId !== value.transactionId ||
              !permitted(s, current) ||
              !s.alive()
            )
              return false;
            await deps.native.reverify(s);
            if (stopped || !s.alive()) return false;
            return await deps.native.authorizeAdoption!(s, current, prepared);
          },
          onAuthorized: () => {
            const current = record(value.installationId);
            if (
              !current ||
              current.phase !== "reserved" ||
              current.transactionId !== value.transactionId
            )
              throw unavailable();
            change(current, "installing");
          },
        },
      );
      if (result.kind !== "outcome") throw unavailable();
      const current = record(value.installationId);
      if (!current || current.transactionId !== value.transactionId)
        throw unavailable();
      if (result.outcome === "recovery-failed") {
        change(current, "recovery-failed", {
          error: {
            code: "recovery_failed",
            message: "Desktop service adoption requires recovery",
          },
        });
        return;
      }
      const proof = await deps.native.verifyAdoptionOutcome!(
        current,
        result.outcome,
      );
      if (
        typeof proof.attempted !== "boolean" ||
        proof.installation.appPath !== value.authority.target.appPath ||
        proof.installation.pacerHome !== value.authority.target.pacerHome ||
        proof.installation.port !== value.authority.target.port ||
        proof.installation.bundleId !== value.authority.target.bundleId ||
        proof.installation.ownerUid !== value.authority.target.ownerUid ||
        proof.installation.arch !== value.authority.target.arch ||
        proof.installation.version !== value.authority.target.version ||
        proof.installation.serviceLabel !== value.authority.target.serviceLabel
      )
        throw unavailable();
      if (
        result.outcome === "committed" &&
        (!proof.attempted ||
          proof.installation.ownership !== "managed" ||
          proof.installation.id === value.installationId)
      )
        throw unavailable();
      if (
        result.outcome === "restored" &&
        (proof.installation.ownership !== "attached" ||
          proof.installation.id !== value.installationId)
      )
        throw unavailable();
      const latest = record(value.installationId)!;
      // The helper proof permits a direct terminal transition; no fabricated update phase/candidate.
      if (result.outcome === "committed" && latest.phase !== "verifying")
        change(latest, "verifying");
      const terminal = change(record(value.installationId)!, result.outcome, {
        resultingInstallationId: proof.installation.id,
        error: null,
        blockers: [],
      });
      await gate.releaseReservation(getCtx(), terminal.transactionId);
      deps.completed?.(value.installationId, proof.installation);
    } catch (error) {
      const current = record(value.installationId);
      if (
        !current ||
        current.transactionId !== value.transactionId ||
        !adoptionPending(current)
      )
        return;
      if (
        !recovery &&
        error instanceof AdapterError &&
        error.handoff === "none"
      ) {
        change(current, "cancelled", {
          error: { code: "pre_handoff", message: error.message },
        });
        await gate.releaseReservation(getCtx(), value.transactionId);
      } else
        change(current, "recovery-failed", {
          error: {
            code: "handoff_uncertain",
            message: "Retain the adoption reservation for native recovery",
          },
        });
    }
  }
  function launch(
    value: AdoptionRecord,
    s: VerifiedNativeSession,
    recovery: boolean,
  ) {
    if (active.has(value.transactionId)) return;
    const controller = new AbortController();
    const promise = run(value, s, recovery, controller).finally(() =>
      active.delete(value.transactionId),
    );
    active.set(value.transactionId, { controller, promise });
    void s.closed.then(() => controller.abort());
  }
  return {
    capable,
    async adopt(input: UpdateRequest) {
      if (stopped) throw unavailable();
      const replay = replayAdoptionRequest(getCtx(), input);
      if (replay) return replay;
      if (!capable()) throw unavailable();
      const s = deps.native
        .sessions()
        .find(
          (s) =>
            s.installation.id === input.installationId &&
            s.alive() &&
            s.bootId === deps.bootId(),
        );
      if (!s) throw unavailable();
      await deps.native.reverify(s);
      if (!s.alive()) throw unavailable();
      const next = beginAdoption(
        getCtx(),
        input,
        deps.native.inspectAdoption!(s),
      );
      deps.changed?.(next);
      return next;
    },
    async cancel(input: UpdateRequest) {
      if (stopped) throw unavailable();
      const next = cancelAdoption(getCtx(), input);
      await gate.releaseReservation(getCtx(), next.transactionId);
      deps.changed?.(next);
      return next;
    },
    async start() {
      if (started) return;
      started = true;
      for (const value of listAdoptions(getCtx()))
        if (value.phase === "waiting") await cancelWaiting(value);
    },
    async tick() {
      if (stopped) return;
      for (let value of listAdoptions(getCtx()).filter(adoptionPending)) {
        if (active.has(value.transactionId)) continue;
        const s = session(value);
        if (value.phase === "waiting") {
          if (!s || !permitted(s, value)) {
            await cancelWaiting(value);
            continue;
          }
          try {
            await deps.native.reverify(s);
          } catch {
            await cancelWaiting(value);
            continue;
          }
          const reservation = await gate.reserveIdle(
            getCtx(),
            value.transactionId,
          );
          const current = record(value.installationId);
          if (
            !current ||
            current.transactionId !== value.transactionId ||
            current.phase !== "waiting"
          ) {
            if (reservation.reserved)
              await gate.releaseReservation(getCtx(), value.transactionId);
            continue;
          }
          if (!reservation.reserved) {
            change(current, "waiting", { blockers: reservation.blockers });
            continue;
          }
          if (stopped || !s.alive() || !permitted(s, current)) {
            await cancelWaiting(current);
            continue;
          }
          value = change(current, "reserved", { blockers: [] });
          launch(value, s, false);
        } else if (s && capable()) {
          await deps.native.reverify(s);
          launch(value, s, true);
        }
      }
    },
    async settled() {
      while (active.size)
        await Promise.all([...active.values()].map((x) => x.promise));
    },
    stop() {
      stopped = true;
      for (const value of active.values()) value.controller.abort();
    },
  };
}
