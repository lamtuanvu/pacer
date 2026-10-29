import { beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

let root: string;
let script: string;
let source: string;

beforeEach(() => {
  root = join(realpathSync(tmpDir()), "repo with spaces");
  mkdirSync(join(root, "desktop", "scripts"), { recursive: true });
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  script = join(root, "desktop", "scripts", "stage-cli.sh");
  const original = join(import.meta.dir, "../desktop/scripts/stage-cli.sh");
  if (existsSync(original)) copyFileSync(original, script);
  writeFileSync(join(root, "pacer-core"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  source = join(root, "pacer binary");
  writeFileSync(source, "#!/bin/sh\nprintf 'fake pacer\\n'\n", { mode: 0o711 });
});

function stage(args: string[], env: Record<string, string> = {}, cwd = root) {
  return Bun.spawnSync(["sh", script, ...args], {
    cwd,
    env: { ...process.env, TAURI_TARGET_TRIPLE: "aarch64-apple-darwin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("stages a supplied executable with the target suffix and mode 0755", () => {
  const result = stage(["pacer binary"]);
  expect(result.exitCode).toBe(0);
  const destination = join(root, "desktop/src-tauri/binaries/pacer-aarch64-apple-darwin");
  expect(result.stdout.toString().trim()).toBe(destination);
  expect(readFileSync(destination, "utf8")).toBe(readFileSync(source, "utf8"));
  expect(statSync(destination).mode & 0o777).toBe(0o755);
});

test("rejects a missing source with its path in the error", () => {
  const missing = join(root, "missing pacer");
  const result = stage([missing]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("source is missing");
  expect(result.stderr.toString()).toContain(missing);
  expect(existsSync(join(root, "desktop/src-tauri/binaries"))).toBe(false);
});

test("rejects a source that is not executable", () => {
  chmodSync(source, 0o644);
  const result = stage([source]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("source is not executable");
  expect(result.stderr.toString()).toContain(source);
});

test("uses the Rust host triple when no cross-build target is set", () => {
  const bin = join(root, "tools");
  mkdirSync(bin);
  writeFileSync(join(bin, "rustc"), '#!/bin/sh\n[ "$1" = "-vV" ] || exit 2\nprintf "host: x86_64-unknown-linux-gnu\\n"\n', { mode: 0o755 });
  const result = stage([source], { TAURI_TARGET_TRIPLE: "", PATH: `${bin}:${process.env.PATH}` });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "desktop/src-tauri/binaries/pacer-x86_64-unknown-linux-gnu"), "utf8"))
    .toBe(readFileSync(source, "utf8"));
});

test("builds at the repository root using the BUN executable override", () => {
  const bun = join(root, "bun command");
  writeFileSync(bun, '#!/bin/sh\nset -eu\n[ "$#" = 2 ] && [ "$1" = run ] && [ "$2" = build ] || exit 2\nmkdir -p dist\npwd > dist/pacer\ncp dist/pacer dist/pacer-core\nchmod 755 dist/pacer dist/pacer-core\n', { mode: 0o755 });
  const result = stage([], { BUN: bun }, join(root, "desktop"));
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, "desktop/src-tauri/binaries/pacer-aarch64-apple-darwin"), "utf8"))
    .toBe(`${root}\n`);
});
