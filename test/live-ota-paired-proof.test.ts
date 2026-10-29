import { expect, test } from "bun:test";
import { validatePairedFixtureCore, verifyPairedAdoptionProcesses } from "../scripts/live/ota-paired-proof";
const root = { pid: 80, bootId: "boot", birth: "root-birth" }, core = { pid: 81, bootId: "boot", birth: "core-birth" };
const app = "/fixture/ota/current.app", front = app + "/Contents/Resources/pacer", companion = front + "-core";
const metadata = { schema: 1, bundleId: "dev.pacer.desktop", version: "0.2.4", arch: "aarch64", cliLayout: "paired", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true };
const input = { appPath: app, ownerUid: 501, arch: "aarch64" as const, branch: "managed" as const, service: root, metadata };
const processes = () => [{ process: root, uid: 501, parentPid: 1, name: "pacer", executable: front }, { process: core, uid: 501, parentPid: root.pid, name: "pacer-core", executable: companion }];
test("paired proof binds real Root/Core inventory snapshots, not layout metadata alone", () => {
  expect(verifyPairedAdoptionProcesses(input, processes(), processes())?.core.process).toEqual(core);
  expect(() => verifyPairedAdoptionProcesses(input, [], [])).toThrow();
  expect(() => verifyPairedAdoptionProcesses({ ...input, metadata: { ...metadata, cliLayout: "legacy" } }, processes(), processes())).toThrow();
});
for (const mutation of ["root-birth", "core-birth", "core-boot", "core-parent", "core-uid", "core-path", "duplicate-core", "wrong-parent-extra", "duplicate-root", "root-uid"]) test(`paired proof refuses ${mutation}`, () => {
  const after = structuredClone(processes());
  if (mutation === "root-birth") after[0]!.process.birth = "reused";
  if (mutation === "core-birth") after[1]!.process.birth = "reused";
  if (mutation === "core-boot") after[1]!.process.bootId = "other";
  if (mutation === "core-parent") after[1]!.parentPid = 1;
  if (mutation === "core-uid") after[1]!.uid = 502;
  if (mutation === "root-uid") after[0]!.uid = 502;
  if (mutation === "core-path") after[1]!.executable = "/unregistered/core";
  if (mutation === "duplicate-core" || mutation === "wrong-parent-extra") after.push({ ...after[1]!, process: { ...core, pid: 82 }, parentPid: mutation === "wrong-parent-extra" ? 1 : root.pid });
  if (mutation === "duplicate-root") after.push({ ...after[0]!, process: { ...root, pid: 82 } });
  expect(() => verifyPairedAdoptionProcesses(input, processes(), after)).toThrow();
});
test("restoration proves ALL candidate Root/Core executables absent including orphans", () => {
  const restored = { ...input, branch: "original" as const };
  expect(verifyPairedAdoptionProcesses(restored, [], [])).toBeNull();
  for (const survivor of processes()) {
    expect(() => verifyPairedAdoptionProcesses(restored, [{ ...survivor, parentPid: 1 }], [])).toThrow();
    expect(() => verifyPairedAdoptionProcesses(restored, [], [{ ...survivor, parentPid: 1 }])).toThrow();
  }
});


test("paired Core uses signed-source hash, native executable architecture and declared metadata", () => {
  const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf,0); bytes.writeUInt32LE(0x0100000c,4); bytes.writeUInt32LE(2,12);
  expect(() => validatePairedFixtureCore(metadata, "aarch64", bytes, bytes)).not.toThrow();
  const changed = Buffer.from(bytes); changed[31] = 1;
  expect(() => validatePairedFixtureCore(metadata, "aarch64", changed, bytes)).toThrow();
  expect(() => validatePairedFixtureCore(metadata, "x86_64", bytes, bytes)).toThrow();
  expect(() => validatePairedFixtureCore({ ...metadata, cliLayout: "legacy" }, "aarch64", bytes, bytes)).toThrow();
  expect(() => validatePairedFixtureCore({ ...metadata, version: "0.2.3" }, "aarch64", bytes, bytes)).toThrow();
  expect(() => validatePairedFixtureCore(metadata, "aarch64", Buffer.alloc(32), Buffer.alloc(32))).toThrow();
});
