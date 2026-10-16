import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith("assets.generated.ts") ? [p] : [];
  });
}

test("core source only imports the Orca status renderer through the serve panel adapter", () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders = files(src).filter(f => {
    const imports = [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"']*orca-plugin\/[^"']*)["']/g)];
    // Serve reuses the read-only page; worker runtime and host APIs stay outside core.
    return imports.some(m => f !== join(src, "serve", "panel.ts") || m[1] !== "../../orca-plugin/src/panel");
  });
  expect(offenders).toEqual([]);
});

test("src/core imports nothing from src/exec/orca", () => {
  const offenders = files(join(import.meta.dir, "..", "src", "core")).filter((f) => /from\s+["'][^"']*exec\/orca/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});
