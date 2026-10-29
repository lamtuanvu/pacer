#!/usr/bin/env bun
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CASES, type ConformanceCase, prepareHome } from "./cases";
import { HostSession } from "./host";
import { installFixture } from "./install";

export { CASES };

/**
 * A `security` stand-in that keeps generic passwords in the case's home. The machine identity
 * keeps its Keychain items in the user's login keychain, so a host under test must never reach the real Keychain.
 */
function sandboxKeychain(home: string): string {
  const bin = join(home, "bin"), store = join(home, "keychain");
  mkdirSync(bin, { recursive: true }); mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(bin, "security"), `#!/bin/sh
store=${JSON.stringify(store)}
item() { s=""; a=""; x=""; while [ $# -gt 0 ]; do case "$1" in -s) s="$2"; shift;; -a) a="$2"; shift;; -X) x="$2"; shift;; esac; shift; done; }
run() { cmd="$1"; shift; item "$@"; f="$store/$s.$(printf %s "$a" | tr / _)"
  case "$cmd" in
    add-generic-password) printf %s "$x" > "$f";;
    find-generic-password) [ -f "$f" ] || exit 44; case " $* " in *" -w "*) cat "$f"; echo;; esac;;
    delete-generic-password) [ -f "$f" ] || exit 44; rm -f "$f";;
    *) exit 1;;
  esac; }
if [ "$1" = "-i" ]; then while read -r line; do eval "run $line" || exit $?; done; else run "$@"; fi
`);
  chmodSync(join(bin, "security"), 0o755);
  return bin;
}

/** Run one case against a host argv with a fresh home under root. Throws on failure. */
export async function runCase(c: ConformanceCase, hostArgv: string[], root: string): Promise<void> {
  mkdirSync(root, { recursive: true });
  const home = mkdtempSync(join(root, `${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-`));
  const pluginsDir = prepareHome(home);
  // Installed fixtures resolve the SDK even when root is outside the repository.
  const scope = join(home, "node_modules", "@pacer");
  mkdirSync(scope, { recursive: true });
  symlinkSync(resolve(import.meta.dir, "../packages/plugin-sdk"), join(scope, "plugin"), "dir");
  const bin = sandboxKeychain(home);
  const sessions: HostSession[] = [];
  const env = { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: home, PACER_HOME: join(home, ".pacer"), PACER_NO_UPDATE_CHECK: "1", TZ: "Asia/Ho_Chi_Minh", ...(process.env.PACER_CORE_ARGV ? { PACER_CORE_ARGV: process.env.PACER_CORE_ARGV } : {}) };
  try {
    await c.run({
      home, pluginsDir,
      install: (name, overrides) => installFixture(name, pluginsDir, overrides),
      host: async () => { const s = new HostSession(hostArgv, env); sessions.push(s); return await s.start(); },
      sleep: ms => Bun.sleep(ms),
    });
  } finally {
    await Promise.all(sessions.map(s => s.close()));
    if (!process.env.PACER_KEEP_CONFORMANCE) rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const host = opt("--host");
  if (!host) { console.error('usage: bun conformance/run.ts --host "<argv>" [--root <dir>] [--only <name>]'); process.exit(2); }
  const root = resolve(opt("--root") ?? join(tmpdir(), "pacer-conformance", "run"));
  mkdirSync(root, { recursive: true });
  const only = opt("--only");
  let failed = 0;
  for (const c of CASES.filter(c => !only || c.name.includes(only))) {
    try { await runCase(c, host.split(" "), root); console.log(`ok    ${c.name}`); }
    catch (e) { failed++; console.log(`FAIL  ${c.name}\n      ${e instanceof Error ? e.message : String(e)}`); }
  }
  process.exit(failed ? 1 : 0);
}
