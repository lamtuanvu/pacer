import { scheduleDeadline } from "../deadline";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";

export interface CallResources {
  /** One exact persisted detached wrapper read, issued by the service only. */
  detachedInspect?: { taskId: string; rev: number; attempt: number; dir: string;
    dirIdentity: { dev: number; ino: number }; startedAt: number; executor: string };
  /** One exact persisted detached wrapper stop, issued by the service only. */
  detachedStop?: { taskId: string; rev: number; attempt: number; dir: string;
    dirIdentity: { dev: number; ino: number }; pid: number; startedAt: number;
    executor: string; graceMs: number };
  /** One exact task-owned detached wrapper launch, issued by the service only. */
  detachedRun?: { taskId: string; rev: number; attempt: number; dir: string;
    dirIdentity: { dev: number; ino: number }; argv: string[]; cwd: string;
    executable: string; executableIdentity: { dev: number; ino: number; size: number; mtimeMs: number; mode: number };
    cwdIdentity: { dev: number; ino: number }; env: Record<string, string>; stdin?: string };
  /** Host-issued secret-reference aliases; names only, never credential values. */
  secretAliases?: Record<string, string>;
  /** Exact hostnames derived only from validated host configuration/grants. */
  http?: { hosts: string[] };
  writes?: { path: string; root?: string; rootIdentity?: { dev: number; ino: number };
    kind: "file" | "directory"; operations: ("write" | "mkdir" | "remove")[] }[];
  reads: { path: string; kind: "file" | "codex-logs" }[];
  commands: {
    argv: string[];
    timeoutMs: number;
    /** Exact UTF-8 process input issued by the host, bounded at admission. */
    stdin?: string;
    cwd?: string;
    env?: Record<string, string>;
    secretEnv?: Record<string, string>;
    /** Host-only policy: discard child streams before run-file capture or plugin reply. */
    suppressOutput?: boolean;
    /** Host-only run files receiving the bounded child output; never selected by plugin RPC params. */
    capture?: { stdout: string; stderr: string };
    /** Host-only fixed interactive exchange; never selected by plugin RPC params. */
    mode?: "codex-live" | "prepare-bundle" | "binary-upload" | "start-input" | "session-duplex";
    /** Host-only bounded input, never provided through the plugin RPC. */
    input?: Uint8Array;
    inputSha256?: string;
  }[];
  /** Exact, one-use host operations issued by the owning service call, never by a plugin RPC. */
  hosts?: HostOperationResource[];
  /** One-use, host-issued binary SSH stages. Never derived from plugin RPC params. */
  bundleStages?: BundleStageResource[];
  stores: { id: string; path: string; kind: "cache" | "cursors"; version?: number; root?: string }[];
}
export interface HostOperationResource {
  alias: string;
  hostFingerprint: string;
  script: string;
  args: string[];
  timeoutMs: number;
  maxBytes: number;
}
export interface BundleStageResource {
  alias: string;
  hostFingerprint: string;
  args: [string, string, string];
  argv: string[];
  timeoutMs: number;
  maxBytes: number;
}
export interface AuthorityOptions { deadlineMs: number; signal?: AbortSignal; grants?: readonly string[]; accountHome?: string | null;
  /** Only the private owner-bound host stream may omit a wall deadline. */ ownerBoundStream?: boolean;
  /** Host-only synchronous admission around the actual spawn, never sent to a plugin. */
  spawnAdmission?: (spawn: () => ChildProcess) => ChildProcess }

/** Host-issued immutable resources. Never construct these from plugin RPC params. */
export class CallAuthority {
  readonly token = randomUUID();
  readonly resources: Readonly<CallResources>;
  private readonly grants: ReadonlySet<string>;
  private readonly controller = new AbortController();
  private readonly cleanup = new Set<() => void | Promise<void>>();
  private readonly cancelDeadline: () => void;
  private settled?: Promise<void>;
  private operation = false;
  private readonly issuedAt = Date.now();
  private readElapsed = 0;
  private readonly usedHostOperations = new Set<number>();
  private detachedRunUsed = false;
  private detachedStopUsed = false;
  private detachedInspectUsed = false;
  private readonly detach: () => void;

  constructor(readonly ctx: Ctx, resources: CallResources, readonly deadlineMs: number, parent?: AbortSignal, grants: readonly string[] = [], readonly accountHome: string | null = null,
    readonly spawnAdmission?: (spawn: () => ChildProcess) => ChildProcess) {
    this.grants = new Set(grants);
    this.resources = structuredClone(resources);
    for (const value of this.resources.commands) {
      Object.freeze(value.argv);
      if (value.env) Object.freeze(value.env);
      if (value.secretEnv) Object.freeze(value.secretEnv);
      if (value.capture) Object.freeze(value.capture);
    }
    for (const list of [this.resources.reads, this.resources.commands, this.resources.stores]) {
      for (const value of list) Object.freeze(value);
      Object.freeze(list);
    }
    if (this.resources.hosts) {
      for (const value of this.resources.hosts) { Object.freeze(value.args); Object.freeze(value); }
      Object.freeze(this.resources.hosts);
    }
    if (this.resources.bundleStages) {
      for (const value of this.resources.bundleStages) {
        Object.freeze(value.args); Object.freeze(value.argv); Object.freeze(value);
      }
      Object.freeze(this.resources.bundleStages);
    }
    if (this.resources.writes) {
      for (const resource of this.resources.writes) {
        Object.freeze(resource.operations);
        if (resource.rootIdentity) Object.freeze(resource.rootIdentity);
        Object.freeze(resource);
      }
      Object.freeze(this.resources.writes);
    }
    if (this.resources.http) { Object.freeze(this.resources.http.hosts); Object.freeze(this.resources.http); }
    if (this.resources.secretAliases) Object.freeze(this.resources.secretAliases);
    if (this.resources.detachedRun) {
      Object.freeze(this.resources.detachedRun.argv);
      Object.freeze(this.resources.detachedRun.env);
      Object.freeze(this.resources.detachedRun.dirIdentity);
      Object.freeze(this.resources.detachedRun.executableIdentity);
      Object.freeze(this.resources.detachedRun.cwdIdentity);
      Object.freeze(this.resources.detachedRun);
    }
    if (this.resources.detachedStop) {
      Object.freeze(this.resources.detachedStop.dirIdentity);
      Object.freeze(this.resources.detachedStop);
    }
    if (this.resources.detachedInspect) {
      Object.freeze(this.resources.detachedInspect.dirIdentity);
      Object.freeze(this.resources.detachedInspect);
    }
    Object.freeze(this.resources);
    const cancel = () => { void this.revoke().catch(() => {}); };
    parent?.addEventListener("abort", cancel, { once: true });
    this.detach = () => parent?.removeEventListener("abort", cancel);
    this.cancelDeadline = scheduleDeadline(deadlineMs, cancel, true);
    if (parent?.aborted) void this.revoke().catch(() => {});
  }
  /** Current host clock for public observation scope checks; resource authority stays captured. */
  readContext(): Ctx {
    this.readElapsed=Math.max(this.readElapsed,Date.now()-this.issuedAt);
    return {...this.ctx,now:this.ctx.now+this.readElapsed/1000,readOnly:true};
  }
  get signal(): AbortSignal { return this.controller.signal; }
  assertActive(): void {
    if (this.signal.aborted || Date.now() >= this.deadlineMs) {
      void this.revoke().catch(() => {});
      throw this.signal.reason instanceof CoreError ? this.signal.reason : new CoreError("capability_denied", "owning plugin call expired");
    }
  }
  assertGranted(name: string): void {
    this.assertActive();
    if (!this.grants.has(name)) throw new CoreError("capability_denied", `${name} is not granted to the owning call`);
  }
  /** Consume before provider effects; another session cannot reuse this call's grant. */
  consumeHostOperation(request: HostOperationResource): void {
    this.assertGranted("hosts");
    const issued = this.resources.hosts ?? [];
    const at = issued.findIndex((resource, index) => !this.usedHostOperations.has(index) &&
      resource.alias === request.alias && resource.hostFingerprint === request.hostFingerprint &&
      resource.script === request.script && resource.timeoutMs >= request.timeoutMs &&
      resource.maxBytes >= request.maxBytes &&
      resource.args.length === request.args.length && resource.args.every((arg, i) => arg === request.args[i]));
    if (at < 0) throw new CoreError("capability_denied", "host operation is not issued for this call");
    this.usedHostOperations.add(at);
  }
  consumeDetachedRun(taskId: string, rev: number, attempt: number): NonNullable<CallResources["detachedRun"]> {
    this.assertGranted("process.spawn");
    const grant = this.resources.detachedRun;
    if (!grant || this.detachedRunUsed || grant.taskId !== taskId || grant.rev !== rev || grant.attempt !== attempt)
      throw new CoreError("capability_denied", "detached run is not issued for this call");
    this.detachedRunUsed = true;
    return grant;
  }
  consumeDetachedStop(taskId: string, attempt: number, graceMs: number): NonNullable<CallResources["detachedStop"]> {
    this.assertGranted("process.spawn");
    const grant = this.resources.detachedStop;
    if (!grant || this.detachedStopUsed || grant.taskId !== taskId || grant.attempt !== attempt ||
      grant.graceMs !== graceMs)
      throw new CoreError("capability_denied", "detached stop is not issued for this call");
    this.detachedStopUsed = true;
    return grant;
  }
  consumeDetachedInspect(taskId: string, attempt: number): NonNullable<CallResources["detachedInspect"]> {
    this.assertGranted("process.spawn");
    const grant = this.resources.detachedInspect;
    if (!grant || this.detachedInspectUsed || grant.taskId !== taskId || grant.attempt !== attempt)
      throw new CoreError("capability_denied", "detached inspection is not issued for this call");
    this.detachedInspectUsed = true;
    return grant;
  }
  onRevoke(cleanup: () => void | Promise<void>): () => void {
    this.assertActive();
    this.cleanup.add(cleanup);
    return () => { this.cleanup.delete(cleanup); };
  }
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.assertActive();
    if (this.operation) throw new CoreError("conflict", "one capability operation is already active for this call");
    let resolve!: () => void;
    const finished = new Promise<void>(done => { resolve = done; });
    const detach = this.onRevoke(() => finished);
    this.operation = true;
    try {
      this.assertActive();
      const result = await action();
      this.assertActive();
      return result;
    } finally { this.operation = false; detach(); resolve(); }
  }
  revoke(reason?: CoreError): Promise<void> {
    if (this.settled) return this.settled;
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.settled = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.cancelDeadline(); this.detach();
    // Publish the settlement promise before abort: observers may reenter revoke().
    this.controller.abort(reason ?? new CoreError("capability_denied", "owning plugin call expired"));
    const cleanup = [...this.cleanup]; this.cleanup.clear();
    void Promise.allSettled(cleanup.map(async finish => { await finish(); })).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") reject(failed.reason);
      else resolve();
    });
    return this.settled;
  }
}
export function createCallAuthority(ctx: Ctx, resources: CallResources, options: AuthorityOptions): CallAuthority {
  if (!Number.isFinite(options.deadlineMs) && !(options.ownerBoundStream && options.deadlineMs === Infinity && options.signal))
    throw new CoreError("invalid_input", "call deadline must be finite");
  return new CallAuthority(ctx, resources, options.deadlineMs, options.signal, options.grants, options.accountHome, options.spawnAdmission);
}
