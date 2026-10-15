import type { RunState } from "./run";

/** A connection failure is distinct from a wrapper that is no longer alive. */
export class Unreachable extends Error {
  constructor(message: string) { super(message); this.name = "Unreachable"; }
}

export interface RunIO {
  read(): Promise<RunState>;
  stop(o: { graceMs: number; sleep: (ms: number) => Promise<void> }): Promise<{ code: number; killed: boolean }>;
}
