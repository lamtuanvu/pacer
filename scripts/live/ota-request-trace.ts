/** Private harness evidence only: no request fields or arbitrary errors cross this boundary. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import type { Session } from "./core";
import { FIXTURE_UPDATE_OPS } from "./ota-exercise-record";
export type OtaTraceStage = "body" | "initial-policy" | "native-ownership" | "final-policy" | "forward" | "upstream";
export interface OtaTraceEvent { stage: OtaTraceStage; outcome: "start" | "pass" | "refused" | "error" | "response"; status?: number }
export type OtaTraceSink = (event: OtaTraceEvent) => void;
export const OTA_REQUEST_TRACE_LIMIT = 1024 * 1024;
const stages: readonly string[] = ["body", "initial-policy", "native-ownership", "final-policy", "forward", "upstream"];
const outcomes: readonly string[] = ["start", "pass", "refused", "error", "response"];

/** A diagnostic observer never participates in the policy verdict or request lifetime. */
export function emitOtaRequestTrace(sink: OtaTraceSink | undefined, event: OtaTraceEvent): void {
  try {
    // Also isolate an accidentally asynchronous observer, without waiting for it.
    const result: unknown = sink?.(event);
    if (result instanceof Promise) void result.catch(() => {});
  } catch { /* Evidence is best-effort, never authority. */ }
}
function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o7777) === 0o700;
}
function privateFile(stat: Stats): boolean {
  return stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600;
}
function append(session: Session, line: string): void {
  let directory: number | undefined, lock: number | undefined, file: number | undefined;
  let lockPath: string | undefined;
  try {
    const root = resolve(session.root), evidence = join(root, "evidence");
    // Reject symlinked ancestors, including a session root reached through a link.
    if (realpathSync(root) !== root || !privateDirectory(lstatSync(root)) || !privateDirectory(lstatSync(evidence))) return;
    directory = openSync(evidence, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!privateDirectory(fstatSync(directory))) return;
    const directoryStat = fstatSync(directory);
    lockPath = join(evidence, ".ota-request-trace.lock");
    lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (!privateFile(fstatSync(lock))) return;
    const path = join(evidence, "ota-request-trace.jsonl");
    file = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(file), bytes = Buffer.from(line);
    const currentDirectory = lstatSync(evidence), currentFile = lstatSync(path);
    if (realpathSync(root) !== root || !privateDirectory(lstatSync(root)) || !privateDirectory(currentDirectory) || currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino) return;
    if (!privateFile(stat) || !privateFile(currentFile) || currentFile.dev !== stat.dev || currentFile.ino !== stat.ino || stat.size + bytes.length > OTA_REQUEST_TRACE_LIMIT) return;
    // Synchronous, locked, one bounded event per append; no retry or truncation.
    writeSync(file, bytes);
  } catch { /* Unsafe/unavailable evidence is refused without affecting the request. */ }
  finally {
    if (file !== undefined) try { closeSync(file); } catch {}
    if (lock !== undefined) {
      try {
        const owned = fstatSync(lock), current = lockPath ? lstatSync(lockPath) : undefined;
        if (lockPath && current?.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath);
      } catch {}
      try { closeSync(lock); } catch {}
    }
    if (directory !== undefined) try { closeSync(directory); } catch {}
  }
}
export function createOtaRequestTrace(session: Session, op: typeof FIXTURE_UPDATE_OPS[number]): OtaTraceSink {
  try {
    if (!(FIXTURE_UPDATE_OPS as readonly string[]).includes(op)) return () => {};
    const correlationId = randomUUID(), started = performance.now();
    return event => {
      try {
        if (!stages.includes(event.stage) || !outcomes.includes(event.outcome)) return;
        if (event.status !== undefined && (!Number.isInteger(event.status) || event.status < 100 || event.status > 599)) return;
        const elapsedMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(performance.now() - started)));
        append(session, JSON.stringify({ correlationId, op, stage: event.stage, outcome: event.outcome, elapsedMs, ...(event.status === undefined ? {} : { status: event.status }) }) + "\n");
      } catch { /* Even invalid observer input must not affect delivery. */ }
    };
  } catch { return () => {}; }
}
