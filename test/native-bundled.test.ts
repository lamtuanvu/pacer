import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ASSISTANT_PACER_BIN_ENV,
  ASSISTANT_PACER_EXECUTABLE,
  inspectBundledNativeExecutable,
  resolveBundledNativeExecutable,
} from "../src/plugins/native-bundled";
import { currentVersion } from "../src/update/version";
import { tmpDir } from "./helpers";

const versionScript = (v: string) => `#!/bin/sh\necho "pacer ${v}"\n`;

test("source mode never searches bun's directory or PACER_BIN", () => {
  const home = tmpDir();
  const bunDir = join(home, "bun-bin");
  const pacerBinDir = join(home, ".local", "bin");
  mkdirSync(bunDir, { recursive: true });
  mkdirSync(pacerBinDir, { recursive: true });
  writeFileSync(join(bunDir, ASSISTANT_PACER_EXECUTABLE), versionScript(currentVersion()), { mode: 0o755 });
  writeFileSync(join(pacerBinDir, ASSISTANT_PACER_EXECUTABLE), versionScript(currentVersion()), { mode: 0o755 });
  chmodSync(join(bunDir, ASSISTANT_PACER_EXECUTABLE), 0o755);
  chmodSync(join(pacerBinDir, ASSISTANT_PACER_EXECUTABLE), 0o755);

  const found = resolveBundledNativeExecutable(
    ASSISTANT_PACER_EXECUTABLE,
    { PACER_BIN: join(pacerBinDir, "pacer") },
    join(bunDir, "bun"),
  );
  expect(found).toBeNull();
});

test("PACER_ASSISTANT_PACER_BIN wins when set", () => {
  const home = tmpDir();
  const explicit = join(home, "built", ASSISTANT_PACER_EXECUTABLE);
  mkdirSync(join(home, "built"), { recursive: true });
  writeFileSync(explicit, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(explicit, 0o755);
  const found = resolveBundledNativeExecutable(
    ASSISTANT_PACER_EXECUTABLE,
    { [ASSISTANT_PACER_BIN_ENV]: explicit, PACER_BIN: join(home, "other", "pacer") },
    join(home, "bun"),
  );
  expect(found).toBe(explicit);
});

test("compiled install resolves next to pacer-core only", () => {
  const home = tmpDir();
  const coreDir = join(home, "Resources");
  mkdirSync(coreDir, { recursive: true });
  const sibling = join(coreDir, ASSISTANT_PACER_EXECUTABLE);
  writeFileSync(sibling, versionScript(currentVersion()), { mode: 0o755 });
  chmodSync(sibling, 0o755);
  const found = resolveBundledNativeExecutable(
    ASSISTANT_PACER_EXECUTABLE,
    { PACER_CORE_ARGV: JSON.stringify([join(coreDir, "pacer-core")]) },
    join(coreDir, "pacer-core"),
  );
  expect(found).toBe(sibling);
});

test("stale sibling is refused as outdated", () => {
  const home = tmpDir();
  const coreDir = join(home, "bin");
  mkdirSync(coreDir, { recursive: true });
  const sibling = join(coreDir, ASSISTANT_PACER_EXECUTABLE);
  writeFileSync(sibling, versionScript("0.0.1"), { mode: 0o755 });
  chmodSync(sibling, 0o755);
  const expected = currentVersion();
  expect(resolveBundledNativeExecutable(
    ASSISTANT_PACER_EXECUTABLE,
    { PACER_CORE_ARGV: JSON.stringify([join(coreDir, "pacer-core")]) },
    join(coreDir, "pacer-core"),
    expected,
  )).toBeNull();
  expect(inspectBundledNativeExecutable(
    ASSISTANT_PACER_EXECUTABLE,
    { PACER_CORE_ARGV: JSON.stringify([join(coreDir, "pacer-core")]) },
    join(coreDir, "pacer-core"),
    expected,
  )).toEqual({ status: "outdated", path: sibling, reported: "0.0.1", expected });
});
