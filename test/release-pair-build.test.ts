import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRelease } from "../scripts/release/build";
import { assetFile, companionFile, parseManifest, parseSha256Sums, sha256Hex } from "../src/update/manifest";
import { tmpDir } from "./helpers";

test("paired release metadata binds both binaries and checksums", () => {
  const out = tmpDir(), version = "0.8.0", platform = { os: "linux", arch: "x64" } as const;
  const dir = join(out, version); mkdirSync(dir, { recursive: true });
  const front = Buffer.from("rust front door"), core = Buffer.from("compiled core");
  writeFileSync(join(dir, assetFile(platform)), front);
  writeFileSync(join(dir, companionFile(platform)), core);
  const manifest = writeRelease(out, version, [platform], { paired: true });
  expect(manifest.assets[0].companions).toEqual([{ name: "pacer-core", file: companionFile(platform), sha256: sha256Hex(core), size: core.length }]);
  expect(parseManifest(manifest)).toEqual(manifest);
  const sums = parseSha256Sums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  expect(sums.get(assetFile(platform))).toBe(sha256Hex(front));
  expect(sums.get(companionFile(platform))).toBe(sha256Hex(core));
});

test("paired metadata refuses a missing core without writing a manifest", () => {
  const out = tmpDir(), platform = { os: "linux", arch: "x64" } as const;
  const dir = join(out, "0.8.0"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, assetFile(platform)), "front");
  expect(() => writeRelease(out, "0.8.0", [platform], { paired: true })).toThrow();
});

test("Rust release builds use locked target-specific Cargo builds and musl for Linux", async () => {
  const build = await import("../scripts/release/build");
  expect(build.frontDoorBuildCommand({ os: "darwin", arch: "arm64" })).toEqual(["cargo", "build", "--release", "--locked", "-p", "pacer", "--target", "aarch64-apple-darwin"]);
  expect(build.frontDoorBuildCommand({ os: "darwin", arch: "x64" }).at(-1)).toBe("x86_64-apple-darwin");
  expect(build.frontDoorBuildCommand({ os: "linux", arch: "arm64" })).toEqual(["cargo", "zigbuild", "--release", "--locked", "-p", "pacer", "--target", "aarch64-unknown-linux-musl"]);
  expect(build.frontDoorBuildCommand({ os: "linux", arch: "x64" }).at(-1)).toBe("x86_64-unknown-linux-musl");
});

test("release CI installs cross-build tools and smoke-tests both executables", () => {
  const workflow = Bun.YAML.parse(readFileSync(".github/workflows/release.yml", "utf8")) as { jobs: { build: { steps: { name?: string; run?: string }[] } } };
  const steps = workflow.jobs.build.steps;
  expect(steps.find(step => step.name === "Install Rust release targets")?.run).toContain("unknown-linux-musl");
  expect(steps.find(step => step.name === "Install Linux cross-build tools")?.run).toContain("cargo-zigbuild");
  const smoke = steps.find(step => step.name === "Smoke test native binary")?.run ?? "";
  expect(smoke).toContain("pacer-core-$os-$arch");
  expect(smoke).toContain("pacer-$os-$arch");
});
