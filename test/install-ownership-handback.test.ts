import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readOwner, writeOwner } from "../src/install/owner";
import { releaseOwnership } from "../src/install/ownership-handback";
import { plist, servicePath, type ServiceDeps } from "../src/service";
import { createTask, updateTask } from "../src/tasks/store";
import { DESKTOP_IDENTIFIERS } from "../src/update/desktop/bundle-identity";
import { fakeCtx, tmpDir } from "./helpers";

const goodFetch = (async () => Response.json({ ok: true, pid: 456 }, { headers: { "X-Pacer": "1" } })) as NonNullable<ServiceDeps["fetch"]>;

function fixture(opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  // Pre-resolved so every path built from ctx.home already matches what realpathSync returns
  // later (macOS's tmp dir itself is a symlink: /var/folders/... -> /private/var/folders/...).
  const ctx = fakeCtx({ home: realpathSync(tmpDir()), env: { PATH: "/bin:/usr/bin", PACER_BIN: "/opt/pacer" }, which: () => null,
    run: async argv => {
      calls.push(argv);
      if (argv[1] === "--version") return { code: 0, stdout: "pacer 9.9.9\n", stderr: "" };
      if (argv[1] === "bootstrap" && opts.fail) return { code: 5, stdout: "", stderr: "bad plist" };
      if (argv[1] === "print") return { code: 0, stdout: "service = {\n state = running\n pid = 456\n last exit code = 0\n}\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    } });
  const service: ServiceDeps = { platform: "darwin", uid: 501, fetch: goodFetch, waitMs: 0 };
  return { ctx, calls, service, path: servicePath(ctx, "darwin") };
}

function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

/** `~/.local/bin/pacer` as the desktop's symlink into a fake app bundle; also used as PACER_BIN,
 * matching the real front door's own canonicalize-and-forward behavior when invoked through it. */
function bundledLink(ctx: ReturnType<typeof fixture>["ctx"]): { link: string; bundled: string } {
  const bundled = join(ctx.home, "pacer.app/Contents/Resources/pacer");
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, "bundled cli");
  const link = join(ctx.home, ".local/bin/pacer");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(bundled, link);
  ctx.env.PACER_BIN = bundled;
  return { link, bundled };
}

/** The desktop's per-OS config dir, as the handback resolves it (macOS and Linux). */
function desktopConfig(home: string): string {
  return process.platform === "darwin"
    ? join(home, "Library/Application Support", DESKTOP_IDENTIFIERS.desktop)
    : join(home, ".config", DESKTOP_IDENTIFIERS.desktop); // the fixture ctx sets no XDG_CONFIG_HOME
}

test("restores the newest pre-app backup over the desktop's link and records the restored link path, never the app bundle", async () => {
  const { ctx, service, path } = fixture();
  const { link } = bundledLink(ctx);
  const binDir = dirname(link);
  put(join(binDir, "pacer.pre-app-20260101T000000Z"), "older backup");
  put(join(binDir, "pacer.pre-app-20260102T000000Z"), "newer backup");
  // Filenames pick the winner, not mtime: give the OLDER name the NEWER mtime.
  utimesSync(join(binDir, "pacer.pre-app-20260101T000000Z"), new Date(5_000_000), new Date(5_000_000));
  utimesSync(join(binDir, "pacer.pre-app-20260102T000000Z"), new Date(1_000_000), new Date(1_000_000));
  writeOwner(ctx, { owner: "desktop", executable: join(ctx.home, "pacer.app/Contents/Resources/pacer"), at: 1 });
  // The service must start the restored command, not the app's: the link is already restored at bootstrap.
  let atBootstrap = "";
  const run = ctx.run;
  ctx.run = async (argv, timeoutMs) => { if (argv[1] === "bootstrap") atBootstrap = readFileSync(link, "utf8"); return run(argv, timeoutMs); };

  const result = await releaseOwnership(ctx, { service });
  expect(atBootstrap).toBe("newer backup");

  expect(result.code).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBe(false);
  expect(readFileSync(link, "utf8")).toBe("newer backup");
  expect(existsSync(join(binDir, "pacer.pre-app-20260102T000000Z"))).toBe(false);
  expect(existsSync(join(binDir, "pacer.pre-app-20260101T000000Z"))).toBe(true); // only the newest backup is consumed
  // Never the PACER_BIN/app-bundle path: the restored link itself, a regular file.
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: link });
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, [link]));
  expect(result.out).toContain("restored the terminal command");
  expect(result.out).toContain("ownership released to this CLI");
});

test("preserves a symlink backup exactly and records the command's own path, not its target", async () => {
  const { ctx, service, path } = fixture();
  const { link } = bundledLink(ctx);
  const external = join(ctx.home, "brew-cellar/pacer");
  put(external, "external build");
  const backup = join(dirname(link), "pacer.pre-app-20260101T000000Z");
  symlinkSync(external, backup);
  writeOwner(ctx, { owner: "desktop", executable: join(ctx.home, "pacer.app/Contents/Resources/pacer"), at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBe(true); // never flattened into a hard link
  expect(readlinkSync(link)).toBe(external);
  expect(existsSync(backup)).toBe(false);
  // The link path survives a Homebrew upgrade that removes the resolved Cellar target.
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: link });
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, [link]));
});

test("without a backup, refuses rather than recording an executable inside the app bundle", async () => {
  const { ctx, service, path } = fixture();
  bundledLink(ctx); // the only pacer command on this machine lives inside the bundle
  writeOwner(ctx, { owner: "desktop", executable: join(ctx.home, "pacer.app/Contents/Resources/pacer"), at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result).toEqual({ code: 2, out: "", err: expect.stringContaining("nothing outside it to hand back to") });
  expect(readOwner(ctx)).toMatchObject({ owner: "desktop" }); // unchanged
  expect(existsSync(path)).toBe(false); // the service was never touched
});

test("without a backup, hands back using the link when it is already a standalone CLI outside the bundle", async () => {
  const { ctx, service, path } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "#!/bin/sh\necho standalone\n");
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("no pacer.pre-app backup found");
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: link });
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, [link]));
});

test("a backup exists but the link is not the app's: left in place, noted, ownership still released with the link's own identity", async () => {
  const { ctx, service } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "some other regular file");
  put(join(dirname(link), "pacer.pre-app-20260101T000000Z"), "backup");

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("is not the app's link");
  expect(readFileSync(link, "utf8")).toBe("some other regular file");
  expect(existsSync(join(dirname(link), "pacer.pre-app-20260101T000000Z"))).toBe(true);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: link });
});

test("refuses while tasks or sessions are running unless --force", async () => {
  const { ctx, service } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "standalone");
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.attemptStartedAt = ctx.now; });

  const refused = await releaseOwnership(ctx, { service });
  expect(refused).toEqual({ code: 2, out: "", err: "pacer: 1 task and 0 sessions are running. Rerun with --force to release ownership anyway." });
  expect(readOwner(ctx)).toBeNull();

  const forced = await releaseOwnership(ctx, { service, force: true });
  expect(forced.code).toBe(0);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli" });
});

test("a failed service re-registration rolls back the restore and leaves the owner record untouched", async () => {
  const { ctx, service, calls, path } = fixture({ fail: true });
  const { link } = bundledLink(ctx);
  const backup = join(dirname(link), "pacer.pre-app-20260101T000000Z");
  put(backup, "original command");
  writeOwner(ctx, { owner: "desktop", executable: join(ctx.home, "pacer.app/Contents/Resources/pacer"), at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(1);
  expect(result.err).toContain("bad plist");
  expect(calls.some(c => c[1] === "bootstrap")).toBe(true); // the risky step really ran
  // Nothing committed: the backup is still there, the link is still the desktop's, ownership unchanged.
  expect(readFileSync(backup, "utf8")).toBe("original command");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readlinkSync(link)).toBe(join(ctx.home, "pacer.app/Contents/Resources/pacer"));
  expect(readOwner(ctx)).toMatchObject({ owner: "desktop" });
  expect(existsSync(path)).toBe(false);
});

test("records Keep-mine for a running desktop so it stays attached instead of re-offering, mirroring consent.json and cli-choice.json", async () => {
  const { ctx, service } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "standalone");
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1 });

  const result = await releaseOwnership(ctx, { service });
  expect(result.code).toBe(0);
  expect(result.out).toContain("Keep-mine");

  const config = desktopConfig(ctx.home);
  const consent = JSON.parse(readFileSync(join(config, "consent.json"), "utf8"));
  expect(consent).toEqual({ at: expect.any(String), path: false, keep: true });
  const choice = JSON.parse(readFileSync(join(config, "cli-choice.json"), "utf8"));
  expect(choice).toEqual({ path: link, version: "pacer 9.9.9" });
});

test("never writes Keep-mine bookkeeping when the CLI already owned the installation", async () => {
  const { ctx, service } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "standalone");
  writeOwner(ctx, { owner: "cli", executable: link, at: 1 });

  const result = await releaseOwnership(ctx, { service });
  expect(result.code).toBe(0);
  expect(existsSync(desktopConfig(ctx.home))).toBe(false);
});
