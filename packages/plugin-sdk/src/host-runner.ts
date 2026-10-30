/** Host-runner wire types for plugins serving the staged extension point. */
export type HostRunnerScript = "CODEX_USAGE" | "PROBE" | "CHECK_REPO" | "SET_IDENTITY" | "PREPARE" | "QUESTION" | "PREFLIGHT" | "BUNDLE_OUT" | "CLEAN" | "BINARY" | "SESSION_FILES" | "SESSION_PIPE" | "SESSION_SOCKET" | "START" | "REPORT" | "READ_FROM" | "STOP";
export interface HostRunnerSession { session:string }
export interface HostRunnerRequest extends HostRunnerSession { script:HostRunnerScript;args:string[];timeoutMs:number }
export interface HostRunnerRunInput extends HostRunnerRequest { stdin?:string;maxBytes:number }
export interface HostRunnerRunResult { code:number;stdout:string;stderr:string;timedOut:boolean }
export interface HostRunnerFetchResult { name:string;bytes:number;sha256:string }
