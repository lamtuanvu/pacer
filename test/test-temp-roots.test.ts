import {expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {OWNER_MARKER, createTestRoot, processStart, staleTestRoot} from "./temp-roots";
import {tmpDir} from "./helpers";

function fixture(owner?: unknown) {
  const root = join(tmpDir(), "pacer-test-fixture");
  mkdirSync(root);
  if (owner !== undefined) writeFileSync(join(root, OWNER_MARKER), JSON.stringify(owner));
  return root;
}

test("test roots record their owner and never consider current-run roots stale", () => {
  const root = createTestRoot("pacer-test-");
  expect(JSON.parse(readFileSync(join(root, OWNER_MARKER), "utf8"))).toEqual({pid: process.pid, startTime: processStart(process.pid)});
  expect(staleTestRoot(root, Date.now() + 48 * 60 * 60_000)).toBe(false);
  // createTestRoot is normally cleaned by helpers/setup; explicitly remove this test-owned extra root.
  rmSync(root, {recursive: true});
});

test("dead owners and reused pids are stale; live and unknown owners are retained", () => {
  expect(staleTestRoot(fixture({pid: 2147483647, startTime: "old"}))).toBe(true);
  expect(staleTestRoot(fixture({pid: process.pid, startTime: processStart(process.pid)}))).toBe(false);
  expect(staleTestRoot(fixture({pid: process.pid, startTime: "previous process"}))).toBe(true);
  expect(staleTestRoot(fixture({pid: process.pid, startTime: null}))).toBe(false);
  expect(staleTestRoot(fixture({pid: -1, startTime: "bad"}))).toBe(false);
});

test("legacy roots need 24 hours; directory and marker symlinks are never followed", () => {
  const root = fixture();
  expect(staleTestRoot(root)).toBe(false);
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(root, old, old);
  expect(staleTestRoot(root)).toBe(true);
  const link = join(tmpDir(), "pacer-test-link");
  symlinkSync(root, link);
  expect(staleTestRoot(link)).toBe(false);
  const markerTarget = join(tmpDir(), "owner");
  writeFileSync(markerTarget, JSON.stringify({pid: 2147483647, startTime: "dead"}));
  symlinkSync(markerTarget, join(root, OWNER_MARKER));
  expect(staleTestRoot(root)).toBe(false);
  expect(existsSync(markerTarget)).toBe(true);
});

for (const keep of [false, true]) test(`startup sweeps only stale owned sibling roots (keep=${keep})`, async () => {
  const parent = tmpDir();
  const dead = join(parent, "pacer-test-dead"), live = join(parent, "pacer-test-live");
  const legacy = join(parent, "pacer-test-home-legacy"), recent = join(parent, "pacer-test-recent");
  const unrelated = join(parent, "tmp.unrelated");
  for (const root of [dead, live, legacy, recent, unrelated]) mkdirSync(root);
  writeFileSync(join(dead, OWNER_MARKER), JSON.stringify({pid: 2147483647, startTime: "dead"}));
  writeFileSync(join(live, OWNER_MARKER), JSON.stringify({pid: process.pid, startTime: processStart(process.pid)}));
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  for (const root of [legacy, unrelated]) utimesSync(root, old, old);
  const link = join(parent, "pacer-test-symlink");
  symlinkSync(unrelated, link);
  const file = join(parent, "startup.test.ts");
  writeFileSync(file, 'import {test} from "bun:test"; test("startup", () => {});\n');
  const child = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "setup.ts"), file], {
    env: {...process.env, HOME: parent, PACER_HOME: join(parent, ".pacer"), TMPDIR: parent, PACER_KEEP_TEST_TMP: keep ? "1" : ""},
    stdout: "ignore", stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  expect(existsSync(dead)).toBe(keep);
  expect(existsSync(legacy)).toBe(keep);
  for (const root of [live, recent, unrelated, link]) expect(existsSync(root)).toBe(true);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`test setup cleans home and helper roots on ${signal}`, async () => {
  const parent = tmpDir(), ready = join(parent, "ready.json"), file = join(parent, "signal.test.ts");
  writeFileSync(file, `import {test} from "bun:test";
import {writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {tmpDir} from ${JSON.stringify(join(import.meta.dir, "helpers.ts"))};
test("wait for signal", async () => {
  writeFileSync(${JSON.stringify(ready)}, JSON.stringify({home: process.env.HOME, root: dirname(tmpDir()), raw: mkdtempSync(join(tmpdir(), "pacer-raw-"))}));
  await new Promise(resolve => setTimeout(resolve, 20000));
});`);
  const child = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "setup.ts"), file], {
    env: {...process.env, HOME: parent, PACER_HOME: join(parent, ".pacer"), TMPDIR: parent, PACER_KEEP_TEST_TMP: ""}, stdout: "ignore", stderr: "ignore",
  });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    const roots = JSON.parse(readFileSync(ready, "utf8"));
    child.kill(signal);
    await child.exited;
    expect(existsSync(roots.home)).toBe(false);
    expect(existsSync(roots.root)).toBe(false);
    expect(existsSync(roots.raw)).toBe(false);
  } finally {child.kill(); await child.exited;}
});

for (const keep of [false, true]) test(`ordinary suite contains and cleans raw temp allocations (keep=${keep})`, async () => {
  const parent = tmpDir(), result = join(parent, "raw.json"), file = join(parent, "raw.test.ts");
  writeFileSync(file, `import {test} from "bun:test";
import {mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";import {tmpdir} from "node:os";
test("raw temp",()=>writeFileSync(${JSON.stringify(result)},JSON.stringify({home:process.env.HOME,raw:mkdtempSync(join(tmpdir(),"raw-fixture-"))})));`);
  const child = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "setup.ts"), file], {
    env: {...process.env, TMPDIR: parent, PACER_KEEP_TEST_TMP: keep ? "1" : ""}, stdout: "ignore", stderr: "pipe",
  });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
  const roots = JSON.parse(readFileSync(result, "utf8"));
  expect(roots.raw.startsWith(roots.home + "/")).toBe(true);
  expect(existsSync(roots.raw)).toBe(keep);
});
