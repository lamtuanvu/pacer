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
 * Every dev/test write site that mentions the real app bundle or the real CLI link path must
 * either go through this guard or be in this short, justified allowlist. Keep the list small:
 * each entry here is read-only evidence capture or builds a path under a fixture's own
 * isolated home, never the real one.
 */
const ALLOWLIST = new Map<string, string>([
  ["live/ota-real-app.ts", "read-only snapshot of the real app/CLI link, for before/after evidence comparison; never writes"],
  ["live/ota.ts", "builds state.pacerHome (the fixture's own isolated home) for comparison, not the real home"],
  ["live/ota-native.ts", "builds the fixture's own .local/bin/pacer symlink under state.pacerHome, the fixture's isolated home"],
]);
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isDirectory()) out.push(...tsFiles(path));
    else if (stat.isFile() && name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}
test("every real-install literal under scripts/live and scripts/release goes through the guard or is allowlisted", () => {
  const scriptsRoot = join(checkout, "scripts");
  const offenders: string[] = [];
  for (const base of ["live", "release"]) {
    for (const file of tsFiles(join(scriptsRoot, base))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("/Applications/pacer.app") && !text.includes(".local/bin/pacer")) continue;
      const key = relative(scriptsRoot, file);
      if (text.includes("real-install-guard") || ALLOWLIST.has(key)) continue;
      offenders.push(key);
    }
  }
  expect(offenders).toEqual([]);
});
test("the allowlist names only files that actually contain a real-install literal", () => {
  const scriptsRoot = join(checkout, "scripts");
  for (const key of ALLOWLIST.keys()) {
    const text = readFileSync(resolve(scriptsRoot, key), "utf8");
    expect(text.includes("/Applications/pacer.app") || text.includes(".local/bin/pacer")).toBe(true);
  }
});
