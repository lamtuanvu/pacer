import { selfCommand } from "../tasks/api";

export function pacerArgv(
  env: NodeJS.ProcessEnv,
  argv: string[] = process.argv,
  execPath: string = process.execPath,
): string[] {
  return env.PACER_BIN ? [env.PACER_BIN] : selfCommand(argv, execPath);
}

export function isDevArgv(a: string[]): boolean {
  return a.length > 1;
}
