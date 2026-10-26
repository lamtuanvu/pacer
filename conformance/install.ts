import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export const RUST_FIXTURES = ["rust-good", "rust-slow", "rust-crasher"] as const;
export const FIXTURES = [...RUST_FIXTURES, "good", "slow", "crasher", "undeclared", "over-privileged", "old-protocol", "observations", "host-runner", "executor", "serial", "reentrant", "claims", "bad-manifest", "mismatch", "shadow"] as const;
export type FixtureName = (typeof FIXTURES)[number];
const FOLDER_IDS: Partial<Record<FixtureName, string>> = { "bad-manifest": "fx-bad", mismatch: "fx-mismatch" };
let rustBuilt = false;
const repo = join(import.meta.dir, "..");
const root = join(import.meta.dir, "fixtures");

/** Copy a fixture into <pluginsDir>/<id>/ as an installed plugin. Returns the folder. */
export function installFixture(name: FixtureName, pluginsDir: string, overrides: { manifest?: Record<string, unknown>; fixture?: Record<string, unknown> } = {}): string {
  const rust = name.startsWith("rust-");
  const src = join(root, rust ? "rust-good" : name);
  if (rust && !rustBuilt) {
    // bun:test isolates HOME; Rust's installed toolchain and crate cache stay in
    // the user's tool directories, independently of the fixture's sandbox home.
    const home = userInfo().homedir;
    const env = {
      ...process.env,
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(home, ".rustup"),
      CARGO_HOME: process.env.CARGO_HOME ?? join(home, ".cargo"),
    };
    execFileSync("cargo", ["build", "--locked", "-q", "-p", "pacer-fixtures", "--bin", "pacer-fixture"], { cwd: repo, env, stdio: "inherit" });
    rustBuilt = true;
  }
  const manifestText = readFileSync(join(src, "pacer-plugin.json"), "utf8");
  let manifest: Record<string, unknown> | null = null;
  try { manifest = JSON.parse(manifestText); } catch { manifest = null; }
  if (manifest && rust) manifest = { ...manifest, id: `fx-${name}`, entry: "fixture" };
  if (manifest && overrides.manifest) manifest = { ...manifest, ...overrides.manifest };
  const id = FOLDER_IDS[name] ?? String(manifest?.id);
  const dir = join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pacer-plugin.json"), manifest ? JSON.stringify(manifest) : manifestText);
  const fixture = { ...JSON.parse(readFileSync(join(src, "fixture.json"), "utf8")), ...(name === "rust-slow" ? { pingDelayMs: 8000, slowPings: 1 } : name === "rust-crasher" ? { crashAfterPings: 1 } : {}), ...overrides.fixture };
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  if (rust) {
    copyFileSync(join(repo, "target", "debug", "pacer-fixture"), join(dir, "fixture"));
    chmodSync(join(dir, "fixture"), 0o755);
    return dir;
  }
  copyFileSync(join(src, "main.ts"), join(dir, "main.ts"));
  copyFileSync(join(root, "plugin.ts"), join(dir, "plugin.ts"));
  chmodSync(join(dir, "main.ts"), 0o755);
  return dir;
}
