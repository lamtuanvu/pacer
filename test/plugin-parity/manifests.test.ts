/**
 * The Rust bundled table and the TypeScript bundled list must cover the same
 * ids. The JSON under `plugins-rs/` is now the source of truth (M3 C13), so
 * the old generator and its freshness test are gone; `bun
 * scripts/plugin-parity/manifests.ts --check` verifies the files themselves.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { BUNDLED } from "../../src/plugins/bundled";

const repoRoot = resolve(import.meta.dir, "..", "..");

describe("plugin manifest parity (TypeScript vs Rust)", () => {
  test("the Rust table lists exactly the TypeScript bundled ids", () => {
    const rust = readFileSync(resolve(repoRoot, "crates", "bundled", "src", "lib.rs"), "utf8");
    const ids = [...rust.matchAll(/Bundled \{ id: "([^"]+)"/g)].map((m) => m[1]!);
    const expected = BUNDLED.map((r) => r.manifest.id).filter((id) => id !== "assistant-pacer");
    expect(new Set(ids)).toEqual(new Set(expected));
    expect(ids).toHaveLength(expected.length);
  });
});
