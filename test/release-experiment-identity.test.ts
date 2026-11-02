import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentManifest, verifyExperimentManifest } from "../scripts/release/experiment-identity";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const identity = { repository: "owner/repo", run: "123", attempt: "2", commit: "a".repeat(40), version: "1.2.3", variant: "linux-x64" };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-experiment-"));
  dirs.push(dir);
  writeFileSync(join(dir, "binary"), "bytes");
  return { dir, manifest: createExperimentManifest(identity, dir, ["binary"]) };
}

describe("experiment artifact evidence", () => {
  test("accepts exact identity and bytes", () => {
    const { dir, manifest } = fixture();
    expect(() => verifyExperimentManifest(manifest, identity, dir, ["binary"])).not.toThrow();
  });
  test("rejects changed run, attempt, commit or version", () => {
    const { dir, manifest } = fixture();
    for (const changed of [{ repository: "other/repo" }, { run: "124" }, { attempt: "1" }, { commit: "b".repeat(40) }, { version: "1.2.4" }, { variant: "linux-arm64" }]) {
      expect(() => verifyExperimentManifest(manifest, { ...identity, ...changed }, dir, ["binary"])).toThrow();
    }
  });
  test("rejects forged digests, sizes, duplicate and unexpected manifest entries", () => {
    const { dir, manifest } = fixture();
    for (const files of [
      [{ ...manifest.files[0], sha256: "f".repeat(64) }],
      [{ ...manifest.files[0], size: 99 }],
      [...manifest.files, manifest.files[0]],
      [{ ...manifest.files[0], name: "unexpected" }],
    ]) expect(() => verifyExperimentManifest({ ...manifest, files }, identity, dir, ["binary"])).toThrow();
  });
  test("rejects modified, missing, extra and symlinked files", () => {
    const { dir, manifest } = fixture();
    writeFileSync(join(dir, "binary"), "other");
    expect(() => verifyExperimentManifest(manifest, identity, dir, ["binary"])).toThrow();
    rmSync(join(dir, "binary"));
    expect(() => verifyExperimentManifest(manifest, identity, dir, ["binary"])).toThrow();
    symlinkSync("target", join(dir, "binary"));
    expect(() => verifyExperimentManifest(manifest, identity, dir, ["binary"])).toThrow();
    expect(() => verifyExperimentManifest({ ...manifest, files: [] }, identity, dir, ["binary"])).toThrow();
  });
});
