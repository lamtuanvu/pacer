/**
 * Manifest parity check for the bundled plugin table (M3 C13).
 *
 * The JSON files are now the source of truth; this script keeps serving the
 * `--check` form used by the slice acceptance command. It compares each
 * BUNDLED row's manifest with its `plugins-rs/<id>/manifest.json` (or the
 * remaining `crates/bundled/manifests/` fallback for pacer-dev).
 */
import { BUNDLED } from "../../src/plugins/bundled";
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
