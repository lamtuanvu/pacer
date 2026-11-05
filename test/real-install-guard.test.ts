import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpDir } from "./helpers";
import { assertNotRealInstall, assertNotRealServiceLabel, REAL_SERVICE_LABEL, realInstallPaths } from "../scripts/lib/real-install-guard";
import { checkout, liveRoot, type Session } from "../scripts/live/core";
import { desktop } from "../scripts/live/surfaces";
import { handoverFailureMarker, upgradePolicy } from "../scripts/live/upgrade";

test("realInstallPaths lists the real app, CLI, core, PACER_HOME and service plist under a given home", () => {
  const home = "/home/example";
  expect(realInstallPaths(home)).toEqual({
    app: "/Applications/pacer.app",
    cli: "/home/example/.local/bin/pacer",
    core: "/home/example/.local/bin/pacer-core",
    pacerHome: "/home/example/.pacer",
    servicePlist: "/home/example/Library/LaunchAgents/com.pacer.serve.plist",
  });
});

test("assertNotRealInstall refuses every real path and anything inside it", () => {
  const home = tmpDir();
  const real = realInstallPaths(home);
  for (const path of Object.values(real)) {
    expect(() => assertNotRealInstall(path, "write", home)).toThrow(/refusing to write/);
    expect(() => assertNotRealInstall(join(path, "nested/file"), "write", home)).toThrow(/refusing to write/);
  }
});

test("assertNotRealInstall allows a disposable temp dir", () => {
  const home = tmpDir();
  expect(() => assertNotRealInstall(tmpDir(), "write", home)).not.toThrow();
  expect(() => assertNotRealInstall(join(tmpDir(), ".local/bin/pacer-live-fixture"), "write", home)).not.toThrow();
});

test("assertNotRealInstall resolves a symlink that points into the real install before comparing", () => {
  const home = tmpDir(), outside = tmpDir();
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/pacer"), "#!/bin/sh\n");
  const alias = join(outside, "alias-bin");
  symlinkSync(join(home, ".local/bin"), alias);
  expect(() => assertNotRealInstall(join(alias, "pacer"), "write", home)).toThrow(/refusing to write/);
  // A symlink that does NOT resolve into the real install is unaffected.
  const other = tmpDir();
  const harmless = join(outside, "harmless-bin");
  symlinkSync(other, harmless);
  expect(() => assertNotRealInstall(join(harmless, "pacer"), "write", home)).not.toThrow();
});

test("assertNotRealInstall follows a dangling symlink into each real path (existsSync is false for these, so a naive realpath walk would miss them)", () => {
  const home = tmpDir(), outside = tmpDir();
  const real = realInstallPaths(home);
  for (const [name, path] of Object.entries(real)) {
    const link = join(outside, `dangling-${name}`);
    symlinkSync(path, link); // the target does not exist: pacer is not actually installed here
    expect(() => assertNotRealInstall(link, "write", home)).toThrow(/refusing to write/);
    expect(() => assertNotRealInstall(join(link, "nested/file"), "write", home)).toThrow(/refusing to write/);
  }
});
test("assertNotRealInstall follows a chain of dangling symlinks, and bounds a symlink loop", () => {
  const home = tmpDir(), outside = tmpDir();
  const first = join(outside, "first"), second = join(outside, "second");
  symlinkSync(join(home, ".local/bin/pacer"), second); // dangling: home/.local/bin was never created
  symlinkSync(second, first);
  expect(() => assertNotRealInstall(first, "write", home)).toThrow(/refusing to write/);
  const loopA = join(outside, "loop-a"), loopB = join(outside, "loop-b");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);
  expect(() => assertNotRealInstall(loopA, "write", home)).toThrow(/too many levels of symbolic links/);
});
test("assertNotRealInstall is case-insensitive for a not-yet-created tail (APFS is case-insensitive by default)", () => {
  const home = tmpDir();
  if (process.platform === "darwin") {
    expect(() => assertNotRealInstall("/Applications/Pacer.app", "write", home)).toThrow(/refusing to write/);
    expect(() => assertNotRealInstall(join(home, ".LOCAL/BIN/PACER"), "write", home)).toThrow(/refusing to write/);
  } else {
    // Elsewhere the filesystem is case-sensitive, so a differently-cased path is simply a different, harmless path.
    expect(() => assertNotRealInstall("/Applications/Pacer.app", "write", home)).not.toThrow();
  }
});
test("assertNotRealInstall collapses .. before comparing, even against a not-yet-created target", () => {
  const home = tmpDir();
  const viaDotDot = join(home, ".local/bin/../bin/pacer");
  expect(() => assertNotRealInstall(viaDotDot, "write", home)).toThrow(/refusing to write/);
  const viaDeeperDotDot = join(home, "elsewhere/one/two/../../../.local/bin/pacer");
  expect(() => assertNotRealInstall(viaDeeperDotDot, "write", home)).toThrow(/refusing to write/);
});

test("assertNotRealInstall is bypassed only by PACER_ALLOW_REAL_INSTALL=1", () => {
  const home = tmpDir();
  const real = join(home, ".local/bin/pacer");
  expect(() => assertNotRealInstall(real, "write", home)).toThrow();
  process.env.PACER_ALLOW_REAL_INSTALL = "0";
  try {
    expect(() => assertNotRealInstall(real, "write", home)).toThrow();
  } finally { delete process.env.PACER_ALLOW_REAL_INSTALL; }
  process.env.PACER_ALLOW_REAL_INSTALL = "1";
  try {
    expect(() => assertNotRealInstall(real, "write", home)).not.toThrow();
  } finally { delete process.env.PACER_ALLOW_REAL_INSTALL; }
  expect(() => assertNotRealInstall(real, "write", home)).toThrow();
});

test("assertNotRealServiceLabel refuses only the real com.pacer.serve label", () => {
  expect(() => assertNotRealServiceLabel(REAL_SERVICE_LABEL, "register")).toThrow(/refusing to register/);
  expect(() => assertNotRealServiceLabel("com.pacer.live.deadbeef.service", "register")).not.toThrow();
  process.env.PACER_ALLOW_REAL_INSTALL = "1";
  try {
    expect(() => assertNotRealServiceLabel(REAL_SERVICE_LABEL, "register")).not.toThrow();
  } finally { delete process.env.PACER_ALLOW_REAL_INSTALL; }
});

test("a live-upgrade entry point (handoverFailureMarker) refuses the real service label but accepts its own fixture label", () => {
  const root = join(liveRoot, "real-install-guard-test");
  const policy = upgradePolicy({ id: "real-install-guard-test", root, port: 1, pid: 1, innerPort: 50123, createdAt: new Date().toISOString() } as Session, "a".repeat(32), 501);
  expect(() => handoverFailureMarker(policy)).not.toThrow();
  expect(() => handoverFailureMarker({ ...policy, serviceLabel: REAL_SERVICE_LABEL })).toThrow(/real pacer service label|non-fixture service label/);
});

test.skipIf(process.platform !== "darwin")("live desktop --app refuses to launch the real installed app", () => {
  const session = { id: "t", root: tmpDir(), port: 1, pid: 1, createdAt: new Date().toISOString() } as Session;
  expect(() => desktop(session, "/Applications/pacer.app")).toThrow(/refusing to live desktop --app/);
  expect(() => desktop(session, "/Applications/pacer.app/Contents/MacOS/pacer")).toThrow(/refusing to live desktop --app/);
});

/**
 * Every dev/test/build file that mentions a real-install surface must either call the guard
 * itself or be in this short, justified allowlist. Keep the list small: each entry here is
 * read-only evidence capture, a fully mocked service manager, a stub written under a fixture's
 * own isolated home, or a disposable mktemp smoke-test home — never the real install.
 */
const ALLOWLIST = new Map<string, string>([
  ["scripts/live/ota-real-app.ts", "read-only snapshot of the real app/CLI link/service plist, for before/after evidence comparison; never writes"],
  ["scripts/live/ota.ts", "reads the real service plist digest read-only for before/after comparison, and builds state.pacerHome (the fixture's own isolated home) for the .local/bin/pacer comparison"],
  ["scripts/live/ota-native.ts", "builds the fixture's own .local/bin/pacer symlink under state.pacerHome, the fixture's isolated home"],
  ["scripts/live/seed.ts", "writes a placeholder plist under the fixture's own isolated sandbox home (never ~/Library/LaunchAgents); the stub refuses every real manager mutation"],
  ["scripts/live/repair-integrations.ts", "ctx.run is replaced by a mock that only asserts the argv a real launchctl/systemctl would see; it never spawns the real binary"],
  ["desktop/scripts/build-linux-bundles.sh", "PACER_HOME is $smoke_home/.pacer, a disposable mktemp smoke-test home"],
  ["desktop/scripts/repack-appimage.sh", "PACER_HOME is $work/home/.pacer, a disposable mktemp smoke-test home"],
]);
/** A `.local`/`bin` path built from separate join() arguments instead of one literal, e.g. `join(home, ".local", "bin")`. */
const SPLIT_JOIN_LOCAL_BIN = /["'`]\.local["'`]\s*,\s*["'`]bin["'`]/;
function hasRealInstallLiteral(text: string): boolean {
  return text.includes("/Applications/pacer.app") || text.includes(".local/bin/pacer") || text.includes("com.pacer.serve")
    || text.includes("LaunchAgents") || text.includes("/.pacer") || SPLIT_JOIN_LOCAL_BIN.test(text);
}
function filesIn(dir: string, ext: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) { if (recursive) out.push(...filesIn(path, ext, recursive)); continue; }
    if (stat.isFile() && name.endsWith(ext) && !name.endsWith(`.test${ext}`)) out.push(path);
  }
  return out;
}
function scannedFiles(): string[] {
  const scriptsRoot = join(checkout, "scripts");
  return [
    ...filesIn(join(scriptsRoot, "live"), ".ts", true),
    ...filesIn(join(scriptsRoot, "release"), ".ts", true),
    ...filesIn(scriptsRoot, ".ts", false), // top-level scripts/*.ts only; scripts/lib defines the guard itself
    ...filesIn(join(checkout, "desktop/scripts"), ".sh", false),
  ];
}
test("every real-install literal under scripts/ and desktop/scripts/ actually calls the guard, or is allowlisted", () => {
  const offenders: string[] = [];
  for (const file of scannedFiles()) {
    const text = readFileSync(file, "utf8");
    if (!hasRealInstallLiteral(text)) continue;
    const key = relative(checkout, file);
    // A mention or a bare import is not enough: require an actual call. Shell scripts can only be allowlisted.
    const calls = file.endsWith(".ts") && (text.includes("assertNotRealInstall(") || text.includes("assertNotRealServiceLabel("));
    if (calls || ALLOWLIST.has(key)) continue;
    offenders.push(key);
  }
  expect(offenders).toEqual([]);
});
test("the allowlist names only files that actually contain a real-install literal", () => {
  for (const key of ALLOWLIST.keys()) {
    expect(hasRealInstallLiteral(readFileSync(resolve(checkout, key), "utf8"))).toBe(true);
  }
});
test("the split-argument join(home, \".local\", \"bin\") style is detected like the single-literal form", () => {
  expect(hasRealInstallLiteral('const bin = join(home, ".local", "bin", "pacer");')).toBe(true);
  expect(hasRealInstallLiteral('const bin = join(home, ".local/bin/pacer");')).toBe(true);
  expect(hasRealInstallLiteral('const other = join(home, ".config", "pacer");')).toBe(false);
});
