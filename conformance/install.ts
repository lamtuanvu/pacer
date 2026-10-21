import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = ["good", "slow", "crasher", "undeclared", "over-privileged", "old-protocol", "serial", "reentrant", "claims", "bad-manifest", "mismatch"] as const;
export type FixtureName = (typeof FIXTURES)[number];
const FOLDER_IDS: Partial<Record<FixtureName, string>> = { "bad-manifest": "fx-bad", mismatch: "fx-mismatch" };
const root = join(import.meta.dir, "fixtures");

/** Copy a fixture into <pluginsDir>/<id>/ as an installed plugin. Returns the folder. */
export function installFixture(name: FixtureName, pluginsDir: string, overrides: { manifest?: Record<string, unknown>; fixture?: Record<string, unknown> } = {}): string {
  const src = join(root, name);
  const manifestText = readFileSync(join(src, "pacer-plugin.json"), "utf8");
  let manifest: Record<string, unknown> | null = null;
  try { manifest = JSON.parse(manifestText); } catch { manifest = null; }
  if (manifest && overrides.manifest) manifest = { ...manifest, ...overrides.manifest };
  const id = FOLDER_IDS[name] ?? String(manifest?.id);
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), manifest ? JSON.stringify(manifest) : manifestText);
  const fixture = { ...JSON.parse(readFileSync(join(src, "fixture.json"), "utf8")), ...overrides.fixture };
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  copyFileSync(join(src, "main.ts"), join(dir, "main.ts"));
  copyFileSync(join(root, "plugin.ts"), join(dir, "plugin.ts"));
  chmodSync(join(dir, "main.ts"), 0o755);
  return dir;
}
