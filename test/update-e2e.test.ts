import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRelease } from "../scripts/release/build";
import { type Platform, assetFile, hostTarget } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const HOST = hostTarget();

async function run(argv: string[], env: Record<string, string>) {
  const p = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

test.skipIf(!HOST)("a compiled pacer updates itself from a file:// release and leaves ~/.pacer alone", async () => {
  const target = HOST!;
  const work = tmpDir();
  const releases = join(work, "release");
  await buildRelease({ root: ROOT, outRoot: releases, version: "0.1.0", targets: [target] });
  const home = join(work, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const pacer = join(bin, "pacer");
  copyFileSync(join(releases, "0.1.0", assetFile(target as Platform)), pacer);
  chmodSync(pacer, 0o755);
  await buildRelease({ root: ROOT, outRoot: releases, version: "0.9.0", targets: [target] });
  mkdirSync(join(home, ".pacer"), { recursive: true });
  writeFileSync(join(home, ".pacer", "strategy.yaml"), "planner: claude-code\n");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PACER_RELEASE_BASE: pathToFileURL(releases).href };

  expect((await run([pacer, "--version"], env)).out.trim()).toBe("pacer 0.1.0");
  const check = await run([pacer, "update", "--check"], env);
  expect(check.out).toContain("update available: 0.1.0 -> 0.9.0");

  const up = await run([pacer, "update"], env);
  expect(up.err).toBe("");
  expect(up.code).toBe(0);
  expect(up.out).toContain("updated pacer 0.1.0 -> 0.9.0");
  expect((await run([pacer, "--version"], env)).out.trim()).toBe("pacer 0.9.0");
  expect((await run([`${pacer}.bak`, "--version"], env)).out.trim()).toBe("pacer 0.1.0");
  expect(readdirSync(bin).sort()).toEqual(["pacer", "pacer.bak"]);

  expect(readdirSync(join(home, ".pacer"))).toEqual(["strategy.yaml"]);
  expect(readFileSync(join(home, ".pacer", "strategy.yaml"), "utf8")).toBe("planner: claude-code\n");

  const again = await run([pacer, "update"], env);
  expect(again).toEqual({ code: 0, out: "pacer 0.9.0 is up to date\n", err: "" });
}, 300_000);
