import { expect, test } from "bun:test";
import { inspectLegacyRelease, legacySourceFingerprint, reverifyLegacySource } from "../src/update/desktop/bootstrap/identity";

const evidence = () => ({ schema: 1 as const, uid: 501, process: { pid: 10, bootId: "boot", birth: "123:456" }, executable: "/tmp/legacy/pacer", file: { device: "1", inode: "2", size: 100, modifiedNs: "3", changedNs: "4", sha256: "f37bb3f6c2dd804e69c0651bda6fd4846ab92b00623b4dc95d75e89e64bbb340", cdhash: "a".repeat(40) }, registration: { label: "com.pacer.serve", home: "/tmp/home", pacerHome: "/tmp/home/.pacer", port: 4317, sha256: "b".repeat(64) } });

test("known legacy release is recognized but cannot migrate without admission exclusion", () => {
  expect(inspectLegacyRelease(evidence().file.sha256, "aarch64", "0.8.0")).toEqual({ supported: false, reason: "legacy-update-bypasses-reservation", version: "0.7.1" });
  expect(inspectLegacyRelease(evidence().file.sha256, "x86_64", "0.8.0")).toEqual({ supported: false, reason: "unknown-release", version: null });
  expect(inspectLegacyRelease(evidence().file.sha256, "aarch64", "0.6.2")).toEqual({ supported: false, reason: "destination-older", version: "0.7.1" });
});

test("approval fingerprint binds the file, running incarnation and complete registration", () => {
  const original = evidence();
  expect(legacySourceFingerprint(original)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => reverifyLegacySource(original, structuredClone(original))).not.toThrow();
  for (const mutate of [
    (value: ReturnType<typeof evidence>) => { value.file.inode = "3"; },
    (value: ReturnType<typeof evidence>) => { value.file.cdhash = "c".repeat(40); },
    (value: ReturnType<typeof evidence>) => { value.file.sha256 = "d".repeat(64); },
    (value: ReturnType<typeof evidence>) => { value.process.birth = "different"; },
    (value: ReturnType<typeof evidence>) => { value.uid = 502; },
    (value: ReturnType<typeof evidence>) => { value.registration.sha256 = "e".repeat(64); },
    (value: ReturnType<typeof evidence>) => { value.registration.port = 4318; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    expect(() => reverifyLegacySource(original, changed)).toThrow("Legacy service identity changed");
  }
});

test("legacy evidence cannot smuggle authority, unsafe paths or invalid identities", () => {
  for (const value of [{ ...evidence(), allowUnsigned: true }, { ...evidence(), executable: "/tmp/../other/pacer" }, { ...evidence(), uid: -1 }, { ...evidence(), process: { ...evidence().process, pid: 0 } }]) expect(() => legacySourceFingerprint(value)).toThrow();
});

test("evidence serialization matches the native journal fingerprint", async () => {
  const value = await Bun.file("test/fixtures/desktop-update/bootstrap-source.json").json();
  expect(legacySourceFingerprint(value)).toBe("24f49ae83c5fd74355f48281f104cd8d3d5c6cc61b97eaada027ed16c8d5a9b7");
});
