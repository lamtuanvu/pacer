import { chmodSync, closeSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execProcess } from "../exec/process";
import type { RunFn } from "../types";

export const SIGNING_IDENTITY = "pacer local code signing";
export const SIGNING_IDENTIFIER = "dev.pacer.cli";
export interface SigningOptions {
  platform?: string;
  run?: RunFn;
  log?: (line: string) => void;
  home?: string;
  /** Cross-compiled release outputs still get verified by codesign; native outputs also smoke-run. */
  smoke?: boolean;
}
export const signingRun: RunFn = (argv, timeoutMs) => execProcess({ argv, timeoutMs, cwd: process.cwd(), env: process.env });

export function parseIdentity(output: string): string | null {
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"pacer local code signing"\s*$/);
    if (match) return match[1];
  }
  return null;
}
export function signArgs(binary: string, hash: string): string[] {
  if (!/^[a-fA-F0-9]{40}$/.test(hash)) throw Error("invalid signing identity fingerprint");
  return ["/usr/bin/codesign", "-f", "-s", hash, "-i", SIGNING_IDENTIFIER, "--options", "0",
    // A leading "=" makes codesign read the requirement inline; without it the text is taken as a file path.
    "-r", `=designated => identifier "${SIGNING_IDENTIFIER}" and certificate leaf = H"${hash}"`, binary];
}
export async function findIdentity(run: RunFn = signingRun): Promise<string | null> {
  const result = await run(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"], 3000);
  if (result.timedOut || result.code !== 0) throw Error("Cannot inspect code-signing identities; unlock the login keychain and retry.");
  return parseIdentity(result.stdout);
}
async function checked(run: RunFn, argv: string[], timeout = 15_000) {
  const r = await run(argv, timeout);
  if (r.timedOut || r.code !== 0) throw Error(`${argv[0]} ${argv[1]} failed: ${r.stderr.trim() || "timed out or requires authorization"}. If macOS requests a password or GUI confirmation, unlock the login keychain and approve it, then retry.`);
  return r;
}

/** Only call on a staged/build output: codesign modifies the file. */
export async function signLocal(binary: string, o: SigningOptions = {}): Promise<boolean> {
  if ((o.platform ?? process.platform) !== "darwin") return false;
  const run = o.run ?? signingRun, log = o.log ?? console.log;
  const hash = await findIdentity(run);
  if (!hash) {
    log("Local signing identity missing; run bun scripts/sign-local.ts --create-identity once.");
    return false;
  }
  const path = resolve(binary);
  await checked(run, signArgs(path, hash));
  await checked(run, ["/usr/bin/codesign", "--verify", "--strict", path]);
  if (o.smoke !== false) await checked(run, [path, "--version"]);
  log(`Signed ${path} as ${SIGNING_IDENTIFIER} with ${SIGNING_IDENTITY}.`);
  const requirement = await checked(run, ["/usr/bin/codesign", "-d", "-r-", path]);
  log((requirement.stdout + requirement.stderr).trim());
  return true;
}

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
function isMachO(path: string): boolean {
  const buf = Buffer.alloc(4), fd = openSync(path, "r");
  try { return readSync(fd, buf, 0, 4, 0) === 4 && MACHO.has(buf.readUInt32BE(0)); } finally { closeSync(fd); }
}

/** Update-time signing: a failure leaves the staged binary ad hoc signed instead of failing the update. */
export async function signStaged(binary: string, o: SigningOptions = {}): Promise<boolean> {
  if ((o.platform ?? process.platform) !== "darwin" || !isMachO(binary)) return false;
  const log = o.log ?? console.log;
  try { return await signLocal(binary, { ...o, smoke: false, log: o.log ?? (() => {}) }); }
  catch (e) { log(`pacer: could not sign the update as ${SIGNING_IDENTIFIER} (${e instanceof Error ? e.message : String(e)}); macOS may ask for removable-volume access again.`); return false; }
}

export async function createIdentity(o: SigningOptions = {}): Promise<void> {
  if ((o.platform ?? process.platform) !== "darwin") return;
  const run = o.run ?? signingRun, log = o.log ?? console.log;
  if (await findIdentity(run)) { log(`Already present: ${SIGNING_IDENTITY}; no changes made.`); return; }
  const dir = mkdtempSync(join(tmpdir(), "pacer-sign-"));
  chmodSync(dir, 0o700);
  const keychain = join(o.home ?? homedir(), "Library", "Keychains", "login.keychain-db");
  const cert = join(dir, "cert.pem"), key = join(dir, "key.pem"), p12 = join(dir, "identity.p12");
  try {
    // Resume a partial import/trust attempt without rotating its certificate.
    const found = await run(["/usr/bin/security", "find-certificate", "-c", SIGNING_IDENTITY, "-p", keychain], 3000);
    if (found.timedOut) throw Error("Keychain lookup timed out; unlock the login keychain and retry.");
    if (found.code === 0 && found.stdout.includes("BEGIN CERTIFICATE")) {
      writeFileSync(cert, found.stdout, {mode: 0o600});
      log(`Reusing ${SIGNING_IDENTITY} certificate already in the login keychain.`);
    } else {
      const config = join(dir, "openssl.cnf");
      writeFileSync(config, `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=${SIGNING_IDENTITY}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`, {mode: 0o600});
      await checked(run, ["openssl", "req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650", "-config", config, "-keyout", key, "-out", cert]);
      log(`Created a self-signed, ten-year code-signing certificate: ${SIGNING_IDENTITY}.`);
      // macOS cannot verify the MAC of a PKCS12 sealed with an empty passphrase, so use a one-time one.
      const pass = randomBytes(18).toString("base64url");
      await checked(run, ["openssl", "pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${pass}`, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1"]);
      log("Importing into the login keychain. macOS may require your keychain password or GUI confirmation; commands time out instead of waiting indefinitely.");
      await checked(run, ["/usr/bin/security", "import", p12, "-k", keychain, "-P", pass, "-T", "/usr/bin/codesign"]);
      log("Imported the certificate and private key; allowed /usr/bin/codesign access.");
    }
    log("Adding user trust for code signing. macOS may ask for your password or GUI confirmation; approve it and retry if the command times out.");
    await checked(run, ["/usr/bin/security", "add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychain, cert]);
    log("Added user trust for code signing.");
    if (!await findIdentity(run)) throw Error("Certificate is present but no valid signing identity is available. Check its private key and trust in Keychain Access; do not delete a working identity.");
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
