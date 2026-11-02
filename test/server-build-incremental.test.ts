import { expect, test } from "bun:test";
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

test("Cargo reruns the asset build for an imported source and rejects stale assets", () => {
  const root = tmpDir();
  const crate = join(root, "crates/server");
  for (const dir of [crate, join(crate, "src"), join(root, "app/src"), join(root, "src/view-model"), join(root, "node_modules"), join(root, "bin")]) mkdirSync(dir, { recursive: true });
  for (const file of ["app/index.html", "app/build.ts", "app/xterm-csp.ts", "app/tokens-gen.ts", "app/tsconfig.json", "package.json", "bun.lock", "src/view-model/words.ts"]) writeFileSync(join(root, file), "initial");
  copyFileSync("crates/server/build.rs", join(crate, "build.rs"));
  writeFileSync(join(crate, "Cargo.toml"), '[package]\nname="asset-build-regression"\nversion="0.1.0"\nedition="2021"\n[build-dependencies]\nserde_json="1"\n');
  writeFileSync(join(crate, "src/lib.rs"), "pub fn fixture() {}\n");
  const bun = join(root, "bin/bun");
  writeFileSync(bun, '#!/bin/sh\necho run >> calls\nif grep -q stale src/view-model/words.ts; then echo "embedded app assets are stale" >&2; exit 1; fi\nprintf \'[{"path":"index.html"}]\'\n');
  chmodSync(bun, 0o755);
  const { CARGO_TARGET_DIR: _target, ...env } = process.env;
  const build = () => Bun.spawnSync(["cargo", "build", "--offline"], { cwd: crate, env: { ...env, PATH: `${join(root, "bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const first = build();
  if (first.exitCode !== 0) throw new Error(first.stderr.toString());
  expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
  writeFileSync(join(root, "src/view-model/words.ts"), "stale");
  const second = build();
  expect(second.exitCode).not.toBe(0);
  expect(second.stderr.toString()).toContain("embedded app assets are stale");
  expect(readFileSync(join(root, "calls"), "utf8").trim().split("\n")).toHaveLength(2);
}, 120_000);
