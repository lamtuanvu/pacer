import { randomUUID } from "node:crypto";
import { CoreError } from "../core/errors";
import type { BundleStageResource, CallAuthority } from "./authority";
import { HOST_RUNNER_METHODS, type HostRunnerRunInput } from "./host-runner-protocol";
import { consumePersistedFetch, validatePersistedFetch, type PersistedFetchGrant } from "./fetch-issuer";
import { issueRemotePreflight, type RemotePreflightReceipt } from "./remote-preflight";
import { beginWorkSync, finishWorkSync } from "../update/desktop/admission";

const MAX_SESSIONS_PER_CALL = 4;
const MAX_ISSUED_SESSIONS_PER_CALL = 64;
const CLOSE_DEADLINE_MS = 10_000;

type ProviderMethod = "hostRunner.open" | "hostRunner.run" | "hostRunner.close";

/** The registry binds this function to one selected, authenticated provider process. */
export interface HostLeaseProvider {
  id: string;
  generation: string;
  process: object;
  invoke(method: ProviderMethod, params: unknown, deadlineAt: number, signal: AbortSignal): Promise<unknown>;
}

export interface HostLeaseSnapshot {
  readonly alias: string;
  readonly sshTarget: string;
  readonly controlPath?: string;
  readonly hostFingerprint: string;
  readonly callerProcess: object;
  readonly callerGeneration: string;
  readonly provider: HostLeaseProvider;
}

export interface HostLeaseOpen extends HostLeaseSnapshot {}

/** Host-only binding; no plugin RPC accepts a task, path, grant or callback. */
export interface HostFetchBinding extends HostLeaseSnapshot {
  readonly providerSession: string;
  readonly resource: Readonly<BundleStageResource>;
}
export interface HostFetchResult { handle: string; bytes: number; sha256: string }

interface Lease extends HostLeaseSnapshot {
  readonly authority: CallAuthority;
  readonly session: string;
  state: "opening" | "open" | "closing" | "closed" | "retired";
  providerSession?: string;
  active?: AbortController;
  inFlight?: Promise<unknown>;
  rawInFlight?: Promise<unknown>;
  detach?: () => void;
  closeTask?: Promise<void>;
  retireTask?: Promise<void>;
  watch?: ReturnType<typeof setInterval>;
  checking?: boolean;
  fetchUsed?: boolean;
  preflightUsed?: boolean;
  fetchCleanupFailure?: CoreError;
}

export interface HostLeaseBrokerOptions {
  /** Refreshes and compares caller, host record, and provider generation at each effect. */
  validate(lease: HostLeaseSnapshot, authority: CallAuthority): void | Promise<void>;
}

function denied(message: string): CoreError {
  return new CoreError("capability_denied", message);
}

/** Only the host owns this table. Plugin RPCs see a random broker handle, never a provider handle. */
export class HostLeaseBroker {
  private readonly leases = new Map<string, Lease>();
  private readonly issued = new WeakMap<CallAuthority, number>();

  constructor(private readonly options: HostLeaseBrokerOptions) {}

  private owner(authority: CallAuthority, session: string): Lease {
    authority.assertGranted("hosts");
    const lease = this.leases.get(session);
    if (!lease || lease.authority !== authority) throw denied("unknown or foreign host session");
    return lease;
  }

  private async validate(lease: Lease): Promise<void> {
    lease.authority.assertGranted("hosts");
    try {
      await this.options.validate(lease, lease.authority);
      lease.authority.assertGranted("hosts");
      if (lease.state === "retired" || lease.state === "closed") throw denied("host session retired");
    } catch (error) {
      void this.retire(lease).catch(() => {});
      throw error;
    }
  }

  private async invoke(lease: Lease, method: ProviderMethod, params: unknown, deadlineAt: number,
    signal: AbortSignal, isCleanup = false, onLateResult?: (result: unknown) => void,
    onDispatch?: () => void): Promise<unknown> {
    if (Date.now() >= deadlineAt) throw new CoreError("plugin_timeout", "host session deadline expired");
    const controller = new AbortController();
    if (!isCleanup) lease.active = controller;
    let rejectAbort!: (reason: unknown) => void;
    const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onControllerAbort = () => rejectAbort(controller.signal.reason ?? denied("host session retired"));
    controller.signal.addEventListener("abort", onControllerAbort, { once: true });
    const cancel = () => {
      const reason = signal.reason instanceof Error ? signal.reason : denied("host session retired");
      controller.abort(reason);
      rejectAbort(reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      const failure = new CoreError("plugin_timeout", "host provider operation expired");
      controller.abort(failure);
      rejectAbort(failure);
    }, Math.max(1, deadlineAt - Date.now()));
    try {
      if (signal.aborted) cancel();
      const raw = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason ?? denied("host session retired");
        onDispatch?.();
        return lease.provider.invoke(method, params, deadlineAt, controller.signal);
      });
      if (method === "hostRunner.run" && !isCleanup) {
        lease.rawInFlight = raw;
        void raw.then(() => { if (lease.rawInFlight === raw) lease.rawInFlight = undefined; },
          () => { if (lease.rawInFlight === raw) lease.rawInFlight = undefined; });
      }
      if (onLateResult) void raw.then(value => {
        if (controller.signal.aborted) onLateResult(value);
      }, () => {});
      return await Promise.race([raw, abort]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onControllerAbort);
      if (!isCleanup && lease.active === controller) lease.active = undefined;
    }
  }

  private async closeProvider(lease: Lease, deadlineAt = Date.now() + CLOSE_DEADLINE_MS): Promise<void> {
    if (lease.closeTask) return lease.closeTask;
    if (!lease.providerSession) return;
    const session = lease.providerSession;
    lease.providerSession = undefined;
    const controller = new AbortController();
    lease.closeTask = this.invoke(lease, "hostRunner.close", { session },
      deadlineAt, controller.signal, true).then(result => {
      if (!HOST_RUNNER_METHODS["hostRunner.close"].result.safeParse(result).success)
        throw new CoreError("plugin_refused", "host provider returned invalid close result");
    });
    return lease.closeTask;
  }

  private async retire(lease: Lease): Promise<void> {
    if (lease.retireTask) return lease.retireTask;
    if (lease.state === "closed") {
      lease.detach?.();
      this.leases.delete(lease.session);
      return;
    }
    lease.state = "retired";
    if (lease.watch) clearInterval(lease.watch);
    lease.active?.abort(denied("host session retired"));
    lease.detach?.();
    this.leases.delete(lease.session);
    lease.retireTask = (async () => {
      const deadlineAt = Date.now() + CLOSE_DEADLINE_MS;
      if (lease.rawInFlight) {
        await Promise.race([lease.rawInFlight.catch(() => {}), new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(2000, Math.max(1, deadlineAt - Date.now())));
          timer.unref();
        })]);
      }
      // The provider close uses its original bound process and a fresh host-owned
      // deadline. It must never borrow the caller's already-aborted signal.
      try { await this.closeProvider(lease, deadlineAt); } catch { /* retired regardless of cleanup result */ }
      if (lease.fetchCleanupFailure) throw lease.fetchCleanupFailure;
    })();
    return lease.retireTask;
  }

  async open(authority: CallAuthority, input: HostLeaseOpen): Promise<{ session: string }> {
    authority.assertGranted("hosts");
    const parsed = HOST_RUNNER_METHODS["hostRunner.open"].params.safeParse({
      alias: input.alias, sshTarget: input.sshTarget, controlPath: input.controlPath,
    });
    if (!parsed.success || !input.hostFingerprint || !input.callerProcess || !input.callerGeneration || !input.provider?.process)
      throw new CoreError("invalid_input", "invalid host lease snapshot");
    const count = [...this.leases.values()].filter(lease => lease.authority === authority && lease.state !== "closed").length;
    if (count >= MAX_SESSIONS_PER_CALL) throw new CoreError("too_large", "too many host sessions for one call");
    const issued = this.issued.get(authority) ?? 0;
    if (issued >= MAX_ISSUED_SESSIONS_PER_CALL) throw new CoreError("too_large", "too many issued host sessions for one call");
    this.issued.set(authority, issued + 1);
    const session = randomUUID().replaceAll("-", "");
    const lease: Lease = { ...input, provider: Object.freeze({ ...input.provider }), authority, session, state: "opening" };
    this.leases.set(session, lease);
    try {
      lease.detach = authority.onRevoke(() => this.retire(lease));
      // A strategy or grant can change while a provider RPC is in flight.
      lease.watch = setInterval(() => {
        if (lease.checking || lease.state === "closed" || lease.state === "retired") return;
        lease.checking = true;
        void this.validate(lease).catch(() => {}).finally(() => { lease.checking = false; });
      }, 100);
      lease.watch.unref();
      await this.validate(lease);
      const result = await this.invoke(lease, "hostRunner.open", parsed.data,
        Math.min(authority.deadlineMs, Date.now() + HOST_RUNNER_METHODS["hostRunner.open"].deadlineMs), authority.signal,
        false, late => {
          const parsedLate = HOST_RUNNER_METHODS["hostRunner.open"].result.safeParse(late);
          if (!parsedLate.success || lease.providerSession) return;
          lease.providerSession = parsedLate.data.session;
          void this.closeProvider(lease).catch(() => {});
        });
      const output = HOST_RUNNER_METHODS["hostRunner.open"].result.safeParse(result);
      if (!output.success) throw new CoreError("plugin_refused", "host provider returned invalid open result");
      lease.providerSession = output.data.session;
      await this.validate(lease);
      if (lease.state !== "opening") throw denied("host session retired during open");
      lease.state = "open";
      return { session };
    } catch (error) {
      await this.retire(lease);
      throw error;
    }
  }

  async run(authority: CallAuthority, input: HostRunnerRunInput): Promise<unknown> {
    const lease = this.owner(authority, input.session);
    if (lease.state !== "open" || !lease.providerSession) throw denied("host session is not open");
    if (lease.inFlight) throw new CoreError("conflict", "host session already has an active run");
    await this.validate(lease);
    if (lease.state !== "open" || !lease.providerSession) throw denied("host session retired");
    if (lease.inFlight) throw new CoreError("conflict", "host session already has an active run");
    const params = { ...input, session: lease.providerSession };
    const parsed = HOST_RUNNER_METHODS["hostRunner.run"].params.safeParse(params);
    if (!parsed.success) throw new CoreError("invalid_input", "invalid host runner request");
    // A hosts grant alone authorizes only PROBE. Other operations require an
    // exact one-use resource issued by the owning host call before any effect.
    const probe = parsed.data.script === "PROBE" && parsed.data.args.length === 0;
    const repoCheck = parsed.data.script === "CHECK_REPO" && parsed.data.args.length === 2 &&
      parsed.data.args[1] === "check";
    const identity = parsed.data.script === "SET_IDENTITY" && parsed.data.args.length === 3 &&
      parsed.data.args.every(arg => arg.length > 0);
    if ((!probe && !repoCheck && !identity) || parsed.data.stdin !== undefined ||
      parsed.data.completionNonce !== undefined || parsed.data.maxBytes > 65_536)
      throw denied("host operation is not issued for this caller");
    if (repoCheck || identity) authority.consumeHostOperation({
      alias: lease.alias, hostFingerprint: lease.hostFingerprint, script: parsed.data.script,
      args: parsed.data.args, timeoutMs: parsed.data.timeoutMs, maxBytes: parsed.data.maxBytes,
    });
    // Persist the mutation blocker before issuing any SSH effect. Only a fixed
    // remote completion receipt can release it; timeout/cancel stays ambiguous.
    const completionNonce = identity ? beginWorkSync(authority.ctx, {
      kind: "operation", id: randomUUID(), label: `Remote identity operation on ${lease.alias}`,
    }) : undefined;
    let dispatched = false;
    const pending = this.invoke(lease, "hostRunner.run",
      completionNonce ? { ...parsed.data, completionNonce } : parsed.data,
      Math.min(authority.deadlineMs, Date.now() + input.timeoutMs), authority.signal,
      false, undefined, () => { dispatched = true; });
    lease.inFlight = pending;
    try {
      const result = await pending;
      const output = HOST_RUNNER_METHODS["hostRunner.run"].result.safeParse(result);
      if (!output.success || Buffer.byteLength(output.data.stdout) + Buffer.byteLength(output.data.stderr) > input.maxBytes)
        throw new CoreError("plugin_refused", "host provider returned invalid or oversized result");
      let value = output.data;
      if (completionNonce) {
        const receipt = `\n__PACER_DONE__=${completionNonce}\n`;
        if (value.timedOut || value.code === 255 || !value.stdout.endsWith(receipt))
          throw new CoreError("plugin_refused", "remote identity completion is unverified");
        finishWorkSync(authority.ctx, completionNonce);
        value = { ...value, stdout: value.stdout.slice(0, -receipt.length) };
      }
      await this.validate(lease);
      if (lease.state !== "open" && lease.state !== "closing") throw denied("host session retired");
      return value;
    } catch (error) {
      // A rejected deadline or cancellation before provider dispatch proves no
      // remote effect began. Once dispatched, only the receipt can settle it.
      if (completionNonce && !dispatched) finishWorkSync(authority.ctx, completionNonce);
      await this.retire(lease);
      throw error;
    } finally {
      if (lease.inFlight === pending) lease.inFlight = undefined;
    }
  }

  /** Host-only read-only preflight, derived from a persisted run on this exact session. */
  async preflight(authority: CallAuthority, session: string, grant: PersistedFetchGrant): Promise<RemotePreflightReceipt> {
    const lease = this.owner(authority, session);
    if (lease.state !== "open" || !lease.providerSession || lease.inFlight || lease.preflightUsed || lease.fetchUsed)
      throw denied("remote preflight session is unavailable or already used");
    validatePersistedFetch(authority.ctx, grant);
    if (grant.resource.alias !== lease.alias || grant.resource.hostFingerprint !== lease.hostFingerprint)
      throw denied("remote preflight does not match the owned host session");
    await this.validate(lease);
    if (lease.state !== "open" || !lease.providerSession || lease.inFlight)
      throw denied("remote preflight session retired");
    const binding: HostFetchBinding = Object.freeze({ alias: lease.alias, sshTarget: lease.sshTarget,
      controlPath: lease.controlPath, hostFingerprint: lease.hostFingerprint,
      callerProcess: lease.callerProcess, callerGeneration: lease.callerGeneration,
      provider: lease.provider, providerSession: lease.providerSession, resource: grant.resource });
    const deadlineAt = Math.min(authority.deadlineMs, Date.now() + 50_000);
    if (deadlineAt <= Date.now()) throw new CoreError("plugin_timeout", "remote preflight deadline expired");
    lease.preflightUsed = true;
    const params = { session: lease.providerSession, script: "PREFLIGHT", args: [...grant.resource.args],
      timeoutMs: Math.min(50_000, Math.max(1, deadlineAt - Date.now())), maxBytes: 65_536 };
    const pending = this.invoke(lease, "hostRunner.run", params, deadlineAt, authority.signal);
    lease.inFlight = pending;
    try {
      const result = await pending;
      await this.validate(lease);
      if (lease.state !== "open" || lease.providerSession !== binding.providerSession)
        throw denied("remote preflight provider session retired");
      const receipt = issueRemotePreflight(authority.ctx, grant, binding, result);
      authority.assertGranted("hosts");
      return receipt;
    } catch (error) {
      await this.retire(lease);
      throw error;
    } finally { if (lease.inFlight === pending) lease.inFlight = undefined; }
  }

  /** One host-issued fetch on an existing owner-bound session. No publication occurs here. */
  async fetch(authority: CallAuthority, session: string, grant: PersistedFetchGrant,
    effect: (binding: HostFetchBinding, signal: AbortSignal, deadlineAt: number) => Promise<HostFetchResult>,
    discardLate: (result: HostFetchResult) => void | Promise<void>): Promise<HostFetchResult> {
    const lease = this.owner(authority, session);
    if (lease.state !== "open" || !lease.providerSession) throw denied("host session is not open");
    if (lease.inFlight) throw new CoreError("conflict", "host session already has an active operation");
    if (lease.fetchUsed) throw denied("host fetch already used for this session");
    await this.validate(lease);
    if (lease.state !== "open" || !lease.providerSession) throw denied("host session retired");
    if (lease.inFlight) throw new CoreError("conflict", "host session already has an active operation");
    const resource = consumePersistedFetch(authority.ctx, grant);
    if (resource.alias !== lease.alias || resource.hostFingerprint !== lease.hostFingerprint)
      throw denied("persisted fetch does not match the owned host session");
    const deadlineAt = Math.min(authority.deadlineMs, Date.now() + resource.timeoutMs);
    if (deadlineAt <= Date.now()) throw new CoreError("plugin_timeout", "host fetch deadline expired");
    lease.fetchUsed = true;
    const binding: HostFetchBinding = Object.freeze({ alias: lease.alias, sshTarget: lease.sshTarget,
      controlPath: lease.controlPath, hostFingerprint: lease.hostFingerprint,
      callerProcess: lease.callerProcess, callerGeneration: lease.callerGeneration,
      provider: lease.provider, providerSession: lease.providerSession, resource });
    const controller = new AbortController();
    lease.active = controller;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason ?? denied("host fetch retired"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const cancel = () => controller.abort(authority.signal.reason ?? denied("host fetch owner retired"));
    authority.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new CoreError("plugin_timeout", "host fetch expired")),
      Math.max(1, deadlineAt - Date.now()));
    let produced: HostFetchResult | undefined, discarded = false;
    const discard = async (value: HostFetchResult) => {
      if (discarded) return;
      discarded = true;
      try { await discardLate(value); }
      catch {
        lease.fetchCleanupFailure ??= new CoreError("plugin_unavailable", "late host fetch cleanup failed; cleanup unverified");
        throw lease.fetchCleanupFailure;
      }
    };
    const raw = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason ?? denied("host fetch retired");
      return effect(binding, controller.signal, deadlineAt);
    });
    const tracked = raw.then(async value => {
      produced = value;
      if (controller.signal.aborted || lease.state === "retired") await discard(value);
    }, () => {});
    lease.rawInFlight = tracked;
    void tracked.finally(() => { if (lease.rawInFlight === tracked) lease.rawInFlight = undefined; }).catch(() => {});
    const pending = Promise.race([raw, aborted]);
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    lease.inFlight = settled;
    try {
      if (authority.signal.aborted) cancel();
      const result = await pending;
      await this.validate(lease);
      // The effect may finish before the deadline while the host's asynchronous
      // generation check finishes afterward. Never return that staged handle.
      if (controller.signal.aborted)
        throw controller.signal.reason ?? denied("host fetch retired");
      if (Date.now() >= deadlineAt)
        throw new CoreError("plugin_timeout", "host fetch expired");
      if ((lease.state !== "open" && lease.state !== "closing") || lease.providerSession !== binding.providerSession)
        throw denied("host fetch session retired");
      if (!result || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.handle) ||
        !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > resource.maxBytes ||
        !/^[a-f0-9]{64}$/.test(result.sha256))
        throw new CoreError("plugin_refused", "host fetch returned an invalid opaque result");
      authority.assertGranted("hosts");
      return { handle: result.handle, bytes: result.bytes, sha256: result.sha256 };
    } catch (error) {
      // A nested provider deadline may reject just after this fetch's absolute
      // deadline while its timer callback is still queued on a busy event loop.
      // Preserve the host-owned timeout instead of leaking that transport's
      // generic cancellation reason; unrelated failures retain their cause.
      const expired = !authority.signal.aborted && Date.now() >= deadlineAt &&
        error instanceof CoreError && (error.code === "plugin_timeout" ||
          (error.code === "plugin_unavailable" && error.message === "owning plugin call ended"))
        ? new CoreError("plugin_timeout", "host fetch expired") : undefined;
      controller.abort(expired ?? (error instanceof Error ? error : denied("host fetch retired")));
      if (produced) await discard(produced).catch(() => {});
      await this.retire(lease);
      throw expired ?? error;
    } finally {
      clearTimeout(timer);
      authority.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      if (lease.active === controller) lease.active = undefined;
      if (lease.inFlight === settled) lease.inFlight = undefined;
      settle();
    }
  }

  async close(authority: CallAuthority, input: { session: string }): Promise<{ ok: true }> {
    const lease = this.owner(authority, input.session);
    if (lease.state === "closed") return { ok: true };
    if (lease.state !== "open") throw denied("host session retired");
    await this.validate(lease);
    if (lease.state !== "open") throw denied("host session retired");
    lease.state = "closing";
    try {
      if (lease.inFlight) await lease.inFlight.catch(() => {});
      if (lease.state !== "closing") throw denied("host session retired during close");
      await this.closeProvider(lease);
      authority.assertGranted("hosts");
      if (lease.state !== "closing") throw denied("host session retired during close");
      lease.state = "closed";
      if (lease.watch) clearInterval(lease.watch);
      return { ok: true };
    } catch (error) {
      await this.retire(lease);
      throw error;
    }
  }
}
