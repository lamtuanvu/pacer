import { expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { createSelfSigningCertificate } from "../scripts/release/self-signing-cert";

const openssl = Bun.spawnSync(["openssl", "version"]).success;

test.skipIf(!openssl)("generates a code-signing identity with only a password-protected private key", async () => {
  const out = join(tmpDir(), "interim-signing");
  const result = await createSelfSigningCertificate(out);
  expect(result.sha1).toMatch(/^[0-9A-F]{40}$/);
  expect(statSync(result.p12).mode & 0o777).toBe(0o600);
  expect(existsSync(join(out, "key.pem"))).toBe(false);
  const info = Bun.spawnSync(["openssl", "x509", "-in", result.certificate, "-noout", "-text"]).stdout.toString();
  expect(info).toContain("Code Signing");
  expect(info).toMatch(/CN ?= ?pacer interim code signing/); // LibreSSL and OpenSSL 3 space it differently
  const parsed = Bun.spawnSync(["openssl", "pkcs12", "-in", result.p12, "-nokeys", "-passin", `pass:${result.password}`]);
  const legacy = parsed.success || Bun.spawnSync(["openssl", "pkcs12", "-legacy", "-in", result.p12, "-nokeys", "-passin", `pass:${result.password}`]).success;
  expect(legacy).toBe(true);
  for (const line of ["gh secret set PACER_SELF_SIGNING_CERTIFICATE_BASE64", "gh secret set PACER_SELF_SIGNING_CERTIFICATE_PASSWORD", `gh variable set PACER_SIGNING_CERT_SHA1 --body ${result.sha1}`]) expect(result.instructions).toContain(line);
  expect(result.instructions).not.toContain(result.password);
});
test("refuses to overwrite an existing output directory", async () => {
  const out = tmpDir(); mkdirSync(join(out, "existing"));
  await expect(createSelfSigningCertificate(join(out, "existing"))).rejects.toThrow("exists");
});
