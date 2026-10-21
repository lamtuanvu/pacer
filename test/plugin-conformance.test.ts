// test/plugin-conformance.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { RUST_FIXTURES, installFixture } from "../conformance/install";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASES, runCase } from "../conformance/run";

const host = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
const root = join(tmpdir(), "pacer-conformance", "suite");
for (const c of CASES) test(`conformance: ${c.name}`, () => runCase(c, host, root), 25000);


test("Rust fixtures install executable entries, variant defaults and caller overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-rust-fixtures-"));
  try {
    for (const name of RUST_FIXTURES) {
      const installed = installFixture(name, dir);
      const manifest = JSON.parse(readFileSync(join(installed, "pacer-plugin.json"), "utf8"));
      const fixture = JSON.parse(readFileSync(join(installed, "fixture.json"), "utf8"));
      expect(manifest.id).toBe(`fx-${name}`);
      expect(manifest.entry).toBe("fixture");
      expect(statSync(join(installed, "fixture")).mode & 0o111).not.toBe(0);
      expect(fixture.callCapability).toBe("config.get");
      if (name === "rust-slow") expect(fixture).toMatchObject({ pingDelayMs: 8000, slowPings: 1 });
      if (name === "rust-crasher") expect(fixture.crashAfterPings).toBe(1);
    }
    const installed = installFixture("rust-slow", dir, { manifest: { id: "fx-custom", version: "2.0.0" }, fixture: { pingDelayMs: 10 } });
    expect(installed).toBe(join(dir, "fx-custom"));
    expect(JSON.parse(readFileSync(join(installed, "pacer-plugin.json"), "utf8")).version).toBe("2.0.0");
    expect(JSON.parse(readFileSync(join(installed, "fixture.json"), "utf8")).pingDelayMs).toBe(10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120000);
