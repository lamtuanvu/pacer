import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { COMPILED_WORKERS, compileCommand } from "../scripts/release/build";

const root = resolve(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("every URL worker the service starts is a compile entrypoint", () => {
  // Source-relative worker URLs that exist on disk; the compiled-mode variants do not.
  const workers = sources(join(root, "src")).filter(file => readFileSync(file, "utf8").includes("new Worker(")).flatMap(file =>
    [...readFileSync(file, "utf8").matchAll(/new URL\("(\.\.?\/[^"]+\.ts)", import\.meta\.url\)/g)]
      .map(match => resolve(dirname(file), match[1]!))
      .filter(path => existsSync(path))
      .map(path => relative(root, path).split("\\").join("/")));
  expect(workers.length).toBeGreaterThan(0);
  expect([...new Set(workers)].sort()).toEqual([...COMPILED_WORKERS].sort());
  const argv = compileCommand({ root, target: { os: "linux", arch: "x64", bunTarget: "bun-linux-x64" }, version: "0.0.0", outfile: "/dev/null" } as Parameters<typeof compileCommand>[0]);
  for (const worker of COMPILED_WORKERS) expect(argv).toContain(join(root, ...worker.split("/")));
});
