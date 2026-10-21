/** Fixed failed-startup diagnostic assets; never a caller-selected executable. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const diagnosticSchema = z.object({ schema: z.literal(1), policySha256: hash, cliSha256: hash, helperSha256: hash, nativeShimSha256: hash.optional() }).strict();
export type FixtureDiagnostics = z.infer<typeof diagnosticSchema>;
export function validateDiagnosticFiles(directory: string, expected: FixtureDiagnostics, policySha256: string): void {
  const descriptor = diagnosticSchema.parse(expected), info = lstatSync(directory);
  if (descriptor.policySha256 !== policySha256 || realpathSync(directory) !== directory || !info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) throw Error("Diagnostic lease or directory differs");
  const names = readdirSync(directory).sort();
  const expectedNames = ["build.json", "pacer-startup-cleanup", "pacer-update-helper", ...(descriptor.nativeShimSha256 ? ["libpacer-native.dylib"] : [])].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw Error("Unrecorded diagnostic resource");
  for (const name of names) {
    const path = join(directory, name);
    if (realpathSync(path) !== path) throw Error("Diagnostic path is not canonical");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const file = fstatSync(fd), metadata = name === "build.json";
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || file.size > (metadata ? 4096 : 512 * 1024 * 1024) || (file.mode & 0o077 || !metadata && !(file.mode & 0o100))) throw Error("Diagnostic file ownership differs");
      const bytes = readFileSync(fd);
      if (metadata) {
        if (JSON.stringify(diagnosticSchema.parse(JSON.parse(bytes.toString("utf8")))) !== JSON.stringify(descriptor)) throw Error("Diagnostic descriptor differs from ledger");
      } else if (createHash("sha256").update(bytes).digest("hex") !== descriptor[name === "pacer-startup-cleanup" ? "cliSha256" : name === "libpacer-native.dylib" ? "nativeShimSha256" : "helperSha256"]) throw Error("Diagnostic executable bytes changed");
    } finally { closeSync(fd); }
  }
}

import type { OtaRecord } from "./ota";
import type { FixtureJobs } from "./ota-native";
import type { ProcessIdentity } from "../../src/update/desktop/process-identity";
/** A signed report is still insufficient without positive OS incarnation exits. */
export function assertStartupRetirement(state: OtaRecord, report: FixtureJobs, exited: (process: ProcessIdentity) => boolean): void {
  if (state.phase !== "prepared" || !state.nativeFixture || !state.diagnostics || state.exercise || state.runtime?.state !== "starting" || state.runtime.request !== null || !state.runtime.desktop) throw Error("Fixture was not an unresolved never-armed startup");
  if (report.schema !== 1 || report.desktops.length || report.jobs.length !== 2 || report.jobs[0].label !== state.serviceLabel || report.jobs[1].label !== state.recoveryLabel || report.jobs.some(job => job.loaded || job.process !== null || !["reserved", "retired"].includes(job.state))) throw Error("Native fixture retirement is unproven");
  if ([state.runtime.driver, state.runtime.sourceService, state.runtime.desktop].some(process => !exited(process))) throw Error("Fixture incarnation exit is unproven");
}
