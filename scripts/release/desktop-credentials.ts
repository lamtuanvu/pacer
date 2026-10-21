#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { copyFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename, dirname } from "node:path";
import { command } from "./desktop-verify";
import { signingConfig, signStagedDesktop } from "./desktop-sign";
import { stageDesktopPackage } from "./desktop";
import type { DesktopArch } from "./desktop-feed";

/** Resumes cleanup after cancellation using the private record from this CI invocation. */
export async function cleanupSigningRecord(record: string, run = command): Promise<void> {
  if (!existsSync(record)) return;
  const stat = lstatSync(record);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw Error("Invalid signing cleanup record");
  const data = JSON.parse(readFileSync(record, "utf8"));
  if (data.schema !== 1 || typeof data.dir !== "string" || dirname(data.dir) !== realpathSync(tmpdir()) || !/^pacer-desktop-sign-[A-Za-z0-9]+$/.test(basename(data.dir)) || !Array.isArray(data.keychains) || !data.keychains.every((p: unknown) => typeof p === "string" && p.startsWith("/") && !/[\r\n]/.test(p))) throw Error("Unowned signing cleanup record");
  if (existsSync(data.dir) && (lstatSync(data.dir).isSymbolicLink() || realpathSync(data.dir) !== data.dir)) throw Error("Redirected signing cleanup directory");
  let unproven = false;
  try { if (existsSync(join(data.dir, "release.keychain-db"))) await run(["/usr/bin/security", "delete-keychain", join(data.dir, "release.keychain-db")]); }
  catch { unproven = true; }
  try { await run(["/usr/bin/security", "list-keychains", "-d", "user", "-s", ...data.keychains]); }
  catch { unproven = true; }
  if (unproven) throw Error("CI signing cleanup unproven; private retry record retained");
  rmSync(data.dir, { recursive: true, force: true }); rmSync(record, { force: true });
}

/** CI only. Never import credentials into an existing user keychain. */
export async function withSigningCredentials<T>(env: NodeJS.ProcessEnv, body: (config: ReturnType<typeof signingConfig>) => Promise<T>, run = command): Promise<T> {
  // The interim signer imports the project's self-signed certificate; it has no notary key.
  const self = !!env.PACER_SIGNING_CERT_SHA1;
  if (self && (env.PACER_APPLE_CERTIFICATE_BASE64 || env.PACER_NOTARY_KEY)) throw Error("Configure one signing certificate: Apple or the interim certificate");
  const certificate = self ? "PACER_SELF_SIGNING_CERTIFICATE_BASE64" : "PACER_APPLE_CERTIFICATE_BASE64", certificatePassword = self ? "PACER_SELF_SIGNING_CERTIFICATE_PASSWORD" : "PACER_APPLE_CERTIFICATE_PASSWORD";
  if ([certificate, certificatePassword, ...(self ? [] : ["PACER_NOTARY_KEY"]), "TAURI_SIGNING_PRIVATE_KEY"].some(k => !env[k])) throw Error("Production signing credentials are not configured");
  // Validate non-secret configuration before any keychain mutation.
  signingConfig({ ...env, PACER_SIGNING_KEYCHAIN: "pending", PACER_NOTARY_KEY_PATH: "pending", TAURI_SIGNING_PRIVATE_KEY_PATH: "pending" });
  const original = await run(["/usr/bin/security", "list-keychains", "-d", "user"]);
  const keychains = original.split("\n").filter(s => s.trim()).map(s => {
    const match = /^\s*"([^"\r\n]+)"\s*$/.exec(s);
    if (!match) throw Error("Cannot preserve CI keychain search list");
    return match[1];
  });
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pacer-desktop-sign-")), keychain = join(dir, "release.keychain-db"), p12 = join(dir, "certificate.p12"), notary = join(dir, "notary.p8"), signer = join(dir, "updater.key"), password = randomBytes(32).toString("base64url");
  const config = signingConfig({ ...env, PACER_SIGNING_KEYCHAIN: keychain, PACER_NOTARY_KEY_PATH: notary, TAURI_SIGNING_PRIVATE_KEY_PATH: signer });
  const cleanupRecord = env.PACER_SIGNING_CLEANUP_RECORD ?? join(dir, "cleanup.json");
  try { writeFileSync(cleanupRecord, JSON.stringify({ schema: 1, dir, keychains }), { mode: 0o600, flag: "wx" }); }
  catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  try {
    writeFileSync(p12, Buffer.from(env[certificate]!, "base64"), { mode: 0o600 });
    if (!self) writeFileSync(notary, env.PACER_NOTARY_KEY!, { mode: 0o600 });
    writeFileSync(signer, env.TAURI_SIGNING_PRIVATE_KEY!, { mode: 0o600 });
    // The durable record exists before create: a lost response still requires cleanup.
    await run(["/usr/bin/security", "create-keychain", "-p", password, keychain]);
    // security creates keychain databases as 0644 even inside our private directory.
    // Restrict only the fresh, owned regular file before importing any credentials.
    const created = lstatSync(keychain);
    if (!created.isFile() || created.isSymbolicLink() || created.uid !== process.getuid?.()) throw Error("Invalid ephemeral signing keychain");
    chmodSync(keychain, 0o600);
    await run(["/usr/bin/security", "set-keychain-settings", "-lut", "21600", keychain]);
    await run(["/usr/bin/security", "unlock-keychain", "-p", password, keychain]);
    await run(["/usr/bin/security", "import", p12, "-k", keychain, "-P", env[certificatePassword]!, "-T", "/usr/bin/codesign"]);
    await run(["/usr/bin/security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]);
    return await body(config);
  } finally {
    await cleanupSigningRecord(cleanupRecord, run);
  }
}
/** Fail before compilation when CI cannot use its configured signing identity. */
export async function probeSigningCredentials(env: NodeJS.ProcessEnv, run = command): Promise<void> {
  await withSigningCredentials(env, async config => {
    const probe = join(dirname(config.keychain), "signing-probe");
    copyFileSync("/usr/bin/true", probe);
    const identity = config.signer === "self" ? config.certSha1 : config.identity;
    try {
      await run(["/usr/bin/codesign", "--force", "--sign", identity, "--keychain", config.keychain, "--timestamp=none", probe]);
      await run(["/usr/bin/codesign", "--verify", "--strict", probe]);
    } catch (error) {
      // Inspect only this disposable release keychain. Publish hashes, never raw command output.
      const certificates = await run(["/usr/bin/security", "find-certificate", "-a", "-Z", config.keychain]).catch(() => "");
      const identities = await run(["/usr/bin/security", "find-identity", "-p", "codesigning", config.keychain]).catch(() => "");
      const hashes = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map(match => match[1].toUpperCase()))].join(",") || "none";
      throw Error(`${error instanceof Error ? error.message : "Signing probe failed"}; expected=${identity}; certificates=${hashes(certificates, /SHA-1 hash:\s*([0-9A-F]{40})/gi)}; identities=${hashes(identities, /^\s*\d+\)\s+([0-9A-F]{40})\b/gim)}`);
    }
  }, run);
}
if (import.meta.main) {
  try {
    if (process.argv[2] === "--cleanup" && process.argv.length === 3 && process.env.GITHUB_ACTIONS === "true") {
      if (process.env.PACER_SIGNING_CLEANUP_RECORD) await cleanupSigningRecord(process.env.PACER_SIGNING_CLEANUP_RECORD);
      process.exit(0);
    }
    if (process.argv[2] === "--probe" && process.argv.length === 3 && process.platform === "darwin" && process.env.GITHUB_ACTIONS === "true") {
      await probeSigningCredentials(process.env);
      console.log("Production signing identity probe passed");
      process.exit(0);
    }
    const [dir, arch, out] = process.argv.slice(2);
    if (!dir || !out || !["aarch64", "x86_64"].includes(arch) || process.argv.length !== 5 || process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true") throw Error("desktop-credentials.ts is restricted to the production macOS release CI job");
    const root = resolve(import.meta.dir, "../.."), version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const stage = await stageDesktopPackage(root, resolve(dir), arch as DesktopArch);
    await withSigningCredentials(process.env, config => signStagedDesktop({ root, stage, out: resolve(out), version, arch: arch as DesktopArch, config }));
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
