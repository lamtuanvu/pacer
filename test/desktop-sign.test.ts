import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { signStagedDesktop, signingConfig } from "../scripts/release/desktop-sign";

function fixture() {
  const stage = tmpDir(), app = join(stage, "pacer.app"), resources = join(app, "Contents/Resources"), calls: string[][] = [];
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "pacer-release.json"), JSON.stringify({ schema: 1, version: "1.2.3", arch: "aarch64", bundleId: "dev.pacer.desktop", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true }));
  mkdirSync(join(app, "Contents/Frameworks"));
  const dylib = Buffer.alloc(32); dylib.writeUInt32LE(0xfeedfacf, 0); dylib.writeUInt32LE(0x0100000c, 4); dylib.writeUInt32LE(6, 12);
  writeFileSync(join(app, "Contents/Frameworks/libpacer-native.dylib"), dylib, { mode: 0o755 });
  const config = { teamId: "ABCDE12345", identity: "a".repeat(40), keychain: join(stage, "keychain"), notaryKey: join(stage, "notary.p8"), notaryKeyId: "ABCDE12345", notaryIssuer: "12345678-1234-1234-1234-123456789abc", signerKey: join(stage, "signer.key"), publicKey: "fixture" };
  for (const path of [config.keychain, config.notaryKey, config.signerKey]) writeFileSync(path, "fixture", { mode: 0o600 });
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "--pacer-identity") return JSON.stringify({ fixture: false, otaMode: "production", appleTeamId: config.teamId, updaterKeySha256: createHash("sha256").update(config.publicKey).digest("hex"), role: argv[0].endsWith("helper") ? "update-helper" : argv[0].includes("/Resources/") ? "cli" : "desktop", version: "1.2.3", arch: "aarch64", bundleId: argv[0].endsWith("/Resources/pacer") ? "dev.pacer.cli" : "dev.pacer.desktop" });
    if (argv[1] === "--pacer-native-transport-test") return JSON.stringify({ schema: 1, role: "cli", version: "1.2.3", arch: "aarch64", nativeTransportAbi: 1, transport: "unix-audit-token", verified: true });
    if (argv[1] === "--pacer-helper-runtime-test") return JSON.stringify({ schema: 1, role: "update-helper", version: "1.2.3", arch: "aarch64", runtime: "tauri-updater", verified: true });
    if (argv.includes("notarytool")) return JSON.stringify({ status: "Accepted", id: "fixture" });
    return "";
  };
  return { stage, app, config, calls, run };
}
test("failed or mismatched native helper runtime cannot reach notarization", async () => {
  for (const fault of ["exception", "version", "unverified"]) {
    const f = fixture();
    await expect(signStagedDesktop({ root: "/fixture/root", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
      const result = await f.run(argv);
      if (argv[1] !== "--pacer-helper-runtime-test") return result;
      if (fault === "exception") throw Error("helper setup failed");
      const receipt = JSON.parse(result);
      if (fault === "version") receipt.version = "1.2.2";
      else receipt.verified = false;
      return JSON.stringify(receipt);
    })).rejects.toThrow();
    expect(f.calls.some(argv => argv.includes("notarytool") || argv[0] === "/usr/bin/tar")).toBe(false);
  }
});
test("production signing requires explicit complete credentials and rejects missing or malformed configuration", () => {
  expect(() => signingConfig({})).toThrow("configured");
  expect(() => signingConfig({ PACER_APPLE_TEAM_ID: "bad" })).toThrow();
});
test("complete app is marked production before inside-out signing, notarized, stapled, then archived and version-signed", async () => {
  const f = fixture();
  await signStagedDesktop({ root: "/fixture/root", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, f.run);
  expect(JSON.parse(readFileSync(join(f.app, "Contents/Resources/pacer-release.json"), "utf8")).fixture).toBe(false);
  const commands = f.calls.map(a => a.join(" "));
  const signs = f.calls.filter(a => a[0] === "/usr/bin/codesign" && a.includes("--sign"));
  expect(signs.map(a => a.at(-1))).toEqual([join(f.app, "Contents/Frameworks/libpacer-native.dylib"), join(f.app, "Contents/Resources/pacer"), join(f.app, "Contents/Resources/pacer-update-helper"), f.app]);
  expect(signs.every(a => a.includes("--timestamp") && a.includes("runtime") && !a.includes("--deep"))).toBe(true);
  const entitlements = readFileSync(signs[1][signs[1].indexOf("--entitlements") + 1], "utf8");
  expect(entitlements).toContain("com.apple.security.cs.allow-jit");
  expect(entitlements).not.toContain("allow-unsigned-executable-memory");
  expect(entitlements).not.toContain("disable-library-validation");
  expect(signs[0]).toContain("dev.pacer.desktop.native-shim");
  expect(signs[0]).not.toContain("--entitlements");
  const notary = commands.findIndex(c => c.includes("notarytool submit")), staple = commands.findIndex(c => c.includes("stapler staple")), archive = commands.findIndex(c => c.startsWith("/usr/bin/tar")), artifactSign = commands.findIndex(c => c.includes("signer sign"));
  expect(notary).toBeGreaterThan(commands.indexOf(signs.at(-1)!.join(" ")));
  const transport = f.calls.findIndex(a => a[1] === "--pacer-native-transport-test");
  expect(transport).toBeGreaterThan(commands.indexOf(signs.at(-1)!.join(" ")));
  expect(transport).toBeLessThan(notary);
  const helperRuntime = f.calls.findIndex(a => a[1] === "--pacer-helper-runtime-test");
  expect(helperRuntime).toBeGreaterThan(transport);
  expect(helperRuntime).toBeLessThan(notary);
  expect(staple).toBeGreaterThan(notary); expect(archive).toBeGreaterThan(staple); expect(artifactSign).toBeGreaterThan(archive);
  expect(f.calls[artifactSign]).toContain("--app-version"); expect(f.calls[artifactSign]).toContain("1.2.3");
  expect(commands.join("\n")).not.toContain("--private-key ");
});

test("native permission helper is validated and signed before its containing app", async () => {
  for (const wrongArch of [false, true]) {
    const f = fixture(), helper = join(f.app, "Contents/MacOS/pacer-permission-setup");
    mkdirSync(join(f.app, "Contents/MacOS"), { recursive: true });
    const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(wrongArch ? 0x01000007 : 0x0100000c, 4); bytes.writeUInt32LE(2, 12);
    writeFileSync(helper, bytes, { mode: 0o755 });
    const sign = () => signStagedDesktop({ root: "/fixture/root", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, f.run);
    if (wrongArch) {
      await expect(sign()).rejects.toThrow("architecture");
      expect(f.calls).toEqual([]);
    } else {
      await sign();
      const signs = f.calls.filter(a => a[0] === "/usr/bin/codesign" && a.includes("--sign"));
      expect(signs.at(-2)?.at(-1)).toBe(helper);
      expect(signs.at(-2)).toContain("dev.pacer.permission-setup");
      expect(signs.at(-2)).not.toContain("--entitlements");
      expect(signs.at(-1)?.at(-1)).toBe(f.app);
      expect(f.calls.some(a => a[0] === helper && a[1]?.startsWith("--pacer"))).toBe(false);
    }
  }
});
test("notary rejection or fixture-built native binary prevents final archive and artifact signature", async () => {
  for (const reason of ["notary", "fixture"]) {
    const f = fixture();
    await expect(signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
      const value = await f.run(argv);
      if (reason === "notary" && argv.includes("notarytool")) return '{"status":"Invalid"}';
      if (reason === "fixture" && argv[1] === "--pacer-identity") return value.replace('"fixture":false', '"fixture":true');
      return value;
    })).rejects.toThrow();
    expect(f.calls.some(a => a[0] === "/usr/bin/tar" || a.includes("signer"))).toBe(false);
  }
});

test("disabled native trust, wrong compiled team/key, or untrusted CLI prevents any signing", async () => {
  for (const reason of ["disabled", "team", "key", "cli"]) {
    const f = fixture();
    await expect(signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
      const value = await f.run(argv);
      if (argv[1] !== "--pacer-identity") return value;
      const id = JSON.parse(value);
      if (reason === "disabled") id.otaMode = "unavailable";
      if (reason === "team") id.appleTeamId = "WRONG12345";
      if (reason === "key") id.updaterKeySha256 = "0".repeat(64);
      if (reason === "cli" && id.role === "cli") id.appleTeamId = null;
      return JSON.stringify(id);
    })).rejects.toThrow("trust");
    expect(f.calls.some(a => a.includes("--sign"))).toBe(false);
  }
});


test("post-sign native transport failure or incompatible result prevents notarization and publication", async () => {
  for (const fault of ["exception", "abi", "version", "unverified", "missing"]) {
    const f = fixture();
    await expect(signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
      const result = await f.run(argv);
      if (argv[1] !== "--pacer-native-transport-test") return result;
      if (fault === "exception") throw Error("Library validation refused");
      if (fault === "missing") return "{}";
      const value = JSON.parse(result);
      if (fault === "abi") value.nativeTransportAbi = 2;
      if (fault === "version") value.version = "1.2.2";
      if (fault === "unverified") value.verified = false;
      return JSON.stringify(value);
    })).rejects.toThrow();
    expect(f.calls.some(a => a.includes("notarytool") || a[0] === "/usr/bin/tar" || a.includes("signer"))).toBe(false);
  }
});

const CERT = "2C5405FB6D2906AE2049D59B9DF5D42661997922";
function selfFixture(bridgeTeamId: string | null = null) {
  const f = fixture();
  const config = { signer: "self" as const, certSha1: CERT, bridgeTeamId, keychain: f.config.keychain, signerKey: f.config.signerKey, publicKey: f.config.publicKey };
  const run = async (argv: string[]) => {
    if (argv[1] !== "--pacer-identity") return f.run(argv);
    const id = JSON.parse(await f.run(argv));
    return JSON.stringify({ ...id, appleTeamId: bridgeTeamId, signingCertSha1: CERT, signer: bridgeTeamId ? "both" : "self" });
  };
  return { ...f, config, run };
}
test("self-signed release signs every component with the pinned certificate, without runtime, timestamp or notarization", async () => {
  const f = selfFixture();
  await signStagedDesktop({ root: "/fixture/root", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, f.run);
  const signs = f.calls.filter(a => a[0] === "/usr/bin/codesign" && a.includes("--sign"));
  expect(signs.map(a => a.at(-1))).toEqual([join(f.app, "Contents/Frameworks/libpacer-native.dylib"), join(f.app, "Contents/Resources/pacer"), join(f.app, "Contents/Resources/pacer-update-helper"), f.app]);
  for (const sign of signs) {
    expect(sign[sign.indexOf("--sign") + 1]).toBe(CERT);
    expect(sign).toContain("--timestamp=none");
    expect(sign.join(" ")).not.toContain("runtime");
    expect(sign).not.toContain("--entitlements");
  }
  const checks = f.calls.filter(a => a[0] === "/usr/bin/codesign" && a.some(x => x.startsWith("-R=")));
  expect(checks.map(a => a.find(x => x.startsWith("-R=")))).toEqual([
    `-R=identifier "dev.pacer.desktop.native-shim" and certificate leaf = H"${CERT}"`,
    `-R=identifier "dev.pacer.cli" and certificate leaf = H"${CERT}"`,
    `-R=identifier "dev.pacer.desktop.update-helper" and certificate leaf = H"${CERT}"`,
    `-R=identifier "dev.pacer.desktop" and certificate leaf = H"${CERT}"`,
  ]);
  const commands = f.calls.map(a => a.join(" ")).join("\n");
  for (const forbidden of ["notarytool", "stapler", "spctl"]) expect(commands).not.toContain(forbidden);
  expect(commands).toContain("--pacer-native-transport-test");
  expect(f.calls.some(a => a[0] === "/usr/bin/tar")).toBe(true);
  expect(f.calls.some(a => a.includes("signer") && a.includes("--app-version"))).toBe(true);
});
test("self-signed release refuses a binary compiled with another pin or an unexpected bridge team", async () => {
  for (const reason of ["cert", "team", "missing"]) {
    const f = selfFixture();
    await expect(signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
      const value = await f.run(argv);
      if (argv[1] !== "--pacer-identity") return value;
      const id = JSON.parse(value);
      if (reason === "cert") id.signingCertSha1 = "A".repeat(40);
      if (reason === "team") id.appleTeamId = "ABCDE12345";
      if (reason === "missing" && id.role === "cli") id.signingCertSha1 = null;
      return JSON.stringify(id);
    })).rejects.toThrow("trust");
    expect(f.calls.some(a => a.includes("--sign"))).toBe(false);
  }
});
test("bridge release is signed with the certificate and verified against either signer", async () => {
  const f = selfFixture("ABCDE12345");
  await signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, f.run);
  const check = f.calls.find(a => a.includes("-R=" + `identifier "dev.pacer.cli" and ((anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345") or certificate leaf = H"${CERT}")`));
  expect(check).toBeDefined();
});
test("Apple signing refuses a binary that also pins a self-signed certificate", async () => {
  const f = fixture();
  await expect(signStagedDesktop({ root: "/fixture", stage: f.stage, out: tmpDir(), version: "1.2.3", arch: "aarch64", config: f.config }, async argv => {
    const value = await f.run(argv);
    return argv[1] === "--pacer-identity" ? JSON.stringify({ ...JSON.parse(value), signingCertSha1: CERT }) : value;
  })).rejects.toThrow("trust");
});
test("signing configuration selects the self signer only without an Apple signing identity", () => {
  const base = { PACER_SIGNING_KEYCHAIN: "/k", TAURI_SIGNING_PRIVATE_KEY_PATH: "/s", PACER_OTA_PUBLIC_KEY: "key" };
  expect(signingConfig({ ...base, PACER_SIGNING_CERT_SHA1: CERT })).toMatchObject({ signer: "self", certSha1: CERT, bridgeTeamId: null });
  expect(signingConfig({ ...base, PACER_SIGNING_CERT_SHA1: CERT, PACER_APPLE_TEAM_ID: "ABCDE12345" })).toMatchObject({ signer: "self", bridgeTeamId: "ABCDE12345" });
  expect(() => signingConfig({ ...base, PACER_SIGNING_CERT_SHA1: CERT, PACER_APPLE_SIGNING_IDENTITY: "a".repeat(40) })).toThrow();
  expect(() => signingConfig({ ...base, PACER_SIGNING_CERT_SHA1: CERT.toLowerCase() })).toThrow();
  expect(() => signingConfig({ PACER_SIGNING_CERT_SHA1: CERT })).toThrow("configured");
});
