import { expect, test } from "bun:test";
import { createIdentity, parseIdentity, signArgs, signLocal } from "../scripts/sign-local";
import type { RunFn } from "../src/types";
const hash = "A".repeat(40);
const identity = `  1) ${hash} "pacer local code signing"\n     1 valid identities found`;
test("identity parser requires an exact valid identity", () => {
  expect(parseIdentity(identity)).toBe(hash);
  expect(parseIdentity(identity.replace('"pacer local code signing"', '"pacer local code signing other"'))).toBeNull();
  expect(parseIdentity(`1) ${hash} "pacer local code signing" (CSSMERR_TP_CERT_EXPIRED)`)).toBeNull();
});
test("signing uses a stable certificate requirement and disables hardened runtime", () => {
  const args = signArgs("/tmp/staged pacer", hash);
  expect(args).toContain("dev.pacer.cli");
  expect(args).toContain("0");
  expect(args.join(" ")).toContain(`certificate leaf = H"${hash}"`);
  expect(args.at(-1)).toBe("/tmp/staged pacer");
});
test("missing identity and non-macOS leave binary untouched", async () => {
  const calls: string[][] = [], logs: string[] = [];
  const run: RunFn = async a => { calls.push(a); return { code: 0, stdout: "0 valid identities found", stderr: "" }; };
  await signLocal("/tmp/pacer", { platform: "linux", run });
  expect(calls).toHaveLength(0);
  await signLocal("/tmp/pacer", { platform: "darwin", run, log: s => logs.push(s) });
  expect(calls).toHaveLength(1);
  expect(logs.join()).toContain("--create-identity");
});
test("signs then verifies version and prints designated requirement", async () => {
  const calls: string[][] = [];
  const run: RunFn = async a => { calls.push(a); return { code: 0, stdout: a[1] === "find-identity" ? identity : "pacer 0.2.3", stderr: "" }; };
  await signLocal("/tmp/staged", { platform: "darwin", run, log: () => {} });
  expect(calls.map(a => a[0])).toEqual(["/usr/bin/security", "/usr/bin/codesign", "/usr/bin/codesign", "/tmp/staged", "/usr/bin/codesign"]);
});
test("identity creation is idempotent", async () => {
  const calls: string[][] = [];
  await createIdentity({ platform: "darwin", run: async a => { calls.push(a); return {code: 0, stdout: identity, stderr: ""}; }, log: () => {} });
  expect(calls).toHaveLength(1);
});
test("identity creation imports once with restricted codesign access and user trust", async () => {
  const calls: string[][] = [], logs: string[] = [];
  let ready = false;
  const run: RunFn = async a => {
    calls.push(a);
    if(a[1] === "find-identity") return {code:0, stdout: ready ? identity : "", stderr:""};
    if(a[1] === "find-certificate") return {code:44, stdout:"", stderr:"not found"};
    if(a[1] === "add-trusted-cert") ready = true;
    return {code:0, stdout:"", stderr:""};
  };
  await createIdentity({platform:"darwin", run, log:s => logs.push(s), home:"/tmp/pacer-test-home"});
  const req = calls.find(a => a[1] === "req")!;
  expect(req).toContain("3650");
  const imp = calls.find(a => a[1] === "import")!;
  expect(imp.slice(-2)).toEqual(["-T", "/usr/bin/codesign"]);
  expect(calls.find(a => a[1] === "add-trusted-cert")).toContain("codeSign");
  expect(logs.join()).toContain("GUI confirmation");
});
test("authorization timeout is actionable and prevents smoke", async () => {
  const calls: string[][] = [];
  const run: RunFn = async a => {
    calls.push(a);
    return a[1] === "find-identity" ? {code:0, stdout:identity, stderr:""} : {code:143, stdout:"", stderr:"", timedOut:true};
  };
  await expect(signLocal("/tmp/staged", {platform:"darwin", run, log:()=>{}})).rejects.toThrow("GUI confirmation");
  expect(calls).toHaveLength(2);
});
test("partial setup reuses the imported certificate instead of rotating it", async () => {
  const calls: string[][] = [];
  let ready = false;
  const run: RunFn = async a => {
    calls.push(a);
    if(a[1] === "find-identity") return {code:0, stdout:ready ? identity : "", stderr:""};
    if(a[1] === "find-certificate") return {code:0, stdout:"-----BEGIN CERTIFICATE-----\nexisting\n-----END CERTIFICATE-----", stderr:""};
    if(a[1] === "add-trusted-cert") ready = true;
    return {code:0, stdout:"", stderr:""};
  };
  await createIdentity({platform:"darwin", run, log:()=>{}});
  expect(calls.some(a => a[0] === "openssl" || a[1] === "import")).toBe(false);
  expect(calls.some(a => a[1] === "add-trusted-cert")).toBe(true);
});

test("update-time signing skips non-Mach-O files and never fails the update", async () => {
  const { signStaged } = await import("../src/update/signing");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pacer-sign-test-"));
  const script = join(dir, "script"), macho = join(dir, "macho");
  writeFileSync(script, "#!/bin/sh\necho hi\n");
  writeFileSync(macho, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 1, stdout: "", stderr: "keychain locked" }; };
  expect(await signStaged(script, { platform: "darwin", run })).toBe(false);
  expect(calls).toHaveLength(0);
  const logs: string[] = [];
  expect(await signStaged(macho, { platform: "darwin", run, log: l => logs.push(l) })).toBe(false);
  expect(calls.length).toBeGreaterThan(0);
  expect(logs.join("\n")).toContain("could not sign the update");
});
