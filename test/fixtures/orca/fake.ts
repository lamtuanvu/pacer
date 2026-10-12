import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFn, RunResult } from "../../../src/types";

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, name), "utf8");
}
export const ok = (name: string): RunResult => ({ code: 0, stdout: fixture(name), stderr: "" });
export const fail = (name: string): RunResult => ({ code: 1, stdout: fixture(name), stderr: "" });
export const raw = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });

export type Reply = RunResult | ((argv: string[]) => RunResult);
export type Route = [string[], Reply | Reply[]];

export interface FakeRun {
  run: RunFn;
  calls: string[][];
  timeouts: number[];
  count: (prefix: string[]) => number;
}

const starts = (argv: string[], prefix: string[]) => prefix.every((p, i) => argv[i] === p);

/**
 * A scripted RunFn: the first route whose prefix starts argv answers. Its replies are used in
 * order and the last one repeats. Unmatched calls return code 99 so a test fails loudly.
 */
export function fakeRun(routes: Route[]): FakeRun {
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const used = new Map<number, number>();
  const run: RunFn = async (argv, timeoutMs) => {
    calls.push(argv);
    timeouts.push(timeoutMs);
    const idx = routes.findIndex(([prefix]) => starts(argv, prefix));
    if (idx < 0) return { code: 99, stdout: "", stderr: `fakeRun: no route for ${argv.join(" ")}` };
    const replies = routes[idx][1];
    const list: Reply[] = Array.isArray(replies) ? replies : [replies];
    const n = used.get(idx) ?? 0;
    used.set(idx, n + 1);
    const r = list[Math.min(n, list.length - 1)];
    return typeof r === "function" ? r(argv) : r;
  };
  return { run, calls, timeouts, count: (prefix) => calls.filter((a) => starts(a, prefix)).length };
}
