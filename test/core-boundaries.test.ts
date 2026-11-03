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

test("src/core imports no Orca-specific module (ARCH-4, P8)", () => {
  // The Orca execution adapter, its host brokers and the bundled plugin are reached only through host-neutral executor interfaces.
  const orca = /(?:from\s+|import\(\s*)["'][^"']*(?:exec\/orca|plugins\/(?:orca-|executor-orca)|pacer-exec-orca)/;
  const offenders = files(join(import.meta.dir, "..", "src", "core")).filter((f) => orca.test(readFileSync(f, "utf8")));
  expect(offenders).toEqual([]);
});

test("the bundled Orca executor imports no host code and builds no Orca argv", () => {
  const plugin = files(join(import.meta.dir, "..", "plugins", "pacer-exec-orca"));
  expect(plugin.length).toBeGreaterThan(0);
  for (const f of plugin) {
    const text = readFileSync(f, "utf8");
    const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1]!);
    expect(imports.filter(spec => !["@pacer/plugin", "zod"].includes(spec) && !/^\.\/[\w-]+$/.test(spec))).toEqual([]);
    expect(text).not.toMatch(/\[\s*["']orca["']\s*,|["'](?:worktree|terminal|orchestration)["']\s*,\s*["'](?:create|show|close|send|worker-start|worker-stop)["']/);
  }
});

test("only the plugin host imports the bundled plugin list", () => {
  const src = join(import.meta.dir, "..", "src");
  const allowed = new Set([join(src, "plugins", "index.ts"), join(src, "plugins", "run.ts"), join(src, "plugins", "registry.ts"), join(src, "core", "plugins.ts")]);
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

test("the API operation table loads execution backends only on use", () => {
  const ops = readFileSync(join(import.meta.dir, "..", "src", "api", "ops.ts"), "utf8");
  expect(ops).not.toMatch(/from\s+["'][^"']*\/exec\//);
  expect(ops).toMatch(/import\(["']\.\.\/exec\/backend["']\)/);
});

test("only the plugin host builds SSH argv and core keeps no direct-SSH fallback", () => {
  const src = join(import.meta.dir, "..", "src");
  const builders = new Set([join(src, "remote", "ssh.ts"), join(src, "plugins", "registry.ts"),
    join(src, "plugins", "fetch-issuer.ts"), join(src, "plugins", "bundle-stage.ts")]);
  expect(files(src).filter(f => !builders.has(f) && /\bsshArgv\b/.test(readFileSync(f, "utf8")))).toEqual([]);
  // The user-opened interactive terminal is the only ssh argv outside the plugin host.
  const spawnsSsh = /\[\s*["']ssh["']\s*,\s*(?:["']-|[\w.]+\.ssh\b)/;
  const allowed = new Set([join(src, "remote", "ssh.ts"), join(src, "remote", "hosts.ts")]);
  expect(files(src).filter(f => !allowed.has(f) && !f.startsWith(join(src, "plugins")) && spawnsSsh.test(readFileSync(f, "utf8")))).toEqual([]);
  expect(readFileSync(join(src, "remote", "ssh.ts"), "utf8")).not.toMatch(/\b(?:Bun\.spawn|spawn|ctx\.run)\s*\(/);
});
