import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { withSigningCredentials } from "../scripts/release/desktop-credentials";

test("missing credentials refuse before keychain calls", async () => {
  let calls = 0;
  await expect(withSigningCredentials({}, async () => {}, async () => { calls++; return ""; })).rejects.toThrow("configured");
  expect(calls).toBe(0);
});
test("private ephemeral credentials are removed and original keychain list restored after failure", async () => {
  const calls: string[][] = []; let directory = "";
  const env = { PACER_APPLE_TEAM_ID: "ABCDE12345", PACER_APPLE_SIGNING_IDENTITY: "a".repeat(40), PACER_NOTARY_KEY_ID: "ABCDE12345", PACER_NOTARY_ISSUER: "12345678-1234-1234-1234-123456789abc", PACER_OTA_PUBLIC_KEY: "public", PACER_APPLE_CERTIFICATE_BASE64: Buffer.from("fixture-certificate").toString("base64"), PACER_APPLE_CERTIFICATE_PASSWORD: "fixture-password", PACER_NOTARY_KEY: "fixture-notary", TAURI_SIGNING_PRIVATE_KEY: "fixture-updater" };
  await expect(withSigningCredentials(env, async config => {
    directory = config.keychain.slice(0, config.keychain.lastIndexOf("/"));
    expect(statSync(config.signerKey).mode & 0o777).toBe(0o600);
    expect(readFileSync(config.signerKey, "utf8")).toBe("fixture-updater");
    throw Error("test failure");
  }, async argv => { calls.push(argv); if (argv[1] === "create-keychain") writeFileSync(argv.at(-1)!, "fixture", { mode: 0o600 }); return argv[1] === "list-keychains" && !argv.includes("-s") ? '    "/fixture/login.keychain-db"\n    "/fixture/System.keychain"\n' : ""; })).rejects.toThrow("test failure");
  expect(existsSync(directory)).toBe(false);
  expect(calls.some(a => a[1] === "import" && a[a.indexOf("-k") + 1].startsWith(directory))).toBe(true);
  expect(calls.some(a => a[1] === "delete-keychain")).toBe(true);
  expect(calls.at(-1)).toEqual(["/usr/bin/security", "list-keychains", "-d", "user", "-s", "/fixture/login.keychain-db", "/fixture/System.keychain"]);
});

test("cancellation cleanup refuses an unrelated directory before manager calls", async () => {
  const { cleanupSigningRecord } = await import("../scripts/release/desktop-credentials");
  const { tmpDir } = await import("./helpers");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const record = join(tmpDir(), "cleanup.json");
  writeFileSync(record, JSON.stringify({ schema: 1, dir: "/fixture/user-keychain", keychains: [] }), { mode: 0o600 });
  let calls = 0;
  await expect(cleanupSigningRecord(record, async () => { calls++; return ""; })).rejects.toThrow("Unowned");
  expect(calls).toBe(0);
});

test("cancellation cleanup removes only its ephemeral keychain and restores the captured search list", async () => {
  const { cleanupSigningRecord } = await import("../scripts/release/desktop-credentials");
  const { tmpDir } = await import("./helpers");
  const { mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pacer-desktop-sign-")), record = join(tmpDir(), "cleanup.json");
  const keychain = join(dir, "release.keychain-db"); writeFileSync(keychain, "fixture");
  writeFileSync(record, JSON.stringify({ schema: 1, dir, keychains: ["/fixture/login.keychain-db"] }), { mode: 0o600 });
  const calls: string[][] = [];
  await cleanupSigningRecord(record, async argv => { calls.push(argv); return ""; });
  expect(calls).toEqual([["/usr/bin/security", "delete-keychain", keychain], ["/usr/bin/security", "list-keychains", "-d", "user", "-s", "/fixture/login.keychain-db"]]);
  expect(existsSync(dir)).toBe(false); expect(existsSync(record)).toBe(false);
});

test("unproven cleanup retains its private record and a lost delete response is safely retried", async () => {
  const { cleanupSigningRecord } = await import("../scripts/release/desktop-credentials");
  const { tmpDir } = await import("./helpers");
  const { mkdtempSync, realpathSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  for (const failure of ["delete", "restore", "lost-delete-response"]) {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "pacer-desktop-sign-")), record = join(tmpDir(), "cleanup.json"), keychain = join(dir, "release.keychain-db");
    writeFileSync(keychain, "fixture", { mode: 0o600 });
    writeFileSync(record, JSON.stringify({ schema: 1, dir, keychains: ["/fixture/login.keychain-db"] }), { mode: 0o600 });
    await expect(cleanupSigningRecord(record, async argv => {
      if (argv[1] === "delete-keychain") {
        if (failure === "delete") throw Error("refused");
        rmSync(keychain);
        if (failure === "lost-delete-response") throw Error("lost response");
      }
      if (argv[1] === "list-keychains" && failure === "restore") throw Error("refused");
      return "";
    })).rejects.toThrow();
    expect(existsSync(record)).toBe(true); expect(existsSync(dir)).toBe(true);
    const retry: string[][] = [];
    await cleanupSigningRecord(record, async argv => { retry.push(argv); return ""; });
    expect(retry.some(a => a[1] === "delete-keychain")).toBe(failure === "delete");
    expect(existsSync(record)).toBe(false); expect(existsSync(dir)).toBe(false);
  }
});

test("interim signing secures a macOS-created 0644 keychain before importing credentials", async () => {
  const calls: string[][] = [];
  const env = { PACER_SIGNING_CERT_SHA1: "2C5405FB6D2906AE2049D59B9DF5D42661997922", PACER_OTA_PUBLIC_KEY: "public", PACER_SELF_SIGNING_CERTIFICATE_BASE64: Buffer.from("p12").toString("base64"), PACER_SELF_SIGNING_CERTIFICATE_PASSWORD: "pw", TAURI_SIGNING_PRIVATE_KEY: "fixture-updater" };
  const seen = await withSigningCredentials(env, async config => {
    expect(config.signer).toBe("self");
    expect(statSync(config.keychain).mode & 0o777).toBe(0o600);
    expect(existsSync(config.keychain.slice(0, config.keychain.lastIndexOf("/")) + "/notary.p8")).toBe(false);
    return config.keychain;
  }, async argv => { calls.push(argv); if (argv[1] === "import") {
    const keychain = argv[argv.indexOf("-k") + 1];
    expect(statSync(keychain).mode & 0o777).toBe(0o600);
    expect(calls.some(call => call[1] === "list-keychains" && call.includes("-s") && call.includes(keychain))).toBe(true);
  } if (argv[1] === "create-keychain") writeFileSync(argv.at(-1)!, "fixture", { mode: 0o644 }); return argv[1] === "list-keychains" && !argv.includes("-s") ? '    "/fixture/login.keychain-db"\n' : ""; });
  const imported = calls.find(a => a[1] === "import")!;
  expect(imported[imported.indexOf("-k") + 1]).toBe(seen);
  expect(imported[imported.indexOf("-P") + 1]).toBe("pw");
  expect(calls.some(a => a[1] === "delete-keychain")).toBe(true);
});
test("interim signing refuses missing certificate secrets or both signers' certificates", async () => {
  const base = { PACER_SIGNING_CERT_SHA1: "2C5405FB6D2906AE2049D59B9DF5D42661997922", PACER_OTA_PUBLIC_KEY: "public", TAURI_SIGNING_PRIVATE_KEY: "k" };
  let calls = 0;
  const run = async () => { calls++; return ""; };
  await expect(withSigningCredentials(base, async () => {}, run)).rejects.toThrow("configured");
  await expect(withSigningCredentials({ ...base, PACER_SELF_SIGNING_CERTIFICATE_BASE64: "eA==", PACER_SELF_SIGNING_CERTIFICATE_PASSWORD: "pw", PACER_APPLE_CERTIFICATE_BASE64: "eA==" }, async () => {}, run)).rejects.toThrow("one signing");
  expect(calls).toBe(0);
});

test("signing preflight exercises the configured identity and cleans its temporary keychain", async () => {
  const { probeSigningCredentials } = await import("../scripts/release/desktop-credentials");
  const env = { PACER_SIGNING_CERT_SHA1: "2C5405FB6D2906AE2049D59B9DF5D42661997922", PACER_OTA_PUBLIC_KEY: "public", PACER_SELF_SIGNING_CERTIFICATE_BASE64: Buffer.from("p12").toString("base64"), PACER_SELF_SIGNING_CERTIFICATE_PASSWORD: "pw", TAURI_SIGNING_PRIVATE_KEY: "fixture-updater" };
  const calls: string[][] = [];
  await probeSigningCredentials(env, async argv => {
    calls.push(argv);
    if (argv[1] === "create-keychain") writeFileSync(argv.at(-1)!, "fixture", { mode: 0o600 });
    return argv[1] === "list-keychains" && !argv.includes("-s") ? '    "/fixture/login.keychain-db"\n' : "";
  });
  const sign = calls.find(a => a[0] === "/usr/bin/codesign" && a[1] === "--force")!;
  expect(sign[sign.indexOf("--sign") + 1]).toBe(env.PACER_SIGNING_CERT_SHA1);
  expect(calls.some(a => a[0] === "/usr/bin/codesign" && a[1] === "--verify")).toBe(true);
  const keychain = sign[sign.indexOf("--keychain") + 1];
  expect(existsSync(keychain)).toBe(false);
  expect(calls.some(a => a[1] === "delete-keychain" && a.at(-1) === keychain)).toBe(true);
});

test("failed signing probe reports only public imported identity hashes", async () => {
  const { probeSigningCredentials } = await import("../scripts/release/desktop-credentials");
  const cert = "A".repeat(40), imported = "B".repeat(40);
  const env = { PACER_SIGNING_CERT_SHA1: cert, PACER_OTA_PUBLIC_KEY: "public", PACER_SELF_SIGNING_CERTIFICATE_BASE64: "cDEy", PACER_SELF_SIGNING_CERTIFICATE_PASSWORD: "pw", TAURI_SIGNING_PRIVATE_KEY: "fixture-updater" };
  let message = "", keychain = "";
  try { await probeSigningCredentials(env, async argv => {
    if (argv[1] === "create-keychain") { keychain = argv.at(-1)!; writeFileSync(keychain, "fixture", { mode: 0o600 }); }
    if (argv[0] === "/usr/bin/codesign") throw Error("signing failed");
    if (argv[1] === "find-certificate") return `SHA-1 hash: ${imported}\nfixture-secret-must-not-be-logged`;
    if (argv[1] === "find-identity") return `  1) ${imported} "fixture-secret-must-not-be-logged"\n`;
    return "";
  }); } catch (error) { message = (error as Error).message; }
  expect(message).toContain(`expected=${cert}`);
  expect(message).toContain(`certificates=${imported}`);
  expect(message).toContain(`identities=${imported}`);
  expect(message).not.toContain("fixture-secret-must-not-be-logged");
  expect(existsSync(keychain)).toBe(false);
});
