import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { MANAGED_BY_DESKTOP_MESSAGE, readOwner, writeOwner } from "../src/install/owner";
import { uninstallAll } from "../src/install/uninstall-all";
import { fakeCtx } from "./helpers";

function withDesktopOwner(executable = "/Applications/pacer.app/Contents/Resources/pacer") {
  const ctx = fakeCtx({ env: { PACER_BIN: "/usr/local/bin/pacer", PACER_NO_UPDATE_CHECK: "1" } });
  writeOwner(ctx, { owner: "desktop", executable, at: 1 });
  return ctx;
}

test("pacer update defers to a desktop owner with exit code 2, but --check (read-only) is unaffected", async () => {
  const ctx = withDesktopOwner();
  expect(await main(["update"], ctx)).toEqual({ code: 2, out: "", err: `pacer update: ${MANAGED_BY_DESKTOP_MESSAGE}` });
  const checked = await main(["update", "--check"], ctx);
  expect(checked.code).toBe(0);
  expect(checked.err).toBe("");
});

test("pacer update --release-ownership routes to the handback path instead of the deference guard", async () => {
  // The happy path (service reinstall succeeding) is covered at the service/ownership-handback
  // layer (test/service.test.ts, test/install-ownership-handback.test.ts); this only checks that
  // `update` routes --release-ownership to that handback instead of returning the deference refusal.
  const ctx = withDesktopOwner();
  const result = await main(["update", "--release-ownership"], ctx);
  expect(result.err).not.toContain(MANAGED_BY_DESKTOP_MESSAGE);
  // Ownership is handed back only once the service is actually re-registered; here that step
  // fails (no real launchd in the test environment), so the desktop record is left untouched.
  expect(readOwner(ctx)).toMatchObject({ owner: "desktop" });
});

test("pacer update --force alone remains an unknown argument; it only works with --release-ownership", async () => {
  expect((await main(["update", "--force"], fakeCtx())).err).toContain('unknown argument "--force"');
});

test("pacer uninstall --all defers to a desktop owner with exit code 2", async () => {
  const ctx = withDesktopOwner();
  expect(await uninstallAll(["--all"], ctx)).toMatchObject({ code: 2, err: `pacer uninstall: ${MANAGED_BY_DESKTOP_MESSAGE}` });
});

test("without a recorded desktop owner, pacer update and uninstall --all proceed past the guard", async () => {
  const ctx = fakeCtx({ env: { PACER_NO_UPDATE_CHECK: "1" } });
  expect((await main(["update", "--check"], ctx)).code).toBe(0);
  // No service/manifest recorded: uninstallAll proceeds to its own (unrelated) plan/consent logic, not the ownership guard.
  const result = await uninstallAll(["--all"], ctx, { tty: false });
  expect(result.err).not.toContain(MANAGED_BY_DESKTOP_MESSAGE);
});
