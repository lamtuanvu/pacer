import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readOwner, writeOwner } from "../src/install/owner";
import { releaseOwnership } from "../src/install/ownership-handback";
import { plist, servicePath, type ServiceDeps } from "../src/service";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const goodFetch = (async () => Response.json({ ok: true, pid: 456 }, { headers: { "X-Pacer": "1" } })) as NonNullable<ServiceDeps["fetch"]>;

function fixture() {
  const calls: string[][] = [];
  const ctx = fakeCtx({ env: { PATH: "/bin:/usr/bin", PACER_BIN: "/opt/pacer" }, which: () => null,
    run: async argv => {
      calls.push(argv);
      if (argv[1] === "print") return { code: 0, stdout: "service = {\n state = running\n pid = 456\n last exit code = 0\n}\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    } });
  const service: ServiceDeps = { platform: "darwin", uid: 501, argv: ["/opt/pacer"], fetch: goodFetch, waitMs: 0 };
  return { ctx, calls, service, path: servicePath(ctx, "darwin") };
}

function put(path: string, text: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

function bundledLink(home: string): string {
  const bundled = join(home, "pacer.app/Contents/Resources/pacer");
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, "bundled cli");
  const link = join(home, ".local/bin/pacer");
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(bundled, link);
  return link;
}

test("restores the newest pre-app backup over the desktop's link, reinstalls the service, and records cli ownership", async () => {
  const { ctx, service, path } = fixture();
  const link = bundledLink(ctx.home);
  const binDir = dirname(link);
  put(join(binDir, "pacer.pre-app-20260101T000000Z"), "older backup");
  put(join(binDir, "pacer.pre-app-20260102T000000Z"), "newer backup");
  // Make mtime order explicit and independent of write order.
  utimesSync(join(binDir, "pacer.pre-app-20260101T000000Z"), new Date(1000_000), new Date(1000_000));
  utimesSync(join(binDir, "pacer.pre-app-20260102T000000Z"), new Date(2000_000), new Date(2000_000));
  writeOwner(ctx, { owner: "desktop", executable: join(ctx.home, "pacer.app/Contents/Resources/pacer"), at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(lstatSync(link).isSymbolicLink()).toBe(false);
  expect(readFileSync(link, "utf8")).toBe("newer backup");
  expect(existsSync(join(binDir, "pacer.pre-app-20260102T000000Z"))).toBe(false);
  expect(existsSync(join(binDir, "pacer.pre-app-20260101T000000Z"))).toBe(true); // only the newest backup is consumed
  expect(readOwner(ctx)).toMatchObject({ owner: "cli", executable: "/opt/pacer" });
  expect(readFileSync(path, "utf8")).toBe(plist(ctx, ["/opt/pacer"]));
  expect(result.out).toContain("restored the terminal command");
  expect(result.out).toContain("ownership released to this CLI");
});

test("no backup: leaves the terminal command alone and says so, but still hands ownership back", async () => {
  const { ctx, service } = fixture();
  const link = bundledLink(ctx.home);
  writeOwner(ctx, { owner: "desktop", executable: "/Applications/pacer.app/Contents/Resources/pacer", at: 1 });

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("no pacer.pre-app backup found");
  expect(lstatSync(link).isSymbolicLink()).toBe(true); // untouched
  expect(readOwner(ctx)).toMatchObject({ owner: "cli" });
});

test("a backup exists but the link is not the app's: left in place, noted, ownership still released", async () => {
  const { ctx, service } = fixture();
  const link = join(ctx.home, ".local/bin/pacer");
  put(link, "some other regular file");
  put(join(dirname(link), "pacer.pre-app-20260101T000000Z"), "backup");

  const result = await releaseOwnership(ctx, { service });

  expect(result.code).toBe(0);
  expect(result.out).toContain("is not the app's link");
  expect(readFileSync(link, "utf8")).toBe("some other regular file");
  expect(existsSync(join(dirname(link), "pacer.pre-app-20260101T000000Z"))).toBe(true);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli" });
});

test("refuses while tasks or sessions are running unless --force", async () => {
  const { ctx, service } = fixture();
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.attemptStartedAt = ctx.now; });

  const refused = await releaseOwnership(ctx, { service });
  expect(refused).toEqual({ code: 2, out: "", err: "pacer: 1 task and 0 sessions are running. Rerun with --force to release ownership anyway." });
  expect(readOwner(ctx)).toBeNull();

  const forced = await releaseOwnership(ctx, { service, force: true });
  expect(forced.code).toBe(0);
  expect(readOwner(ctx)).toMatchObject({ owner: "cli" });
});
