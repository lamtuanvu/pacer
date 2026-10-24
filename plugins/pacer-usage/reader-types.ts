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
