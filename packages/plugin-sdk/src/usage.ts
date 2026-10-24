export type UsageKind = "quota" | "metered" | "reactive" | "unmetered";

export type UsageSource = "status-line" | "session-log" | "provider-cli" | "metered" | "reactive" | "unmetered";

/** One usage window of one provider. Times are unix seconds. */
export interface UsageWindow {
  name: string;            // "weekly", "5h", "monthly", "7d", "limit"
  usedPct: number | null;  // null = unknown
  resetsAt: number | null; // null = no reset known / rolling
  lengthS: number;         // window length in seconds
  paced: boolean;          // true = compare against pace; false = only limit checks
  stale?: boolean;         // set by markFreshness
}

export interface UsageReading {
  alternatives?: UsageReading[];
  evidence?: AccountEvidence;
  availability?: { state: "ready" | "unavailable" | "unknown"; reason: string; validUntil: number | null };
  spending?: SpendingSignals;
  windows: UsageWindow[];
  capturedAt: number | null;
  stale: boolean;
  source?: UsageSource;
  remoteHost?: string;
  error?: string;
  spendUsd?: number; // 7-day spend for the account's model, from opencode stats
}

export interface RunResult { timedOut?: boolean; code: number; stdout: string; stderr: string }


export interface EvidenceScope { account: string; identity: string; runner?: string; model?: string; host?: string }
export interface Evidence<T> {
  /** Configuration used to derive a metered percentage; not execution identity. */
  budgetPolicy?: string;
  id: string;
  scope: EvidenceScope;
  source: UsageSource | "execution" | "configuration";
  observedAt: number | null;
  validUntil: number | null;
  reason: string;
  value: T;
}
export interface SpendingSignals {
  creditsAvailable: boolean | null;
  creditBalance: number | null;
  paidConsumption: "observed" | "not_observed" | "unknown";
}
export interface AccountEvidence {
  availability: Evidence<"ready" | "unavailable" | "unknown">[];
  budget: Evidence<UsageWindow>[];
  spending: Evidence<SpendingSignals>[];
}

/** Host capabilities only: provider readers never access ambient filesystem/process state. */
export interface FileInfo { path: string; size: number; mtimeMs: number; inode: number; device: number }
export interface Cursor<T> { size: number; mtime: number; inode: number; offset: number; aggregate: T; retainedSince?: number }
export interface Cached<T> { value: T | null; capturedAt: number | null; stale: boolean; error?: string }
export interface ReaderIO {
  read(path: string): Promise<{ text: string; mtime: number } | null>;
  list(root: string, glob: string): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo | null>;
  range(path: string, offset: number, length: number, expectedInfo: FileInfo): Promise<{ bytes: Uint8Array; info: FileInfo }>;
  run(argv: string[], timeoutMs: number): Promise<RunResult>;
  cachedFetch<T>(key: string, ttlS: number, maxStaleS: number, fetcher: () => Promise<T>,
    options: { refresh?: boolean; now: number; readOnly?: boolean }): Promise<Cached<T>>;
  cursors<T, R>(storeId: string, version: number, validAggregate: (value: unknown) => boolean,
    action: (files: Record<string, Cursor<T>>) => Promise<R>): Promise<R>;
}
export interface ReaderContext {
  io: ReaderIO;
  now: number;
  readOnly?: boolean;
  resources?: { claudeFiles?: string[]; codexSessions?: string };
}
export interface MeteredConfig { model?: string | null; weeklyTokens?: number | null; weeklyUsd?: number | null }

import type { HostClient } from "./index";
const CHUNK = 256 * 1024;
const sameFile = (a: FileInfo, b: FileInfo | undefined) => !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.inode === b.inode && a.device === b.device;
const stateMethod = (op: string) => `capability.usage.state.${op}`;

/** Per-handler adapter. Paths and store IDs remain subject to the host's captured authority. */
export function createUsageReaderIO(host: HostClient): ReaderIO {
  async function snapshot(store: string): Promise<{ lease: string; data: any; dirty: boolean }> {
    const begin = await host.call<{ lease: string; bytes: number; dirty?: boolean }>(stateMethod("begin"), { store });
    try {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < begin.bytes;) {
        const length = Math.min(CHUNK, begin.bytes - offset);
        const next = await host.call<{ base64: string }>(stateMethod("readChunk"), { lease: begin.lease, offset, length });
        const chunk = Buffer.from(next.base64, "base64");
        if (chunk.length !== length) throw Error("incomplete usage state snapshot");
        chunks.push(chunk); offset += length;
      }
      return { lease: begin.lease, data: JSON.parse(Buffer.concat(chunks).toString("utf8")), dirty: begin.dirty === true };
    } catch (error) { await host.call(stateMethod("release"), { lease: begin.lease }); throw error; }
  }
  async function stage(lease: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value));
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const part = bytes.subarray(offset, offset + CHUNK);
      const result = await host.call<{ bytes: number }>(stateMethod("stageChunk"), { lease, offset, base64: part.toString("base64") });
      if (result.bytes !== offset + part.length) throw Error("incomplete usage state staging");
    }
  }
  async function output(handle: string): Promise<string> {
    const chunks: Buffer[] = [];
    for (let offset = 0;;) {
      const next = await host.call<{ base64: string }>("capability.process.outputChunk", { handle, offset, length: CHUNK });
      const part = Buffer.from(next.base64, "base64");
      if (part.length > CHUNK) throw Error("invalid provider output chunk");
      chunks.push(part); offset += part.length;
      if (offset > 1048576) throw Error("provider output exceeds 1 MiB");
      if (part.length < CHUNK) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  return {
    async read(path) {
      const result = await host.call<any>("capability.fs.read", { path });
      if (result.missing) return null;
      if (!result.ranged) return { text: result.text, mtime: result.mtime };
      const info = result.ranged as FileInfo, chunks: Buffer[] = [];
      for (let offset = 0; offset < info.size; offset += CHUNK) {
        const result = await host.call<any>("capability.fs.readRange", { path, offset, length: Math.min(CHUNK, info.size - offset), expected: info });
        if (result.missing) throw Object.assign(Error("usage file disappeared"), { code: "ENOENT" });
        const chunk = Buffer.from(result.base64, "base64");
        if (chunk.length !== Math.min(CHUNK, info.size - offset) || !sameFile(info, result.info)) throw Error("incomplete or changed usage file range");
        chunks.push(chunk);
      }
      return { text: Buffer.concat(chunks).toString("utf8"), mtime: info.mtimeMs / 1000 };
    },
    async stat(path) { const result = await host.call<{ info?: FileInfo }>("capability.fs.stat", { path }); return result.info ?? null; },
    async list(dir, glob) {
      // The host scans the complete authorized tree and selects the newest files before limiting.
      const result = await host.call<{ files: FileInfo[] }>("capability.fs.list", { dir, glob, limit: 1000 });
      return result.files;
    },
    async range(path, offset, length, expected) {
      try {
        const result = await host.call<{ base64: string; info: FileInfo }>("capability.fs.readRange", { path, offset, length, expected });
        if ((result as any).missing) throw Object.assign(Error("usage file disappeared"), { code: "ENOENT" });
        const bytes = Buffer.from(result.base64, "base64");
        if (bytes.length !== Math.min(length, Math.max(0, expected.size - offset)) || !sameFile(expected, result.info))
          throw Error("incomplete or changed usage file range");
        return { bytes, info: result.info };
      } catch (error) {
        // The source reader treats a concurrently removed rollout as absent, not corrupt usage.
        if ((error as { code?: string }).code === "not_found") (error as { code: string }).code = "ENOENT";
        throw error;
      }
    },
    async run(argv, timeoutMs) {
      const result = await host.call<any>("capability.process.spawn", { argv, timeoutMs });
      if (!result.output) return result;
      const stdout = await output(result.output.stdout), stderr = await output(result.output.stderr);
      return { code: result.code, timedOut: result.timedOut, stdout, stderr };
    },
    async cachedFetch<T>(key: string, ttlS: number, maxStaleS: number, fetcher: () => Promise<T>, options: { refresh?: boolean; now: number; readOnly?: boolean }): Promise<Cached<T>> {
      const lease = await snapshot(key), hit = lease.data;
      let consumed = false;
      try {
        if (!options.refresh && hit && options.now >= hit.capturedAt && options.now - hit.capturedAt < ttlS)
          return { value: hit.value, capturedAt: hit.capturedAt, stale: false };
        try {
          const value = await fetcher();
          if (!options.readOnly) {
            await stage(lease.lease, { capturedAt: options.now, value });
            consumed = true; // Commit consumes the lease even if persistence/cleanup rejects.
            await host.call(stateMethod("commit"), { lease: lease.lease });
          }
          return { value, capturedAt: options.now, stale: false };
        } catch (error) {
          const message = (error as Error).message;
          if (hit && options.now >= hit.capturedAt && options.now - hit.capturedAt < maxStaleS)
            return { value: hit.value, capturedAt: hit.capturedAt, stale: true, error: message };
          return { value: null, capturedAt: null, stale: false, error: message };
        }
      } finally { if (!consumed) await host.call(stateMethod("release"), { lease: lease.lease }); }
    },
    async cursors<T, R>(store: string, version: number, validAggregate: (value: unknown) => boolean, action: (files: Record<string, Cursor<T>>) => Promise<R>): Promise<R> {
      const lease = await snapshot(store);
      let consumed = false;
      try {
        const files: Record<string, Cursor<T>> = {};
        if (lease.data?.version === version && lease.data.files && typeof lease.data.files === "object" && !Array.isArray(lease.data.files)) {
          for (const [path, value] of Object.entries(lease.data.files)) {
            const c = value as Cursor<T> | null;
            if (c && Number.isFinite(c.offset) && c.offset >= 0 && c.offset <= c.size && Number.isFinite(c.size)
              && Number.isFinite(c.mtime) && validAggregate(c.aggregate)) files[path] = c;
          }
        }
        let dirty = false;
        const tracked = new Proxy(files, {
          set(target, path: string, value: Cursor<T>) { if (target[path] !== value) dirty = true; target[path] = value; return true; },
          deleteProperty(target, path: string) { if (Object.hasOwn(target, path)) dirty = true; delete target[path]; return true; },
        });
        const result = await action(tracked);
        // Persistence errors never discard a successfully interpreted Codex reading.
        try {
          await stage(lease.lease, { version, files });
          consumed = true;
          await host.call(stateMethod("commit"), { lease: lease.lease, dirty: dirty || lease.dirty });
        } catch { /* The host retains its prior snapshot/dirty retry; logs remain authoritative. */ }
        return result;
      } finally { if (!consumed) await host.call(stateMethod("release"), { lease: lease.lease }); }
    },
  };
}
