import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { DESKTOP_IDENTIFIERS, FIXTURE_IDENTIFIERS, RELEASE_IDENTIFIERS, desktopIdentifiers } from "../src/update/desktop/bundle-identity";
import { BUNDLE_ID, parseBundleRelease } from "../src/update/desktop/identity";
import { parseAdapterCommand, parseAdapterFrame } from "../src/update/desktop/adapter";
import { adoptionAuthoritySchema } from "../src/update/desktop/adoption-state";
import { nativeIdentifier } from "../src/update/desktop/native-os";

const nonce = "a".repeat(32);
const lease = { schema: 1, root: "/fixture/.work/live/test/ota", nonce, home: "/fixture/.work/live/test/home", port: 49991, currentApp: "/fixture/.work/live/test/ota/current.app", serviceLabel: `com.pacer.live.${nonce}.service`, recoveryLabel: `com.pacer.live.${nonce}.recovery`, uid: 501 };

/** Bundle the probe with an optional compiled lease, then run it with an optional runtime environment. */
function compiledIdentity(compiled?: string, env: Record<string, string> = {}) {
  const out = join(tmpDir(), "identity.js");
  const build = Bun.spawnSync([process.execPath, "build", "--target=bun", join(import.meta.dir, "fixtures/desktop-update/compiled-identity.ts"), "--outfile", out,
    ...(compiled === undefined ? [] : ["--define", `PACER_BUILD_OTA_FIXTURE=${JSON.stringify(compiled)}`])], { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const result = Bun.spawnSync([process.execPath, out], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}

test("identifier sets are fixed and the fixture set never overlaps the release set", () => {
  expect(RELEASE_IDENTIFIERS).toEqual({ desktop: "dev.pacer.desktop", cli: "dev.pacer.cli", nativeShim: "dev.pacer.desktop.native-shim", helper: "dev.pacer.desktop.update-helper" });
  expect(FIXTURE_IDENTIFIERS).toEqual({ desktop: "dev.pacer.desktop.fixture", cli: "dev.pacer.desktop.fixture.cli", nativeShim: "dev.pacer.desktop.fixture.native-shim", helper: "dev.pacer.desktop.fixture.update-helper" });
  expect(desktopIdentifiers(false)).toBe(RELEASE_IDENTIFIERS);
  expect(desktopIdentifiers(true)).toBe(FIXTURE_IDENTIFIERS);
  expect(Object.isFrozen(RELEASE_IDENTIFIERS)).toBe(true);
  expect(Object.isFrozen(FIXTURE_IDENTIFIERS)).toBe(true);
  const all = [...Object.values(RELEASE_IDENTIFIERS), ...Object.values(FIXTURE_IDENTIFIERS)];
  expect(new Set(all).size).toBe(all.length);
});

test("only a compiled fixture lease selects the fixture identifiers and the fixture app", () => {
  const release = { identifiers: RELEASE_IDENTIFIERS, shim: RELEASE_IDENTIFIERS.nativeShim, open: ["open", "-b", RELEASE_IDENTIFIERS.desktop, "pacer://overview"] };
  expect(compiledIdentity()).toEqual(release);
  // A runtime environment variable with the same name never selects fixture identity.
  expect(compiledIdentity(undefined, { PACER_BUILD_OTA_FIXTURE: JSON.stringify(lease) })).toEqual(release);
  expect(compiledIdentity(JSON.stringify(lease))).toEqual({ identifiers: FIXTURE_IDENTIFIERS, shim: FIXTURE_IDENTIFIERS.nativeShim, open: ["open", "-b", FIXTURE_IDENTIFIERS.desktop, "pacer://overview"] });
  // A binary compiled with any lease never claims the release identity, even an invalid one.
  expect(compiledIdentity("{}").identifiers).toEqual(FIXTURE_IDENTIFIERS);
}, 60_000);

test("the release service uses release identifiers for every check", () => {
  expect(DESKTOP_IDENTIFIERS).toBe(RELEASE_IDENTIFIERS);
  expect(BUNDLE_ID).toBe(RELEASE_IDENTIFIERS.desktop);
  expect(nativeIdentifier("desktop")).toBe(RELEASE_IDENTIFIERS.desktop);
  expect(nativeIdentifier("cli")).toBe(RELEASE_IDENTIFIERS.cli);
  expect(nativeIdentifier("helper")).toBe(RELEASE_IDENTIFIERS.helper);
  expect(nativeIdentifier("native-shim")).toBe(RELEASE_IDENTIFIERS.nativeShim);
});

test("release bundle metadata refuses the fixture identifier", () => {
  const release = { schema: 1, bundleId: RELEASE_IDENTIFIERS.desktop, version: "1.2.3", arch: "aarch64", protocolMajors: [3], admissionProtocol: 1, rollbackCompatible: true, nativeTransportAbi: 1 };
  expect(parseBundleRelease(release).bundleId).toBe(RELEASE_IDENTIFIERS.desktop);
  expect(() => parseBundleRelease({ ...release, bundleId: FIXTURE_IDENTIFIERS.desktop })).toThrow("Unsupported desktop release metadata");
});

test("the release adapter refuses fixture targets and fixture hello frames", () => {
  const wire = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/desktop-update/adapter-wire.json"), "utf8"));
  const install = wire.commands.find((command: { command: string }) => command.command === "install");
  expect(parseAdapterCommand(install).command).toBe("install");
  expect(() => parseAdapterCommand({ ...install, target: { ...install.target, bundleId: FIXTURE_IDENTIFIERS.desktop } })).toThrow();
  const hello = wire.frames.find((frame: { kind: string }) => frame.kind === "hello");
  expect(parseAdapterFrame(hello).kind).toBe("hello");
  expect(() => parseAdapterFrame({ ...hello, bundleId: FIXTURE_IDENTIFIERS.desktop })).toThrow();
});

test("release adoption state refuses a fixture target", () => {
  const authority = {
    target: { id: "attached", appPath: "/tmp/pacer.app", bundleId: RELEASE_IDENTIFIERS.desktop, ownerUid: 501, arch: "aarch64", pacerHome: "/tmp/pacer-home", port: 7433, serviceLabel: "com.pacer.serve", ownership: "attached", version: "1.0.0" },
    nativeSessionId: "native", desktopClientId: "desktop", bootId: "boot",
    desktop: { pid: 101, bootId: "boot", birth: "1:1" }, service: { pid: 102, bootId: "boot", birth: "1:2" },
    serviceVersion: "1.0.0", oldServiceExecutable: "/opt/pacer", newServiceExecutable: "/tmp/pacer.app/Contents/Resources/pacer",
  };
  expect(adoptionAuthoritySchema.safeParse(authority).success).toBe(true);
  expect(adoptionAuthoritySchema.safeParse({ ...authority, target: { ...authority.target, bundleId: FIXTURE_IDENTIFIERS.desktop } }).success).toBe(false);
});
