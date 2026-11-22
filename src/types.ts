export * from "@pacer/protocol-schema/shared/usage-types";

export interface RunResult { timedOut?: boolean; code: number; stdout: string; stderr: string; stdoutOverflow?: boolean }
export type RunFn = (argv: string[], timeoutMs: number, options?: { env?: Record<string, string | undefined>; stdin?: string; stdinUntilResponseId?: number; maxStdoutBytes?: number }) => Promise<RunResult>;

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