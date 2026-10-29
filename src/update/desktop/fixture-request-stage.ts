/** Disposable old-Core request trace. Only a compiled native fixture calls this. */
import { lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compiledNativeFixture } from "./native-fixture";

export type BaselineRequestStage =
  | "request-arrival" | "api-entry" | "route-dispatch" | "adopt-entry"
  | "replay-enter" | "replay-exit" | "reverify-enter" | "reverify-exit"
  | "begin-enter" | "begin-exit" | "cancel-startup" | "cancel-no-session"
  | "cancel-not-permitted" | "cancel-reverify" | "cancel-after-reserve";

const stageNames = new Set<BaselineRequestStage>([
  "request-arrival", "api-entry", "route-dispatch", "adopt-entry", "replay-enter", "replay-exit",
  "reverify-enter", "reverify-exit", "begin-enter", "begin-exit",
  "cancel-startup", "cancel-no-session", "cancel-not-permitted", "cancel-reverify",
  "cancel-after-reserve",
]);

/** The compiled policy fixes the destination; no API input or environment chooses it. */
export function createBaselineRequestRecorder(
  policy: { root: string; uid: number },
  now: () => number = Date.now,
): (stage: BaselineRequestStage) => void {
  const stages: { stage: BaselineRequestStage; atMs: number }[] = [];
  let disabled = false;
  const evidence = join(dirname(policy.root), "evidence");
  const destination = join(evidence, "baseline-request-stages.json");
  const temporary = destination + `.tmp.${process.pid}`;
  return stage => {
    if (disabled || stages.length >= 12 || !stageNames.has(stage)) return;
    let created = false;
    try {
      if (process.getuid?.() !== policy.uid) throw Error("fixture owner changed");
      for (const path of [policy.root, evidence]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== policy.uid || stat.mode & 0o077 || realpathSync(path) !== path)
          throw Error("fixture directory changed");
      }
      const atMs = now();
      if (!Number.isSafeInteger(atMs) || atMs < 0) throw Error("invalid time");
      stages.push({ stage, atMs });
      const body = JSON.stringify({ schema: 1, pid: process.pid, stages });
      if (Buffer.byteLength(body) > 1024) throw Error("trace limit exceeded");
      writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
      created = true;
      renameSync(temporary, destination);
    } catch {
      disabled = true;
      if (created) try { unlinkSync(temporary); } catch { /* rename may have succeeded */ }
    }
  };
}

let recorder: ((stage: BaselineRequestStage) => void) | undefined;
export function recordBaselineRequestStage(stage: BaselineRequestStage): void {
  if (!recorder) {
    try {
      const policy = compiledNativeFixture();
      if (!policy) return;
      recorder = createBaselineRequestRecorder(policy);
    } catch { return; }
  }
  recorder(stage);
}
