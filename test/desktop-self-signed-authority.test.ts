import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DarwinAuthority } from "../src/update/desktop/native-os";

const dir = mkdtempSync(join(tmpdir(), "pacer-self-signer-")), keychain = join(dir, "test.keychain-db");
const run = (argv: string[]) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
function selfSigner(): string | null {
  if (process.platform !== "darwin") return null;
  writeFileSync(join(dir, "cs.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=pacer authority test\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n");
  const steps = [
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-config", join(dir, "cs.cnf")],
    ["openssl", "pkcs12", "-export", "-legacy", "-passout", "pass:test", "-inkey", join(dir, "key.pem"), "-in", join(dir, "cert.pem"), "-out", join(dir, "id.p12")],
    ["security", "create-keychain", "-p", "test", keychain],
    ["security", "unlock-keychain", "-p", "test", keychain],
    ["security", "import", join(dir, "id.p12"), "-k", keychain, "-P", "test", "-T", "/usr/bin/codesign"],
    ["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", "test", keychain],
  ];
  for (const argv of steps) if (!run(argv).success) return null;
  const fingerprint = run(["openssl", "x509", "-noout", "-fingerprint", "-sha1", "-in", join(dir, "cert.pem")]);
  if (!fingerprint.success) return null;
  const sha1 = fingerprint.stdout.toString().trim().split("=").at(-1)!.replaceAll(":", "");
  // Some hosted runners cannot use a private keychain identity from codesign; skip there.
  const probe = join(dir, "probe");
  copyFileSync("/usr/bin/true", probe);
  return run(["/usr/bin/codesign", "--force", "--timestamp=none", "--sign", sha1, "--keychain", keychain, probe]).success ? sha1 : null;
}
const sha1 = selfSigner();
afterAll(() => { if (process.platform === "darwin") run(["security", "delete-keychain", keychain]); rmSync(dir, { recursive: true, force: true }); });

test.skipIf(!sha1)("service authority accepts only code signed by the pinned certificate", () => {
  const pinned = join(dir, "pinned"), impostor = join(dir, "impostor");
  copyFileSync("/usr/bin/true", pinned); copyFileSync("/usr/bin/true", impostor);
  expect(run(["/usr/bin/codesign", "--force", "--timestamp=none", "--sign", sha1!, "--keychain", keychain, "--identifier", "dev.pacer.cli", pinned]).success).toBe(true);
  expect(run(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", "dev.pacer.cli", impostor]).success).toBe(true);
  const authority = new DarwinAuthority({ signingCertSha1: sha1 });
  expect(() => authority.verifyStatic(pinned, "cli")).not.toThrow();
  expect(() => authority.verifyStatic(pinned, "helper")).toThrow();
  expect(() => authority.verifyStatic(impostor, "cli")).toThrow();
  expect(() => new DarwinAuthority({ signingCertSha1: "A".repeat(40) }).verifyStatic(pinned, "cli")).toThrow();
  expect(() => new DarwinAuthority({ appleTeamId: "ABCDE12345", signingCertSha1: sha1 }).verifyStatic(pinned, "cli")).not.toThrow();
});
