import { resolve } from "node:path";
import { shellCommand } from "./fsx";
import { selfCommand } from "../tasks/api";

export function pacerArgv(
  env: NodeJS.ProcessEnv,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  const command = env.PACER_BIN ? [env.PACER_BIN] : selfCommand(argv, execPath);
  validateInstallArgv(env, command);
  return command;
}

export function isDevArgv(a: string[]): boolean {
  return a.length > 1;
}

export function validateInstallArgv(env: NodeJS.ProcessEnv, argv: string[]): void {
  if (!env.PACER_BIN && argv.some(arg => resolve(arg).includes("/.worktrees/"))) {
    throw new Error(`Refusing to install transient worktree command ${shellCommand(argv)}; set PACER_BIN to a stable pacer executable.`);
  }
}
