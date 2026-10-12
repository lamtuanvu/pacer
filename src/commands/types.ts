import type { Ctx } from "../types";

export type Result = { code: number; out: string; err: string; keepAlive?: boolean };

/** A CLI command added by a later plan. `usage` is one help line (command + aligned description). */
export interface Command {
  name: string;
  usage: string;
  run: (args: string[], ctx: Ctx) => Promise<Result> | Result;
}
