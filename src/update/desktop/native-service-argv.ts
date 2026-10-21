import { realpathSync } from "node:fs";

/** Bun's compiled argv begins with `bun` and its virtual entrypoint. The signed
 * executable has already been independently verified by the native provider. */
export function nativeServiceArgv(): string[] {
  if (!Bun.isStandaloneExecutable)
    throw Error("Native service requires the compiled signed baseline");
  return [realpathSync(process.execPath), ...process.argv.slice(2)];
}
