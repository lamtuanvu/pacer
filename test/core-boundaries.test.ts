import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith("assets.generated.ts") ? [p] : [];
  });
}

test("core source never imports the Orca plugin's source tree", () => {
  const offenders = files(join(import.meta.dir, "..", "src")).filter((f) => /from\s+["'][^"']*orca-plugin\//.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("src/core imports nothing from src/exec/orca", () => {
  const offenders = files(join(import.meta.dir, "..", "src", "core")).filter((f) => /from\s+["'][^"']*exec\/orca/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});
