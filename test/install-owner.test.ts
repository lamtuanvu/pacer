import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimCliOwnership, isInsideAppBundle, isRecordedOwnerExecutable, MANAGED_BY_DESKTOP_MESSAGE, ownerPath, ownerRefusal, readOwner, writeOwner } from "../src/install/owner";
import { fakeCtx, tmpDir } from "./helpers";

/**
 * A canonical owner.json, byte for byte. desktop/src-tauri/src/owner.rs's
 * `cross_language_fixture_matching_the_typescript_side_parses` test parses this exact same
 * literal string, so a record either side writes is provably readable by the other: `at`
 * especially must stay a plain integer token (no decimal point), since Rust declares it `u64`.
 */
const CROSS_LANGUAGE_OWNER_FIXTURE = '{\n  "schema": 1,\n  "owner": "cli",\n  "executable": "/usr/local/bin/pacer",\n  "at": 1700000000\n}\n';

test("readOwner returns null for a missing or malformed record, never throws", () => {
  const ctx = fakeCtx();
  expect(readOwner(ctx)).toBeNull();
  mkdirSync(ctx.pacerHome, { recursive: true });
  for (const text of ["not json", "{}", '{"schema":1,"owner":"nobody","executable":"/x","at":1}',
    '{"schema":2,"owner":"cli","executable":"/x","at":1}', '{"schema":1,"owner":"cli","executable":"relative","at":1}',
    '{"schema":1,"owner":"cli","executable":"/x","at":"soon"}']) {
    writeFileSync(ownerPath(ctx), text);
    expect(readOwner(ctx)).toBeNull();
  }
});

test("writeOwner is atomic, mode 0600, and round-trips through readOwner", () => {
  const ctx = fakeCtx();
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1700000000 });
  expect(readOwner(ctx)).toEqual({ schema: 1, owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1700000000 });
  const path = ownerPath(ctx);
  expect(readFileSync(path, "utf8")).toContain('"owner": "desktop"');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("writeOwner floors a fractional `at` so the Rust side (which declares it u64) can parse it", () => {
  const ctx = fakeCtx();
  writeOwner(ctx, { owner: "cli", executable: "/usr/local/bin/pacer", at: 1700000000.789 });
  expect(readOwner(ctx)).toMatchObject({ at: 1700000000 });
  const text = readFileSync(ownerPath(ctx), "utf8");
  expect(text).toContain('"at": 1700000000');
  expect(text).not.toMatch(/"at":\s*\d+\.\d/);
});

test("a canonical owner.json also readable by the Rust side round-trips through readOwner", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(ownerPath(ctx), CROSS_LANGUAGE_OWNER_FIXTURE);
  expect(readOwner(ctx)).toEqual({ schema: 1, owner: "cli", executable: "/usr/local/bin/pacer", at: 1700000000 });
});

test("claimCliOwnership only writes cli when unclaimed or already cli; never overrides desktop", () => {
  const ctx = fakeCtx();
  claimCliOwnership(ctx, "/usr/local/bin/pacer", 100);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/usr/local/bin/pacer", at: 100 });
  // Already cli: a later successful install may update the recorded executable/time.
  claimCliOwnership(ctx, "/opt/pacer", 200);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/opt/pacer", at: 200 });
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 300 });
  claimCliOwnership(ctx, "/usr/local/bin/pacer", 400);
  expect(readOwner(ctx)).toEqual({ schema: 1, owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 300 });
});

test("isInsideAppBundle recognizes Contents/Resources and Contents/MacOS paths only", () => {
  expect(isInsideAppBundle("/Applications/pacer.app/Contents/Resources/pacer")).toBe(true);
  expect(isInsideAppBundle("/Applications/pacer.app/Contents/MacOS/pacer")).toBe(true);
  expect(isInsideAppBundle("/usr/local/bin/pacer")).toBe(false);
  expect(isInsideAppBundle(join(tmpDir(), "pacer.app-backup/pacer"))).toBe(false);
});

test("claimCliOwnership never claims an executable inside the app bundle, even over an absent or existing cli record", () => {
  const ctx = fakeCtx();
  claimCliOwnership(ctx, "/Applications/pacer.app/Contents/Resources/pacer", 100);
  expect(readOwner(ctx)).toBeNull(); // this happens when the desktop's own bundled CLI runs `service install`
  writeOwner(ctx, { owner: "cli", executable: "/usr/local/bin/pacer", at: 50 });
  claimCliOwnership(ctx, "/Applications/pacer.app/Contents/Resources/pacer", 200);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/usr/local/bin/pacer", at: 50 }); // unchanged
});

test("ownerRefusal is null without a desktop owner, and refuses a foreign CLI once desktop owns it", () => {
  const ctx = fakeCtx({ env: { PACER_BIN: "/usr/local/bin/pacer" } });
  expect(ownerRefusal(ctx, "update")).toBeNull();
  writeOwner(ctx, { owner: "cli", executable: "/usr/local/bin/pacer", at: 1 });
  expect(ownerRefusal(ctx, "update")).toBeNull();
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 2 });
  expect(ownerRefusal(ctx, "update")).toEqual({ code: 2, out: "", err: `pacer update: ${MANAGED_BY_DESKTOP_MESSAGE}` });
  expect(ownerRefusal(ctx, "service")).toEqual({ code: 2, out: "", err: `pacer service: ${MANAGED_BY_DESKTOP_MESSAGE}` });
});

test("the bundled CLI exemption: the desktop's own recorded executable is never blocked by its own guard", () => {
  const home = tmpDir();
  const bundled = join(home, "pacer.app/Contents/Resources/pacer");
  mkdirSync(join(home, "pacer.app/Contents/Resources"), { recursive: true });
  writeFileSync(bundled, "bundled cli");
  chmodSync(bundled, 0o755);
  const ctx = fakeCtx({ home, env: { PACER_BIN: bundled } });
  writeOwner(ctx, { owner: "desktop", executable: bundled, at: 1 });
  // The desktop spawns its managed CLI with PACER_BIN set to the exact bundled path (see
  // desktop/src-tauri/src/client.rs `Cli::run`'s `command.env("PACER_BIN", binary)`).
  expect(isRecordedOwnerExecutable(ctx, readOwner(ctx)!)).toBe(true);
  expect(ownerRefusal(ctx, "update")).toBeNull();
  // A different executable path (even if also real and executable) remains foreign.
  const foreign = join(home, "other-pacer");
  writeFileSync(foreign, "other"); chmodSync(foreign, 0o755);
  const other = fakeCtx({ home, env: { PACER_BIN: foreign } });
  expect(ownerRefusal(other, "update")).not.toBeNull();
});

test("the exemption covers the core running beside the recorded front door", () => {
  // Inside the app the front door forwards to Resources/pacer-core, so the running process is
  // not the recorded executable itself but lives in the same directory.
  const home = tmpDir();
  const beside = join(realpathSync(dirname(process.execPath)), "pacer");
  const ctx = fakeCtx({ home, env: {} });
  writeOwner(ctx, { owner: "desktop", executable: beside, at: 1 });
  expect(ownerRefusal(ctx, "update")).toBeNull();
  writeOwner(ctx, { owner: "desktop", executable: join(home, "elsewhere/pacer"), at: 1 });
  expect(ownerRefusal(ctx, "update")).not.toBeNull();
});

test("the exemption follows a symlinked executable to its real target", () => {
  const home = tmpDir();
  const bundled = join(home, "pacer.app/Contents/Resources/pacer");
  mkdirSync(join(home, "pacer.app/Contents/Resources"), { recursive: true });
  writeFileSync(bundled, "bundled cli"); chmodSync(bundled, 0o755);
  const link = join(home, ".local/bin/pacer");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(bundled, link);
  const ctx = fakeCtx({ home, env: { PACER_BIN: link } });
  writeOwner(ctx, { owner: "desktop", executable: bundled, at: 1 });
  expect(ownerRefusal(ctx, "update")).toBeNull();
});
