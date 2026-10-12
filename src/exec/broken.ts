import { createHash } from "node:crypto";
import { readFileSync, readlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import type { ExecResult } from "./process";

export interface BrokenMark { until: number; reason: string }
export function readBroken(ctx: Ctx): Record<string, BrokenMark> {
  const raw = readJson<Record<string, BrokenMark>>(join(ctx.pacerHome, "broken.json")) ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([, m]) => m && typeof m.until === "number" && typeof m.reason === "string" && m.until > ctx.now));
}
export function markBroken(ctx: Ctx, id: string, reason: string): void {
  writeJsonAtomic(join(ctx.pacerHome, "broken.json"), { ...readBroken(ctx), [id]: { until: ctx.now + 1800, reason } });
}
const USAGE_ERRORS = [
  /(?:unknown|unrecognized|unexpected|invalid) (?:option|argument|flag)\b/i,
  /(?:option|argument|flag) .*?(?:requires|expected|missing|not recognized|not supported)/i,
  /error: -p took .*? as its prompt/i,
  /(?:error:.*\n)?usage:\s*(?:agy|codex|cursor-agent|agent|claude|opencode)\b/i,
  /\bENOENT\b|command not found|executable not found/i,
];
/** CLI startup errors only: task failures and timeouts never qualify. */
export function brokenReason(exec: ExecResult, durationS: number, unchanged: boolean): string | null {
  if (!unchanged || durationS < 0 || durationS > 10 || exec.code === 0 || exec.timedOut) return null;
  const text = exec.stderr.slice(-8000);
  if (![126, 127].includes(exec.code) && !USAGE_ERRORS.some(re => re.test(text))) return null;
  return (text.trim().replace(/\s+/g, " ") || `CLI exited with code ${exec.code}`).slice(0, 500);
}
/** Compare content, including dirty files, untracked files and commits. Unknown never means unchanged. */
export async function repoFingerprint(ctx: Ctx, repo: string): Promise<string | null> {
  try {
    const results = await Promise.all([
      ctx.run(["git", "-C", repo, "rev-parse", "HEAD"], 5000),
      ctx.run(["git", "-C", repo, "diff", "--binary", "HEAD"], 5000),
      ctx.run(["git", "-C", repo, "ls-files", "--others", "--exclude-standard", "-z"], 5000),
    ]);
    if (results.some(r => r.code !== 0)) return null;
    const hash = createHash("sha256");
    for (const r of results) hash.update(r.stdout).update("\0");
    for (const path of results[2].stdout.split("\0").filter(Boolean)) {
      const file = join(repo, path);
      hash.update(path).update("\0").update(lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file)).update("\0");
    }
    return hash.digest("hex");
  } catch { return null; }
}
