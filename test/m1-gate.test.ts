import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { hostTarget, assetFile, companionFile, sha256Hex } from "../src/update/manifest";
import { validateM1Artifacts, validateNativeRegistry } from "../scripts/gate/m1";

test("M1 gate requires test operations to remain feature-gated", () => {
  const source = readFileSync(join(import.meta.dir, "../crates/server/src/native.rs"), "utf8");
  expect(() => validateNativeRegistry(source)).not.toThrow();
  for (const name of ["test.echo", "_debug.native"]) {
    const entry = `#[cfg(feature = "test-ops")]\n    NativeOp {\n        name: "${name}"`;
    expect(source).toContain(entry);
    expect(() => validateNativeRegistry(source.replace(entry, entry.replace('#[cfg(feature = "test-ops")]\n    ', "")))).toThrow("feature-gated native registry");
  }
  expect(() => validateNativeRegistry(source.replace('name: "test.echo"', 'name: "different.echo"'))).toThrow("coverage changed");
  expect(() => validateNativeRegistry(source.replace('name: "activity.list"', 'name: "test.echo"'))).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(source.replace('static OPS: &[NativeOp] = &[', 'static OPS: &[NativeOp] = &[\n    unknown_entry(),'))).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(source.replace('name: engine_ops::ops()[0].name', 'name: engine_ops::ops()[1].name'))).toThrow("feature-gated native registry");
});

test("M1 gate requires the exact paired host release bytes", () => {
  const target = hostTarget()!;
  const dir = tmpDir(), front = Buffer.from("front"), core = Buffer.from("core");
  const file = assetFile(target), companion = companionFile(target);
  writeFileSync(join(dir, file), front, { mode: 0o755 });
  writeFileSync(join(dir, companion), core, { mode: 0o755 });
  const manifest = { version: "1.2.3", assets: [{ ...target, file, size: front.length, sha256: sha256Hex(front),
    companions: [{ name: "pacer-core", file: companion, size: core.length, sha256: sha256Hex(core) }] }] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  expect(validateM1Artifacts(dir).version).toBe("1.2.3");
  writeFileSync(join(dir, companion), "changed");
  expect(() => validateM1Artifacts(dir)).toThrow("checksum/size");
  manifest.assets[0].companions = [];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  expect(() => validateM1Artifacts(dir)).toThrow("companion");
});
