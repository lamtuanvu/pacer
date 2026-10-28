import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith("assets.generated.ts") ? [p] : [];
  });
}

test("source never imports the removed Orca plugin", () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders = files(src).filter(f => /from\s+["'][^"']*orca-plugin\//.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("src/core imports nothing from src/exec/orca", () => {
  const offenders = files(join(import.meta.dir, "..", "src", "core")).filter((f) => /from\s+["'][^"']*exec\/orca/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("only the plugin host imports the bundled plugin list", () => {
  const src = join(import.meta.dir, "..", "src");
  const allowed = new Set([join(src, "plugins", "index.ts"), join(src, "plugins", "run.ts"), join(src, "core", "plugins.ts")]);
  const offenders = files(src).filter(f => !allowed.has(f) && /from\s+["'][^"']*\/plugins\/bundled["']/.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("core config takes backend readiness by injection, not from src/exec", () => {
  expect(readFileSync(join(import.meta.dir, "..", "src", "core", "config.ts"), "utf8")).not.toMatch(/from\s+["'][^"']*\/exec\//);
});

test("src/core runs no orca CLI and leaves host cleanup to src/exec adapters", () => {
  const core = files(join(import.meta.dir, "..", "src", "core"));
  const argv = /(?:\b(?:run|spawn|spawnSync|execProcess)\s*\(\s*\[\s*["']orca["'])|\[\s*["']orca["']\s*,\s*["'](?:worktree|terminal|orchestration|repo|status|project|account)["']/;
  const cli = core.filter((f) => argv.test(readFileSync(f, "utf8")));
  expect(cli).toEqual([]);
  const env = core.filter((f) => /sanitizedOrcaEnv|attestation-env/.test(readFileSync(f, "utf8")));
  expect(env).toEqual([]);
  expect(readFileSync(join(import.meta.dir, "..", "src", "core", "tasks.ts"), "utf8")).not.toMatch(/orca/i);
});
