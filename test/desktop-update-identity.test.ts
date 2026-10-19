import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CoreError } from "../src/core/errors";
import { plist, servicePath } from "../src/service";
import { inspectInstallation, installationFingerprint, isBundledExecutable, parseBundleRelease, verifyInstallation, type BundleRelease } from "../src/update/desktop/identity";
import { fakeCtx, tmpDir } from "./helpers";

const release: BundleRelease = { schema: 1, bundleId: "dev.pacer.desktop", version: "1.2.3", arch: process.arch === "arm64" ? "aarch64" : "x86_64", protocolMajors: [3], admissionProtocol: 1, rollbackCompatible: true, nativeTransportAbi: 1 };
function fixture() {
  const ctx = fakeCtx({ env: { PACER_PORT: "54321" } });
  mkdirSync(ctx.pacerHome);
  const app = join(ctx.home, "Applications/pacer.app");
  const cli = join(app, "Contents/Resources/pacer");
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"));
  for (const path of [cli, join(app, "Contents/Resources/pacer-update-helper"), join(app, "Contents/MacOS/pacer")]) writeFileSync(path, "executable fixture", { mode: 0o755 });
  writeFileSync(join(app, "Contents/Resources/pacer-release.json"), JSON.stringify(release));
  writeFileSync(join(app, "Contents/Info.plist"), `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${release.bundleId}</string><key>CFBundleShortVersionString</key><string>${release.version}</string><key>CFBundleExecutable</key><string>pacer</string></dict></plist>`);
  const registration = servicePath(ctx, "darwin");
  mkdirSync(dirname(registration), { recursive: true });
  writeFileSync(registration, plist(ctx, [cli]));
  return { ctx, app, cli, registration };
}

test("trusted registration canonicalizes app aliases and binds the full service identity", async () => {
  const f = fixture(), alias = join(f.ctx.home, "alias.app");
  symlinkSync(f.app, alias);
  const identity = await inspectInstallation(f.ctx, alias);
  expect(identity).toMatchObject({ appPath: realpathSync(f.app), ownerUid: process.getuid!(), pacerHome: realpathSync(f.ctx.pacerHome), port: 54321, ownership: "managed", version: "1.2.3", bundleId: release.bundleId });
  await verifyInstallation(f.ctx, identity);
  expect(isBundledExecutable(f.cli)).toBe(true);
  const binAlias = join(f.ctx.home, "pacer"); symlinkSync(f.cli, binAlias);
  expect(isBundledExecutable(binAlias)).toBe(true);
  expect(isBundledExecutable(process.execPath)).toBe(false);
});

test("an independent registered binary stays attached and is never executed or adopted", async () => {
  const f = fixture();
  const external = join(f.ctx.home, "old-pacer"); writeFileSync(external, "older executable", { mode: 0o755 });
  writeFileSync(f.registration, plist(f.ctx, [external]));
  f.ctx.run = async () => { throw Error("must not execute old CLI or service manager"); };
  const before = readFileSync(f.registration, "utf8");
  expect((await inspectInstallation(f.ctx, f.app)).ownership).toBe("attached");
  expect(readFileSync(f.registration, "utf8")).toBe(before);
});

test("wrong home, port, argv, label and ambiguous plist fail without mutation", async () => {
  for (const change of [
    (s: string) => s.replace(`<string>${54321}</string>`, "<string>54322</string>"),
    (s: string) => s.replace(/<key>HOME<\/key><string>.*?<\/string>/, "<key>HOME</key><string>/another-home</string>"),
    (s: string) => s.replace(/<key>PACER_HOME<\/key><string>.*?<\/string>/, "<key>PACER_HOME</key><string>/another-state</string>"),
    (s: string) => s.replace("<string>serve</string>", "<string>serve</string><string>--port</string><string>54322</string>"),
    (s: string) => s.replace("<string>serve</string>", "<string>src/cli.ts</string><string>serve</string>"),
    (s: string) => s.replace("<string>com.pacer.serve</string>", "<string>other.service</string>"),
    (s: string) => s.replace("<key>ProgramArguments</key>", "<key>Program</key><string>/different</string><key>ProgramArguments</key>"),
    (s: string) => s.replace("<key>Label</key>", "<key>Label</key><string>duplicate</string><key>Label</key>"),
  ]) {
    const f = fixture(), text = change(readFileSync(f.registration, "utf8"));
    writeFileSync(f.registration, text);
    await expect(inspectInstallation(f.ctx, f.app)).rejects.toBeInstanceOf(CoreError);
    expect(readFileSync(f.registration, "utf8")).toBe(text);
  }
});

test("verification detects changed UID, home, port, version and moved or swapped app", async () => {
  const f = fixture(), identity = await inspectInstallation(f.ctx, f.app);
  for (const changed of [{ ownerUid: identity.ownerUid + 1 }, { pacerHome: tmpDir() }, { port: 1 }, { version: "9.0.0" }, { id: "another-installation" }]) {
    await expect(verifyInstallation(f.ctx, { ...identity, ...changed })).rejects.toBeInstanceOf(CoreError);
  }
  const moved = f.app + "-moved"; renameSync(f.app, moved); symlinkSync(moved, f.app);
  await expect(verifyInstallation(f.ctx, identity)).rejects.toBeInstanceOf(CoreError);
});

test("read-only destinations, symlinked payloads and missing metadata refuse eligibility", async () => {
  for (const mode of ["parent", "payload", "metadata", "registration"]) {
    const f = fixture();
    if (mode === "parent") chmodSync(dirname(f.app), 0o555);
    if (mode === "payload") { rmSync(f.cli); symlinkSync(process.execPath, f.cli); }
    if (mode === "metadata") rmSync(join(f.app, "Contents/Resources/pacer-release.json"));
    if (mode === "registration") { renameSync(f.registration, f.registration + ".real"); symlinkSync(f.registration + ".real", f.registration); }
    try { await expect(inspectInstallation(f.ctx, f.app)).rejects.toBeInstanceOf(CoreError); }
    finally { if (mode === "parent") chmodSync(dirname(f.app), 0o755); }
  }
});

test("bundle metadata fails closed on unsupported admission, architecture and schema", () => {
  expect(parseBundleRelease({ ...release, additive: true })).toEqual(release);
  for (const patch of [{ nativeTransportAbi: undefined }, { nativeTransportAbi: 2 }, { schema: 2 }, { admissionProtocol: 0 }, { arch: "universal" }, { rollbackCompatible: false }, { version: "latest" }, { bundleId: "other.app" }, { protocolMajors: [] }]) {
    expect(() => parseBundleRelease({ ...release, ...patch })).toThrow(CoreError);
  }
});

test("attached registration changes and swapped executable aliases invalidate the recorded identity", async () => {
  const f = fixture(), first = join(f.ctx.home, "old-pacer"), second = join(f.ctx.home, "other-pacer"), alias = join(f.ctx.home, "bin-pacer");
  for (const path of [first, second]) writeFileSync(path, "executable", { mode: 0o755 });
  symlinkSync(first, alias); writeFileSync(f.registration, plist(f.ctx, [alias]));
  const expected = await inspectInstallation(f.ctx, f.app);
  rmSync(alias); symlinkSync(second, alias);
  await expect(verifyInstallation(f.ctx, expected)).rejects.toBeInstanceOf(CoreError);
});

test("bundle mismatches and missing bootstrap registration refuse before native mutation", async () => {
  for (const mode of ["version", "arch", "registration", "other-app", "translocation"]) {
    const f = fixture();
    if (mode === "version") writeFileSync(join(f.app, "Contents/Resources/pacer-release.json"), JSON.stringify({ ...release, version: "2.0.0" }));
    if (mode === "arch") writeFileSync(join(f.app, "Contents/Resources/pacer-release.json"), JSON.stringify({ ...release, arch: release.arch === "aarch64" ? "x86_64" : "aarch64" }));
    if (mode === "registration") rmSync(f.registration);
    if (mode === "other-app") { const other = fixture(); writeFileSync(f.registration, plist(f.ctx, [other.cli])); }
    if (mode === "translocation") { const moved = join(f.ctx.home, "AppTranslocation/pacer.app"); mkdirSync(dirname(moved)); renameSync(f.app, moved); f.app = moved; }
    await expect(inspectInstallation(f.ctx, f.app)).rejects.toBeInstanceOf(CoreError);
  }
});

test("installation fingerprint uses canonical field ordering and binds executable plus registration",async()=>{
 const f=fixture(),installation=await inspectInstallation(f.ctx,f.app);const {id,version,...identity}=installation;
 const text=readFileSync(f.registration,"utf8"),binary=realpathSync(f.cli);
 expect(installationFingerprint(identity,binary,text)).toBe(id);
 expect(installationFingerprint({...identity,appPath:identity.appPath},binary,text)).toBe(id);
 const reverse=Object.fromEntries(Object.entries(identity).reverse()) as typeof identity;
 expect(installationFingerprint(reverse,binary,text)).toBe(id);
 expect(installationFingerprint(identity,binary+"-other",text)).not.toBe(id);
 expect(installationFingerprint(identity,binary,text+"\n")).not.toBe(id);
});

test("shared adoption identity fixture matches the native ordered serialization",()=>{
 const fixture=JSON.parse(readFileSync(new URL("./fixtures/desktop-update/adoption-identity.json",import.meta.url),"utf8"));
 expect(installationFingerprint(fixture.identity,fixture.binary,fixture.registrationText)).toBe(fixture.expected);
});
