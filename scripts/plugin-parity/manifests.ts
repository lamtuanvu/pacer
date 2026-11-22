/**
 * Manifest generator for the Rust bundled plugin table (M3 C0a).
 *
 * Imports the TypeScript runtime BUNDLED rows and writes each manifest as
 * pretty-printed JSON + "\n", byte-equal to what test/plugin-parity
 * reads. Targets `plugins-rs/<id>/manifest.json` once that directory exists
 * (i.e. after the plugin is ported), otherwise `crates/bundled/manifests/`.
 * Never hand-edit the generated files; run this script (or its --check form).
 */
import { BUNDLED } from "../../plugins/bundled";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");

/** Absolute path where `<id>`'s manifest should live at HEAD. */
export function manifestPath(id: string): string {
  const rs = resolve(repoRoot, "plugins-rs", id, "manifest.json");
  if (existsSync(rs)) return rs;
  return resolve(repoRoot, "crates", "bundled", "manifests", `${id}.json`);
}

/** Pretty-printed manifest text a Rust table embeds, byte-equal everywhere. */
export function manifestText(id: string): string {
  const row = BUNDLED.find((p) => p.manifest.id === id);
  if (!row) throw new Error(`no bundled manifest for ${id}`);
  return JSON.stringify(row.manifest, null, 2) + "\n";
}

function generate(): { written: string[] } {
  const written: string[] = [];
  for (const row of BUNDLED) {
    if ("executable" in row) continue;
    const path = manifestPath(row.manifest.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, manifestText(row.manifest.id));
    written.push(path);
  }
  return { written };
}

function check(): string[] {
  const stale: string[] = [];
  for (const row of BUNDLED) {
    if ("executable" in row) continue;
    const path = manifestPath(row.manifest.id);
    if (!existsSync(path) || readFileSync(path, "utf8") !== manifestText(row.manifest.id)) {
      stale.push(path);
    }
  }
  return stale;
}

const args = process.argv.slice(2);
if (import.meta.main) {
  if (args.includes("--check")) {
    const stale = check();
    for (const path of stale) console.error(`stale: ${path}`);
    if (stale.length > 0) process.exit(1);
  } else {
    const { written } = generate();
    for (const path of written) console.log(`wrote ${path}`);
  }
}