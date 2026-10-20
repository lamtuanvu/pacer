export type Verdict =
  | "EXHAUSTED" | "NEAR_LIMIT" | "AHEAD" | "ON_PACE" | "BEHIND" | "EXPIRING" | "OK" | "UNKNOWN";

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
  evidence?: import("./evidence/types").AccountEvidence;
  availability?: { state: "ready" | "unavailable" | "unknown"; reason: string; validUntil: number | null };
  spending?: import("./evidence/types").SpendingSignals;
  windows: UsageWindow[];
  capturedAt: number | null;
  stale: boolean;
  source?: UsageSource;
  remoteHost?: string;
  error?: string;
}

export interface RunResult { timedOut?: boolean; code: number; stdout: string; stderr: string }
export type RunFn = (argv: string[], timeoutMs: number, options?: { env?: Record<string, string | undefined>; stdin?: string }) => Promise<RunResult>;

export interface Ctx {
  readOnly?: boolean; // Suppress cache writes for strategy previews.
  home: string;       // user home (agent logs live under it)
  pacerHome: string;  // pacer state dir
  now: number;        // unix seconds
  env: Record<string, string | undefined>;
  run: RunFn;
  which: (bin: string) => string | null;
}
