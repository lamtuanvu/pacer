export type Verdict =
  | "EXHAUSTED" | "NEAR_LIMIT" | "AHEAD" | "ON_PACE" | "BEHIND" | "EXPIRING" | "OK" | "UNMETERED" | "UNKNOWN";

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

/** One usage window after evaluation: it carries its own freshness and verdict. */
export interface UsageWindowState extends UsageWindow {
  verdict: Verdict;
  pace?: number;
  delta?: number;
  activeHoursLeft?: number;
  rolled?: boolean;
}

export type UsageFreshness = "fresh" | "historical" | "unknown";

/** The figure a record is quoted from: 100% over "limit" while a limit mark is active. */
export interface UsageFigure {
  usedPct: number;
  window: string;
  lengthS: number;
  resetsAt: number | null;
}

/** An active limit mark or limit fact that covers the whole record scope. */
export interface UsageLimit {
  until: number;
  observedAt: number | null;
  manual: boolean;
}

/** One runner of an account that cannot take work now; account records only. */
export interface BlockedRunner {
  runner: string;
  model: string;
  until: number | null;
  reason: "quota_failure" | "authentication_failed" | "subscription_missing";
}

/**
 * The one usage record every surface reads (ADR 0030). `computeStatus` emits one
 * per account and one per runner; account records also list `blockedRunners`.
 */
export interface UsageState {
  scope: { account: string; runner?: string };
  source: UsageSource | "unknown";
  figure: UsageFigure | null; // null = no figure
  windows: UsageWindowState[]; // every measured window, each with its own freshness
  limit: UsageLimit | null; // applies to this whole scope
  blockedRunners: BlockedRunner[]; // account records only
  observedAt: number | null; // when the binding fact was observed
  freshness: UsageFreshness;
  verdict: Verdict; // EXHAUSTED when `limit` is active
  eligibility: import("./evidence/types").EligibilityDecision;
  spend: { usdWeek: number; capUsdWeek: number | null } | null;
  error: { message: string; at: number } | null;
}

export interface UsageReading {
  alternatives?: UsageReading[];
  evidence?: import("./evidence/types").AccountEvidence;
  availability?: { state: "ready" | "unavailable" | "unknown"; reason: string; validUntil: number | null };
  spending?: import("./evidence/types").SpendingSignals;
  windows: UsageWindow[];
  capturedAt: number | null;
  stale: boolean;
  source?: UsageSource;
  remoteHost?: string;
  error?: string;
  /** The CoreError code behind `error`, when the read threw one. */
  errorCode?: string;
  spendUsd?: number; // 7-day spend for the account's model, from opencode stats
}

export interface RunResult { timedOut?: boolean; code: number; stdout: string; stderr: string; stdoutOverflow?: boolean }
export type RunFn = (argv: string[], timeoutMs: number, options?: {
  env?: Record<string, string | undefined>;
  stdin?: string;
  stdinUntilResponseId?: number;
  maxStdoutBytes?: number;
  /** Working directory for the child (defaults to process.cwd()). */
  cwd?: string;
}) => Promise<RunResult>;

export interface Ctx {
  /** Trusted request lifetime. Never accept from wire params or retain for detached work. */
  operation?: { readonly signal: AbortSignal; readonly deadline?: number };
  readOnly?: boolean; // Suppress cache writes for strategy previews.
  home: string;       // user home (agent logs live under it)
  pacerHome: string;  // pacer state dir
  now: number;        // unix seconds
  env: Record<string, string | undefined>;
  run: RunFn;
  which: (bin: string) => string | null;
}
