import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, symlinkSync, realpathSync, unlinkSync, linkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { diagnosticSchema, validateDiagnosticFiles } from "../scripts/live/ota-diagnostics";
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const directory = join(realpathSync(tmpDir()), "diagnostics");
  mkdirSync(directory, { mode: 0o700 });
  const descriptor = { schema: 1 as const, policySha256: digest("policy"), cliSha256: digest("cli"), helperSha256: digest("helper") };
  writeFileSync(join(directory, "build.json"), JSON.stringify(descriptor), { mode: 0o600 });
  writeFileSync(join(directory, "pacer-startup-cleanup"), "cli", { mode: 0o700 });
  writeFileSync(join(directory, "pacer-update-helper"), "helper", { mode: 0o700 });
  return { directory, descriptor };
}
test("diagnostic ownership accepts only exact private fixed files and policy", () => {
  const f = fixture();
  expect(() => validateDiagnosticFiles(f.directory, f.descriptor, digest("policy"))).not.toThrow();
  expect(() => validateDiagnosticFiles(f.directory, f.descriptor, digest("another lease"))).toThrow();
  expect(() => diagnosticSchema.parse({ ...f.descriptor, command: "anything" })).toThrow();
});
for (const change of ["binary", "descriptor", "extra", "link", "hardlink", "permissions"]) test(`diagnostic ownership refuses ${change} before any process invocation`, () => {
  const f = fixture();
  if (change === "binary") writeFileSync(join(f.directory, "pacer-startup-cleanup"), "changed");
  if (change === "descriptor") writeFileSync(join(f.directory, "build.json"), JSON.stringify({ ...f.descriptor, helperSha256: digest("other") }));
  if (change === "extra") writeFileSync(join(f.directory, "arbitrary"), "extra");
  if (change === "link") {
    unlinkSync(join(f.directory, "pacer-startup-cleanup"));
    symlinkSync(join(f.directory, "pacer-update-helper"), join(f.directory, "pacer-startup-cleanup"));
  }
  if (change === "hardlink") linkSync(join(f.directory, "pacer-startup-cleanup"), join(f.directory, "../other"));
  if (change === "permissions") chmodSync(join(f.directory, "build.json"), 0o644);
  expect(() => validateDiagnosticFiles(f.directory, f.descriptor, digest("policy"))).toThrow();
});

test("failed startup retirement requires both jobs absent and every recorded incarnation exited", async () => {
  const { assertStartupRetirement } = await import("../scripts/live/ota-diagnostics");
  const identity = (pid: number) => ({ pid, bootId: "boot", birth: String(pid) });
  const state = { phase: "prepared", nativeFixture: {}, diagnostics: {}, exercise: null, serviceLabel: "service", recoveryLabel: "recovery", runtime: { state: "starting", request: null, driver: identity(11), sourceService: identity(12), desktop: identity(13) } } as any;
  const report = { schema: 1 as const, desktops: [], jobs: ["service", "recovery"].map((label, index) => ({ label, state: index ? "reserved" as const : "retired" as const, loaded: false, process: null, executable: null, registrationSha256: null, registrationText: null })) };
  expect(() => assertStartupRetirement(state, report, () => true)).not.toThrow();
  expect(() => assertStartupRetirement(state, report, process => process.pid !== 13)).toThrow();
  expect(() => assertStartupRetirement(state, { ...report, jobs: [report.jobs[0], report.jobs[0]] }, () => true)).toThrow();
  expect(() => assertStartupRetirement(state, { ...report, desktops: [identity(14)] }, () => true)).toThrow();
  expect(() => assertStartupRetirement(state, { ...report, jobs: [{ ...report.jobs[0], loaded: true }, report.jobs[1]] }, () => true)).toThrow();
  expect(() => assertStartupRetirement({ ...state, exercise: {} }, report, () => true)).toThrow();
});

test("certificate-signed paired attached startup retires without a diagnostic descriptor", async () => {
  const { assertStartupRetirement } = await import("../scripts/live/ota-diagnostics");
  const identity = (pid: number) => ({ pid, bootId: "boot", birth: String(pid) });
  const root = "/fixture/.work/live/test/ota";
  const state = { phase: "prepared", root, initialLayout: "paired", nativeFixture: { signingCertSha1: "A".repeat(40) }, diagnostics: null, external: [{}, {}], exercise: null, serviceLabel: "service", recoveryLabel: "recovery", runtime: { state: "starting", request: null, driver: identity(11), sourceService: identity(12), desktop: identity(13) } } as any;
  const service = { label: "service", state: "retired" as const, loaded: false, process: null, executable: join(root, "external/pacer"), registrationSha256: "a".repeat(64), registrationText: "registration" };
  const recovery = { label: "recovery", state: "reserved" as const, loaded: false, process: null, executable: null, registrationSha256: null, registrationText: null };
  const report = { schema: 1 as const, desktops: [], jobs: [service, recovery] };
  expect(() => assertStartupRetirement(state, report, () => true)).not.toThrow();
  expect(() => assertStartupRetirement(state, { ...report, jobs: [{ ...service, executable: join(root, "current.app/Contents/Resources/pacer") }, recovery] }, () => true)).toThrow();
  expect(() => assertStartupRetirement({ ...state, nativeFixture: { signingCertSha1: null } }, report, () => true)).toThrow();
  expect(() => assertStartupRetirement({ ...state, initialLayout: "bridge" }, report, () => true)).toThrow();
});

test("diagnostic native library must match its immutable optional descriptor", () => {
  const f = fixture(), descriptor = { ...f.descriptor, nativeShimSha256: digest("shim") };
  writeFileSync(join(f.directory, "build.json"), JSON.stringify(descriptor));
  writeFileSync(join(f.directory, "libpacer-native.dylib"), "shim", { mode: 0o700 });
  expect(() => validateDiagnosticFiles(f.directory, descriptor, digest("policy"))).not.toThrow();
  writeFileSync(join(f.directory, "libpacer-native.dylib"), "changed");
  expect(() => validateDiagnosticFiles(f.directory, descriptor, digest("policy"))).toThrow();
  unlinkSync(join(f.directory, "libpacer-native.dylib"));
  expect(() => validateDiagnosticFiles(f.directory, descriptor, digest("policy"))).toThrow();
});
