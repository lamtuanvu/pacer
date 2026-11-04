import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimCliOwnership, isRecordedOwnerExecutable, MANAGED_BY_DESKTOP_MESSAGE, ownerPath, ownerRefusal, readOwner, writeOwner } from "../src/install/owner";
import { fakeCtx, tmpDir } from "./helpers";

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
