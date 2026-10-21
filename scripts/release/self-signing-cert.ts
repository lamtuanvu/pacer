#!/usr/bin/env bun
/**
 * Maintainer-run: create the interim self-signed code-signing identity for desktop
 * releases (docs/specs/2026-10-20-interim-self-signed-ota-design.md). The private key
 * exists only inside the password-protected PKCS#12; store both as GitHub secrets.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CONFIG = `[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=pacer interim code signing
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
`;
function openssl(args: string[]): string {
  const result = Bun.spawnSync(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw Error(`openssl ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}
export async function createSelfSigningCertificate(out: string): Promise<{ sha1: string; p12: string; certificate: string; password: string; instructions: string }> {
  if (existsSync(out)) throw Error(`Output directory exists: ${out}`);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const key = join(out, "key.pem"), certificate = join(out, "signing.cert.pem"), p12 = join(out, "signing.p12"), config = join(out, "openssl.cnf");
  const password = randomBytes(24).toString("base64url");
  try {
    writeFileSync(config, CONFIG, { mode: 0o600 });
    openssl(["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "7300", "-keyout", key, "-out", certificate, "-config", config]);
    // macOS `security import` reads the legacy PKCS#12 algorithms; OpenSSL 3 needs -legacy for them.
    const exportArgs = ["pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", p12, "-passout", `pass:${password}`];
    try { openssl([...exportArgs.slice(0, 2), "-legacy", ...exportArgs.slice(2)]); } catch { openssl(exportArgs); }
    chmodSync(p12, 0o600);
  } finally {
    rmSync(key, { force: true }); rmSync(config, { force: true });
  }
  const sha1 = openssl(["x509", "-in", certificate, "-noout", "-fingerprint", "-sha1"]).trim().split("=").at(-1)!.replaceAll(":", "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(sha1)) throw Error("Unexpected certificate fingerprint");
  const instructions = [
    `Certificate SHA-1: ${sha1}`,
    "Store the identity in the repository's desktop-release environment, then delete this directory:",
    `  base64 -i ${p12} | gh secret set PACER_SELF_SIGNING_CERTIFICATE_BASE64 --env desktop-release`,
    `  gh secret set PACER_SELF_SIGNING_CERTIFICATE_PASSWORD --env desktop-release < ${join(out, "password.txt")}`,
    `  gh variable set PACER_SIGNING_CERT_SHA1 --body ${sha1}`,
    `  rm -rf ${out}`,
  ].join("\n");
  writeFileSync(join(out, "password.txt"), password, { mode: 0o600 });
  return { sha1, p12, certificate, password, instructions };
}
if (import.meta.main) {
  try {
    const [out] = process.argv.slice(2);
    if (!out || process.argv.length !== 3) throw Error("usage: self-signing-cert.ts <new-output-directory>");
    console.log((await createSelfSigningCertificate(resolve(out))).instructions);
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
