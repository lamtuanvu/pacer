/**
 * Keep the Rust bundled table's embedded manifests byte-equal to the
 * TypeScript runtime authority (M3 C0a). The generator
 * (scripts/plugin-parity/manifests.ts) is the only writer; the Rust table
 * only embeds what it produced, and this suite fails when either drifts.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUNDLED } from "../../plugins/bundled";
import { manifestPath, manifestText } from "../../scripts/plugin-parity/manifests";

const repoRoot = resolve(import.meta.dir, "..", "..");
const rows = BUNDLED.filter((row) => !("executable" in row));

describe("plugin manifest parity (TypeScript vs Rust)", () => {
  test("every TypeScript bundled manifest is byte-equal to its Rust table JSON", () => {
    for (const row of rows) {
      const candidates = candidatePaths(row.manifest.id);
      const present = candidates.filter((p) => existsSync(p));
      expect(present, `exactly one candidate for ${row.manifest.id} (${candidates.join(", ")})`).toHaveLength(1);
      expect(readFileSync(present[0]!, "utf8")).toBe(manifestText(row.manifest.id));
    }
  });

  test("the Rust table lists exactly the TypeScript bundled ids", () => {
    const rust = readFileSync(resolve(repoRoot, "crates", "bundled", "src", "lib.rs"), "utf8");
    const ids = [...rust.matchAll(/Bundled \{ id: "([^"]+)"/g)].map((m) => m[1]!);
    const expected = BUNDLED.map((r) => r.manifest.id).filter((id) => id !== "assistant-pacer");
    expect(new Set(ids)).toEqual(new Set(expected));
    expect(ids).toHaveLength(expected.length);
  });

  test("the generator is fresh", () => {
    const result = Bun.spawnSync([process.execPath, resolve(repoRoot, "scripts", "plugin-parity", "manifests.ts"), "--check"], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});

function candidatePaths(id: string): string[] {
  return [
    resolve(repoRoot, "plugins-rs", id, "manifest.json"),
    resolve(repoRoot, "crates", "bundled", "manifests", `${id}.json`),
  ];
}
