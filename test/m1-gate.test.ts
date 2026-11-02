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
    const entry = new RegExp(`#\\[cfg\\(feature = "test-ops"\\)\\]\\s*NativeOp \\{\\s*name: "${name.replace(".", "\\.")}"`);
    expect(() => validateNativeRegistry(source.replace(entry, `NativeOp { name: "${name}"`))).toThrow("feature-gated native registry");
  }
  expect(() => validateNativeRegistry(source.replaceAll('#[cfg(feature = "test-ops")]', '#[cfg(not(feature = "test-ops"))]'))).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(source.replace('call: echo,', 'call: echo, extra: true,'))).toThrow("feature-gated native registry");
  // New production operations need no gate edit; only the known test operations must stay gated.
  expect(() => validateNativeRegistry(source.replace('name: "task.log"', 'name: "task.cancel"'))).not.toThrow();
  expect(() => validateNativeRegistry(source.replace('name: "test.echo"', 'name: "different.echo"'))).toThrow("coverage changed");
  expect(() => validateNativeRegistry(source.replace("static OPS:", '#[cfg(feature = "test-ops")]\nstatic OPS:'))).toThrow("feature-gated native registry");
  const alternate = source.replace("static OPS:", '#[cfg(feature = "test-ops")]\nstatic OPS:')
    + '\n#[cfg(not(feature = "test-ops"))]\nstatic OPS: &[NativeOp] = &[NativeOp { name: "test.echo", call: task_reads::task_log, }];';
  expect(() => validateNativeRegistry(alternate)).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(alternate.replace(/static OPS:([^]*?)static OPS:/, "static OPS:$1const OPS:"))).toThrow("feature-gated native registry");
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
