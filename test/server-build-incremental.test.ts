import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

const manifest = (text: string) => JSON.stringify({ version: "1.0.0", files: [{ path: "index.html", type: "text/html", text }] }, null, 2) + "\n";

test("the server build embeds app/assets.generated.json without bun or src/, and reruns when it changes", () => {
  const root = tmpDir();
  const crate = join(root, "crates/server");
  for (const dir of [crate, join(crate, "src"), join(root, "app")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
  writeFileSync(join(root, "app/assets.generated.json"), manifest("one"));
  copyFileSync("crates/server/build.rs", join(crate, "build.rs"));
  writeFileSync(join(crate, "Cargo.toml"), '[package]\nname="asset-build-regression"\nversion="0.1.0"\nedition="2021"\n[build-dependencies]\nserde_json="1"\n');
  writeFileSync(join(crate, "src/lib.rs"), 'pub const ASSETS: &str = include_str!(concat!(env!("OUT_DIR"), "/app-assets.json"));\n');
  const { CARGO_TARGET_DIR: _target, ...env } = process.env;
  const target = join(root, "target");
  // No bun on PATH: only the directories cargo and the linker need.
  const path = (process.env.PATH ?? "").split(":").filter(dir => !readdirSafe(dir).includes("bun")).join(":");
  const build = () => Bun.spawnSync(["cargo", "build", "--offline"], { cwd: crate, env: { ...env, PATH: path, CARGO_TARGET_DIR: target }, stdout: "pipe", stderr: "pipe" });
  const embedded = () => readFileSync(Bun.spawnSync(["sh", "-c", `ls ${target}/debug/build/asset-build-regression-*/out/app-assets.json | head -1`]).stdout.toString().trim(), "utf8");
  const first = build();
  if (first.exitCode !== 0) throw new Error(first.stderr.toString());
  expect(JSON.parse(embedded())[0].text).toBe("one");
  writeFileSync(join(root, "app/assets.generated.json"), manifest("two"));
  expect(build().exitCode).toBe(0);
  expect(JSON.parse(embedded())[0].text).toBe("two");
}, 120_000);

function readdirSafe(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
