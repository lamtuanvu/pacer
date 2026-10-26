import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { buildDesktopFeed, desktopAssetName, publishDesktopRelease, verifyUpdateSignature, DESKTOP_ARCHES, type DesktopReleaseOptions } from "../scripts/release/desktop-feed";

function signingFixture() {
  const keys = generateKeyPairSync("ed25519"), id = Buffer.from("fixture1");
  const raw = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = Buffer.from("untrusted comment: fixture public key\n" + Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64") + "\n").toString("base64");
  const signature = (data: Uint8Array, version = "1.2.3") => {
    const trusted = `timestamp:1\tfile:fixture.tar.gz\tversion:${version}`;
    const sig = sign(null, createHash("blake2b512").update(data).digest(), keys.privateKey);
    const packet = Buffer.concat([Buffer.from("ED"), id, sig]);
    return Buffer.from(`untrusted comment: fixture\n${packet.toString("base64")}\ntrusted comment: ${trusted}\n${sign(null, Buffer.concat([sig, Buffer.from(trusted)]), keys.privateKey).toString("base64")}\n`).toString("base64");
  };
  return { publicKey, signature };
}
function fixture() {
  const dir = tmpDir(), signing = signingFixture();
  writeFileSync(join(dir, "desktop-release-1.2.3.json"), JSON.stringify({ schema: 1, version: "1.2.3", notes: "release", pub_date: "2026-10-19T00:00:00Z" }));
  for (const arch of DESKTOP_ARCHES) {
    const bytes = Buffer.from(`signed fixture archive ${arch}`), name = desktopAssetName("1.2.3", arch);
    writeFileSync(join(dir, name), bytes); writeFileSync(join(dir, name + ".sig"), signing.signature(bytes));
  }
  const options: DesktopReleaseOptions = {
    mode: "fixture", publicKey: signing.publicKey, pins: { appleTeamId: "FIXTURE123" },
    verifyArchive: async (_bytes, arch) => ({ schema: 1, version: "1.2.3", arch, bundleId: "dev.pacer.desktop", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true, fixture: true }),
  };
  let promotions = 0;
  const assets = new Map<string, Uint8Array>();
  let head = "original", feed: string | null = null;
  const publisher = { mode: "fixture" as const, readAsset: async (name: string) => assets.get(name) ?? null,
    createAsset: async (name: string, bytes: Uint8Array) => { if (assets.has(name)) throw Error("exists"); assets.set(name, bytes); },
    readFeed: async () => ({ head, feed }),
    compareAndSwap: async (expected: string | null, next: string) => { if (expected !== head) throw Error("conflict"); promotions++; head = "promoted"; feed = next; },
  };
  return { dir, signing, options, publisher, assets, promotions: () => promotions };
}

test("version-bound minisign verification rejects tampering and version relabeling", () => {
  const f = signingFixture(), bytes = Buffer.from("payload"), signature = f.signature(bytes);
  expect(() => verifyUpdateSignature(bytes, signature, f.publicKey, "1.2.3")).not.toThrow();
  expect(() => verifyUpdateSignature(Buffer.from("changed"), signature, f.publicKey, "1.2.3")).toThrow();
  expect(() => verifyUpdateSignature(bytes, signature, f.publicKey, "1.2.4")).toThrow();
  expect(() => verifyUpdateSignature(bytes, signature, signingFixture().publicKey, "1.2.3")).toThrow();
});

test("the stable desktop feed refuses an absent Intel package", async () => {
  const f = fixture();
  rmSync(join(f.dir, desktopAssetName("1.2.3", "x86_64")));
  await expect(buildDesktopFeed(f.dir, "1.2.3", f.options)).rejects.toThrow();
});

test("complete feed contains both immutable macOS URLs and matching metadata", async () => {
  const f = fixture();
  const feed = JSON.parse(await buildDesktopFeed(f.dir, "1.2.3", f.options));
  expect(Object.keys(feed.platforms)).toEqual(["darwin-aarch64", "darwin-x86_64"]);
  expect(feed.platforms["darwin-aarch64"].url).toBe("https://github.com/lamtuanvu/pacer/releases/download/v1.2.3/desktop-pacer-1.2.3-darwin-aarch64.app.tar.gz");
  expect(feed.platforms["darwin-x86_64"].url).toBe("https://github.com/lamtuanvu/pacer/releases/download/v1.2.3/desktop-pacer-1.2.3-darwin-x86_64.app.tar.gz");
  expect(feed.platforms["darwin-aarch64"].admissionProtocol).toBe(1);
  expect(feed.platforms["darwin-x86_64"].admissionProtocol).toBe(1);
});

for (const reason of ["missing-archive", "bad-signature", "wrong-version", "wrong-arch", "wrong-protocol", "no-notarization", "prerelease", "cli-only"]) {
  test(`invalid desktop release ${reason} performs zero promotions`, async () => {
    const f = fixture(); let version = "1.2.3";
    if (reason === "missing-archive" || reason === "cli-only") rmSync(join(f.dir, desktopAssetName("1.2.3", "aarch64")));
    if (reason === "bad-signature") writeFileSync(join(f.dir, desktopAssetName("1.2.3", "aarch64") + ".sig"), "invalid");
    if (reason === "prerelease") version = "1.2.3-beta.1";
    const original = f.options.verifyArchive!;
    if (reason.startsWith("wrong-")) f.options.verifyArchive = async (b, a) => ({ ...await original(b, a), ...(reason === "wrong-version" ? { version: "1.2.2" } : reason === "wrong-arch" ? { arch: "other" } : { protocolMajors: [2] }) });
    if (reason === "no-notarization") f.options.verifyArchive = async () => { throw Error("notarization validation failed"); };
    await expect(publishDesktopRelease(f.dir, version, f.publisher, f.options)).rejects.toThrow();
    expect(f.promotions()).toBe(0); expect(f.assets.size).toBe(0);
  });
}

test("identical retry is a no-op and changed same-version bytes are immutable conflicts", async () => {
  const f = fixture();
  await publishDesktopRelease(f.dir, "1.2.3", f.publisher, f.options);
  await publishDesktopRelease(f.dir, "1.2.3", f.publisher, f.options);
  expect(f.promotions()).toBe(1);
  const name = desktopAssetName("1.2.3", "aarch64"), bytes = Buffer.from("new validly signed bytes");
  writeFileSync(join(f.dir, name), bytes); writeFileSync(join(f.dir, name + ".sig"), f.signing.signature(bytes));
  await expect(publishDesktopRelease(f.dir, "1.2.3", f.publisher, f.options)).rejects.toThrow("immutable");
  expect(f.promotions()).toBe(1);
});

test("partial asset failure and stale promotion leave the previous feed untouched", async () => {
  const f = fixture();
  await expect(publishDesktopRelease(f.dir, "1.2.3", { ...f.publisher, createAsset: async () => { throw Error("upload failed"); } }, f.options)).rejects.toThrow();
  await expect(publishDesktopRelease(f.dir, "1.2.3", { ...f.publisher, compareAndSwap: async () => { throw Error("conflict"); } }, f.options)).rejects.toThrow("conflict");
  expect(f.promotions()).toBe(0); expect((await f.publisher.readFeed()).feed).toBe(null);
});

test("fixture validation can never authorize a production publisher", async () => {
  const f = fixture();
  await expect(publishDesktopRelease(f.dir, "1.2.3", { ...f.publisher, mode: "production" }, f.options)).rejects.toThrow("fixture");
  expect(f.promotions()).toBe(0);
});

test("official version-bound Tauri vector interoperates and altered trusted comment fails", () => {
  const key = Buffer.from("untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe").toString("base64");
  const raw = "untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==";
  expect(() => verifyUpdateSignature(Buffer.from("test"), Buffer.from(raw).toString("base64"), key, "2.0.0")).not.toThrow();
  expect(() => verifyUpdateSignature(Buffer.from("test"), Buffer.from(raw.replace("file:payload", "file:other")).toString("base64"), key, "2.0.0")).toThrow();
});

test("real local git CAS permits one competing promotion and preserves immutable retry", async () => {
  const { localFixturePublisher } = await import("../scripts/release/desktop-publisher");
  const f = fixture(), publisher = await localFixturePublisher(tmpDir(), "1.2.3");
  const a = await publisher.readFeed(), b = await publisher.readFeed();
  const results = await Promise.allSettled([publisher.compareAndSwap(a.head, '{"version":"1.0.0"}\n'), publisher.compareAndSwap(b.head, '{"version":"1.1.0"}\n')]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  await publishDesktopRelease(f.dir, "1.2.3", publisher, f.options);
  const before = await publisher.readFeed();
  await publishDesktopRelease(f.dir, "1.2.3", publisher, f.options);
  expect(await publisher.readFeed()).toEqual(before);
});

test("downgrade and production fixture verifier are refused before asset writes", async () => {
  const f = fixture();
  await expect(publishDesktopRelease(f.dir, "1.2.3", { ...f.publisher, readFeed: async () => ({ head: "newer", feed: '{"version":"2.0.0"}' }) }, f.options)).rejects.toThrow("downgrade");
  await expect(buildDesktopFeed(f.dir, "1.2.3", { ...f.options, mode: "production" })).rejects.toThrow("fixture verifier");
  expect(f.assets.size).toBe(0);
});
test("lost CAS response is recovered only when the exact validated feed is current", async () => {
  const f = fixture();
  await publishDesktopRelease(f.dir, "1.2.3", { ...f.publisher, compareAndSwap: async (expected, feed) => { await f.publisher.compareAndSwap(expected, feed); throw Error("lost response"); } }, f.options);
  expect(f.promotions()).toBe(1);
});

test("feed text limits match the native private wire in UTF8 bytes", async () => {
  const f = fixture();
  const manifest = join(f.dir, "desktop-release-1.2.3.json");
  writeFileSync(manifest, JSON.stringify({ schema: 1, version: "1.2.3", notes: "é".repeat(16385), pub_date: "2026-10-19T00:00:00Z" }));
  await expect(buildDesktopFeed(f.dir, "1.2.3", f.options)).rejects.toThrow();
  writeFileSync(manifest, JSON.stringify({ schema: 1, version: "1.2.3", notes: "ok", pub_date: "2026-10-19T00:00:00Z" }));
  const signature = join(f.dir, desktopAssetName("1.2.3", "aarch64") + ".sig");
  const raw = Buffer.from(readFileSync(signature, "utf8"), "base64").toString().replace("untrusted comment: fixture", "untrusted comment: " + "x".repeat(6000));
  writeFileSync(signature, Buffer.from(raw).toString("base64"));
  await expect(buildDesktopFeed(f.dir, "1.2.3", f.options)).rejects.toThrow();
});

test("release validation requires a valid signer pin before reading any asset", async () => {
  const f = fixture();
  for (const pins of [{}, { appleTeamId: "bad" }, { signingCertSha1: "a".repeat(40) }])
    await expect(buildDesktopFeed(f.dir, "1.2.3", { ...f.options, pins })).rejects.toThrow("trust inputs");
  expect(await buildDesktopFeed(f.dir, "1.2.3", { ...f.options, pins: { signingCertSha1: "A".repeat(40) } })).toContain("darwin-aarch64");
});
test("interim archives are verified by certificate requirement, Developer ID archives by notarization", async () => {
  const { signedAppChecks } = await import("../scripts/release/desktop-verify");
  const cert = "2C5405FB6D2906AE2049D59B9DF5D42661997922";
  const self = signedAppChecks("/a/pacer.app", { signingCertSha1: cert }).map(a => a.join(" "));
  expect(self).toContain(`/usr/bin/codesign --verify --strict -R=identifier "dev.pacer.cli" and certificate leaf = H"${cert}" /a/pacer.app/Contents/Resources/pacer`);
  expect(self.join("\n")).not.toMatch(/stapler|spctl/);
  const apple = signedAppChecks("/a/pacer.app", { appleTeamId: "ABCDE12345" }).map(a => a.join(" "));
  expect(apple).toContain("/usr/bin/xcrun stapler validate /a/pacer.app");
  expect(apple).toContain("/usr/sbin/spctl --assess --type execute /a/pacer.app");
  const bridge = signedAppChecks("/a/pacer.app", { appleTeamId: "ABCDE12345", signingCertSha1: cert }).map(a => a.join(" "));
  expect(bridge.join("\n")).not.toMatch(/stapler|spctl/);
  expect(bridge.some(c => c.includes("or certificate leaf"))).toBe(true);
});
