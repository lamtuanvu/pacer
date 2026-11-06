import type { Ctx } from "./types";
import type { Result } from "./commands/types";

type Main = (argv: string[], ctx?: Ctx) => Promise<Result>;
let registered: Main | undefined;

/**
 * cli.ts registers its main here while it loads. A command that needs to run another CLI command
 * must not `await import("../cli")`: when cli.ts is the entry module it is still evaluating its
 * top-level `await main(...)`, so that import never settles and the process hangs.
 */
export function registerCliMain(main: Main): void { registered = main; }

export async function cliMain(): Promise<Main> {
  return registered ?? (await import("./cli")).main;
}
