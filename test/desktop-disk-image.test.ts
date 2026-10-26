import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "./helpers";
import { appTreeDigest, command, inspectDesktopDiskImage } from "../scripts/release/desktop-verify";

// Real hdiutil images in the release layout; macOS only.
const darwin = process.platform === "darwin";
async function image(change: (volume: string) => void = () => {}) {
  const root = tmpDir(), volume = join(root, "volume"), app = join(volume, "pacer.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/pacer"), "fixture executable", { mode: 0o755 });
  writeFileSync(join(app, "Contents/Info.plist"), "fixture plist");
  symlinkSync("/Applications", join(volume, "Applications"));
  const reference = appTreeDigest(app);
  change(volume);
  const path = join(root, "pacer.dmg");
  await command(["/usr/bin/hdiutil", "create", "-quiet", "-volname", "pacer", "-srcfolder", volume, "-fs", "HFS+", "-format", "UDZO", path], 120_000);
  return { bytes: readFileSync(path), reference };
}

test.skipIf(!darwin)("mounted release image yields the source app's tree digest and is detached and removed", async () => {
  const { bytes, reference } = await image();
  let mountedApp = "";
  const digest = await inspectDesktopDiskImage(bytes, async app => { mountedApp = app; return appTreeDigest(app); });
  expect(digest).toBe(reference);
  expect(existsSync(dirname(dirname(mountedApp)))).toBe(false);
}, 120_000);

test.skipIf(!darwin)("images with extra roots, hidden entries, a redirected drop link or app symlinks are refused", async () => {
  const faults: [string, (volume: string) => void][] = [
    ["roots", v => writeFileSync(join(v, "README"), "extra")],
    ["roots", v => writeFileSync(join(v, ".hidden"), "extra")],
    ["Applications link", v => { const link = join(v, "Applications"); rmSync(link); symlinkSync("/tmp", link); }],
    ["Unsupported", v => symlinkSync("MacOS/pacer", join(v, "pacer.app/Contents/link"))],
  ];
  for (const [message, change] of faults) {
    const { bytes } = await image(change);
    await expect(inspectDesktopDiskImage(bytes, async () => "accepted")).rejects.toThrow(message);
  }
  await expect(inspectDesktopDiskImage(Buffer.from("not a disk image"), async () => "accepted")).rejects.toThrow();
}, 300_000);

test("app tree digest covers content, executable bits and layout", () => {
  const app = join(tmpDir(), "pacer.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents/pacer"), "a", { mode: 0o644 });
  const base = appTreeDigest(app);
  chmodSync(join(app, "Contents/pacer"), 0o755);
  const executable = appTreeDigest(app);
  expect(executable).not.toBe(base);
  writeFileSync(join(app, "Contents/pacer"), "b", { mode: 0o755 });
  const content = appTreeDigest(app);
  expect(content).not.toBe(executable);
  mkdirSync(join(app, "Contents/empty"));
  expect(appTreeDigest(app)).not.toBe(content);
});
