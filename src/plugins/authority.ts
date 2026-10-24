import { scheduleDeadline } from "../deadline";
import { randomUUID } from "node:crypto";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";

export interface CallResources {
  /** Host-issued secret-reference aliases; names only, never credential values. */
  secretAliases?: Record<string, string>;
  /** Exact hostnames derived only from validated host configuration/grants. */
  http?: { hosts: string[] };
  reads: { path: string; kind: "file" | "codex-logs" }[];
  commands: { argv: string[]; timeoutMs: number }[];
  stores: { id: string; path: string; kind: "cache" | "cursors"; version?: number; root?: string }[];
}
export interface AuthorityOptions { deadlineMs: number; signal?: AbortSignal; grants?: readonly string[]; accountHome?: string | null }

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
  private readonly detach: () => void;

  constructor(readonly ctx: Ctx, resources: CallResources, readonly deadlineMs: number, parent?: AbortSignal, grants: readonly string[] = [], readonly accountHome: string | null = null) {
    this.grants = new Set(grants);
    this.resources = structuredClone(resources);
    for (const value of this.resources.commands) Object.freeze(value.argv);
    for (const list of [this.resources.reads, this.resources.commands, this.resources.stores]) {
      for (const value of list) Object.freeze(value);
      Object.freeze(list);
    }
    if (this.resources.http) { Object.freeze(this.resources.http.hosts); Object.freeze(this.resources.http); }
    if (this.resources.secretAliases) Object.freeze(this.resources.secretAliases);
    Object.freeze(this.resources);
    const cancel = () => { void this.revoke().catch(() => {}); };
    parent?.addEventListener("abort", cancel, { once: true });
    this.detach = () => parent?.removeEventListener("abort", cancel);
    this.cancelDeadline = scheduleDeadline(deadlineMs, cancel, true);
    if (parent?.aborted) void this.revoke().catch(() => {});
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
  if (!Number.isFinite(options.deadlineMs)) throw new CoreError("invalid_input", "call deadline must be finite");
  return new CallAuthority(ctx, resources, options.deadlineMs, options.signal, options.grants, options.accountHome);
}
