import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFn } from "../src/types";

export const PACER = ["/opt/pacer/bin/pacer"];
export function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string, relative: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".pacer") continue;
      const path = join(dir, entry.name);
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path, key);
      else files[key] = readFileSync(path).toString("latin1");
    }
  }
  walk(root, "");
  return files;
}
export function recordingRun(calls: string[][], code = 0): RunFn {
  return async (argv, timeout) => {
    if (timeout !== 30000) throw new Error(`unexpected timeout ${timeout}`);
    calls.push([...argv]);
    return { code, stdout: "", stderr: code ? "not available\nmore detail" : "" };
  };
}
