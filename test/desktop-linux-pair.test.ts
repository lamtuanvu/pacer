import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

function fixture() {
  const root = tmpDir();
  const scripts = join(root, "desktop/scripts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(root, "desktop/src-tauri"), { recursive: true });
  for (const name of ["stage-cli", "build-linux-bundles", "repack-appimage"]) {
    copyFileSync(join(import.meta.dir, `../desktop/scripts/${name}.sh`), join(scripts, `${name}.sh`));
  }
  const cli = join(root, "pacer");
  const core = join(root, "pacer-core");
  for (const path of [cli, core]) writeFileSync(path, '#!/bin/sh\necho "pacer 1.2.3"\n', { mode: 0o755 });
  return { root, scripts, cli, core };
}

test("Linux staging copies the executable pair and fails before staging a missing core", () => {
  const f = fixture();
  const run = (core = f.core) => Bun.spawnSync(["sh", join(f.scripts, "stage-cli.sh"), f.cli, core], {
    env: { ...process.env, TAURI_TARGET_TRIPLE: "x86_64-unknown-linux-gnu" },
  });
  expect(run(join(f.root, "missing")).exitCode).not.toBe(0);
  expect(existsSync(join(f.root, "desktop/src-tauri/binaries"))).toBe(false);
  expect(run().exitCode).toBe(0);
  expect(statSync(join(f.root, "desktop/src-tauri/binaries/pacer-core-x86_64-unknown-linux-gnu")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(f.root, "desktop/src-tauri/binaries/pacer-core-x86_64-unknown-linux-gnu"), "utf8"))
    .toBe(readFileSync(f.core, "utf8"));
  expect(run(join(f.root, "missing")).exitCode).not.toBe(0);
});

test("AppImage repack preserves both payloads, smokes the core and leaves original intact on failure", () => {
  const f = fixture();
  const tools = join(f.root, "tools");
  mkdirSync(tools);
  const app = join(f.root, "test.AppImage");
  const original = '#!/bin/sh\necho 1\n';
  writeFileSync(app, original, { mode: 0o755 });
  writeFileSync(join(tools, "unsquashfs"), '#!/bin/sh\nwhile [ "$1" != -d ]; do shift; done\nmkdir -p "$2/usr/bin"\ntouch "$2/usr/bin/pacer" "$2/usr/bin/pacer-core"\n', { mode: 0o755 });
  writeFileSync(join(tools, "mksquashfs"), '#!/bin/sh\ncp "$1/usr/bin/pacer" "$CAPTURE/pacer"\ncp "$1/usr/bin/pacer-core" "$CAPTURE/pacer-core"\necho squash > "$2"\n', { mode: 0o755 });
  const run = () => Bun.spawnSync(["sh", join(f.scripts, "repack-appimage.sh"), app, f.cli, "1.2.3"], {
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, CAPTURE: tools },
  });
  const result = run();
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(tools, "pacer-core"), "utf8")).toBe(readFileSync(f.core, "utf8"));
  expect(readFileSync(join(tools, "pacer"), "utf8")).toBe(readFileSync(f.cli, "utf8"));
  writeFileSync(app, original);
  writeFileSync(f.core, '#!/bin/sh\necho "pacer 0.0.0"\n');
  expect(run().exitCode).not.toBe(0);
  expect(readFileSync(app, "utf8")).toBe(original);
});

test("Linux bundling shields both payloads from AppImage deployment and stages the real pair for deb", () => {
  const f = fixture();
  const tools = join(f.root, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "bunx"), `#!/bin/sh
set -eu
case "$*" in
  *appimage*)
    ! cmp -s src-tauri/binaries/pacer-x86_64-unknown-linux-gnu "$PAIR_CLI"
    ! cmp -s src-tauri/binaries/pacer-core-x86_64-unknown-linux-gnu "$PAIR_CORE"
    cmp src-tauri/binaries/pacer-x86_64-unknown-linux-gnu src-tauri/binaries/pacer-core-x86_64-unknown-linux-gnu
    mkdir -p src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage
    touch src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/pacer.AppImage
    ;;
  *deb*)
    cmp src-tauri/binaries/pacer-x86_64-unknown-linux-gnu "$PAIR_CLI"
    cmp src-tauri/binaries/pacer-core-x86_64-unknown-linux-gnu "$PAIR_CORE"
    ;;
  *) exit 2 ;;
esac
printf '%s\\n' "$*" >> "$PAIR_LOG"
`, { mode: 0o755 });
  writeFileSync(join(f.scripts, "repack-appimage.sh"), '#!/bin/sh\n[ "$2" = "$PAIR_CLI" ] && [ "$3" = "1.2.3" ] || exit 2\necho repacked >> "$PAIR_LOG"\n');
  const log = join(f.root, "build.log");
  const result = Bun.spawnSync(["sh", join(f.scripts, "build-linux-bundles.sh"), f.cli, "1.2.3", "x86_64-unknown-linux-gnu"], {
    env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, PAIR_CLI: f.cli, PAIR_CORE: f.core, PAIR_LOG: log },
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
    "--no-install tauri build --target x86_64-unknown-linux-gnu --bundles appimage --no-sign",
    "--no-install tauri build --target x86_64-unknown-linux-gnu --bundles deb --no-sign",
    "repacked",
  ]);
});

test("staging resolves platform-named core beside a relative release filename", () => {
  const f = fixture();
  copyFileSync(f.cli, join(f.root, "pacer-linux-x64"));
  copyFileSync(f.core, join(f.root, "pacer-core-linux-x64"));
  const result = Bun.spawnSync(["sh", join(f.scripts, "stage-cli.sh"), "pacer-linux-x64"], {
    cwd: f.root,
    env: { ...process.env, TAURI_TARGET_TRIPLE: "x86_64-unknown-linux-gnu" },
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
