import { expect, test } from "bun:test";
import { parseManifest, type Companion, type NativePlugin, type ReleaseAsset } from "../src/update/manifest";
const core: Companion = { name: "pacer-core", file: "pacer-core-linux-x64", sha256: "a".repeat(64), size: 3 };
const assistant: NativePlugin = { name: "pacer-assistant-pacer", file: "pacer-assistant-pacer-linux-x64", sha256: "c".repeat(64), size: 7 };
const asset: ReleaseAsset = { os: "linux", arch: "x64", file: "pacer-linux-x64", sha256: "b".repeat(64), size: 5 };

/** Frozen pre-S4 validator: unknown asset fields (including nativePlugins) are ignored; unknown companion names still fail. */
function parseManifestLegacyCompanionsOnly(raw: unknown) {
  const o = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const version = typeof o.version === "string" ? o.version : null;
  if (!version) throw new Error("invalid");
  if (!Array.isArray(o.assets)) throw new Error("invalid");
  for (const a of o.assets) {
    const x = (typeof a === "object" && a !== null ? a : {}) as Record<string, unknown>;
    if (x.companions !== undefined) {
      if (!Array.isArray(x.companions)) throw new Error("companions");
      for (const value of x.companions) {
        const c = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
        if (c.name !== "pacer-core") throw new Error("unknown companion name");
      }
    }
  }
  return { version, assets: o.assets };
}

test("old manifests retain their shape; companions survive parsing", () => {
  expect(parseManifest({ version: "1.0.0", assets: [asset] }).assets).toEqual([asset]);
  expect(parseManifest({ version: "1.0.0", assets: [{ ...asset, companions: [core] }] }).assets[0].companions).toEqual([core]);
});
test("invalid or duplicate companions are refused with their manifest location", () => {
  for (const companions of [[{ ...core, file: "../pacer-core" }], [{ ...core, sha256: "bad" }], [{ ...core, name: "other" }], [{ ...core, size: 0 }], [core, core]]) {
    expect(() => parseManifest({ version: "1.0.0", assets: [{ ...asset, companions }] })).toThrow("assets[0].companions");
  }
});
test("old-updater fixture ignores nativePlugins while still validating companions", () => {
  const raw = { version: "1.0.0", assets: [{ ...asset, companions: [core], nativePlugins: [assistant] }] };
  expect(() => parseManifestLegacyCompanionsOnly(raw)).not.toThrow();
  expect(() => parseManifestLegacyCompanionsOnly({
    version: "1.0.0",
    assets: [{ ...asset, companions: [{ ...core, name: "pacer-assistant-pacer" }], nativePlugins: [assistant] }],
  })).toThrow("unknown companion name");
});
test("nativePlugins parse for the assistant sibling and refuse invalid entries", () => {
  expect(parseManifest({ version: "1.0.0", assets: [{ ...asset, companions: [core], nativePlugins: [assistant] }] }).assets[0].nativePlugins).toEqual([assistant]);
  for (const nativePlugins of [
    [{ ...assistant, file: "wrong" }],
    [{ ...assistant, sha256: "bad" }],
    [{ ...assistant, name: "other" }],
    [{ ...assistant, size: 0 }],
    [assistant, assistant],
  ]) {
    expect(() => parseManifest({ version: "1.0.0", assets: [{ ...asset, nativePlugins }] })).toThrow("assets[0].nativePlugins");
  }
});
