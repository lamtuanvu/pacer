import { expect, test } from "bun:test";
import { coreBuildDescriptor } from "../src/update/desktop/build-identity";
import { currentVersion } from "../src/update/version";

// coreBuild is a runtime property of the actual paired core, injected by the
// desktop build scripts as a module-scope define (PACER_COMPONENT_*). In the
// Bun test runtime there is no define, so injection via globalThis must be read
// at call time. These tests prove the descriptor honors a non-default, bounded
// compile identity and is platform-independent (never derived from the running
// host), then falls back to defaults when no define is present.

const releaseVersion = currentVersion();

test("coreBuild falls back to development identity when no component defines exist", () => {
  const d = coreBuildDescriptor();
  expect(d).toEqual({ schemaVersion: 1, releaseVersion, buildId: "development-uncompiled", role: "core", targetOs: process.platform, targetArch: process.arch });
});

test("coreBuild honors non-default compile identity", () => {
  const injected = { PACER_COMPONENT_BUILD_ID: "f1f0-4c8e-nondefault-buildid", PACER_COMPONENT_TARGET_OS: "linux", PACER_COMPONENT_TARGET_ARCH: "x64" };
  try {
    for (const [k, v] of Object.entries(injected)) (globalThis as Record<string, unknown>)[k] = v;
    const d = coreBuildDescriptor();
    expect(d).toEqual({ schemaVersion: 1, releaseVersion, buildId: injected.PACER_COMPONENT_BUILD_ID, role: "core", targetOs: injected.PACER_COMPONENT_TARGET_OS, targetArch: injected.PACER_COMPONENT_TARGET_ARCH });
  } finally {
    for (const k of Object.keys(injected)) delete (globalThis as Record<string, unknown>)[k];
  }
});

test("coreBuild is platform-independent across injected targets", () => {
  const cases = [
    { os: "darwin", arch: "arm64" },
    { os: "linux", arch: "x64" },
    { os: "win32", arch: "x64" },
  ];
  for (let index = 0; index < cases.length; index++) {
    const { os, arch } = cases[index]!;
    try {
      (globalThis as Record<string, unknown>).PACER_COMPONENT_TARGET_OS = os;
      (globalThis as Record<string, unknown>).PACER_COMPONENT_TARGET_ARCH = arch;
      (globalThis as Record<string, unknown>).PACER_COMPONENT_BUILD_ID = "ci-abc123";
      const d = coreBuildDescriptor();
      expect(d.targetOs).toBe(os);
      expect(d.targetArch).toBe(arch);
      expect(d.buildId).toBe("ci-abc123");
      // Injection fully determines the descriptor: distinct injected targets
      // must yield distinct descriptors, never collapsing to the host.
      if (index > 0) expect(d.targetOs).not.toBe(cases[index - 1]!.os);
    } finally {
      delete (globalThis as Record<string, unknown>).PACER_COMPONENT_TARGET_OS;
      delete (globalThis as Record<string, unknown>).PACER_COMPONENT_TARGET_ARCH;
      delete (globalThis as Record<string, unknown>).PACER_COMPONENT_BUILD_ID;
    }
  }
});