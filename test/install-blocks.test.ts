import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockText, hasBlock, removeBlock, upsertBlock, type BlockStyle } from "../src/install/blocks";
import { backupPath, readText, sha256, shellCommand, shq } from "../src/install/fsx";
import { localTs, tmpDir } from "./helpers";

const dirs: string[] = [];
function tempDir(): string {
  const dir = tmpDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const styles: BlockStyle[] = ["md", "hash"];
for (const style of styles) {
  const open = style === "md" ? "<!-- >>> pacer >>> -->" : "# >>> pacer >>>";
  const close = style === "md" ? "<!-- <<< pacer <<< -->" : "# <<< pacer <<<";

  test(`${style}: blockText normalizes trailing body newlines`, () => {
    expect(blockText("v1\n\n", style)).toBe(`${open}\nv1\n${close}\n`);
    expect(blockText("", style)).toBe(`${open}\n\n${close}\n`);
  });

  for (const original of ["", "# notes\n", "# notes\n\n", "line one\nline two\n"]) {
    test(`${style}: upsert and remove round-trip ${JSON.stringify(original)}`, () => {
      const v1 = upsertBlock(original, "v1", style);
      const v2 = upsertBlock(v1, "v2", style);
      const prefix = original === "" ? "" : `${original}\n`;
      expect(v1).toBe(`${prefix}${open}\nv1\n${close}\n`);
      expect(v2).toBe(`${prefix}${open}\nv2\n${close}\n`);
      expect(v2).toBe(upsertBlock(original, "v2", style));
      expect(removeBlock(v2, style)).toBe(original);
    });
  }

  test(`${style}: a block in the middle is replaced and removed in place`, () => {
    const original = `before\n${open}\nv1\n${close}\nafter\n`;
    expect(upsertBlock(original, "v2", style)).toBe(`before\n${open}\nv2\n${close}\nafter\n`);
    expect(removeBlock(original, style)).toBe("before\nafter\n");
  });

  test(`${style}: missing trailing newline gets added on round-trip`, () => {
    expect(removeBlock(upsertBlock("abc", "v1", style), style)).toBe("abc\n");
  });

  test(`${style}: detects complete blocks and leaves unmarked text alone`, () => {
    expect(hasBlock(`${open}\nv1\n${close}`, style)).toBe(true);
    expect(removeBlock(`${open}\nv1\n${close}`, style)).toBe("");
    expect(hasBlock(`${open}\nv1\n`, style)).toBe(false);
    expect(hasBlock(`${close}\nv1\n${open}`, style)).toBe(false);
    expect(removeBlock("unrelated\n", style)).toBe("unrelated\n");
  });
}

test("backupPath uses local time and increments collision suffixes", () => {
  const path = join(tempDir(), "config.toml");
  const now = localTs(2026, 10, 11, 9, 5) + 7;
  const first = `${path}.pacer-bak-20261011-090507`;
  expect(backupPath(path, now)).toBe(first);
  writeFileSync(first, "backup");
  expect(backupPath(path, now)).toBe(`${first}-2`);
  writeFileSync(`${first}-2`, "backup");
  expect(backupPath(path, now)).toBe(`${first}-3`);
});

test("sha256 hashes UTF-8 text", () => {
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("shellCommand quotes paths with spaces and embedded single quotes", () => {
  expect(shellCommand(["/Volumes/My Disk/pacer", "it's"])).toBe("'/Volumes/My Disk/pacer' 'it'\\''s'");
  expect(shq("/usr/bin/pacer_-.:=@%+")).toBe("/usr/bin/pacer_-.:=@%+");
  expect(shq("")).toBe("''");
  expect(shq("$(echo unsafe)")).toBe("'$(echo unsafe)'");
});

test("readText returns file contents including empty text, or null for a missing file", () => {
  const path = join(tempDir(), "notes.md");
  expect(readText(path)).toBeNull();
  writeFileSync(path, "");
  expect(readText(path)).toBe("");
  writeFileSync(path, "notes\n");
  expect(readText(path)).toBe("notes\n");
});
