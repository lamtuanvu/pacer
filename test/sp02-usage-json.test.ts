import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursorFile } from "../src/plugins/usage-state/json";

test("cursor entry scanning preserves escaped nesting and Unicode across input chunk boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cursor-json-"));
  try {
    const path = join(root, "state.json");
    const payload = { escaped: '\\"},[\n界'.repeat(50000), nested: [null, true, false, -1.2e30, { retained: "unknown" }] };
    const source = JSON.stringify({ ignored: { nested: [1, 2] }, version: 4, files: { first: payload, second: { aggregate: payload } } });
    writeFileSync(path, source);
    let checks = 0;
    const actual = await readCursorFile(path, () => { checks++; });
    expect(actual).toEqual({ version: 4, files: JSON.parse(source).files });
    expect(checks).toBeGreaterThan(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cursor streaming scanner retains final duplicate keys and rejects incomplete or trailing JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cursor-json-"));
  try {
    const path = join(root, "state.json");
    for (const text of ['{"files":null,"version":1,"files":{"a":1},"version":4}', '{"files":{"a":1},"files":null,"version":4}']) {
      writeFileSync(path, text);
      const value = JSON.parse(text);
      expect(await readCursorFile(path, () => {})).toEqual({ version: value.version, files: value.files ?? {} });
    }
    for (const text of ['{"files":{"a":"unterminated}}', '{"files":{"a":[1,2}}', '{"files":{}}x']) {
      writeFileSync(path, text);
      await expect(readCursorFile(path, () => {})).rejects.toBeInstanceOf(Error);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cursor scanning checks cancellation between bounded input chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pacer-cursor-json-"));
  try {
    const path = join(root, "state.json");
    writeFileSync(path, JSON.stringify({ version: 4, files: { a: { aggregate: "x".repeat(1048576) } } }));
    let checks = 0;
    await expect(readCursorFile(path, () => { if (++checks === 2) throw Error("owned read canceled"); })).rejects.toThrow("owned read canceled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
