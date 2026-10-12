import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseError } from "../src/update/errors";
import {
  TARGETS, assetFile, formatSha256Sums, hostPlatform, latestUrl, parseLatest, parseManifest, type Manifest,
  parseSha256Sums, releaseUrl, sha256Hex,
} from "../src/update/manifest";
import { DEV_VERSION, compareVersions, currentVersion, isVersion } from "../src/update/version";

const PKG_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
const SHA = "a".repeat(64);

test("currentVersion reads package.json when no build version is embedded", () => {
  expect(currentVersion()).toBe(PKG_VERSION);
  expect(isVersion(DEV_VERSION)).toBe(true);
});

test("isVersion accepts MAJOR.MINOR.PATCH with an optional prerelease only", () => {
  for (const v of ["0.1.0", "10.20.30", "1.0.0-rc.1", "1.0.0-alpha-2"]) expect(isVersion(v)).toBe(true);
  for (const v of ["1.0", "v1.0.0", "01.0.0", "1.0.0-", "../1.0.0", "1.0.0/x", ""]) expect(isVersion(v)).toBe(false);
});

test("compareVersions orders by core numbers, then prerelease per semver", () => {
  expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
  expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
  expect(compareVersions("1.0.0-rc", "1.0.0-rc.1")).toBe(-1);
  expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  expect(compareVersions(DEV_VERSION, "0.0.1")).toBe(-1);
  expect(() => compareVersions("1.0", "1.0.0")).toThrow(ReleaseError);
});

test("targets and asset names cover the four release platforms", () => {
  expect(TARGETS.map((t) => [t.bunTarget, assetFile(t)])).toEqual([
    ["bun-darwin-arm64", "pacer-darwin-arm64"],
    ["bun-darwin-x64", "pacer-darwin-x64"],
    ["bun-linux-x64", "pacer-linux-x64"],
    ["bun-linux-arm64", "pacer-linux-arm64"],
  ]);
  expect(hostPlatform("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
  expect(hostPlatform("linux", "x64")).toEqual({ os: "linux", arch: "x64" });
  expect(hostPlatform("win32", "x64")).toBeNull();
  expect(hostPlatform("linux", "ia32")).toBeNull();
});

test("SHA256SUMS round-trips and tolerates binary-mode markers and junk lines", () => {
  const text = formatSha256Sums([{ file: "pacer-darwin-arm64", sha256: SHA }, { file: "pacer-linux-x64", sha256: "b".repeat(64) }]);
  expect(text).toBe(`${SHA}  pacer-darwin-arm64\n${"b".repeat(64)}  pacer-linux-x64\n`);
  const parsed = parseSha256Sums(`${text}\nnot a line\n${"C".repeat(64)} *pacer-linux-arm64\n`);
  expect(parsed.get("pacer-darwin-arm64")).toBe(SHA);
  expect(parsed.get("pacer-linux-arm64")).toBe("c".repeat(64));
  expect(parsed.size).toBe(3);
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("SHA256SUMS rejects conflicting duplicate filenames", () => {
  expect(() => parseSha256Sums(`${SHA}  pacer-linux-x64\n${"b".repeat(64)}  pacer-linux-x64\n`)).toThrow("conflicting hashes for pacer-linux-x64");
});

test("parseLatest strips a leading v and rejects anything that is not a version", () => {
  expect(parseLatest({ version: "0.2.0" })).toBe("0.2.0");
  expect(parseLatest({ version: "v0.2.0" })).toBe("0.2.0");
  expect(() => parseLatest({ version: "../../etc" })).toThrow("latest.json has no valid");
  expect(() => parseLatest(null)).toThrow(ReleaseError);
});

test("parseManifest validates every field and lists all problems", () => {
  const good: Manifest = { version: "0.2.0", assets: [{ os: "darwin", arch: "arm64", file: "pacer-darwin-arm64", sha256: SHA, size: 10 }] };
  expect(parseManifest(good)).toEqual(good);
  let msg = "";
  try {
    parseManifest({ version: "2", assets: [{ os: "darwin", arch: "arm64", file: "../evil", sha256: "xyz", size: 0 }, { os: "windows", arch: "x64" }] });
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toContain("invalid manifest.json");
  expect(msg).toContain("version must be");
  expect(msg).toContain('file must be "pacer-darwin-arm64"');
  expect(msg).toContain("sha256 must be");
  expect(msg).toContain("size must be");
  expect(msg).toContain("unsupported os/arch windows-x64");
  expect(() => parseManifest({ version: "0.2.0", assets: [] })).toThrow("assets must be a non-empty list");
  expect(() => parseManifest({ version: "0.2.0", assets: [good.assets[0], good.assets[0]] })).toThrow("duplicate platform darwin-arm64");
});

test("release URLs follow the documented layout", () => {
  expect(latestUrl("file:///r")).toBe("file:///r/latest.json");
  expect(releaseUrl("https://h/p", "0.2.0", "SHA256SUMS")).toBe("https://h/p/0.2.0/SHA256SUMS");
});
