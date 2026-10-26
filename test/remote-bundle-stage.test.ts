import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCfg } from "../src/config/hosts";
import { bundleToFile } from "../src/remote/ssh";
import { fakeCtx, tmpDir } from "./helpers";

function fixture(mode: string) {
  const home = tmpDir(), pacerHome = join(home, ".pacer"), tasks = join(pacerHome, "tasks"), bin = join(home, "bin");
  // setup.init creates PACER_HOME with default mkdir permissions (usually 0755).
  mkdirSync(pacerHome, { recursive: true });
  chmodSync(pacerHome, 0o755);
  mkdirSync(tasks, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh
case "$PACER_BUNDLE_FIXTURE" in
  missing) printf 'unframed'; exit 0 ;;
esac
printf '__PACER_BEGIN__\\n'
case "$PACER_BUNDLE_FIXTURE" in
  oversized) printf 'ABCD' ;;
  exit255) printf 'ABC'; exit 255 ;;
  sleeping) sleep 5; printf 'ABC' ;;
  stderrbig) head -c 70000 /dev/zero >&2; printf 'ABC' ;;
  *) printf '\\000\\377A' ;;
esac
`, { mode: 0o700 });
  chmodSync(ssh, 0o700);
  const ctx = fakeCtx({ pacerHome, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, PACER_BUNDLE_FIXTURE: mode } });
  const host: HostCfg = { alias: "box", ssh: "fixture", repos: {}, accounts: {}, maxTasks: 1 };
  const path = join(tasks, "t-test.bundle");
  const stages = () => readdirSync(tasks).filter(name => name.startsWith(".bundle-stage-"));
  return { ctx, host, path, stages };
}

test("bundle receive accepts a setup-style 0755 home and publishes framed binary bytes privately", async () => {
  const f = fixture("ok");
  const result = await bundleToFile(f.ctx, f.host, [], f.path, 3);
  expect(lstatSync(f.ctx.pacerHome).mode & 0o777).toBe(0o755);
  expect(result.code).toBe(0);
  expect([...readFileSync(f.path)]).toEqual([0, 255, 65]);
  expect(lstatSync(f.path).mode & 0o077).toBe(0);
  expect(f.stages()).toEqual([]);
});

test("bundle receive never truncates or follows an existing destination symlink", async () => {
  const f = fixture("ok"), victim = join(f.ctx.pacerHome, "victim");
  writeFileSync(victim, "keep");
  symlinkSync(victim, f.path);
  await expect(bundleToFile(f.ctx, f.host, [], f.path, 3)).rejects.toThrow("destination already exists");
  expect(readFileSync(victim, "utf8")).toBe("keep");
  expect(lstatSync(f.path).isSymbolicLink()).toBe(true);
  expect(f.stages()).toEqual([]);
});

test("bundle receive refuses an existing regular file and any raised size bound", async () => {
  const f = fixture("ok");
  writeFileSync(f.path, "original", { mode: 0o600 });
  await expect(bundleToFile(f.ctx, f.host, [], f.path, 3)).rejects.toThrow("destination already exists");
  expect(readFileSync(f.path, "utf8")).toBe("original");
  await expect(bundleToFile(f.ctx, f.host, [], f.path, 50 * 1024 * 1024 + 1)).rejects.toThrow("invalid remote bundle limit");
  expect(f.stages()).toEqual([]);
});

for (const mode of ["oversized", "missing", "exit255"] as const) {
  test(`bundle receive removes a failed ${mode} stage`, async () => {
    const f = fixture(mode);
    if (mode === "missing") await expect(bundleToFile(f.ctx, f.host, [], f.path, 3)).rejects.toThrow("sentinel missing");
    else {
      const result = await bundleToFile(f.ctx, f.host, [], f.path, 3);
      expect(mode === "oversized" ? result.stdoutOverflow : result.code).toBe(mode === "oversized" ? true : 255);
    }
    expect(existsSync(f.path)).toBe(false);
    expect(f.stages()).toEqual([]);
  });
}

test("bundle receive aborts a streaming SSH child and removes its partial stage", async () => {
  const f = fixture("sleeping"), abort = new AbortController();
  f.ctx.operation = { signal: abort.signal };
  const pending = bundleToFile(f.ctx, f.host, [], f.path, 3);
  setTimeout(() => abort.abort(), 100);
  await expect(pending).rejects.toThrow("cancelled");
  expect(existsSync(f.path)).toBe(false);
  expect(f.stages()).toEqual([]);
}, 10000);

test("bundle receive accepts a setup-style 0755 tasks directory with private staging", async () => {
  const f = fixture("ok");
  chmodSync(join(f.ctx.pacerHome, "tasks"), 0o755);
  const result = await bundleToFile(f.ctx, f.host, [], f.path, 3);
  expect(result.published).toBe(true);
  expect([...readFileSync(f.path)]).toEqual([0, 255, 65]);
  expect(lstatSync(f.path).mode & 0o077).toBe(0);
  expect(f.stages()).toEqual([]);
});

test("bundle receive refuses a group-writable tasks directory", async () => {
  const f = fixture("ok");
  chmodSync(join(f.ctx.pacerHome, "tasks"), 0o777);
  await expect(bundleToFile(f.ctx, f.host, [], f.path, 3)).rejects.toThrow("task directory is writable");
  expect(existsSync(f.path)).toBe(false);
});

test("bundle receive reports timeout without publishing or leaving a stage", async () => {
  const f = fixture("sleeping");
  const result = await bundleToFile(f.ctx, f.host, [], f.path, 3, 40);
  expect(result.timedOut).toBe(true);
  expect(result.published).toBeUndefined();
  expect(existsSync(f.path)).toBe(false);
  expect(f.stages()).toEqual([]);
}, 10000);

test("bundle receive bounds remote stderr and refuses publication", async () => {
  const f = fixture("stderrbig");
  const result = await bundleToFile(f.ctx, f.host, [], f.path, 3);
  expect(result.stderrOverflow).toBe(true);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
  expect(existsSync(f.path)).toBe(false);
  expect(f.stages()).toEqual([]);
});
