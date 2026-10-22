import { expect, test } from "bun:test";
import { parseManifest, type Companion, type ReleaseAsset } from "../src/update/manifest";
const core: Companion = { name: "pacer-core", file: "pacer-core-linux-x64", sha256: "a".repeat(64), size: 3 };
const asset: ReleaseAsset = { os: "linux", arch: "x64", file: "pacer-linux-x64", sha256: "b".repeat(64), size: 5 };
test("old manifests retain their shape; companions survive parsing", () => {
  expect(parseManifest({ version: "1.0.0", assets: [asset] }).assets).toEqual([asset]);
  expect(parseManifest({ version: "1.0.0", assets: [{ ...asset, companions: [core] }] }).assets[0].companions).toEqual([core]);
});
test("invalid or duplicate companions are refused with their manifest location", () => {
  for (const companions of [[{ ...core, file: "../pacer-core" }], [{ ...core, sha256: "bad" }], [{ ...core, name: "other" }], [{ ...core, size: 0 }], [core, core]]) {
    expect(() => parseManifest({ version: "1.0.0", assets: [{ ...asset, companions }] })).toThrow("assets[0].companions");
  }
});
