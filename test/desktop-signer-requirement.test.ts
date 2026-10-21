import { expect, test } from "bun:test";
import { signerKind, signerRequirement, validSignerPins } from "../src/update/desktop/signer-requirement";

const CERT = "2C5405FB6D2906AE2049D59B9DF5D42661997922";

test("signer requirements match the compiled Rust trust exactly", () => {
  expect(signerRequirement("dev.pacer.desktop.update-helper", { appleTeamId: "ABCDE12345" })).toBe(
    'anchor apple generic and identifier "dev.pacer.desktop.update-helper" and certificate leaf[subject.OU] = "ABCDE12345"');
  expect(signerRequirement("dev.pacer.cli", { signingCertSha1: CERT })).toBe(`identifier "dev.pacer.cli" and certificate leaf = H"${CERT}"`);
  expect(signerRequirement("dev.pacer.desktop.update-helper", { appleTeamId: "ABCDE12345", signingCertSha1: CERT })).toBe(
    `identifier "dev.pacer.desktop.update-helper" and ((anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345") or certificate leaf = H"${CERT}")`);
  expect([signerKind({ appleTeamId: "ABCDE12345" }), signerKind({ signingCertSha1: CERT }), signerKind({ appleTeamId: "ABCDE12345", signingCertSha1: CERT }), signerKind({})]).toEqual(["apple", "self", "both", null]);
});

test("malformed or missing pins are refused", () => {
  for (const pins of [{}, { appleTeamId: "abcde12345" }, { signingCertSha1: CERT.toLowerCase() }, { signingCertSha1: CERT.slice(1) }, { signingCertSha1: CERT.slice(1) + '"' }, { appleTeamId: "ABCDE12345", signingCertSha1: "x" }]) {
    expect(validSignerPins(pins)).toBe(false);
    expect(() => signerRequirement("dev.pacer.cli", pins)).toThrow();
  }
  expect(() => signerRequirement('dev.pacer.cli" or always', { signingCertSha1: CERT })).toThrow();
});
