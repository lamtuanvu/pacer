/** Read-only paired adoption evidence. Two snapshots do not provide atomic CAS. */
import { createHash } from "node:crypto";
import { verifyDesktopExecutable } from "../release/desktop";
import { join } from "node:path";
import type { NativeProcess } from "../../src/update/desktop/native-os";
import { sameProcess, type ProcessIdentity } from "../../src/update/desktop/process-identity";
import { FIXTURE_IDENTIFIERS } from "../../src/update/desktop/bundle-identity";
export interface PairedAdoptionInput {
  appPath: string; ownerUid: number; arch: "aarch64" | "x86_64";
  branch: "managed" | "original"; service: ProcessIdentity; metadata: unknown;
}
const refuse = (): never => { throw Error("Exact paired adoption participants are not proven"); };
const identity = (value: ProcessIdentity) => Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.birth === "string" && value.birth.length > 0 && typeof value.bootId === "string" && value.bootId.length > 0;
function validateMetadata(metadata: unknown, arch: "aarch64" | "x86_64"): void {
  const m = metadata as Record<string, unknown> | null;
  if (!m || m.schema !== 1 || m.bundleId !== FIXTURE_IDENTIFIERS.desktop || m.version !== "0.2.4" || m.arch !== arch || m.cliLayout !== "paired" ||
      m.admissionProtocol !== 1 || m.nativeTransportAbi !== 1 || m.rollbackCompatible !== true || !Array.isArray(m.protocolMajors) || !m.protocolMajors.includes(3) ||
      !m.protocolMajors.every(major => Number.isSafeInteger(major) && major > 0)) refuse();
}
export function validatePairedFixtureCore(metadata: unknown, arch: "aarch64" | "x86_64", bytes: Buffer, immutableSource: Buffer): void {
  validateMetadata(metadata, arch);
  verifyDesktopExecutable(bytes, arch);
  if (createHash("sha256").update(bytes).digest("hex") !== createHash("sha256").update(immutableSource).digest("hex")) refuse();
}
export function verifyPairedAdoptionProcesses(input: PairedAdoptionInput, before: NativeProcess[], after: NativeProcess[]): { root: NativeProcess; core: NativeProcess } | null {
  validateMetadata(input.metadata, input.arch);
  if (!identity(input.service)) refuse();
  const front = join(input.appPath, "Contents/Resources/pacer"), companion = join(input.appPath, "Contents/Resources/pacer-core");
  function snapshot(values: NativeProcess[]) {
    const roots = values.filter(value => value.executable === front), cores = values.filter(value => value.executable === companion);
    if (input.branch === "original") {
      if (roots.length || cores.length) refuse();
      return null;
    }
    if (input.branch !== "managed" || roots.length !== 1 || cores.length !== 1) refuse();
    const root = roots[0]!, core = cores[0]!;
    if (!identity(root.process) || !identity(core.process) || !sameProcess(root.process, input.service) || root.uid !== input.ownerUid || core.uid !== input.ownerUid ||
        core.process.bootId !== root.process.bootId || core.process.pid === root.process.pid || core.parentPid !== root.process.pid || !Number.isSafeInteger(root.parentPid) || root.parentPid < 1) refuse();
    return { root, core };
  }
  const first = snapshot(before), second = snapshot(after);
  if (!first || !second) return null;
  if (!sameProcess(first.root.process, second.root.process) || !sameProcess(first.core.process, second.core.process) || first.root.parentPid !== second.root.parentPid) refuse();
  return second;
}
